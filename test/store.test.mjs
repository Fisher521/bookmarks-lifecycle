import assert from "node:assert/strict"
import { test } from "node:test"
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { spawn, spawnSync } from "node:child_process"
import { loadConfig, loadState, loadStateMeta, saveState, withStateLock } from "../src/store.js"
import { CURRENT_VERSION } from "../src/schema.js"

function spawnAsync(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, options)
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (d) => (stdout += d))
    child.stderr.on("data", (d) => (stderr += d))
    child.on("close", (status) => resolve({ status, stdout, stderr }))
  })
}

const STORE_MODULE_URL = new URL("../src/store.js", import.meta.url).href
const SCHEMA_MODULE_URL = new URL("../src/schema.js", import.meta.url).href

// Always `await`ed by callers below. Must itself be async: a sync
// try/finally around an async callback would run the `finally` (which
// deletes the tmp dir) as soon as the callback returns its pending promise,
// not after it settles — exactly the kind of bug this file exists to catch
// elsewhere, so it can't be allowed here either.
async function withTmpDir(fn) {
  const dir = mkdtempSync(join(tmpdir(), "bl-store-test-"))
  process.env.BOOKMARKS_LIFECYCLE_STATE_DIR = dir
  try {
    return await fn(dir)
  } finally {
    delete process.env.BOOKMARKS_LIFECYCLE_STATE_DIR
    rmSync(dir, { recursive: true, force: true })
  }
}

function makeItem(id, extra = {}) {
  const at = "2024-01-01T00:00:00Z"
  return { id, url: `https://example.com/${id}`, title: id, folder: null, sources: [], addedAt: null, state: "kept", enteredStateAt: at, history: [{ eventId: `${id}#0`, state: "kept", at, by: "user" }], note: null, sourceGone: false, ...extra }
}

// --- loadConfig ------------------------------------------------------------

test("loadConfig: defaults when no env vars set", () => {
  for (const k of ["BOOKMARKS_LIFECYCLE_PENDING_HOURS", "BOOKMARKS_LIFECYCLE_WATCHING_DAYS", "BOOKMARKS_LIFECYCLE_DRIP_PER_DAY", "BOOKMARKS_LIFECYCLE_AUTO_DECIDE"]) {
    delete process.env[k]
  }
  const config = loadConfig()
  assert.equal(config.pendingMs, 24 * 60 * 60 * 1000)
  assert.equal(config.watchingMs, 30 * 24 * 60 * 60 * 1000)
  assert.equal(config.dripPerDay, 15)
  assert.equal(config.autoDecide, false)
})

test("loadConfig: env vars override the defaults", () => {
  process.env.BOOKMARKS_LIFECYCLE_PENDING_HOURS = "1"
  process.env.BOOKMARKS_LIFECYCLE_WATCHING_DAYS = "7"
  process.env.BOOKMARKS_LIFECYCLE_DRIP_PER_DAY = "5"
  process.env.BOOKMARKS_LIFECYCLE_AUTO_DECIDE = "true"
  try {
    const config = loadConfig()
    assert.equal(config.pendingMs, 60 * 60 * 1000)
    assert.equal(config.watchingMs, 7 * 24 * 60 * 60 * 1000)
    assert.equal(config.dripPerDay, 5)
    assert.equal(config.autoDecide, true)
  } finally {
    for (const k of ["BOOKMARKS_LIFECYCLE_PENDING_HOURS", "BOOKMARKS_LIFECYCLE_WATCHING_DAYS", "BOOKMARKS_LIFECYCLE_DRIP_PER_DAY", "BOOKMARKS_LIFECYCLE_AUTO_DECIDE"]) {
      delete process.env[k]
    }
  }
})

// --- load/save basics --------------------------------------------------

test("loadState: missing file returns empty current-version state", async () => {
  await withTmpDir(() => {
    const s = loadState()
    assert.equal(s.version, CURRENT_VERSION)
    assert.deepEqual(s.items, {})
    assert.equal(s.revision, 0)
  })
})

test("saveState/loadState: round-trip preserves data and increments revision", async () => {
  await withTmpDir(() => {
    const s = { version: 2, items: { x: makeItem("x") }, lastDripAt: null, revision: 0 }
    const saved = saveState(s)
    assert.equal(saved.revision, 1)
    const reloaded = loadState()
    assert.equal(reloaded.revision, 1)
    assert.equal(reloaded.items.x.url, "https://example.com/x")
  })
})

test("saveState: creates a .bak of the previous generation before overwriting", async () => {
  await withTmpDir((dir) => {
    saveState({ version: 2, items: { x: makeItem("x") }, lastDripAt: null, revision: 0 })
    const before = readFileSync(join(dir, "state.json"), "utf8")
    saveState(loadState())
    const bak = readFileSync(join(dir, "state.json.bak"), "utf8")
    assert.equal(bak, before, "backup holds exactly the previous generation's bytes")
  })
})

test("saveState: CAS conflict throws instead of silently overwriting", async () => {
  await withTmpDir(() => {
    const s = saveState({ version: 2, items: { x: makeItem("x") }, lastDripAt: null, revision: 0 })
    // A stale revision (as if loaded before someone else's write) must be rejected.
    assert.throws(() => saveState({ ...s, revision: s.revision - 1 }), /revision conflict/)
  })
})

test("loadState: corrupt JSON throws with a clear message, does not overwrite the file", async () => {
  await withTmpDir((dir) => {
    writeFileSync(join(dir, "state.json"), "{ not json at all", "utf8")
    assert.throws(() => loadState(), /not valid JSON/)
    assert.equal(readFileSync(join(dir, "state.json"), "utf8"), "{ not json at all", "file untouched by the failed load")
  })
})

test("loadStateMeta: reports migrated:true for a v1 file, false for current-version", async () => {
  await withTmpDir((dir) => {
    writeFileSync(join(dir, "state.json"), JSON.stringify({ version: 1, items: {}, lastDripAt: null }), "utf8")
    assert.equal(loadStateMeta().migrated, true)
    saveState(loadState())
    assert.equal(loadStateMeta().migrated, false)
  })
})

// --- atomic write: interrupted write must never corrupt the real file ------

test("atomic write: a write that fails partway through leaves the previous valid file completely intact", async () => {
  await withTmpDir((dir) => {
    saveState({ version: 2, items: { safe: makeItem("safe", { note: "valuable judgment" }) }, lastDripAt: null, revision: 0 })
    const before = readFileSync(join(dir, "state.json"), "utf8")

    // Force a large write to fail mid-way by capping the file-size ulimit in a child
    // process, mirroring CODEX-REVIEW 1.1's exact repro.
    const childScript = `
      import { saveState } from ${JSON.stringify(STORE_MODULE_URL)}
      const items = {}
      for (let i = 0; i < 5000; i++) items[i] = { id: String(i), url: "https://example.com/" + i, title: "x".repeat(200), sources: [], addedAt: null, state: "kept", enteredStateAt: "2024-01-01T00:00:00Z", history: [{eventId:i+"#0",state:"kept",at:"2024-01-01T00:00:00Z",by:"user"}], note: null, sourceGone: false }
      saveState({ version: 2, items, lastDripAt: null, revision: 1 })
    `
    const result = spawnSync("zsh", ["-c", "ulimit -f 1; exec node --input-type=module -e \"$1\"", "review", childScript], {
      env: { ...process.env, BOOKMARKS_LIFECYCLE_STATE_DIR: dir },
      encoding: "utf8",
    })
    assert.notEqual(result.status, 0, "the oversized write must fail")

    const after = readFileSync(join(dir, "state.json"), "utf8")
    assert.equal(after, before, "state.json is byte-identical to before the failed write")
    assert.doesNotThrow(() => JSON.parse(after), "still valid JSON")
    assert.ok(after.includes("valuable judgment"), "the pre-existing judgment history survived")

    // no leftover temp files
    const leftovers = readdirSync(dir).filter((f) => f.includes(".tmp-"))
    assert.deepEqual(leftovers, [], "no temp files left behind after the failed write")
  })
})

// --- cross-process lock ------------------------------------------------

test("withStateLock: a stale lock (old timestamp) is stolen immediately rather than waited out", async () => {
  await withTmpDir(async (dir) => {
    writeFileSync(join(dir, "state.json.lock"), JSON.stringify({ pid: 999999, at: new Date(Date.now() - 60_000).toISOString() }), "utf8")
    const started = Date.now()
    let ran = false
    await withStateLock(async () => {
      ran = true
    })
    assert.equal(ran, true)
    assert.ok(Date.now() - started < 1000, "stale lock was stolen quickly, not waited out for the full timeout")
  })
})

test("withStateLock: two concurrent processes both persist their write — no lost update (CODEX-REVIEW 1.2)", async () => {
  await withTmpDir(async (dir) => {
    saveState({ version: 2, items: {}, lastDripAt: null, revision: 0 })

    const workerScript = (id, delayMs) => `
      import { withStateLock, loadState, saveState } from ${JSON.stringify(STORE_MODULE_URL)}
      await withStateLock(async () => {
        const s = loadState()
        await new Promise((r) => setTimeout(r, ${delayMs}))
        s.items[${JSON.stringify(id)}] = { id: ${JSON.stringify(id)}, url: "https://example.com/" + ${JSON.stringify(id)}, title: ${JSON.stringify(id)}, folder: null, sources: [], addedAt: null, state: "kept", enteredStateAt: "2024-01-01T00:00:00Z", history: [{eventId:${JSON.stringify(id)}+"#0",state:"kept",at:"2024-01-01T00:00:00Z",by:"user"}], note: null, sourceGone: false }
        saveState(s)
      })
      console.log("SAVED_${id}")
    `
    const env = { ...process.env, BOOKMARKS_LIFECYCLE_STATE_DIR: dir }
    const [a, b] = await Promise.all([
      spawnAsync("node", ["--input-type=module", "-e", workerScript("A", 150)], { env }),
      spawnAsync("node", ["--input-type=module", "-e", workerScript("B", 30)], { env }),
    ])
    assert.match(a.stdout, /SAVED_A/, a.stderr)
    assert.match(b.stdout, /SAVED_B/, b.stderr)

    const final = loadState()
    assert.deepEqual(Object.keys(final.items).sort(), ["A", "B"], "both concurrent writers' items survived — the lock serialized them instead of one clobbering the other")
  })
})

// --- scale (lighter version of CODEX-REVIEW 3.1 — correctness at 5k, not a strict perf budget) --

test("5,000-item state: save/load round-trips correctly and completes in a sane amount of time", async () => {
  await withTmpDir(async () => {
    const items = {}
    for (let i = 0; i < 5000; i++) {
      const id = `item${i}`
      items[id] = makeItem(id, { addedAt: `${2000 + (i % 26)}-01-01T00:00:00Z` })
    }
    const t0 = performance.now()
    saveState({ version: 2, items, lastDripAt: null, revision: 0 })
    const saveMs = performance.now() - t0

    const t1 = performance.now()
    const reloaded = loadState()
    const loadMs = performance.now() - t1

    assert.equal(Object.keys(reloaded.items).length, 5000)
    assert.equal(reloaded.items.item0.url, "https://example.com/item0")
    // Generous ceiling, not a tight perf assertion — this only needs to catch a
    // regression that makes save/load accidentally quadratic, not track exact ms.
    assert.ok(saveMs < 2000, `saveState took ${saveMs}ms for 5k items — expected well under 2s`)
    assert.ok(loadMs < 2000, `loadState took ${loadMs}ms for 5k items — expected well under 2s`)
  })
})
