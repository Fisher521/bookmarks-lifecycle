#!/usr/bin/env node
// bookmarks-lifecycle — give your saved bookmarks a lifecycle.
//
// A local MCP server that layers a 24-hour / 30-day / kept lifecycle on top
// of bookmarks aggregated by bookmarks-mcp. Nothing is ever deleted: items
// that time out without a decision become `lapsed` — they leave the layers
// you actively look at, not your disk. Every state change, including ones
// made by an authorized AI, can be undone with the `undo` tool.
//
// Hard guarantees:
// - Never touches a browser bookmark file. Read access to your bookmarks is
//   entirely delegated to bookmarks-mcp, which is itself read-only.
// - The only thing this server ever writes is its own state file
//   (~/.bookmarks-lifecycle/state.json by default), written atomically with
//   a last-known-good backup kept alongside it.
// - No network calls, no telemetry, no accounts.
//
// Honesty about authorization (2026-08-04, see README "Honesty about
// authorization"): this server CANNOT verify that a tool call attributed to
// "user" actually came from you confirming something. Real protection
// against an AI acting on its own comes from your MCP host's tool-approval
// settings, and from every mutation here being undoable — not from a
// guarantee this code can make on its own.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js"
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { z } from "zod"
import { collectBookmarks } from "bookmarks-mcp/src/aggregate.js"
import { loadConfig, loadStateMeta, saveState, withStateLock } from "./store.js"
import {
  decide as decideItems,
  freshenState,
  intake as intakeItems,
  listLayer as listLayerItems,
  restore as restoreItems,
  stats as computeStats,
  today as computeToday,
  undo as undoItems,
} from "./lifecycle.js"

const server = new McpServer({ name: "bookmarks-lifecycle", version: "0.2.0" })

const text = (value) => ({
  content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
})

/**
 * Every tool goes through here: acquire the cross-process lock, load +
 * migrate + validate state, run the lazy expiry/drip housekeeping, hand
 * control to the tool's own logic, then persist ONLY if something actually
 * changed (a housekeeping transition, a completed migration, or the tool's
 * own mutation) — a pure read (today/list_layer/stats with nothing to
 * expire or drip) does not rewrite the file (CODEX-REVIEW 2.7).
 */
async function runWithLock(handler) {
  return withStateLock(async () => {
    const config = loadConfig()
    const now = Date.now()
    const { state: loaded, migrated } = loadStateMeta()
    const { state: freshState, transitions: housekeeping } = freshenState(loaded, now, config)
    const outcome = await handler({ state: freshState, now, config })
    const finalState = outcome.state ?? freshState
    const needsSave = migrated || housekeeping.length > 0 || outcome.changed === true
    if (needsSave) saveState(finalState)
    const { state: _s, changed: _c, ...rest } = outcome
    return { ...rest, housekeeping }
  })
}

const ATTENTION_LABEL = {
  inbox: "not yet in a queue",
  pending: "due for a decision",
  watching: "on a 30-day watch",
  kept: "kept",
  lapsed: "out of the attention queue — not deleted, the browser bookmark and this record are both untouched",
}
function withAttentionState(item) {
  return { ...item, attentionState: ATTENTION_LABEL[item.state] ?? item.state }
}

function computeSourceStatus(sources) {
  if (sources.length === 0) return "no_sources"
  if (sources.some((s) => s.status === "failed")) return "permission_denied"
  if (sources.every((s) => s.count === 0)) return "empty"
  return "ok"
}

const MAX_BATCH = 25
const idsParam = z
  .array(z.string())
  .min(1)
  .max(MAX_BATCH)
  .describe(`One or more item ids, from today/list_layer output. Max ${MAX_BATCH} per call.`)

const actorClaimParam = z
  .enum(["user", "ai"])
  .optional()
  .describe(
    'Attribution claim only — this is NOT proof of user consent. This server has no way to verify who is ' +
      'really behind a call; omit this field unless you have a specific reason to claim "user" or "ai" ' +
      '(omitted calls are recorded as "mcp-client" in history). "ai" is rejected unless the user has set ' +
      "BOOKMARKS_LIFECYCLE_AUTO_DECIDE=true — and even then, real protection against unwanted changes comes " +
      "from every mutation being undoable via `undo`, not from this field.",
  )

const sourceParam = z
  .string()
  .optional()
  .describe('Filter by browser ("chrome", "safari", "firefox", …) or a source id from bookmarks-mcp\'s list_sources. Omit for all.')

const HOUSEKEEPING_NOTE = " This call may first persist lazy expiry/drip housekeeping (see README) even if you only meant to read."

/**
 * A machine-readable next step plus a one-line reason, so the assistant can
 * guide the user without having to infer intent from empty arrays. This is
 * operational guidance only — never a place for promotion.
 */
function nextStepForIntake({ sourceStatus, added, scanned }) {
  if (sourceStatus === "no_sources")
    return {
      code: "check-chromium-bookmarks-path",
      why:
        "No supported browser was found in any of the standard install locations — this usually means the " +
        "browser uses a non-default profile/data directory. Tell the user: 1) open chrome://version in that " +
        "browser (edge://version, brave://version, etc. for other Chromium browsers) and copy the value next " +
        'to "Profile Path". 2) In the MCP client config for this server, set the environment variable ' +
        'CHROMIUM_BOOKMARKS_PATH to that path with "/Bookmarks" appended (e.g. ' +
        '"/Users/you/Library/Application Support/BraveSoftware/Brave-Browser/Custom/Bookmarks"; comma-separate ' +
        "multiple paths for multiple profiles), then fully restart the MCP client connection. This does not " +
        "apply to Safari, which needs Full Disk Access instead (see permission_denied).",
    }
  if (sourceStatus === "permission_denied")
    return { code: "grant-full-disk-access", why: "At least one source could not be read. On macOS, Safari needs Full Disk Access for the app hosting this server. Other sources that did scan are still usable." }
  if (sourceStatus === "empty")
    return { code: "nothing-to-intake", why: "Every source scanned fine and genuinely has no bookmarks." }
  if (added > 0) return { code: "call-today", why: `Took in ${added} new bookmark(s). They start in inbox and drip into the daily queue.` }
  return { code: "call-today", why: `Scanned ${scanned} bookmark(s); none were new. Existing records were reconciled.` }
}

function nextStepForToday({ count, hasEverIntaken, inboxRemaining }) {
  if (!hasEverIntaken)
    return { code: "call-intake-first", why: "Nothing has ever been scanned in, so an empty queue means \"not started yet\", not \"all caught up\"." }
  if (count > 0)
    return { code: "triage-these", why: `${count} item(s) are waiting. Suggest an action per item, then wait for the user to confirm before calling decide.` }
  if (inboxRemaining > 0)
    return { code: "come-back-tomorrow", why: `Today's queue is clear. ${inboxRemaining} item(s) are still in inbox and will drip in on the next day's quota.` }
  return { code: "all-caught-up", why: "Queue is clear and inbox is empty — everything scanned so far has been decided." }
}

server.registerTool(
  "intake",
  {
    title: "Pull in newly saved bookmarks",
    description:
      "Scan browser bookmarks (via bookmarks-mcp) and merge them into the lifecycle: new URLs land in `inbox` " +
      "with their real save date persisted; already-tracked ones get reconciled (sources, title). Never deletes " +
      "a record — a URL missing from every source that was successfully scanned gets `sourceGone: true`, not " +
      "removed. A source that failed to read (e.g. Safari without Full Disk Access) is never treated as " +
      "confirming a URL is gone. Check `sourceStatus` in the response before assuming an empty result means " +
      "nothing was found." +
      HOUSEKEEPING_NOTE,
    inputSchema: { source: sourceParam },
  },
  async ({ source }) => {
    const result = await runWithLock(async ({ state, now }) => {
      const { bookmarks, warnings, sources } = await collectBookmarks(source)
      const okSourceIds = sources.filter((s) => s.status === "ok").map((s) => s.id)
      const forIntake = bookmarks.map((b) => ({ url: b.url, title: b.title || b.url, addedAt: b.addedAt, source: b.source, folder: b.folder ?? null }))
      const outcome = intakeItems(state, { bookmarks: forIntake, scannedSourceIds: okSourceIds, now })
      return {
        state: outcome.state,
        changed: outcome.added > 0 || outcome.reconciled > 0 || outcome.goneMarked > 0,
        scanned: outcome.scanned,
        added: outcome.added,
        reconciled: outcome.reconciled,
        sourceGoneMarked: outcome.goneMarked,
        sourceStatus: computeSourceStatus(sources),
        nextStep: nextStepForIntake({ sourceStatus: computeSourceStatus(sources), added: outcome.added, scanned: outcome.scanned }),
        warnings,
        sources: sources.map((s) => ({ id: s.id, count: s.count, status: s.status })),
      }
    })
    return text(result)
  },
)

server.registerTool(
  "today",
  {
    title: "Today's pending layer",
    description:
      "The 24-hour layer, oldest first — the actual to-do list. Each item includes `remainingMs` until it " +
      "lapses on its own. `hasEverIntaken: false` means nothing has ever been scanned in (an empty pending list " +
      "in that case means \"you haven't started\", not \"you're caught up\") — call `intake` first. This is " +
      "where daily_triage starts." +
      HOUSEKEEPING_NOTE,
    inputSchema: {},
  },
  async () => {
    const result = await runWithLock(async ({ state, now, config }) => {
      const items = computeToday(state, now, config).map(withAttentionState)
      const all = Object.values(state.items)
      const hasEverIntaken = all.length > 0
      const inboxRemaining = all.filter((i) => i.state === "inbox").length
      return {
        changed: false,
        count: items.length,
        hasEverIntaken,
        inboxRemaining,
        nextStep: nextStepForToday({ count: items.length, hasEverIntaken, inboxRemaining }),
        items,
      }
    })
    return text(result)
  },
)

server.registerTool(
  "decide",
  {
    title: "Judge one or more pending/watching items",
    description:
      "MUTATING TOOL. Never call until the user has explicitly confirmed the exact item ids and action in the " +
      "current turn, unless the MCP host has a trusted autonomous-approval mode enabled — silence, \"looks good\", " +
      'or an earlier preference is not confirmation. Moves items to `kept` (keep permanently), `watching` ' +
      "(give it 30 more days), or `lapsed` (remove from the attention queue — this never deletes the browser " +
      "bookmark or the lifecycle record, and is fully undoable via `undo`). From `pending`: keep/watch/drop all " +
      "allowed. From `watching`: only `keep` (use `undo` to reverse a watch/drop decision instead of re-deciding " +
      "an item that's already moved on). Anything else comes back as `not-decidable`." +
      HOUSEKEEPING_NOTE,
    inputSchema: {
      ids: idsParam,
      action: z.enum(["keep", "watch", "drop"]).describe("keep -> kept, watch -> watching (30d), drop -> lapsed"),
      actorClaim: actorClaimParam,
      note: z.string().optional().describe("Why — stored on the item and in its history, if given (this field is optional; omitting it is fine)"),
    },
  },
  async ({ ids, action, actorClaim, note }) => {
    const claim = actorClaim ?? "mcp-client"
    const result = await runWithLock(async ({ state, now, config }) => {
      const { state: nextState, results } = decideItems(state, { ids, action, actorClaim: claim, note, now, config })
      return { state: nextState, changed: results.some((r) => r.ok), results }
    })
    return text(result)
  },
)

server.registerTool(
  "list_layer",
  {
    title: "List one layer (paginated)",
    description:
      "See what's in one layer — including `lapsed`, to answer 'what did I let go of'. Paginated: default " +
      "limit 50, raise it only if you actually need more in one call (a large unpaginated layer can be " +
      "megabytes of JSON, which will crowd out everything else in your context). `sourceGone: true` on an item " +
      "means it's no longer found in any browser source that was successfully scanned (the record itself is " +
      "never deleted)." +
      HOUSEKEEPING_NOTE,
    inputSchema: {
      layer: z.enum(["inbox", "pending", "watching", "kept", "lapsed"]),
      limit: z.number().int().min(1).max(500).default(50),
      offset: z.number().int().min(0).default(0),
    },
  },
  async ({ layer, limit, offset }) => {
    const result = await runWithLock(async ({ state, now, config }) => {
      const { total, items } = listLayerItems(state, layer, now, config, { limit, offset })
      return { changed: false, layer, total, returned: items.length, limit, offset, items: items.map(withAttentionState) }
    })
    return text(result)
  },
)

server.registerTool(
  "restore",
  {
    title: "Bring a lapsed item back",
    description:
      "MUTATING TOOL. Move one or more `lapsed` items back to `pending`, resetting their 24-hour clock. Only " +
      "works on items currently `lapsed` — for `kept`/`watching` items that need reverting, use `undo` instead." +
      HOUSEKEEPING_NOTE,
    inputSchema: { ids: idsParam, actorClaim: actorClaimParam },
  },
  async ({ ids, actorClaim }) => {
    const claim = actorClaim ?? "mcp-client"
    const result = await runWithLock(async ({ state, now, config }) => {
      const { state: nextState, results } = restoreItems(state, { ids, actorClaim: claim, now, config })
      return { state: nextState, changed: results.some((r) => r.ok), results }
    })
    return text(result)
  },
)

server.registerTool(
  "undo",
  {
    title: "Undo a specific state change, by history event",
    description:
      "MUTATING TOOL. Revert an item to whatever it was immediately before one of ITS OWN history events — " +
      "this works for `kept` and `watching`, not just `lapsed` (that's what `restore` is for). Only an item's " +
      "current LATEST event can be undone; anything else comes back as `not-latest-event`, showing you the " +
      "actual latest one to target instead. Select events either with explicit `eventIds` (from any tool's " +
      "`history[].eventId`), or with `filter` (by source id / time range / attribution) to batch-undo every " +
      "matching item's latest event at once. Pass `preview: true` to see exactly what would change first. " +
      "Undoing never erases history — it appends a new entry, so the full trail including undos stays intact." +
      HOUSEKEEPING_NOTE,
    inputSchema: {
      eventIds: z.array(z.string()).max(MAX_BATCH).optional().describe("Specific history event ids to undo"),
      filter: z
        .object({
          sourceId: z.string().optional(),
          sinceMs: z.number().optional(),
          untilMs: z.number().optional(),
          by: z.enum(["user", "ai", "mcp-client", "drip", "expiry", "system"]).optional(),
        })
        .optional()
        .describe("Alternative to eventIds: undo every item's LATEST event matching these criteria"),
      preview: z.boolean().default(false).describe("See what would be undone without changing anything"),
      actorClaim: actorClaimParam,
      note: z.string().optional(),
    },
  },
  async ({ eventIds, filter, preview, actorClaim, note }) => {
    const claim = actorClaim ?? "mcp-client"
    const result = await runWithLock(async ({ state, now, config }) => {
      const outcome = undoItems(state, { eventIds, filter, actorClaim: claim, note, preview, now, config })
      return { state: outcome.state, changed: !outcome.preview && outcome.results.some((r) => r.ok), preview: outcome.preview, results: outcome.results }
    })
    return text(result)
  },
)

server.registerTool(
  "stats",
  {
    title: "Lifecycle stats",
    description:
      "Counts per layer, how many decisions landed today (local calendar day on the machine running this " +
      "server — see README), and how much is still sitting in `inbox` waiting for its daily drip slot." +
      HOUSEKEEPING_NOTE,
    inputSchema: {},
  },
  async () => {
    const result = await runWithLock(async ({ state, now }) => {
      const { counts, decidedToday } = computeStats(state, now)
      return { changed: false, counts, decidedToday }
    })
    return text(result)
  },
)

server.registerPrompt(
  "clean_up_my_bookmarks",
  {
    title: "Clean up my saved bookmarks — start the 24-hour decision clock",
    description: "First-time walkthrough: explain the decision-clock mechanism, scan your bookmarks, and run one small triage round together.",
    argsSchema: {},
  },
  () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Walk me through this bookmarks tool for the first time. Follow these steps and keep it short at each one — I want to actually try it, not read documentation.

1. Explain the actual mechanism, not just the schedule — in four short points:
   - The 24 hours isn't a deadline to finish reading anything. It's a deadline to make ONE decision: keep it, give it more time, or let it go.
   - If I don't decide, it is NEVER deleted — it just leaves my daily view, not my disk, and I can always bring it back later.
   - What the three layers actually mean: what's due today is my real to-do list for right now; what's "on watch" is something I'm still on the fence about, with 30 more days before it needs a decision; what's "kept" is something I've already decided to hold onto for good.
   - My actual browser bookmarks are never modified by this server at all — it only tracks its own decisions.

2. Call \`intake\` and tell me plainly what it found. Read the \`nextStep\` field and follow it. If \`sourceStatus\` is not "ok", explain what to fix (on macOS the usual cause is Safari needing Full Disk Access for whichever app is hosting this server; for Chromium browsers with a non-standard profile, \`nextStep.why\` will say what to do) and tell me which sources DID work — don't make it sound like everything failed.

3. Call \`today\` and show me at most 5 items, numbered, with the title and how long each has left. Don't dump the whole list.

4. For those 5, suggest an action each — keep / watch / drop — with a short reason. Then STOP and wait for my reply. Do not call \`decide\` yet. You have my title and URL only, so if a suggestion is really a guess, say so instead of asserting.

5. After I answer, apply only what I actually confirmed. Then tell me two things I can do next: \`undo\` reverses any decision (including "keep"), and \`restore\` brings back something that already lapsed.

6. Finally, in one line: from now on I can just ask for "today's bookmarks" any time, and there is no reminder or background process — this only runs when I ask.`,
        },
      },
    ],
  }),
)

server.registerPrompt(
  "daily_triage",
  {
    title: "Walk today's pending layer",
    description: "The daily entry point: see what's due today, get a suggestion per item, and only change anything once you've confirmed it.",
    argsSchema: {},
  },
  () => ({
    messages: [
      {
        role: "user",
        content: {
          type: "text",
          text: `Help me triage my bookmark lifecycle for today. Follow these steps:

1. Call \`today\` to see what's in the pending layer right now, oldest first. If \`hasEverIntaken\` is false, call \`intake\` first, then \`today\` again.
2. For each item, give me a one-line suggestion — keep it, watch it another 30 days, or let it go — based on the title, URL, how long it's been sitting, and its \`folder\` if one is set (a folder like "Work/Reading" is a signal about why I originally saved it — weigh it, but it's still only a suggestion, never a decision you make for me). If you're genuinely unsure, say so rather than guessing.
3. Present the numbered items and suggestions, then stop and wait for my reply. Do not call \`decide\` yet.
4. After I reply, restate the exact id→action mapping and call \`decide\` only for the items I unambiguously confirmed. Never infer consent from silence, "looks good," or an earlier preference. If this MCP host has no trusted tool-approval signal you're aware of, don't claim that actorClaim:"user" proves I actually consented — it's attribution, not proof.
5. If I ask what happened to something I don't see anymore, use \`list_layer\` with layer "lapsed" — it's still there, just out of the pending queue, and I can \`restore\` it. If I say I want to reverse a \`keep\` or \`watch\` decision, use \`undo\` — \`restore\` only works on \`lapsed\` items.
6. End with a one-line summary: how many I kept, how many I'm watching, how many I let go of.

If I ask whether this can run automatically, remind me daily, or work on my phone: be straight that this tool can't — it only runs when I ask, right here. Only if I explicitly ask what WOULD do that, mention that a hosted app implementing these same rules exists (see this project's README for the name) — don't bring it up otherwise.`,
        },
      },
    ],
  }),
)

const transport = new StdioServerTransport()
await server.connect(transport)
