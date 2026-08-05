import assert from "node:assert/strict"
import { test } from "node:test"
import { CURRENT_VERSION, FutureVersionError, SchemaError, emptyState, migrateAndValidate, validateStateShape } from "../src/schema.js"

test("emptyState: matches CURRENT_VERSION and has a revision", () => {
  const s = emptyState()
  assert.equal(s.version, CURRENT_VERSION)
  assert.deepEqual(s.items, {})
  assert.equal(s.lastDripAt, null)
  assert.equal(s.revision, 0)
})

test("migrateAndValidate: v0 (no version field) migrates to current, items preserved", () => {
  const at = "2024-01-01T00:00:00Z"
  const v0 = {
    items: {
      x: { id: "x", url: "https://a.com", title: "A", source: "chrome:Default", state: "inbox", enteredStateAt: at, history: [{ state: "inbox", at, by: "system" }], note: null, sourceGone: false },
    },
    lastDripAt: null,
  }
  const { state, migrated } = migrateAndValidate(v0)
  assert.equal(migrated, true)
  assert.equal(state.version, CURRENT_VERSION)
  assert.equal(state.items.x.url, "https://a.com")
  assert.deepEqual(state.items.x.sources, [{ id: "chrome:Default", lastSeenAt: at }])
  assert.equal(state.items.x.addedAt, null)
  assert.equal(state.items.x.folder, null, "v0 never had folder — migration chain must not fabricate one")
  assert.equal(state.revision, 0)
})

test("migrateAndValidate: v1 (this package's original shape) migrates `source` string -> `sources` array", () => {
  const at = "2024-01-01T00:00:00Z"
  const v1 = {
    version: 1,
    items: {
      x: { id: "x", url: "https://a.com", title: "A", source: "safari", state: "kept", enteredStateAt: at, history: [{ state: "kept", at, by: "user" }], note: "great", sourceGone: false },
    },
    lastDripAt: at,
  }
  const { state, migrated } = migrateAndValidate(v1)
  assert.equal(migrated, true)
  assert.equal(state.version, CURRENT_VERSION)
  assert.deepEqual(state.items.x.sources, [{ id: "safari", lastSeenAt: at }])
  assert.equal(state.items.x.addedAt, null, "v1 never persisted addedAt — migration must not fabricate one")
  assert.equal(state.items.x.folder, null, "v1 never had folder — migration chain must not fabricate one")
  assert.equal(state.items.x.note, "great")
  assert.equal(state.revision, 0)
  assert.equal(state.lastDripAt, at)
})

test("migrateAndValidate: v2 (no `folder` field) migrates forward, old records get folder: null", () => {
  const at = "2024-01-01T00:00:00Z"
  const v2 = {
    version: 2,
    items: {
      x: {
        id: "x",
        url: "https://a.com",
        title: "A",
        sources: [{ id: "chrome:Default", lastSeenAt: at }],
        addedAt: at,
        state: "kept",
        enteredStateAt: at,
        history: [{ eventId: "x#0", state: "kept", at, by: "user" }],
        note: "great",
        sourceGone: false,
      },
    },
    lastDripAt: at,
    revision: 3,
  }
  const { state, migrated } = migrateAndValidate(v2)
  assert.equal(migrated, true)
  assert.equal(state.version, CURRENT_VERSION)
  assert.equal(state.items.x.folder, null, "v2 never persisted folder — migration must not fabricate one")
  // everything else survives the migration untouched
  assert.equal(state.items.x.url, "https://a.com")
  assert.equal(state.items.x.state, "kept")
  assert.equal(state.items.x.note, "great")
  assert.equal(state.revision, 3)
  assert.equal(state.lastDripAt, at)
})

test("migrateAndValidate: v2 record that already happens to carry a `folder`-shaped key some other tool wrote is left as-is", () => {
  const at = "2024-01-01T00:00:00Z"
  const v2 = {
    version: 2,
    items: {
      x: {
        id: "x",
        url: "https://a.com",
        title: "A",
        folder: "Work/Reading",
        sources: [],
        addedAt: null,
        state: "inbox",
        enteredStateAt: at,
        history: [{ eventId: "x#0", state: "inbox", at, by: "system" }],
        note: null,
        sourceGone: false,
      },
    },
    lastDripAt: null,
    revision: 0,
  }
  const { state } = migrateAndValidate(v2)
  assert.equal(state.items.x.folder, "Work/Reading")
})

test("migrateAndValidate: current-version input passes through (migrated: false)", () => {
  const at = "2024-01-01T00:00:00Z"
  const v3 = {
    version: CURRENT_VERSION,
    items: {
      x: {
        id: "x",
        url: "https://a.com",
        title: "A",
        folder: "Work/Reading",
        sources: [{ id: "chrome:Default", lastSeenAt: at }],
        addedAt: at,
        state: "inbox",
        enteredStateAt: at,
        history: [{ eventId: "x#0", state: "inbox", at, by: "system" }],
        note: null,
        sourceGone: false,
      },
    },
    lastDripAt: null,
    revision: 5,
  }
  const { state, migrated } = migrateAndValidate(v3)
  assert.equal(migrated, false)
  assert.equal(state.revision, 5)
  assert.equal(state.items.x.folder, "Work/Reading")
})

test("migrateAndValidate: version newer than CURRENT_VERSION throws FutureVersionError, never touches shape", () => {
  const input = { version: 99, items: { x: { state: "kept" } }, futureField: "must-survive" }
  assert.throws(() => migrateAndValidate(input), FutureVersionError)
  // the thrown error must happen before any migration/normalization — the input object itself is untouched
  assert.equal(input.futureField, "must-survive")
})

test("migrateAndValidate: version exactly CURRENT_VERSION + 1 also throws (boundary)", () => {
  assert.throws(() => migrateAndValidate({ version: CURRENT_VERSION + 1, items: {} }), FutureVersionError)
})

test("validateStateShape: rejects unknown state value", () => {
  const at = "2024-01-01T00:00:00Z"
  const bad = {
    version: CURRENT_VERSION,
    revision: 0,
    lastDripAt: null,
    items: { x: { id: "x", url: "https://a.com", title: "A", folder: null, sources: [], addedAt: null, state: "future_state", enteredStateAt: at, history: [], note: null, sourceGone: false } },
  }
  assert.throws(() => validateStateShape(bad), SchemaError)
})

test("validateStateShape: rejects non-array history (the exact crash CODEX-REVIEW 1.3 found)", () => {
  const at = "2024-01-01T00:00:00Z"
  const bad = {
    version: CURRENT_VERSION,
    revision: 0,
    lastDripAt: null,
    items: { x: { id: "x", url: "https://a.com", title: "A", folder: null, sources: [], addedAt: null, state: "kept", enteredStateAt: at, history: null, note: null, sourceGone: false } },
  }
  assert.throws(() => validateStateShape(bad), /history must be an array/)
})

test("validateStateShape: rejects invalid enteredStateAt / addedAt / history[].at", () => {
  const at = "2024-01-01T00:00:00Z"
  const base = { id: "x", url: "https://a.com", title: "A", folder: null, sources: [], addedAt: null, state: "kept", enteredStateAt: at, history: [], note: null, sourceGone: false }
  const wrap = (item) => ({ version: CURRENT_VERSION, revision: 0, lastDripAt: null, items: { x: item } })

  assert.throws(() => validateStateShape(wrap({ ...base, enteredStateAt: "not-a-date" })), /enteredStateAt/)
  assert.throws(() => validateStateShape(wrap({ ...base, addedAt: "not-a-date" })), /addedAt/)
  assert.throws(() => validateStateShape(wrap({ ...base, history: [{ state: "kept", at: "not-a-date", by: "user" }] })), /history\[0\]\.at/)
})

test("validateStateShape: rejects missing/empty url and non-object root", () => {
  assert.throws(() => validateStateShape(null), SchemaError)
  assert.throws(() => validateStateShape([]), SchemaError)
  assert.throws(
    () => validateStateShape({ version: CURRENT_VERSION, revision: 0, lastDripAt: null, items: { x: { url: "", title: "A", folder: null, sources: [], state: "kept", enteredStateAt: "2024-01-01T00:00:00Z", history: [], note: null, sourceGone: false } } }),
    /url must be a non-empty string/,
  )
})

test("validateStateShape: accepts a well-formed current-version state", () => {
  const at = "2024-01-01T00:00:00Z"
  const good = {
    version: CURRENT_VERSION,
    revision: 3,
    lastDripAt: at,
    items: {
      x: {
        id: "x",
        url: "https://a.com",
        title: "A",
        folder: null,
        sources: [{ id: "chrome:Default", lastSeenAt: at }],
        addedAt: at,
        state: "pending",
        enteredStateAt: at,
        history: [{ eventId: "x#0", state: "inbox", at, by: "system" }],
        note: null,
        sourceGone: false,
      },
    },
  }
  assert.deepEqual(validateStateShape(good), good)
})

test("validateStateShape: rejects a non-null, non-string folder", () => {
  const at = "2024-01-01T00:00:00Z"
  const bad = {
    version: CURRENT_VERSION,
    revision: 0,
    lastDripAt: null,
    items: { x: { id: "x", url: "https://a.com", title: "A", folder: 42, sources: [], addedAt: null, state: "kept", enteredStateAt: at, history: [], note: null, sourceGone: false } },
  }
  assert.throws(() => validateStateShape(bad), /folder must be null or a string/)
})
