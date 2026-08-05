// Real end-to-end MCP protocol tests: spawns the actual src/index.js entry
// point over stdio and talks JSON-RPC to it, the same way a real MCP host
// would. CODEX-REVIEW 3.4 flagged that src/index.js (the MCP glue layer)
// had zero test coverage despite the unit tests looking complete — this
// file exists specifically to close that gap.

import assert from "node:assert/strict"
import { test } from "node:test"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const INDEX_PATH = new URL("../src/index.js", import.meta.url).pathname

class McpClient {
  constructor(env) {
    this.child = spawn("node", [INDEX_PATH], { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...env } })
    this.buf = ""
    this.messages = []
    this.nextId = 1
    this.stderr = ""
    this.child.stdout.on("data", (chunk) => {
      this.buf += chunk.toString()
      let idx
      while ((idx = this.buf.indexOf("\n")) >= 0) {
        const line = this.buf.slice(0, idx)
        this.buf = this.buf.slice(idx + 1)
        if (line.trim()) {
          try {
            this.messages.push(JSON.parse(line))
          } catch {
            // ignore non-JSON stdout noise
          }
        }
      }
    })
    this.child.stderr.on("data", (d) => (this.stderr += d.toString()))
  }

  async init() {
    this.send("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "test", version: "0.0.1" } })
    await this.waitFor((m) => m.id === 1)
    this.notify("notifications/initialized")
    await sleep(50)
  }

  send(method, params) {
    const id = this.nextId++
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
    return id
  }

  notify(method, params) {
    this.child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n")
  }

  async waitFor(predicate, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = this.messages.find(predicate)
      if (found) return found
      await sleep(10)
    }
    throw new Error(`timed out waiting for a matching message. stderr so far: ${this.stderr.slice(0, 2000)}`)
  }

  async call(name, args = {}) {
    const id = this.send("tools/call", { name, arguments: args })
    const msg = await this.waitFor((m) => m.id === id)
    if (msg.error) throw new Error(`RPC error calling ${name}: ${JSON.stringify(msg.error)}`)
    return msg.result
  }

  async callParsed(name, args = {}) {
    const result = await this.call(name, args)
    if (result.isError) return { isError: true, text: result.content?.[0]?.text }
    return JSON.parse(result.content[0].text)
  }

  async listTools() {
    const id = this.send("tools/list")
    const msg = await this.waitFor((m) => m.id === id)
    return msg.result.tools.map((t) => t.name)
  }

  async listPrompts() {
    const id = this.send("prompts/list")
    const msg = await this.waitFor((m) => m.id === id)
    return msg.result.prompts.map((p) => p.name)
  }

  async getPrompt(name) {
    const id = this.send("prompts/get", { name, arguments: {} })
    const msg = await this.waitFor((m) => m.id === id)
    if (msg.error) throw new Error(`RPC error getting prompt ${name}: ${JSON.stringify(msg.error)}`)
    return msg.result
  }

  close() {
    this.child.kill()
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function withServer(fn) {
  return async () => {
    const dir = mkdtempSync(join(tmpdir(), "bl-mcp-test-"))
    const client = new McpClient({ BOOKMARKS_LIFECYCLE_STATE_DIR: dir })
    try {
      await client.init()
      await fn(client, dir)
    } finally {
      client.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }
}

// --- discovery -----------------------------------------------------------

test(
  "tools/list includes all seven tools; prompts/list includes both prompts",
  withServer(async (client) => {
    const tools = await client.listTools()
    assert.deepEqual(tools.sort(), ["decide", "intake", "list_layer", "restore", "stats", "today", "undo"].sort())
    const prompts = await client.listPrompts()
    assert.deepEqual(prompts.sort(), ["clean_up_my_bookmarks", "daily_triage"].sort())
  }),
)

test(
  "prompts/get daily_triage returns non-empty guidance text mentioning decide/undo/actorClaim",
  withServer(async (client) => {
    const prompt = await client.getPrompt("daily_triage")
    const text = prompt.messages[0].content.text
    assert.ok(text.length > 200)
    assert.match(text, /decide/)
    assert.match(text, /undo/)
    assert.match(text, /actorClaim/)
  }),
)

// --- first-use scenarios ---------------------------------------------------

test(
  "0-item first use: today is empty with hasEverIntaken:false, not indistinguishable silence",
  withServer(async (client) => {
    const result = await client.callParsed("today")
    assert.equal(result.count, 0)
    assert.equal(result.hasEverIntaken, false)
  }),
)

test(
  "3-item first use: 3 items freshly in inbox surface in today via the real drip path (no real browser needed to prove the plumbing)",
  withServer(async (client, dir) => {
    // Seed 3 items sitting in `inbox` (as if intake had just aggregated them) with no
    // prior lastDripAt — this exercises the exact same freshenState() drip path that
    // real intake output goes through, without depending on real browser bookmarks
    // being present in whatever environment runs this test.
    const at = new Date().toISOString()
    const items = {}
    for (const n of ["a", "b", "c"]) {
      items[n] = {
        id: n,
        url: `https://example.com/${n}`,
        title: n,
        sources: [{ id: "chrome:Default", lastSeenAt: at }],
        addedAt: at,
        state: "inbox",
        enteredStateAt: at,
        history: [{ eventId: `${n}#0`, state: "inbox", at, by: "system" }],
        note: null,
        sourceGone: false,
      }
    }
    writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 2, items, lastDripAt: null, revision: 0 }), "utf8")
    const result = await client.callParsed("today")
    assert.equal(result.count, 3, "first-ever drip surfaces all 3 immediately (well under the default 15/day quota)")
    assert.equal(result.hasEverIntaken, true)
  }),
)

// --- decide / undo / restore over real JSON-RPC ----------------------------

async function seedThreePending(dir) {
  const at = new Date().toISOString()
  const items = {}
  for (const n of ["a", "b", "c"]) {
    items[n] = {
      id: n,
      url: `https://example.com/${n}`,
      title: n,
      sources: [{ id: "chrome:Default", lastSeenAt: at }],
      addedAt: at,
      state: "pending",
      enteredStateAt: at,
      history: [{ eventId: `${n}#0`, state: "pending", at, by: "system" }],
      note: null,
      sourceGone: false,
    }
  }
  writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 2, items, lastDripAt: at, revision: 0 }), "utf8")
}

test(
  "decide -> today reflects it; omitted actorClaim is recorded as mcp-client, not user",
  withServer(async (client, dir) => {
    await seedThreePending(dir)
    const decided = await client.callParsed("decide", { ids: ["a"], action: "keep" }) // actorClaim omitted
    assert.equal(decided.results[0].ok, true)
    const kept = await client.callParsed("list_layer", { layer: "kept" })
    assert.equal(kept.total, 1)
    assert.equal(kept.items[0].history.at(-1).by, "mcp-client", "omitted actorClaim must not default to \"user\"")

    const today = await client.callParsed("today")
    assert.equal(today.count, 2, "the kept item leaves the pending queue")
  }),
)

test(
  "decide keep -> undo -> back in today (full round trip through real MCP calls)",
  withServer(async (client, dir) => {
    await seedThreePending(dir)
    const decided = await client.callParsed("decide", { ids: ["a"], action: "keep", actorClaim: "user" })
    const keptLayer = await client.callParsed("list_layer", { layer: "kept" })
    const eventId = keptLayer.items[0].history.at(-1).eventId
    const undone = await client.callParsed("undo", { eventIds: [eventId], actorClaim: "user" })
    assert.equal(undone.results[0].ok, true)
    assert.equal(undone.results[0].to, "pending")
    const today = await client.callParsed("today")
    assert.equal(today.count, 3, "back to all three pending")
  }),
)

test(
  "restore only works on lapsed; kept items must go through undo instead",
  withServer(async (client, dir) => {
    await seedThreePending(dir)
    await client.callParsed("decide", { ids: ["a"], action: "keep", actorClaim: "user" })
    const restoreAttempt = await client.callParsed("restore", { ids: ["a"], actorClaim: "user" })
    assert.equal(restoreAttempt.results[0].ok, false)
    assert.equal(restoreAttempt.results[0].reason, "not-lapsed")
  }),
)

test(
  "actorClaim 'ai' without BOOKMARKS_LIFECYCLE_AUTO_DECIDE is rejected over real MCP; with it enabled, succeeds",
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "bl-mcp-test-"))
    try {
      await seedThreePending(dir)
      const blocked = new McpClient({ BOOKMARKS_LIFECYCLE_STATE_DIR: dir })
      try {
        await blocked.init()
        const r = await blocked.callParsed("decide", { ids: ["a"], action: "keep", actorClaim: "ai" })
        assert.equal(r.results[0].ok, false)
        assert.equal(r.results[0].reason, "ai-not-authorized")
      } finally {
        blocked.close()
      }

      const allowed = new McpClient({ BOOKMARKS_LIFECYCLE_STATE_DIR: dir, BOOKMARKS_LIFECYCLE_AUTO_DECIDE: "true" })
      try {
        await allowed.init()
        const r = await allowed.callParsed("decide", { ids: ["a"], action: "keep", actorClaim: "ai" })
        assert.equal(r.results[0].ok, true)
      } finally {
        allowed.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  },
)

// --- pagination ------------------------------------------------------------

test(
  "list_layer pagination: limit/offset actually slice, total reflects the whole layer",
  withServer(async (client, dir) => {
    const at = new Date().toISOString()
    const items = {}
    for (let i = 0; i < 10; i++) {
      const id = `k${i}`
      items[id] = { id, url: `https://example.com/${id}`, title: id, sources: [], addedAt: null, state: "kept", enteredStateAt: new Date(Date.parse(at) + i).toISOString(), history: [{ eventId: `${id}#0`, state: "kept", at, by: "user" }], note: null, sourceGone: false }
    }
    writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 2, items, lastDripAt: null, revision: 0 }), "utf8")
    const page1 = await client.callParsed("list_layer", { layer: "kept", limit: 4, offset: 0 })
    assert.equal(page1.total, 10)
    assert.equal(page1.returned, 4)
    const page2 = await client.callParsed("list_layer", { layer: "kept", limit: 4, offset: 8 })
    assert.equal(page2.returned, 2, "last page is a partial page, not padded or errored")
  }),
)

// --- schema safety over real MCP calls --------------------------------------

test(
  "a future-version state file makes every tool call fail cleanly (isError) rather than silently downgrading it",
  withServer(async (client, dir) => {
    writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 99, items: {}, futureField: "must-survive" }), "utf8")
    const before = readFileSync(join(dir, "state.json"), "utf8")
    const result = await client.call("stats")
    assert.equal(result.isError, true)
    const after = readFileSync(join(dir, "state.json"), "utf8")
    assert.equal(after, before, "file is completely untouched")
  }),
)

test(
  "housekeeping-only calls (nothing due, nothing to drip) do not rewrite state.json (CODEX-REVIEW 2.7)",
  withServer(async (client, dir) => {
    await client.callParsed("stats") // first call may write (state file created)
    const before = existsSync(join(dir, "state.json")) ? statSync(join(dir, "state.json")).mtimeMs : null
    await sleep(20)
    await client.callParsed("stats") // second call: nothing changed, nothing due
    const after = existsSync(join(dir, "state.json")) ? statSync(join(dir, "state.json")).mtimeMs : null
    assert.equal(after, before, "a pure read with no housekeeping transitions must not rewrite the file")
  }),
)

test(
  "prompts/get clean_up_my_bookmarks walks a first-timer through intake -> today -> confirm, states the no-deletion guarantee, and explains the decision-clock mechanism",
  withServer(async (client) => {
    const prompt = await client.getPrompt("clean_up_my_bookmarks")
    const text = prompt.messages[0].content.text
    assert.ok(text.length > 200)
    assert.match(text, /intake/)
    assert.match(text, /today/)
    assert.match(text, /NEVER deleted/i, "the walkthrough must make the no-deletion guarantee explicit")
    assert.match(text, /wait for my reply|STOP and wait/i, "must tell the assistant to stop before deciding")
    assert.doesNotMatch(text, /Burn 451|burn451/i, "the walkthrough is operational guidance, not promotion")
    assert.match(text, /ONE decision/, "must frame the 24h window as a decision deadline, not a reading deadline")
    assert.match(text, /on the fence/i, "must explain what the watching layer means")
  }),
)

test("intake: no_sources nextStep.why tells the assistant how to find and set a non-standard Chrome profile path", async () => {
  // Force real detection (via bookmarks-mcp) to find zero browsers: point HOME at a
  // fresh empty directory so none of the standard per-OS install locations exist,
  // and clear CHROMIUM_BOOKMARKS_PATH in case this machine's shell env sets one.
  const fakeHome = mkdtempSync(join(tmpdir(), "bl-mcp-fakehome-"))
  const stateDir = mkdtempSync(join(tmpdir(), "bl-mcp-test-"))
  const client = new McpClient({ HOME: fakeHome, CHROMIUM_BOOKMARKS_PATH: "", BOOKMARKS_LIFECYCLE_STATE_DIR: stateDir })
  try {
    await client.init()
    const result = await client.callParsed("intake")
    assert.equal(result.sourceStatus, "no_sources")
    assert.equal(result.nextStep.code, "check-chromium-bookmarks-path")
    assert.match(result.nextStep.why, /chrome:\/\/version/, "must name the exact page to open")
    assert.match(result.nextStep.why, /CHROMIUM_BOOKMARKS_PATH/, "must name the exact env var to set")
  } finally {
    client.close()
    rmSync(fakeHome, { recursive: true, force: true })
    rmSync(stateDir, { recursive: true, force: true })
  }
})

test(
  "today on a fresh state returns a nextStep telling the assistant to intake first",
  withServer(async (client) => {
    const res = await client.callParsed("today", {})
    assert.equal(res.hasEverIntaken, false)
    assert.equal(res.nextStep.code, "call-intake-first")
    assert.ok(res.nextStep.why.length > 20, "an empty queue must explain itself, not just return count:0")
  }),
)
