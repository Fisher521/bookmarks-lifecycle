// The state machine, kept pure and side-effect-free (no clock reads, no
// file I/O) so every rule is unit-testable with an injected `now`. See
// growth/M7W5/DISCUSSION-2026-08-02-local-first-intake.md §7 for the spec
// this implements, and CODEX-REVIEW.md / FIX-REPORT.md for the defects
// found in the first pass and how each was addressed here.

import { createHash } from "node:crypto"

const DAY_MS = 24 * 60 * 60 * 1000
const FAR_PAST_OFFSET_MS = 100 * 365 * DAY_MS

/** Deterministic id: same URL always maps to the same record, across sources. */
export function idFor(url) {
  return createHash("sha256").update(url).digest("hex").slice(0, 16)
}

function iso(now) {
  return new Date(now).toISOString()
}

// `by` here is an attribution CLAIM carried into history, not a verified
// identity (§7.7, rewritten 2026-08-04 — see README's "Honesty about
// authorization" section for why this can't be enforced server-side).
function transitionTo(item, newState, now, by, note) {
  const at = iso(now)
  const eventId = `${item.id}#${item.history.length}`
  const entry = { eventId, state: newState, at, by }
  if (note) entry.note = note
  return {
    ...item,
    state: newState,
    enteredStateAt: at,
    history: [...item.history, entry],
    ...(note !== undefined ? { note } : {}),
  }
}

/**
 * Sort key for "oldest first": real `addedAt` wins when known. When it
 * isn't (source didn't provide one), fall back to when *we* first saw the
 * item — offset far into the past so undated items still sort ahead of any
 * dated one, without fabricating a fake save date (CODEX-REVIEW 2.2/§4).
 */
function ageKey(item) {
  if (item.addedAt) return Date.parse(item.addedAt)
  const discoveredAt = item.history[0]?.at ?? item.enteredStateAt
  return Date.parse(discoveredAt) - FAR_PAST_OFFSET_MS
}

function pickOldest(items, ids, n) {
  if (n <= 0) return []
  return [...ids]
    .sort((a, b) => {
      const diff = ageKey(items[a]) - ageKey(items[b])
      return diff !== 0 ? diff : a.localeCompare(b) // deterministic tiebreak
    })
    .slice(0, n)
}

/**
 * Run the two time-driven rules that make this tool need no background
 * process (§7.5): expire anything past its layer duration, and refill
 * `pending` from `inbox` at the configured daily drip rate. Both are
 * computed from absolute timestamps at call time, not a running timer.
 *
 * Expiry boundary is strict `>` per §7.5's literal text (CODEX-REVIEW 2.11
 * caught this implementation using `>=`).
 *
 * Drip does NOT accumulate across a long absence (CODEX-REVIEW 2.5: 100
 * days away used to mean a 1,500-item dump on return). Each call promotes
 * at most one day's quota, full stop — if at least a day has passed since
 * the last drip, dripPerDay oldest inbox items move to pending and the
 * anchor resets to now. A user who wants to "catch up" faster has to call
 * again after another day passes, or raise BOOKMARKS_LIFECYCLE_DRIP_PER_DAY.
 *
 * @param {object} state
 * @param {number} now epoch ms
 * @param {{pendingMs:number, watchingMs:number, dripPerDay:number}} config
 * @returns {{state: object, transitions: Array}}
 */
export function freshenState(state, now, config) {
  const items = { ...state.items }
  const transitions = []

  for (const id of Object.keys(items)) {
    const item = items[id]
    if (item.state === "pending" && now - Date.parse(item.enteredStateAt) > config.pendingMs) {
      items[id] = transitionTo(item, "lapsed", now, "expiry")
      transitions.push({ id, from: "pending", to: "lapsed", by: "expiry" })
    } else if (item.state === "watching" && now - Date.parse(item.enteredStateAt) > config.watchingMs) {
      items[id] = transitionTo(item, "lapsed", now, "expiry")
      transitions.push({ id, from: "watching", to: "lapsed", by: "expiry" })
    }
  }

  let lastDripAt = state.lastDripAt
  const inboxIds = Object.keys(items).filter((id) => items[id].state === "inbox")
  if (inboxIds.length > 0) {
    const dueForDrip = lastDripAt === null || now - Date.parse(lastDripAt) >= DAY_MS
    if (dueForDrip) {
      const promoted = pickOldest(items, inboxIds, config.dripPerDay)
      for (const id of promoted) {
        items[id] = transitionTo(items[id], "pending", now, "drip")
        transitions.push({ id, from: "inbox", to: "pending", by: "drip" })
      }
      lastDripAt = iso(now)
    }
  }

  return { state: { ...state, items, lastDripAt }, transitions }
}

/**
 * Merge a fresh scan of the browser sources into state: new URLs land in
 * `inbox` with their real `addedAt` persisted (CODEX-REVIEW 2.2 — the first
 * version accepted `bm.addedAt` and then silently dropped it, which made
 * "oldest first" meaningless in practice). Existing URLs get their
 * `sources`/`title`/`addedAt` reconciled without touching sources this call
 * didn't look at.
 *
 * `sourceGone` is a derived, conservative flag (CODEX-REVIEW 2.3/2.4): it
 * only flips to true when EVERY source this item is known from was
 * actually scanned this call (i.e. status `ok`, not `failed`) and the URL
 * turned up under none of them. A source that failed to read, or wasn't
 * included in a filtered scan, never counts as evidence of absence.
 *
 * @param {object} state
 * @param {{bookmarks: Array<{url:string,title:string,addedAt:string|null,source:string,folder:string|null}>, scannedSourceIds: string[], now: number}} args
 */
export function intake(state, { bookmarks, scannedSourceIds, now }) {
  const items = { ...state.items }
  const seenThisScan = new Set()
  let added = 0
  let reconciled = 0
  const nowIso = iso(now)

  const byId = new Map()
  for (const bm of bookmarks) {
    const id = idFor(bm.url)
    if (!byId.has(id)) byId.set(id, [])
    byId.get(id).push(bm)
  }

  for (const [id, matches] of byId) {
    seenThisScan.add(id)
    const newSources = matches.map((bm) => ({ id: bm.source, lastSeenAt: nowIso }))
    const scannedAddedAt = matches.map((bm) => bm.addedAt).filter(Boolean).sort()[0] ?? null
    const title = matches[0].title
    const folder = matches[0].folder ?? null
    const existing = items[id]
    if (!existing) {
      items[id] = {
        id,
        url: matches[0].url,
        title,
        folder,
        sources: newSources,
        addedAt: scannedAddedAt,
        state: "inbox",
        enteredStateAt: nowIso,
        history: [{ eventId: `${id}#0`, state: "inbox", at: nowIso, by: "system" }],
        note: null,
        sourceGone: false,
      }
      added += 1
      continue
    }
    const untouchedSources = existing.sources.filter((s) => !newSources.some((n) => n.id === s.id))
    const mergedSources = [...untouchedSources, ...newSources]
    // A source's lastSeenAt legitimately changes on every scan just by time passing —
    // that alone isn't a "reconciliation" worth reporting. Only count it when the set
    // of known source ids, the title, sourceGone, or a previously-unknown addedAt
    // actually changed, so "re-scanning something unchanged" honestly reports 0.
    const existingSourceIds = new Set(existing.sources.map((s) => s.id))
    const newSourceIdSet = new Set(newSources.map((s) => s.id))
    const sourceSetChanged = mergedSources.length !== existing.sources.length || [...newSourceIdSet].some((sid) => !existingSourceIds.has(sid))
    const titleChanged = existing.title !== title
    const folderChanged = existing.folder !== folder
    const addedAtFillable = !existing.addedAt && scannedAddedAt
    const meaningfulChange = existing.sourceGone || sourceSetChanged || titleChanged || folderChanged || addedAtFillable
    // lastSeenAt is refreshed regardless — it's informational metadata, not a
    // decision input — but only a meaningful change increments `reconciled`.
    items[id] = {
      ...existing,
      title,
      folder,
      sources: mergedSources,
      addedAt: existing.addedAt ?? scannedAddedAt,
      sourceGone: false,
    }
    if (meaningfulChange) reconciled += 1
  }

  let goneMarked = 0
  for (const [id, item] of Object.entries(items)) {
    if (seenThisScan.has(id) || item.sourceGone || item.sources.length === 0) continue
    const allKnownSourcesScanned = item.sources.every((s) => scannedSourceIds.includes(s.id))
    if (!allKnownSourcesScanned) continue
    items[id] = { ...item, sourceGone: true }
    goneMarked += 1
  }

  return { state: { ...state, items }, added, reconciled, goneMarked, scanned: bookmarks.length }
}

// `authorize` is a soft default, not a security boundary (§7.7 rewrite):
// server code cannot verify that an `actorClaim: "ai"` call actually had a
// human confirm it — any caller can simply omit the claim or say "user".
// What it actually gates is only the caller's own SELF-DECLARATION of being
// an unattended AI; real safety comes from every mutation being undoable
// (see `undo` below), not from this check.
function authorize(actorClaim, config) {
  return actorClaim !== "ai" || config.autoDecide
}

const ALLOWED_ACTIONS_FROM_STATE = {
  pending: ["keep", "watch", "drop"],
  watching: ["keep"], // §7.3's diagram only defines watching -> kept via user decision
}

/**
 * Apply a judgment to one or more items. `actorClaim` is recorded in
 * history as given (or "mcp-client" if the caller didn't supply the
 * mapped-in default — see src/index.js) — it is attribution, not proof.
 */
export function decide(state, { ids, action, actorClaim, note, now, config }) {
  const targetState = { keep: "kept", watch: "watching", drop: "lapsed" }[action]
  if (!targetState) throw new Error(`unknown decide action: ${action}`)
  if (!authorize(actorClaim, config)) {
    return { state, results: ids.map((id) => ({ id, ok: false, reason: "ai-not-authorized" })) }
  }
  const items = { ...state.items }
  const results = []
  for (const id of ids) {
    const item = items[id]
    if (!item) {
      results.push({ id, ok: false, reason: "not-found" })
      continue
    }
    const allowed = ALLOWED_ACTIONS_FROM_STATE[item.state]
    if (!allowed) {
      results.push({ id, ok: false, reason: "not-decidable", currentState: item.state })
      continue
    }
    if (!allowed.includes(action)) {
      results.push({ id, ok: false, reason: "action-not-allowed-from-state", currentState: item.state, action })
      continue
    }
    items[id] = transitionTo(item, targetState, now, actorClaim, note)
    results.push({ id, ok: true, from: item.state, to: targetState })
  }
  return { state: { ...state, items }, results }
}

/** Bring a `lapsed` item back to `pending`, resetting its clock. */
export function restore(state, { ids, actorClaim, now, config }) {
  if (!authorize(actorClaim, config)) {
    return { state, results: ids.map((id) => ({ id, ok: false, reason: "ai-not-authorized" })) }
  }
  const items = { ...state.items }
  const results = []
  for (const id of ids) {
    const item = items[id]
    if (!item) {
      results.push({ id, ok: false, reason: "not-found" })
      continue
    }
    if (item.state !== "lapsed") {
      results.push({ id, ok: false, reason: "not-lapsed", currentState: item.state })
      continue
    }
    items[id] = transitionTo(item, "pending", now, actorClaim)
    results.push({ id, ok: true })
  }
  return { state: { ...state, items }, results }
}

function latestEvent(item) {
  return item.history.length > 0 ? item.history[item.history.length - 1] : null
}

function parseEventId(eventId) {
  const sep = eventId.lastIndexOf("#")
  if (sep === -1) return null
  return { itemId: eventId.slice(0, sep) }
}

function resolveUndoTargets(state, { eventIds, filter }) {
  if (eventIds && eventIds.length > 0) {
    return eventIds.map((eventId) => ({ itemId: parseEventId(eventId)?.itemId ?? null, eventId }))
  }
  if (filter) {
    const targets = []
    for (const item of Object.values(state.items)) {
      const latest = latestEvent(item)
      if (!latest) continue
      if (filter.sourceId && !item.sources.some((s) => s.id === filter.sourceId)) continue
      const atMs = Date.parse(latest.at)
      if (filter.sinceMs !== undefined && atMs < filter.sinceMs) continue
      if (filter.untilMs !== undefined && atMs > filter.untilMs) continue
      if (filter.by !== undefined && latest.by !== filter.by) continue
      targets.push({ itemId: item.id, eventId: latest.eventId })
    }
    return targets
  }
  return []
}

/**
 * Revert an item to the state it was in immediately before one of its own
 * history events — the concrete implementation of §7.7's "safety is built
 * on reversibility": this is what makes it honest to say kept/watching are
 * recoverable too, not just lapsed->pending via `restore`.
 *
 * Only an item's CURRENT latest event can be undone (undoing a mid-history
 * event would require a full replay engine this tool doesn't have — scope
 * decision, see FIX-REPORT.md). Undoing is itself just another transition:
 * it appends a new history entry rather than erasing the old one, so the
 * full audit trail — including undos — is never lost.
 *
 * Selection is either explicit `eventIds`, or a `filter` (source / time
 * range / by) applied to every item's latest event, for batch undo.
 * `preview: true` reports what would happen without changing anything.
 */
export function undo(state, { eventIds, filter, actorClaim, note, preview = false, now, config }) {
  if (!authorize(actorClaim, config)) {
    return { state, preview, results: [{ ok: false, reason: "ai-not-authorized" }] }
  }
  const targets = resolveUndoTargets(state, { eventIds, filter })
  const items = { ...state.items }
  const results = []
  for (const { itemId, eventId } of targets) {
    const item = itemId ? items[itemId] : null
    if (!item) {
      results.push({ eventId, itemId, ok: false, reason: "not-found" })
      continue
    }
    const latest = latestEvent(item)
    if (!latest || latest.eventId !== eventId) {
      results.push({ eventId, itemId, ok: false, reason: "not-latest-event", latestEventId: latest?.eventId ?? null })
      continue
    }
    if (item.history.length < 2) {
      results.push({ eventId, itemId, ok: false, reason: "nothing-to-undo" })
      continue
    }
    const previousState = item.history[item.history.length - 2].state
    if (preview) {
      results.push({ eventId, itemId, ok: true, preview: true, from: item.state, to: previousState })
      continue
    }
    const undone = transitionTo(item, previousState, now, actorClaim, note ?? `undo of ${eventId}`)
    items[itemId] = undone
    results.push({ eventId, itemId, ok: true, from: item.state, to: previousState, newEventId: latestEvent(undone).eventId })
  }
  return { state: preview ? state : { ...state, items }, preview, results }
}

function withRemaining(item, now, durationMs) {
  if (!durationMs) return { ...item }
  return { ...item, remainingMs: Math.max(0, durationMs - (now - Date.parse(item.enteredStateAt))) }
}

/** The `pending` layer, oldest-first — the day's actual to-do list. */
export function today(state, now, config) {
  const items = Object.values(state.items)
    .filter((i) => i.state === "pending")
    .sort((a, b) => Date.parse(a.enteredStateAt) - Date.parse(b.enteredStateAt))
    .map((i) => withRemaining(i, now, config.pendingMs))
  return items
}

/**
 * Any single layer, including `lapsed` ("what did I let go of"). Paginated
 * (CODEX-REVIEW 3.1: an unpaginated 50k-item layer serialized to 12.22MiB —
 * enough to blow out a model's context on its own).
 */
export function listLayer(state, layer, now, config, { limit = 50, offset = 0 } = {}) {
  const durationFor = { pending: config.pendingMs, watching: config.watchingMs }
  const all = Object.values(state.items)
    .filter((i) => i.state === layer)
    .sort((a, b) => Date.parse(a.enteredStateAt) - Date.parse(b.enteredStateAt))
  const page = all.slice(offset, offset + limit).map((i) => withRemaining(i, now, durationFor[layer]))
  return { total: all.length, items: page }
}

/** Counts per layer + how many decide-outcomes landed today (excludes expiry/restore/undo). */
export function stats(state, now) {
  const counts = { inbox: 0, pending: 0, watching: 0, kept: 0, lapsed: 0 }
  const todayKey = new Date(now).toDateString() // local calendar day — see README's "Time zone" note
  let decidedToday = 0
  for (const item of Object.values(state.items)) {
    counts[item.state] += 1
    for (const h of item.history) {
      const isDecision = (h.by === "user" || h.by === "ai") && (h.state === "kept" || h.state === "watching" || h.state === "lapsed")
      if (isDecision && new Date(Date.parse(h.at)).toDateString() === todayKey) decidedToday += 1
    }
  }
  return { counts, decidedToday }
}
