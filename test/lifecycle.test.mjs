import assert from "node:assert/strict"
import { test } from "node:test"
import { decide, freshenState, idFor, intake, listLayer, restore, stats, today, undo } from "../src/lifecycle.js"

const BASE_NOW = 1_700_000_000_000 // fixed epoch ms, arbitrary but deterministic
const SECOND = 1000
const DAY_MS = 24 * 60 * 60 * 1000

const CONFIG = { pendingMs: 10 * SECOND, watchingMs: 30 * SECOND, dripPerDay: 2, autoDecide: false }

function emptyState() {
  return { version: 2, items: {}, lastDripAt: null, revision: 0 }
}

function item(overrides) {
  const id = overrides.id ?? "item0000000000"
  const at = new Date(BASE_NOW).toISOString()
  return {
    id,
    url: "https://example.com/a",
    title: "A",
    sources: [{ id: "chrome:Default", lastSeenAt: at }],
    addedAt: null,
    state: "pending",
    enteredStateAt: at,
    history: [{ eventId: `${id}#0`, state: "pending", at, by: "system" }],
    note: null,
    sourceGone: false,
    ...overrides,
  }
}

function stateWith(...items) {
  const s = emptyState()
  for (const i of items) s.items[i.id] = i
  return s
}

// --- idFor -------------------------------------------------------------

test("idFor: deterministic, 16 hex chars, distinct per url", () => {
  const a = idFor("https://example.com/a")
  const b = idFor("https://example.com/b")
  assert.equal(idFor("https://example.com/a"), a, "same url -> same id")
  assert.notEqual(a, b)
  assert.match(a, /^[0-9a-f]{16}$/)
})

// --- freshenState: expiry (strict `>`, per §7.5's literal text) -----------

test("freshenState: pending item exactly AT the boundary is NOT yet lapsed (strict >, not >=)", () => {
  const enteredAt = BASE_NOW - CONFIG.pendingMs // exactly at the boundary
  const s = stateWith(item({ id: "x", state: "pending", enteredStateAt: new Date(enteredAt).toISOString() }))
  const { state, transitions } = freshenState(s, BASE_NOW, CONFIG)
  assert.equal(state.items.x.state, "pending", "§7.5 is strict `>` — exactly-at-the-limit has not yet lapsed")
  assert.equal(transitions.length, 0)
})

test("freshenState: pending item 1ms past the boundary lapses, with an expiry history entry", () => {
  const enteredAt = BASE_NOW - CONFIG.pendingMs - 1
  const s = stateWith(item({ id: "x", state: "pending", enteredStateAt: new Date(enteredAt).toISOString() }))
  const { state, transitions } = freshenState(s, BASE_NOW, CONFIG)
  assert.equal(state.items.x.state, "lapsed")
  const last = state.items.x.history.at(-1)
  assert.equal(last.state, "lapsed")
  assert.equal(last.by, "expiry")
  assert.match(last.eventId, /^x#\d+$/)
  assert.deepEqual(transitions, [{ id: "x", from: "pending", to: "lapsed", by: "expiry" }])
})

test("freshenState: watching item past watchingMs lapses (same strict boundary)", () => {
  const enteredAt = BASE_NOW - CONFIG.watchingMs - 1
  const s = stateWith(item({ id: "x", state: "watching", enteredStateAt: new Date(enteredAt).toISOString() }))
  const { state, transitions } = freshenState(s, BASE_NOW, CONFIG)
  assert.equal(state.items.x.state, "lapsed")
  assert.deepEqual(transitions, [{ id: "x", from: "watching", to: "lapsed", by: "expiry" }])
})

test("freshenState: inbox/kept/lapsed never expire regardless of age", () => {
  const veryOld = new Date(BASE_NOW - 999 * DAY_MS).toISOString()
  const s = stateWith(
    item({ id: "a", state: "inbox", enteredStateAt: veryOld }),
    item({ id: "b", state: "kept", enteredStateAt: veryOld }),
    item({ id: "c", state: "lapsed", enteredStateAt: veryOld }),
  )
  s.lastDripAt = new Date(BASE_NOW).toISOString() // suppress drip so it doesn't promote "a" out of inbox — covered separately
  const { state, transitions } = freshenState(s, BASE_NOW, CONFIG)
  assert.equal(state.items.a.state, "inbox")
  assert.equal(state.items.b.state, "kept")
  assert.equal(state.items.c.state, "lapsed")
  assert.equal(transitions.length, 0)
})

// --- freshenState: drip, capped (does NOT accumulate across a long gap) ---

test("freshenState: first-ever drip promotes up to dripPerDay oldest inbox items, oldest-first by real addedAt", () => {
  const s = emptyState()
  s.items.old = item({ id: "old", state: "inbox", addedAt: "2020-01-01T00:00:00Z" })
  s.items.mid = item({ id: "mid", state: "inbox", addedAt: "2021-01-01T00:00:00Z" })
  s.items.new = item({ id: "new", state: "inbox", addedAt: "2022-01-01T00:00:00Z" })
  const { state, transitions } = freshenState(s, BASE_NOW, CONFIG)
  assert.equal(state.items.old.state, "pending")
  assert.equal(state.items.mid.state, "pending")
  assert.equal(state.items.new.state, "inbox", "3rd-oldest exceeds the daily quota of 2")
  assert.equal(transitions.filter((t) => t.to === "pending" && t.by === "drip").length, 2)
  assert.equal(state.lastDripAt, new Date(BASE_NOW).toISOString())
})

test("freshenState: items with no addedAt fall back to discovery order, not fabricated dates", () => {
  const s = emptyState()
  const discoveredEarlier = new Date(BASE_NOW - 5000).toISOString()
  const discoveredLater = new Date(BASE_NOW - 1000).toISOString()
  s.items.dated = item({ id: "dated", state: "inbox", addedAt: "2024-01-01T00:00:00Z", history: [{ eventId: "dated#0", state: "inbox", at: discoveredEarlier, by: "system" }] })
  s.items.undatedEarly = item({ id: "undatedEarly", state: "inbox", addedAt: null, history: [{ eventId: "undatedEarly#0", state: "inbox", at: discoveredEarlier, by: "system" }] })
  s.items.undatedLate = item({ id: "undatedLate", state: "inbox", addedAt: null, history: [{ eventId: "undatedLate#0", state: "inbox", at: discoveredLater, by: "system" }] })
  const config = { ...CONFIG, dripPerDay: 2 }
  const { state } = freshenState(s, BASE_NOW, config)
  assert.equal(state.items.undatedEarly.state, "pending", "undated items are treated as oldest overall")
  assert.equal(state.items.undatedLate.state, "pending", "among undated items, the one discovered first wins the 2nd slot")
  assert.equal(state.items.dated.state, "inbox", "a real (recent) addedAt loses to undated items under this fallback")
  assert.equal(state.items.undatedEarly.addedAt, null, "no date is ever fabricated into addedAt itself")
})

test("freshenState: calling again within the same day does not re-drip", () => {
  const s = emptyState()
  for (const id of ["a", "b", "c"]) s.items[id] = item({ id, state: "inbox", addedAt: "2020-01-01T00:00:00Z" })
  const first = freshenState(s, BASE_NOW, CONFIG)
  const second = freshenState(first.state, BASE_NOW + 5 * SECOND, CONFIG)
  assert.equal(second.transitions.length, 0)
  assert.equal(second.state.lastDripAt, first.state.lastDripAt)
})

test("freshenState: a long absence does NOT accumulate — one call still promotes at most dripPerDay (CODEX-REVIEW 2.5)", () => {
  const s = emptyState()
  for (let i = 0; i < 10; i++) {
    s.items[`i${i}`] = item({ id: `i${i}`, state: "inbox", addedAt: `202${i}-01-01T00:00:00Z` })
  }
  const first = freshenState(s, BASE_NOW, CONFIG) // promotes 2
  assert.equal(Object.values(first.state.items).filter((i) => i.state === "pending").length, 2)

  const HUNDRED_DAYS = 100 * DAY_MS
  const muchLater = BASE_NOW + HUNDRED_DAYS
  const second = freshenState(first.state, muchLater, CONFIG)
  const promotedThisCall = second.transitions.filter((t) => t.to === "pending" && t.by === "drip").length
  assert.equal(promotedThisCall, 2, "100 days away still only yields ONE day's quota, not 100x it")
  assert.equal(second.state.lastDripAt, new Date(muchLater).toISOString(), "anchor resets straight to now — the backlog is not owed later either")
})

test("freshenState: empty inbox does not touch lastDripAt", () => {
  const s = emptyState()
  const { state } = freshenState(s, BASE_NOW, CONFIG)
  assert.equal(state.lastDripAt, null)
})

// --- intake ---------------------------------------------------------------

test("intake: new URL creates an inbox item with real addedAt persisted and a system history entry", () => {
  const s = emptyState()
  const { state, added, scanned } = intake(s, {
    bookmarks: [{ url: "https://example.com/a", title: "A", addedAt: "2024-01-01T00:00:00Z", source: "chrome:Default" }],
    scannedSourceIds: ["chrome:Default"],
    now: BASE_NOW,
  })
  assert.equal(added, 1)
  assert.equal(scanned, 1)
  const rec = state.items[idFor("https://example.com/a")]
  assert.equal(rec.state, "inbox")
  assert.equal(rec.addedAt, "2024-01-01T00:00:00Z", "CODEX-REVIEW 2.2: addedAt must actually be persisted, not silently dropped")
  assert.deepEqual(rec.sources, [{ id: "chrome:Default", lastSeenAt: new Date(BASE_NOW).toISOString() }])
  assert.equal(rec.sourceGone, false)
  assert.equal(rec.history[0].by, "system")
})

test("intake: a bookmark's browser folder path is persisted on the new record", () => {
  const s = emptyState()
  const { state } = intake(s, {
    bookmarks: [{ url: "https://example.com/a", title: "A", addedAt: null, source: "chrome:Default", folder: "Work/Reading" }],
    scannedSourceIds: ["chrome:Default"],
    now: BASE_NOW,
  })
  const rec = state.items[idFor("https://example.com/a")]
  assert.equal(rec.folder, "Work/Reading")
})

test("intake: a bookmark with no folder (root-level) persists folder: null, not undefined or omitted", () => {
  const s = emptyState()
  const { state } = intake(s, {
    bookmarks: [{ url: "https://example.com/a", title: "A", addedAt: null, source: "chrome:Default", folder: null }],
    scannedSourceIds: ["chrome:Default"],
    now: BASE_NOW,
  })
  const rec = state.items[idFor("https://example.com/a")]
  assert.equal(rec.folder, null)
})

test("intake: re-scanning with the same folder is a no-op; a moved folder counts as reconciled and updates the record", () => {
  const s = emptyState()
  const bm = { url: "https://example.com/a", title: "A", addedAt: null, source: "chrome:Default", folder: "Work/Reading" }
  const first = intake(s, { bookmarks: [bm], scannedSourceIds: ["chrome:Default"], now: BASE_NOW })
  const unchanged = intake(first.state, { bookmarks: [bm], scannedSourceIds: ["chrome:Default"], now: BASE_NOW + SECOND })
  assert.equal(unchanged.reconciled, 0, "same folder on re-scan must not count as a change")

  const moved = { ...bm, folder: "Archive" }
  const afterMove = intake(unchanged.state, { bookmarks: [moved], scannedSourceIds: ["chrome:Default"], now: BASE_NOW + 2 * SECOND })
  assert.equal(afterMove.reconciled, 1, "the user moving the bookmark to a new folder is a meaningful reconciliation")
  assert.equal(afterMove.state.items[idFor(bm.url)].folder, "Archive")
})

test("intake -> freshenState integration: real addedAt actually drives oldest-first drip (not a hand-built fixture)", () => {
  // This is the exact link CODEX-REVIEW 2.2 found broken: intake() used to accept
  // addedAt and then never store it, so drip's "oldest first" was meaningless on
  // real data even though unit tests with hand-built inbox fixtures looked fine.
  const s = emptyState()
  const scanned = [
    { url: "https://example.com/new", title: "new", addedAt: "2025-06-01T00:00:00Z", source: "chrome:Default" },
    { url: "https://example.com/old", title: "old", addedAt: "2000-01-01T00:00:00Z", source: "chrome:Default" },
  ]
  const afterIntake = intake(s, { bookmarks: scanned, scannedSourceIds: ["chrome:Default"], now: BASE_NOW })
  const config = { ...CONFIG, dripPerDay: 1 }
  const { state } = freshenState(afterIntake.state, BASE_NOW, config)
  const oldId = idFor("https://example.com/old")
  const newId = idFor("https://example.com/new")
  assert.equal(state.items[oldId].state, "pending", "the genuinely older bookmark must win the single daily slot")
  assert.equal(state.items[newId].state, "inbox")
})

test("intake: re-scanning the same unchanged bookmark is a no-op", () => {
  const s = emptyState()
  const bm = { url: "https://example.com/a", title: "A", addedAt: "2024-01-01T00:00:00Z", source: "chrome:Default" }
  const first = intake(s, { bookmarks: [bm], scannedSourceIds: ["chrome:Default"], now: BASE_NOW })
  const second = intake(first.state, { bookmarks: [bm], scannedSourceIds: ["chrome:Default"], now: BASE_NOW + SECOND })
  assert.equal(second.added, 0)
  assert.equal(second.reconciled, 0)
})

test("intake: a URL saved under two sources at once keeps BOTH source entries", () => {
  const s = emptyState()
  const bmChrome = { url: "https://example.com/a", title: "A", addedAt: "2024-01-01T00:00:00Z", source: "chrome:Default" }
  const bmSafari = { url: "https://example.com/a", title: "A", addedAt: "2024-01-01T00:00:00Z", source: "safari" }
  const { state, added } = intake(s, { bookmarks: [bmChrome, bmSafari], scannedSourceIds: ["chrome:Default", "safari"], now: BASE_NOW })
  assert.equal(added, 1, "same URL, one record")
  const rec = state.items[idFor(bmChrome.url)]
  assert.deepEqual(
    rec.sources.map((x) => x.id).sort(),
    ["chrome:Default", "safari"],
  )
})

test("intake: URL missing from every successfully-scanned source it's known from is flagged sourceGone; record kept", () => {
  const s = emptyState()
  const bm = { url: "https://example.com/a", title: "A", addedAt: "2024-01-01T00:00:00Z", source: "chrome:Default" }
  const first = intake(s, { bookmarks: [bm], scannedSourceIds: ["chrome:Default"], now: BASE_NOW })
  const second = intake(first.state, { bookmarks: [], scannedSourceIds: ["chrome:Default"], now: BASE_NOW + SECOND })
  const id = idFor(bm.url)
  assert.equal(second.goneMarked, 1)
  assert.equal(second.state.items[id].sourceGone, true)
  assert.ok(second.state.items[id], "record still exists — never auto-deleted")
})

test("intake: sourceGone is NOT set when the item's source wasn't among the sources scanned this call", () => {
  const s = emptyState()
  const bm = { url: "https://example.com/a", title: "A", addedAt: "2024-01-01T00:00:00Z", source: "safari" }
  const first = intake(s, { bookmarks: [bm], scannedSourceIds: ["safari"], now: BASE_NOW })
  const second = intake(first.state, { bookmarks: [], scannedSourceIds: ["chrome:Default"], now: BASE_NOW + SECOND })
  const id = idFor(bm.url)
  assert.equal(second.state.items[id].sourceGone, false)
  assert.equal(second.goneMarked, 0)
})

test("intake: multi-source item is NOT marked gone unless ALL its known sources were scanned and all missed it (CODEX-REVIEW 2.4)", () => {
  const s = emptyState()
  const bmChrome = { url: "https://example.com/a", title: "A", addedAt: null, source: "chrome:Default" }
  const bmSafari = { url: "https://example.com/a", title: "A", addedAt: null, source: "safari" }
  const withBoth = intake(s, { bookmarks: [bmChrome, bmSafari], scannedSourceIds: ["chrome:Default", "safari"], now: BASE_NOW })
  const id = idFor(bmChrome.url)

  // Only Safari is re-scanned this time and the URL isn't found there — but Chrome
  // (also a known source) wasn't scanned this call, so we can't conclude "gone".
  const partial = intake(withBoth.state, { bookmarks: [], scannedSourceIds: ["safari"], now: BASE_NOW + SECOND })
  assert.equal(partial.state.items[id].sourceGone, false, "chrome wasn't checked this time — not enough evidence")
  assert.equal(partial.goneMarked, 0)

  // Now both are scanned and neither has it -> gone.
  const full = intake(partial.state, { bookmarks: [], scannedSourceIds: ["chrome:Default", "safari"], now: BASE_NOW + 2 * SECOND })
  assert.equal(full.state.items[id].sourceGone, true)
})

test("intake: a source that FAILED to read must never be treated as evidence a URL is gone (CODEX-REVIEW 2.3)", () => {
  // The caller (src/index.js) is responsible for only passing `ok`-status source ids
  // into scannedSourceIds — this test proves intake() honors that contract: a source
  // id that ISN'T in scannedSourceIds (e.g. because it failed and was excluded)
  // must not cause sourceGone even though the URL is absent from this scan.
  const s = emptyState()
  const bm = { url: "https://example.com/a", title: "A", addedAt: null, source: "safari" }
  const seeded = intake(s, { bookmarks: [bm], scannedSourceIds: ["safari"], now: BASE_NOW })
  // Simulate: safari failed to read this time (permission denied) -> excluded from scannedSourceIds.
  const afterFailedScan = intake(seeded.state, { bookmarks: [], scannedSourceIds: [], now: BASE_NOW + SECOND })
  const id = idFor(bm.url)
  assert.equal(afterFailedScan.state.items[id].sourceGone, false)
  assert.equal(afterFailedScan.goneMarked, 0)
})

test("intake: URL reappearing clears sourceGone, adds the new source without dropping the old one", () => {
  const s = emptyState()
  const bmChrome = { url: "https://example.com/a", title: "A", addedAt: "2024-01-01T00:00:00Z", source: "chrome:Default" }
  const first = intake(s, { bookmarks: [bmChrome], scannedSourceIds: ["chrome:Default"], now: BASE_NOW })
  const gone = intake(first.state, { bookmarks: [], scannedSourceIds: ["chrome:Default"], now: BASE_NOW + SECOND })
  const id = idFor(bmChrome.url)
  assert.equal(gone.state.items[id].sourceGone, true)

  const bmSafari = { ...bmChrome, source: "safari" }
  const reappeared = intake(gone.state, { bookmarks: [bmSafari], scannedSourceIds: ["chrome:Default", "safari"], now: BASE_NOW + 2 * SECOND })
  assert.equal(reappeared.state.items[id].sourceGone, false)
  assert.equal(reappeared.added, 0, "same id, must not be recreated")
})

// --- decide ----------------------------------------------------------------

test("decide: keep moves pending -> kept and records history with note and eventId", () => {
  const s = stateWith(item({ id: "x", state: "pending" }))
  const { state, results } = decide(s, { ids: ["x"], action: "keep", actorClaim: "user", note: "great article", now: BASE_NOW + SECOND, config: CONFIG })
  assert.equal(results[0].ok, true)
  assert.equal(state.items.x.state, "kept")
  assert.equal(state.items.x.note, "great article")
  const last = state.items.x.history.at(-1)
  assert.equal(last.state, "kept")
  assert.equal(last.by, "user")
  assert.equal(last.note, "great article")
  assert.match(last.eventId, /^x#\d+$/)
})

test("decide: from pending, keep/watch/drop are all allowed", () => {
  const s = stateWith(item({ id: "x", state: "pending" }))
  const watched = decide(s, { ids: ["x"], action: "watch", actorClaim: "user", now: BASE_NOW, config: CONFIG })
  assert.equal(watched.state.items.x.state, "watching")
})

test("decide: from watching, ONLY keep is allowed — matches §7.3's literal diagram (CODEX-REVIEW §7 item 1)", () => {
  const s = stateWith(item({ id: "x", state: "watching" }))
  const dropAttempt = decide(s, { ids: ["x"], action: "drop", actorClaim: "user", now: BASE_NOW, config: CONFIG })
  assert.equal(dropAttempt.results[0].ok, false)
  assert.equal(dropAttempt.results[0].reason, "action-not-allowed-from-state")
  assert.equal(dropAttempt.state.items.x.state, "watching", "rejected — state unchanged")

  const watchAgainAttempt = decide(s, { ids: ["x"], action: "watch", actorClaim: "user", now: BASE_NOW, config: CONFIG })
  assert.equal(watchAgainAttempt.results[0].ok, false)

  const keepAttempt = decide(s, { ids: ["x"], action: "keep", actorClaim: "user", now: BASE_NOW, config: CONFIG })
  assert.equal(keepAttempt.results[0].ok, true)
  assert.equal(keepAttempt.state.items.x.state, "kept")
})

test("decide: rejects items not in pending/watching (not-decidable) and unknown ids (not-found)", () => {
  const s = stateWith(item({ id: "x", state: "kept" }))
  const { results } = decide(s, { ids: ["x", "ghost"], action: "keep", actorClaim: "user", now: BASE_NOW, config: CONFIG })
  assert.deepEqual(results[0], { id: "x", ok: false, reason: "not-decidable", currentState: "kept" })
  assert.deepEqual(results[1], { id: "ghost", ok: false, reason: "not-found" })
})

test("decide: actorClaim 'ai' without autoDecide is rejected wholesale, state untouched (same object reference)", () => {
  const s = stateWith(item({ id: "x", state: "pending" }))
  const { state, results } = decide(s, { ids: ["x"], action: "keep", actorClaim: "ai", now: BASE_NOW, config: { ...CONFIG, autoDecide: false } })
  assert.equal(results[0].ok, false)
  assert.equal(results[0].reason, "ai-not-authorized")
  assert.equal(state, s, "same reference — proves no copy/mutation occurred")
})

test("decide: omitted actorClaim is not rejected (only an explicit 'ai' claim is gated) — caller (index.js) maps omission to 'mcp-client'", () => {
  const s = stateWith(item({ id: "x", state: "pending" }))
  const { results } = decide(s, { ids: ["x"], action: "keep", actorClaim: undefined, now: BASE_NOW, config: { ...CONFIG, autoDecide: false } })
  assert.equal(results[0].ok, true, "authorize() only gates the literal string 'ai' — undefined passes through")
})

test("decide: actorClaim 'ai' with autoDecide:true is allowed and recorded as 'ai'", () => {
  const s = stateWith(item({ id: "x", state: "pending" }))
  const { state, results } = decide(s, { ids: ["x"], action: "keep", actorClaim: "ai", now: BASE_NOW, config: { ...CONFIG, autoDecide: true } })
  assert.equal(results[0].ok, true)
  assert.equal(state.items.x.history.at(-1).by, "ai")
})

test("decide: batch call applies per-id results independently, capped ids are the caller's (index.js zod schema) responsibility", () => {
  const s = stateWith(item({ id: "a", state: "pending" }), item({ id: "b", state: "kept" }))
  const { state, results } = decide(s, { ids: ["a", "b"], action: "keep", actorClaim: "user", now: BASE_NOW, config: CONFIG })
  assert.equal(results.find((r) => r.id === "a").ok, true)
  assert.equal(results.find((r) => r.id === "b").ok, false)
  assert.equal(state.items.a.state, "kept")
})

// --- restore -----------------------------------------------------------

test("restore: lapsed -> pending resets the clock and records history", () => {
  const oldEnteredAt = new Date(BASE_NOW - 999 * DAY_MS).toISOString()
  const s = stateWith(item({ id: "x", state: "lapsed", enteredStateAt: oldEnteredAt }))
  const { state, results } = restore(s, { ids: ["x"], actorClaim: "user", now: BASE_NOW, config: CONFIG })
  assert.equal(results[0].ok, true)
  assert.equal(state.items.x.state, "pending")
  assert.equal(state.items.x.enteredStateAt, new Date(BASE_NOW).toISOString())
  assert.equal(state.items.x.history.at(-1).by, "user")
})

test("restore: rejects items that aren't lapsed", () => {
  const s = stateWith(item({ id: "x", state: "pending" }))
  const { results } = restore(s, { ids: ["x"], actorClaim: "user", now: BASE_NOW, config: CONFIG })
  assert.deepEqual(results[0], { id: "x", ok: false, reason: "not-lapsed", currentState: "pending" })
})

test("restore: actorClaim 'ai' without autoDecide is rejected", () => {
  const s = stateWith(item({ id: "x", state: "lapsed" }))
  const { results } = restore(s, { ids: ["x"], actorClaim: "ai", now: BASE_NOW, config: { ...CONFIG, autoDecide: false } })
  assert.equal(results[0].reason, "ai-not-authorized")
})

// --- undo ----------------------------------------------------------------

test("undo: reverts a kept item back to pending (CODEX-REVIEW: undo must cover kept, not just lapsed)", () => {
  const s = stateWith(item({ id: "x", state: "pending" }))
  const kept = decide(s, { ids: ["x"], action: "keep", actorClaim: "user", now: BASE_NOW, config: CONFIG })
  const eventId = kept.state.items.x.history.at(-1).eventId
  const undone = undo(kept.state, { eventIds: [eventId], actorClaim: "user", now: BASE_NOW + SECOND, config: CONFIG })
  assert.equal(undone.results[0].ok, true)
  assert.equal(undone.results[0].from, "kept")
  assert.equal(undone.results[0].to, "pending")
  assert.equal(undone.state.items.x.state, "pending")
  assert.equal(undone.state.items.x.history.length, 3, "undo appends, it does not erase — full trail including the undo itself is kept")
})

test("undo: reverts a watching item back to pending, too", () => {
  const s = stateWith(item({ id: "x", state: "pending" }))
  const watched = decide(s, { ids: ["x"], action: "watch", actorClaim: "user", now: BASE_NOW, config: CONFIG })
  const eventId = watched.state.items.x.history.at(-1).eventId
  const undone = undo(watched.state, { eventIds: [eventId], actorClaim: "user", now: BASE_NOW + SECOND, config: CONFIG })
  assert.equal(undone.state.items.x.state, "pending")
})

test("undo: only the CURRENT latest event of an item can be undone", () => {
  const s = stateWith(item({ id: "x", state: "pending" }))
  const kept = decide(s, { ids: ["x"], action: "keep", actorClaim: "user", now: BASE_NOW, config: CONFIG })
  const staleEventId = kept.state.items.x.history[0].eventId // the original "pending" entry, not the latest "kept" one
  const { results } = undo(kept.state, { eventIds: [staleEventId], actorClaim: "user", now: BASE_NOW + SECOND, config: CONFIG })
  assert.equal(results[0].ok, false)
  assert.equal(results[0].reason, "not-latest-event")
  assert.ok(results[0].latestEventId, "tells the caller what the actual latest event id is")
})

test("undo: the very first history event (nothing before it) cannot be undone", () => {
  const s = stateWith(item({ id: "x", state: "inbox", history: [{ eventId: "x#0", state: "inbox", at: new Date(BASE_NOW).toISOString(), by: "system" }] }))
  const eventId = s.items.x.history[0].eventId
  const { results } = undo(s, { eventIds: [eventId], actorClaim: "user", now: BASE_NOW, config: CONFIG })
  assert.equal(results[0].ok, false)
  assert.equal(results[0].reason, "nothing-to-undo")
})

test("undo: preview:true reports what would happen without changing anything", () => {
  const s = stateWith(item({ id: "x", state: "pending" }))
  const kept = decide(s, { ids: ["x"], action: "keep", actorClaim: "user", now: BASE_NOW, config: CONFIG })
  const eventId = kept.state.items.x.history.at(-1).eventId
  const preview = undo(kept.state, { eventIds: [eventId], preview: true, actorClaim: "user", now: BASE_NOW + SECOND, config: CONFIG })
  assert.equal(preview.results[0].ok, true)
  assert.equal(preview.results[0].preview, true)
  assert.equal(preview.results[0].to, "pending")
  assert.equal(preview.state.items.x.state, "kept", "preview must not mutate anything")
  assert.equal(preview.state.items.x.history.length, 2, "no new history entry from a preview")
})

test("undo: filter by source batch-undoes every matching item's latest event", () => {
  const at = new Date(BASE_NOW).toISOString()
  const a = item({ id: "a", state: "pending", sources: [{ id: "chrome:Default", lastSeenAt: at }] })
  const b = item({ id: "b", state: "pending", sources: [{ id: "safari", lastSeenAt: at }] })
  let s = stateWith(a, b)
  s = decide(s, { ids: ["a", "b"], action: "keep", actorClaim: "user", now: BASE_NOW, config: CONFIG }).state
  const { state, results } = undo(s, { filter: { sourceId: "chrome:Default" }, actorClaim: "user", now: BASE_NOW + SECOND, config: CONFIG })
  assert.equal(results.length, 1, "only the chrome-sourced item matches the filter")
  assert.equal(state.items.a.state, "pending")
  assert.equal(state.items.b.state, "kept", "untouched — different source")
})

test("undo: filter by time range only matches events within [sinceMs, untilMs]", () => {
  const s = stateWith(item({ id: "x", state: "pending" }))
  const kept = decide(s, { ids: ["x"], action: "keep", actorClaim: "user", now: BASE_NOW, config: CONFIG })
  const tooEarly = undo(kept.state, { filter: { sinceMs: BASE_NOW + 10_000 }, actorClaim: "user", now: BASE_NOW + SECOND, config: CONFIG })
  assert.equal(tooEarly.results.length, 0)
  const inRange = undo(kept.state, { filter: { sinceMs: BASE_NOW - 1000, untilMs: BASE_NOW + 1000 }, actorClaim: "user", now: BASE_NOW + SECOND, config: CONFIG })
  assert.equal(inRange.results.length, 1)
})

test("undo: actorClaim 'ai' without autoDecide is rejected", () => {
  const s = stateWith(item({ id: "x", state: "pending" }))
  const kept = decide(s, { ids: ["x"], action: "keep", actorClaim: "user", now: BASE_NOW, config: CONFIG })
  const eventId = kept.state.items.x.history.at(-1).eventId
  const { results } = undo(kept.state, { eventIds: [eventId], actorClaim: "ai", now: BASE_NOW + SECOND, config: { ...CONFIG, autoDecide: false } })
  assert.equal(results[0].reason, "ai-not-authorized")
})

test("undo: unknown/malformed event id resolves to not-found rather than throwing", () => {
  const s = stateWith(item({ id: "x", state: "pending" }))
  const { results } = undo(s, { eventIds: ["totally-made-up"], actorClaim: "user", now: BASE_NOW, config: CONFIG })
  assert.equal(results[0].ok, false)
  assert.equal(results[0].reason, "not-found")
})

// --- today / listLayer -----------------------------------------------------

test("today: only pending items, oldest first, with clamped remainingMs", () => {
  const s = stateWith(
    item({ id: "newer", state: "pending", enteredStateAt: new Date(BASE_NOW - 2 * SECOND).toISOString() }),
    item({ id: "older", state: "pending", enteredStateAt: new Date(BASE_NOW - 8 * SECOND).toISOString() }),
    item({ id: "kept", state: "kept" }),
  )
  const items = today(s, BASE_NOW, CONFIG)
  assert.deepEqual(items.map((i) => i.id), ["older", "newer"])
  assert.equal(items[0].remainingMs, CONFIG.pendingMs - 8 * SECOND)
  assert.ok(items.every((i) => i.remainingMs >= 0))
})

test("listLayer: lapsed layer has no remainingMs (unbounded)", () => {
  const s = stateWith(item({ id: "x", state: "lapsed" }))
  const { items } = listLayer(s, "lapsed", BASE_NOW, CONFIG)
  assert.equal(items[0].remainingMs, undefined)
})

test("listLayer: paginated — default-sized page, `total` reflects the whole layer", () => {
  const s = emptyState()
  for (let i = 0; i < 5; i++) s.items[`x${i}`] = item({ id: `x${i}`, state: "kept", enteredStateAt: new Date(BASE_NOW + i).toISOString() })
  const page1 = listLayer(s, "kept", BASE_NOW, CONFIG, { limit: 2, offset: 0 })
  assert.equal(page1.total, 5)
  assert.equal(page1.items.length, 2)
  assert.deepEqual(page1.items.map((i) => i.id), ["x0", "x1"])
  const page2 = listLayer(s, "kept", BASE_NOW, CONFIG, { limit: 2, offset: 2 })
  assert.deepEqual(page2.items.map((i) => i.id), ["x2", "x3"])
})

// --- stats -------------------------------------------------------------

test("stats: counts per layer and decidedToday excludes expiry/restore/undo, includes only decide outcomes today", () => {
  const today0 = new Date(BASE_NOW).toISOString()
  const s = emptyState()
  s.items.a = item({ id: "a", state: "kept", history: [{ eventId: "a#0", state: "pending", at: today0, by: "system" }, { eventId: "a#1", state: "kept", at: today0, by: "user" }] })
  s.items.b = item({ id: "b", state: "lapsed", history: [{ eventId: "b#0", state: "pending", at: today0, by: "system" }, { eventId: "b#1", state: "lapsed", at: today0, by: "expiry" }] })
  s.items.c = item({ id: "c", state: "pending", history: [{ eventId: "c#0", state: "pending", at: today0, by: "system" }] })
  s.items.d = item({
    id: "d",
    state: "pending",
    history: [
      { eventId: "d#0", state: "lapsed", at: new Date(BASE_NOW - 5 * DAY_MS).toISOString(), by: "expiry" },
      { eventId: "d#1", state: "pending", at: today0, by: "user" }, // a restore — must NOT count as a decision
    ],
  })
  s.items.e = item({
    id: "e",
    state: "kept",
    history: [{ eventId: "e#0", state: "kept", at: new Date(BASE_NOW - 5 * DAY_MS).toISOString(), by: "user" }], // decided, but not today
  })
  const { counts, decidedToday } = stats(s, BASE_NOW)
  assert.equal(counts.kept, 2)
  assert.equal(counts.lapsed, 1)
  assert.equal(counts.pending, 2)
  assert.equal(decidedToday, 1, "only item a's keep counts — expiry, restore, and yesterday's decision are excluded")
})

// --- time zone (documents the intentional behavior, README "Time zone") --

test("stats: decidedToday uses the LOCAL calendar day of the machine running the server — intentional, not a bug", () => {
  const originalTz = process.env.TZ
  try {
    // Two absolute instants 8 hours apart, straddling UTC midnight: in UTC they fall
    // on different calendar days; in a timezone 8 hours behind UTC (e.g. Los Angeles
    // in winter), the exact same pair of instants falls on the SAME local day. This
    // is the case README's "Time zone" section documents: this server only ever runs
    // on the user's own machine, so "today" is deliberately defined by that machine's
    // clock, not a fixed zone.
    const decidedAt = "2026-01-01T20:00:00.000Z"
    const now = Date.parse("2026-01-02T04:00:00.000Z") // 8 hours later
    const s = {
      version: 2,
      items: { x: { id: "x", url: "https://a.com", title: "A", sources: [], addedAt: null, state: "kept", enteredStateAt: decidedAt, history: [{ eventId: "x#0", state: "kept", at: decidedAt, by: "user" }], note: null, sourceGone: false } },
      lastDripAt: null,
      revision: 0,
    }

    process.env.TZ = "UTC"
    const utcResult = stats(s, now)

    process.env.TZ = "America/Los_Angeles" // UTC-8 in winter
    const laResult = stats(s, now)

    assert.equal(utcResult.decidedToday, 0, "in UTC, the decision (Jan 1) and `now` (Jan 2) are different calendar days")
    assert.equal(laResult.decidedToday, 1, "the identical pair of instants falls on the same LA calendar day")
  } finally {
    if (originalTz === undefined) delete process.env.TZ
    else process.env.TZ = originalTz
  }
})

test("freshenState: pendingMs/watchingMs are strict elapsed-duration windows, unaffected by DST wall-clock shifts", () => {
  // US DST 2026 spring-forward: 2026-03-08 02:00 local becomes 03:00 local (a wall-clock
  // day that's only 23 hours). freshenState never reads wall-clock/local time for the
  // expiry math — it's pure `now - enteredStateAt` in epoch ms — so this is unaffected
  // by DST by construction. This test pins that down so a future change can't
  // accidentally introduce a wall-clock dependency here.
  const enteredAt = Date.parse("2026-03-07T10:00:00-08:00") // before the spring-forward
  const twentyFourHoursLaterUtc = enteredAt + 24 * 60 * 60 * 1000
  const s = stateWith(item({ id: "x", state: "pending", enteredStateAt: new Date(enteredAt).toISOString() }))
  const { state } = freshenState(s, twentyFourHoursLaterUtc, CONFIG)
  // CONFIG.pendingMs here is 10s (test config), so 24 real hours later is unambiguously lapsed —
  // the point isn't the specific outcome, it's that epoch-ms math is what decided it, not local dates.
  assert.equal(state.items.x.state, "lapsed")
})
