// Persistence and configuration. The state file is the only thing this
// package ever writes to — never a browser bookmark file (see src/index.js
// header for the hard guarantee).
//
// Three data-safety layers, all zero-dependency (node:fs only):
//  1. Atomic write: new content lands in a sibling temp file, gets fsync'd,
//     then swapped in with `rename` (POSIX guarantees this is atomic — a
//     reader/crash never observes a half-written file). The previous
//     generation is kept as `state.json.bak` before being replaced.
//  2. Cross-process lock: an O_EXCL lockfile serializes the ENTIRE
//     load -> freshen -> mutate -> save critical section across processes
//     (e.g. Claude Desktop and Cursor both running this server), not just
//     the final write — see withStateLock().
//  3. Revision CAS: state carries a monotonic `revision`; saveState()
//     re-reads the on-disk revision immediately before writing and refuses
//     to overwrite if it doesn't match what this state was loaded from —
//     defense in depth against a bug or an out-of-band edit slipping past
//     the lock, not the primary mechanism.

import {
  closeSync,
  copyFileSync,
  existsSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs"
import { randomBytes } from "node:crypto"
import { homedir } from "node:os"
import { basename, dirname, join } from "node:path"
import { emptyState, migrateAndValidate } from "./schema.js"

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

function intEnv(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  const n = Number.parseInt(raw, 10)
  return Number.isFinite(n) && n > 0 ? n : fallback
}

function boolEnv(name, fallback) {
  const raw = process.env[name]
  if (raw === undefined || raw === "") return fallback
  return raw === "true" || raw === "1"
}

/** Read the four tunables from the environment. See README for defaults. */
export function loadConfig() {
  return {
    pendingMs: intEnv("BOOKMARKS_LIFECYCLE_PENDING_HOURS", 24) * HOUR_MS,
    watchingMs: intEnv("BOOKMARKS_LIFECYCLE_WATCHING_DAYS", 30) * DAY_MS,
    dripPerDay: intEnv("BOOKMARKS_LIFECYCLE_DRIP_PER_DAY", 15),
    autoDecide: boolEnv("BOOKMARKS_LIFECYCLE_AUTO_DECIDE", false),
  }
}

function stateDir() {
  return process.env.BOOKMARKS_LIFECYCLE_STATE_DIR || join(homedir(), ".bookmarks-lifecycle")
}

function statePath() {
  return join(stateDir(), "state.json")
}

function backupPath() {
  return `${statePath()}.bak`
}

function lockPath() {
  return join(stateDir(), "state.json.lock")
}

// ---------------------------------------------------------------------
// Cross-process lock
// ---------------------------------------------------------------------

const LOCK_STALE_MS = 30_000 // a lock older than this is assumed to belong to a crashed process
const LOCK_RETRY_MS = 40
const LOCK_TIMEOUT_MS = 5_000

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function tryStealStaleLock(path) {
  try {
    const info = JSON.parse(readFileSync(path, "utf8"))
    if (Date.now() - Date.parse(info.at) > LOCK_STALE_MS) {
      unlinkSync(path)
      return true
    }
    return false
  } catch {
    // unreadable/corrupt lock file — race or a leftover from a crash. Treat as stale.
    try {
      unlinkSync(path)
    } catch {
      // someone else already cleaned it up
    }
    return true
  }
}

/**
 * Publish the lock file via write-then-link rather than O_EXCL-create-then-
 * write. This matters: with create-then-write, there's a real window where
 * the lock file exists but is still empty (between `open` and `write`) —
 * another process reading it in that window sees invalid JSON and, if that
 * were treated as "corrupt, therefore stale", would steal a lock that its
 * owner is still actively holding (found by writing exactly this race into
 * a test — two processes both proceeded into the critical section at once).
 * Writing the full content to a private temp file first and then
 * `link`-ing it into place means the lock file is either fully-formed or
 * doesn't exist yet — there is no partial-content state visible to anyone
 * else. `link` (unlike `rename`) fails with EEXIST if the target already
 * exists, so it preserves exclusivity.
 */
function publishLock(path) {
  const tmpPath = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`
  writeFileSync(tmpPath, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), { mode: 0o600 })
  try {
    linkSync(tmpPath, path)
    return true
  } catch (err) {
    if (err.code !== "EEXIST") throw err
    return false
  } finally {
    try {
      unlinkSync(tmpPath)
    } catch {
      // already gone
    }
  }
}

async function acquireLock() {
  mkdirSync(stateDir(), { recursive: true })
  const path = lockPath()
  const deadline = Date.now() + LOCK_TIMEOUT_MS
  for (;;) {
    if (publishLock(path)) {
      return () => {
        try {
          unlinkSync(path)
        } catch {
          // already gone — fine
        }
      }
    }
    if (tryStealStaleLock(path)) continue
    if (Date.now() > deadline) {
      throw new Error(
        `bookmarks-lifecycle: timed out waiting ${LOCK_TIMEOUT_MS}ms for the state lock at ${path} ` +
          `(held by another process). If you're sure no other bookmarks-lifecycle process is running, ` +
          `delete this file and retry.`,
      )
    }
    await sleep(LOCK_RETRY_MS)
  }
}

/**
 * Run `fn` holding an exclusive cross-process lock over the ENTIRE critical
 * section — every tool handler wraps its load/freshen/mutate/save sequence
 * in this, not just the final write, so two MCP hosts (e.g. Claude Desktop
 * and Cursor) running this server against the same state file serialize
 * instead of losing each other's updates.
 */
export async function withStateLock(fn) {
  const release = await acquireLock()
  try {
    return await fn()
  } finally {
    release()
  }
}

// ---------------------------------------------------------------------
// Atomic write
// ---------------------------------------------------------------------

function atomicWriteFile(path, content) {
  const dir = dirname(path)
  const tmpPath = join(dir, `${basename(path)}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`)
  let fd
  try {
    fd = openSync(tmpPath, "w", 0o600)
    // A single writeSync call is not guaranteed to write the whole buffer —
    // under a file-size limit (ulimit -f) it can return a SHORT count
    // (e.g. 512 of 5000 bytes) without throwing at all; the failure only
    // surfaces on the next call. Looping and checking the byte count is
    // what actually catches "disk full"/quota-style failures — writing
    // once and assuming success does not (found by testing this exact
    // scenario, not by inspection).
    const buf = Buffer.from(content, "utf8")
    let written = 0
    while (written < buf.length) {
      const n = writeSync(fd, buf, written, buf.length - written)
      if (n <= 0) throw new Error(`bookmarks-lifecycle: write stalled at ${written}/${buf.length} bytes`)
      written += n
    }
    fsyncSync(fd)
    closeSync(fd)
    fd = undefined
    renameSync(tmpPath, path) // POSIX rename onto an existing path is atomic
    let dirFd
    try {
      dirFd = openSync(dir, "r")
      fsyncSync(dirFd) // durability for the rename itself, not just the file content
    } finally {
      if (dirFd !== undefined) closeSync(dirFd)
    }
  } catch (err) {
    if (fd !== undefined) {
      try {
        closeSync(fd)
      } catch {
        // already closed
      }
    }
    try {
      unlinkSync(tmpPath)
    } catch {
      // never got created, or already gone
    }
    throw err // the real file at `path` was never opened for writing — it is untouched
  }
}

// ---------------------------------------------------------------------
// Public load/save
// ---------------------------------------------------------------------

/**
 * Load + migrate + validate the state file. Missing file (first run) is
 * normal and returns an empty v-current state. A present-but-corrupt file,
 * or one from a future version this code doesn't understand, is NEVER
 * silently discarded or overwritten — it throws, file untouched.
 * @returns {{state: object, migrated: boolean}}
 */
function readStateMeta() {
  let raw
  try {
    raw = readFileSync(statePath(), "utf8")
  } catch (err) {
    if (err.code === "ENOENT") return { state: emptyState(), migrated: false }
    throw err
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(
      `bookmarks-lifecycle: state file at ${statePath()} exists but is not valid JSON. Not overwriting it ` +
        `automatically — inspect it, or check ${backupPath()} for the last known-good version, then retry.`,
    )
  }
  return migrateAndValidate(parsed)
}

/** Convenience wrapper returning just the state (used by most callers/tests). */
export function loadState() {
  return readStateMeta().state
}

/** Like loadState(), but also reports whether the on-disk file needed a version migration. */
export function loadStateMeta() {
  return readStateMeta()
}

/**
 * Persist state atomically. Before overwriting, the current on-disk
 * generation (if any) is copied to `state.json.bak`. A revision mismatch
 * against what's currently on disk throws instead of overwriting — this
 * should never trigger when called inside withStateLock(), and existing
 * as a check is exactly what makes that guarantee verifiable.
 */
export function saveState(state) {
  mkdirSync(stateDir(), { recursive: true })
  const path = statePath()
  if (existsSync(path)) {
    let onDiskRevision
    try {
      onDiskRevision = JSON.parse(readFileSync(path, "utf8")).revision ?? 0
    } catch {
      throw new Error(
        `bookmarks-lifecycle: on-disk state file is not valid JSON right now — refusing to save over it blindly.`,
      )
    }
    if (typeof state.revision === "number" && onDiskRevision !== state.revision) {
      throw new Error(
        `bookmarks-lifecycle: revision conflict — on-disk revision is ${onDiskRevision}, this save expected ` +
          `${state.revision}. Something modified the state file since it was loaded; reload and retry.`,
      )
    }
    try {
      copyFileSync(path, backupPath())
    } catch {
      // best-effort — a missed backup must not block the save itself
    }
  }
  const next = { ...state, revision: (state.revision ?? 0) + 1 }
  atomicWriteFile(path, JSON.stringify(next, null, 2))
  return next
}

export const paths = { stateDir, statePath, backupPath, lockPath }
