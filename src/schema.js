// State file schema: validation and version migration, kept separate from
// store.js's I/O so both can be unit-tested with plain objects.
//
// Hard rule (CODEX-REVIEW 1.3): a file whose `version` is HIGHER than
// CURRENT_VERSION is never touched — we throw before returning anything,
// so the caller never reaches a save(). A missing `version` is treated as
// the oldest known shape (v0) and migrated forward. Every migration step
// is a pure function with its own fixture tests (test/schema.test.mjs).

export const CURRENT_VERSION = 3

export const KNOWN_STATES = ["inbox", "pending", "watching", "kept", "lapsed"]

// `user`/`ai` are attribution *claims*, not verified identity (§7.7, rewritten
// 2026-08-04). `mcp-client` is what an omitted actorClaim gets recorded as.
export const KNOWN_BY_VALUES = ["user", "ai", "mcp-client", "drip", "expiry", "system"]

export class SchemaError extends Error {
  constructor(message) {
    super(message)
    this.name = "SchemaError"
  }
}

export class FutureVersionError extends Error {
  constructor(foundVersion) {
    super(
      `bookmarks-lifecycle: state file version ${foundVersion} is newer than this version of the tool ` +
        `understands (max ${CURRENT_VERSION}). Not touching the file. Update the tool, or use a version ` +
        `of it that understands this file.`,
    )
    this.name = "FutureVersionError"
    this.foundVersion = foundVersion
  }
}

export function emptyState() {
  return { version: CURRENT_VERSION, items: {}, lastDripAt: null, revision: 0 }
}

function assert(condition, message) {
  if (!condition) throw new SchemaError(`bookmarks-lifecycle: invalid state — ${message}`)
}

function isValidDateString(s) {
  return typeof s === "string" && !Number.isNaN(Date.parse(s))
}

/** v0 = no `version` field at all. Normalize to the v1 shape (pre-sources, pre-revision). */
function migrateV0toV1(parsed) {
  assert(parsed && typeof parsed === "object" && !Array.isArray(parsed), "root is not an object")
  return { version: 1, items: parsed.items && typeof parsed.items === "object" ? parsed.items : {}, lastDripAt: parsed.lastDripAt ?? null }
}

/**
 * v1 (this package's original shape: `item.source` string, no `addedAt`
 * persisted, no `revision`) -> v2 (`item.sources: [{id, lastSeenAt}]`,
 * `addedAt`, top-level `revision`).
 */
function migrateV1toV2(v1) {
  const items = {}
  for (const [id, raw] of Object.entries(v1.items ?? {})) {
    const sources = Array.isArray(raw.sources)
      ? raw.sources
      : raw.source
        ? [{ id: raw.source, lastSeenAt: raw.enteredStateAt ?? null }]
        : []
    items[id] = {
      id: raw.id ?? id,
      url: raw.url,
      title: raw.title,
      sources,
      addedAt: raw.addedAt ?? null,
      state: raw.state,
      enteredStateAt: raw.enteredStateAt,
      history: Array.isArray(raw.history) ? raw.history : [],
      note: raw.note ?? null,
      sourceGone: raw.sourceGone ?? false,
    }
  }
  return { version: 2, items, lastDripAt: v1.lastDripAt ?? null, revision: v1.revision ?? 0 }
}

/**
 * v2 -> v3: adds `item.folder` (the browser folder path this bookmark lives
 * in, e.g. "Work/Reading" — see bookmarks-mcp's chromium.js). v2 records
 * never had it; migration backfills `null` rather than guessing, matching
 * migrateV1toV2's precedent of never fabricating a value it doesn't have.
 */
function migrateV2toV3(v2) {
  const items = {}
  for (const [id, raw] of Object.entries(v2.items ?? {})) {
    items[id] = { ...raw, folder: raw.folder ?? null }
  }
  return { version: 3, items, lastDripAt: v2.lastDripAt ?? null, revision: v2.revision ?? 0 }
}

const MIGRATIONS = { 1: migrateV1toV2, 2: migrateV2toV3 }

/**
 * Strict shape validation. Throws SchemaError with a specific, actionable
 * message on the first thing that's wrong — unknown state values, non-array
 * history, unparseable dates — rather than letting bad data reach the state
 * machine (CODEX-REVIEW 1.3: `history is not iterable` used to surface deep
 * inside `stats()` after the file had already been overwritten).
 */
export function validateStateShape(state) {
  assert(state && typeof state === "object" && !Array.isArray(state), "root is not an object")
  assert(state.version === CURRENT_VERSION, `expected version ${CURRENT_VERSION}, got ${JSON.stringify(state.version)}`)
  assert(state.items && typeof state.items === "object" && !Array.isArray(state.items), "`items` must be an object")
  assert(typeof state.revision === "number" && Number.isFinite(state.revision), "`revision` must be a number")
  assert(state.lastDripAt === null || isValidDateString(state.lastDripAt), "`lastDripAt` is not null or a valid date string")

  for (const [id, item] of Object.entries(state.items)) {
    const where = `item "${id}"`
    assert(typeof item.url === "string" && item.url.length > 0, `${where}: url must be a non-empty string`)
    assert(typeof item.title === "string", `${where}: title must be a string`)
    assert(item.folder === null || typeof item.folder === "string", `${where}: folder must be null or a string`)
    assert(KNOWN_STATES.includes(item.state), `${where}: unknown state "${item.state}"`)
    assert(isValidDateString(item.enteredStateAt), `${where}: enteredStateAt is not a valid date string`)
    assert(item.addedAt === null || isValidDateString(item.addedAt), `${where}: addedAt is not null or a valid date string`)
    assert(Array.isArray(item.sources), `${where}: sources must be an array`)
    for (const [i, s] of item.sources.entries()) {
      assert(s && typeof s.id === "string", `${where}: sources[${i}].id must be a string`)
      assert(s.lastSeenAt === null || isValidDateString(s.lastSeenAt), `${where}: sources[${i}].lastSeenAt is not null or a valid date string`)
    }
    assert(Array.isArray(item.history), `${where}: history must be an array`)
    for (const [i, h] of item.history.entries()) {
      assert(h && typeof h === "object", `${where}: history[${i}] is not an object`)
      assert(KNOWN_STATES.includes(h.state), `${where}: history[${i}].state is unknown ("${h.state}")`)
      assert(isValidDateString(h.at), `${where}: history[${i}].at is not a valid date string`)
      assert(typeof h.by === "string", `${where}: history[${i}].by must be a string`)
    }
    assert(item.note === null || typeof item.note === "string", `${where}: note must be null or a string`)
    assert(typeof item.sourceGone === "boolean", `${where}: sourceGone must be a boolean`)
  }
  return state
}

/**
 * Parse+migrate+validate a raw `JSON.parse()` result into the current
 * schema. Throws (never returns a partial/best-guess result) on:
 *  - a version newer than this code understands (FutureVersionError)
 *  - any structural problem after migration (SchemaError)
 * Returns `{ state, migrated }` — `migrated` is true when the on-disk
 * version was older than CURRENT_VERSION, so the caller knows to persist
 * the upgraded shape (with a backup of the pre-migration file) even if
 * nothing else changed this call.
 */
export function migrateAndValidate(parsed) {
  const rawVersion = parsed && typeof parsed === "object" ? parsed.version : undefined
  if (typeof rawVersion === "number" && rawVersion > CURRENT_VERSION) {
    throw new FutureVersionError(rawVersion)
  }
  let working = parsed
  let version = rawVersion
  let migrated = false
  if (version === undefined) {
    working = migrateV0toV1(working)
    version = 1
    migrated = true
  }
  while (version < CURRENT_VERSION) {
    const step = MIGRATIONS[version]
    assert(step, `no migration registered from version ${version}`)
    working = step(working)
    version = working.version
    migrated = true
  }
  return { state: validateStateShape(working), migrated }
}
