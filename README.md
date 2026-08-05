# bookmarks-lifecycle

**Give your saved bookmarks a lifecycle.**

Saving is easy. Almost nothing you save ever gets decided about — it just
accumulates. This is a local MCP server that puts every bookmark on a clock:
24 hours to decide, or 30 days to keep watching, or keep it for good. Nothing
is ever deleted — a bookmark that times out without a decision just leaves
your attention, not your disk, and every change (including ones an AI made)
can be undone.

```
Aggregates via bookmarks-mcp. Writes only its own local state file, atomically. No accounts, no cloud, no network calls.
```

> ⚠️ **Not published yet.** This package isn't on npm and can't be installed
> with `npx`. See [Install](#install) for the clone-based setup this
> currently requires.

## The model

Five states:

| State | Meaning | Counts down? |
|---|---|---|
| `inbox` | Aggregated, not yet up for a decision | no |
| `pending` | The 24-hour layer — today's actual to-do list | yes |
| `watching` | The 30-day layer — "give it more time" | yes |
| `kept` | Decided: keep this for good | no |
| `lapsed` | Timed out or let go — **fully recoverable, never deleted** | no |

```
aggregate → inbox
              │ drip (up to N/day, oldest first)
              ▼
           pending ──you decide──→ watching / kept / lapsed
              │
              └──24h, no decision────────────→ lapsed
                                                  ▲
           watching ──30d, no decision───────────┘
              └──you decide──→ kept

lapsed ──restore──→ pending (clock resets)
any state ──undo (by history event)──→ whatever it was right before that event
```

From `pending` you can go to any of the three outcomes. From `watching`, a
decision can only be `keep` — that matches the model above; to back out of a
`watch` or a `drop`, use `undo` rather than re-deciding an item that's
already moved on.

Bookmarks don't all land in `pending` the moment you aggregate them — a
one-time import of 3,000 old bookmarks would otherwise all time out on the
same day and the mechanism would mean nothing. They **drip in** at a daily
rate instead (default 15/day, oldest first — by real save date when the
source provides one). This is computed lazily whenever you call a tool, not
by a background timer, and it does **not** accumulate across a long absence:
however many days you've been away, one call promotes at most one day's
quota. A 3,000-bookmark backlog at 15/day realistically takes months of
daily visits to clear — that's an honest tradeoff of "no reminders, nothing
runs unless you ask", not a claim that this replaces a habit-forming app.

## Install

Not on npm yet. Both this package and its dependency `bookmarks-mcp` have to
be run from a local clone:

```bash
mkdir bookmarks-tools && cd bookmarks-tools

# All three must be siblings — the file: dependencies resolve via ../
git clone https://github.com/Fisher521/parse-bookmarks.git
git clone https://github.com/Fisher521/bookmarks-mcp.git
git clone https://github.com/Fisher521/bookmarks-lifecycle.git

cd bookmarks-mcp && npm install && cd ..
cd bookmarks-lifecycle && npm install
```

The directory layout `npm install` expects:

```
bookmarks-tools/
├── parse-bookmarks/      ← parsing library (no dependencies)
├── bookmarks-mcp/        ← reads your browsers; depends on ../parse-bookmarks
└── bookmarks-lifecycle/  ← this package; depends on ../bookmarks-mcp
```

Then point your MCP client at the absolute path of `src/index.js`:

```json
{
  "mcpServers": {
    "bookmarks-lifecycle": {
      "command": "node",
      "args": ["/absolute/path/to/bookmarks-lifecycle/src/index.js"]
    }
  }
}
```

Claude Code:

```bash
claude mcp add -s user bookmarks-lifecycle -- node /absolute/path/to/bookmarks-lifecycle/src/index.js
```

**Use `-s user`.** Without it the scope defaults to `local`, which registers the
server only for the directory you ran the command in — you'd have to be inside
that folder for your assistant to see it. Your bookmarks have nothing to do with
which code project you happen to be sitting in, so register it once for your
whole account.

**Config file locations** (for the JSON form above):
- Claude Desktop: `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS)
- Cursor: `~/.cursor/mcp.json` (or per-project `.cursor/mcp.json`)

**Verifying it's connected**: ask your assistant to call the `stats` tool, or
check your client's MCP/server log — a successful `initialize` handshake and
a `tools/list` containing `intake, today, decide, list_layer, restore, undo,
stats` means it's up.

**After changing any environment variable below**, fully restart your MCP
client's connection to this server (quit/reopen Claude Desktop, or restart
the Cursor MCP process) — it reads them once at startup.

## First run

If you're on macOS and want Safari bookmarks included, the app hosting this
server (Claude Desktop, your terminal, Cursor) needs **Full Disk Access**
(System Settings → Privacy & Security → Full Disk Access) — `~/Library/Safari`
is protected. Without it, `intake`'s response will show `"sourceStatus":
"permission_denied"` and a `warnings` entry explaining exactly that; it will
NOT silently look like an empty result. Chromium browsers and Firefox need
nothing extra.

Call `intake` first — nothing shows up in `today` until you do. Then `today`
gives you the day's actual queue. If both `intake` and `today` come back
completely empty and `sourceStatus` says `"ok"`, that's an honest "you have
no bookmarks in the sources this scanned" — check `sourceStatus` before
assuming something's broken:

| `sourceStatus` | Meaning |
|---|---|
| `no_sources` | No supported browser was even detected on this machine |
| `permission_denied` | At least one source failed to read (commonly Safari without Full Disk Access) |
| `empty` | Every source scanned successfully and genuinely has 0 bookmarks |
| `ok` | Scanned successfully and found something |

**`no_sources` even though you can see bookmarks in your browser?** This detects
Chromium browsers (Chrome, Edge, Brave, Arc, Vivaldi, Chromium) only in their
standard per-OS install locations. If your browser uses a custom profile or
data directory (a separate work profile, a portable install, a renamed user
data folder, …), it won't be found automatically:

1. Open `chrome://version` in that browser (`edge://version`, `brave://version`,
   etc. — the same page exists in every Chromium browser) and copy the value
   next to **Profile Path**.
2. In your MCP client's config for this server, add an environment variable
   `CHROMIUM_BOOKMARKS_PATH` set to that path with `/Bookmarks` appended, e.g.
   `"/Users/you/Library/Application Support/BraveSoftware/Brave-Browser/Custom/Bookmarks"`.
   Comma-separate multiple paths if you have more than one profile to include.
3. Fully restart the MCP client's connection to this server (see
   [Configuration](#configuration) below).

This doesn't apply to Safari — see the Full Disk Access note above instead.

## Talking to it

You never call these tools yourself — your assistant does. You just talk. If
you'd rather be walked through it, run the **`clean_up_my_bookmarks`** prompt
once (in Claude Code: `/mcp`; in Claude Desktop: the prompts menu) and it will
set you up and do one round with you.

Otherwise, plain sentences are enough:

| Say something like | What happens |
|---|---|
| "Pull in my browser bookmarks" | `intake` — scans your browsers, adds new URLs to the inbox |
| "What should I look at today?" | `today` — the day's queue, oldest first, up to the daily quota |
| "Keep the first one, drop the last two" | `decide` — after you've confirmed, not before |
| "Actually, undo that" | `undo` — reverses any decision, including "keep" |
| "What did I let go of?" | `list_layer` on `lapsed` — everything is still there |
| "Bring that one back" | `restore` — returns it to the queue with a fresh clock |
| "How much is left?" | `stats` — counts per layer and what's still waiting in inbox |

Two things worth knowing on day one:

- **Nothing reminds you.** There is no background process and no notification.
  The queue only moves when you ask — which also means it can never surprise you.
- **An empty result explains itself.** Every response carries a `nextStep`
  telling your assistant what to suggest, so "0 items" never has to be guessed
  at: it will say whether you simply haven't scanned yet, whether today's batch
  is done, or whether a source failed to read.

## Tools

| Tool | What it does |
|---|---|
| `intake` | Scan bookmark sources, merge new ones into `inbox`, reconcile ones that moved or disappeared |
| `today` | The `pending` layer right now, oldest first — your daily entry point |
| `decide` | Judge one or more items: `keep` / `watch` / `drop` |
| `list_layer` | See any single layer, paginated (default 50/page), including `lapsed` ("what did I let go of") |
| `restore` | Bring a `lapsed` item back to `pending`, clock reset |
| `undo` | Revert an item to what it was right before one of its own history events — works for `kept`/`watching` too, not just `lapsed` |
| `stats` | Counts per layer, today's decision count, how much is waiting in `inbox` |

Every read tool (`today`/`list_layer`/`stats`) may still write to disk on
the call you make: expiry and drip are computed lazily, so even "just
looking" can move items between layers as a side effect. It only writes
when something actually changed — a call that finds nothing due and nothing
to drip touches nothing.

Plus two prompts:

| Prompt | When |
|---|---|
| `clean_up_my_bookmarks` | First time. Explains the decision-clock mechanism, runs `intake`, and does one small triage round with you. |
| `daily_triage` | Every day after that. `today` → a suggestion per item → waits for your confirmation → applies it. |

Both `intake` and `today` also return a `nextStep` object (`code` + `why`) so
your assistant knows what to suggest next instead of inferring it from an
empty list. It is operational guidance only — never promotion.

## Honesty about authorization

**This server cannot verify that a tool call attributed to `"user"` actually
came from you confirming something.** Every parameter it receives — including
`actorClaim: "user"` — comes from the AI, over the same channel as everything
else. There is no separate, trusted channel this code can check. An earlier
version of this README claimed "AI can't act without your say-so" as a
server-enforced guarantee; that was tested and shown to be false — an AI
that simply omits the field, or claims `"user"`, goes through unchallenged.
We're not going to repeat that claim.

What's actually true:

- **Whether an AI needs your click-through before it can call a mutating
  tool depends on your MCP client's own tool-approval settings** — Claude
  Desktop and Cursor both have per-tool or per-session approval prompts.
  That's the real gate, and it lives in your client, not in this server.
- `actorClaim: "ai"` is rejected unless you've explicitly set
  `BOOKMARKS_LIFECYCLE_AUTO_DECIDE=true` — but a caller can just omit the
  field (recorded as `"mcp-client"`) or claim `"user"` instead, so don't
  treat this as a security boundary either.
- **What this server actually guarantees is reversibility.** Every mutation
  — including ones made under `autoDecide`, including expiry, including
  drip — is undoable. `restore` reverses `lapsed → pending`. `undo` reverses
  *any* state change, including `kept` and `watching`, by history event, with
  a `preview` mode to check first. If an AI does something you didn't want,
  the fix is `undo`, not a promise that it couldn't have happened.
- `history` records `by: "user" | "ai" | "mcp-client" | "drip" | "expiry" |
  "system"` on every change. The first two are **claims**, not verified
  identity — treat them as a hint for your own review, not evidence.

## Configuration

All via environment variables in your MCP client config — none require
touching this package's code. **Restart your MCP client's connection after
changing any of these.**

| Variable | Default | What |
|---|---|---|
| `BOOKMARKS_LIFECYCLE_PENDING_HOURS` | `24` | Hours in the `pending` layer before an undecided item lapses |
| `BOOKMARKS_LIFECYCLE_WATCHING_DAYS` | `30` | Days in the `watching` layer before an undecided item lapses |
| `BOOKMARKS_LIFECYCLE_DRIP_PER_DAY` | `15` | Max `inbox` items promoted to `pending` per day (never accumulates across a gap) |
| `BOOKMARKS_LIFECYCLE_AUTO_DECIDE` | `false` | Whether `decide`/`restore`/`undo` calls claiming `actorClaim: "ai"` are allowed through (see [Honesty about authorization](#honesty-about-authorization) — this is not a security guarantee) |
| `BOOKMARKS_LIFECYCLE_STATE_DIR` | `~/.bookmarks-lifecycle` | Where `state.json` (and its lock/backup files) live |

## What gets stored

One file: `~/.bookmarks-lifecycle/state.json`. Plain JSON, human-readable.
Writes are atomic (temp file → fsync → rename, never a partial write left
behind mid-crash) and the previous generation is kept as `state.json.bak`
before each overwrite.

Per bookmark: id, url, title, the browser source(s) it's known from (a URL
saved in two browsers keeps both), when it was actually added according to
the browser (`addedAt`, used for oldest-first ordering — `null` if the
source didn't provide one, never fabricated), current lifecycle state, when
it entered that state, a full history of every transition (each with a
stable `eventId`, when, who/what did it, and an optional note), and a
`sourceGone` flag for bookmarks no longer found in any source that was
successfully re-scanned (their record stays — nothing here is ever
auto-deleted; a source that merely *failed* to read never counts as
evidence something's gone).

Only identifiers and your own judgments are stored — never the page content
itself. The file has an internal `version`; if a future version of this tool
writes a shape this version doesn't understand, this version refuses to
touch the file rather than guess.

**Concurrent access**: if two MCP clients (say, Claude Desktop and Cursor)
run this server against the same state file at once, a lock file
(`state.json.lock`) serializes them — the second one waits briefly rather
than silently overwriting the first one's changes.

## Time zone

`stats`'s "today" (for `decidedToday`) uses the local calendar day on the
machine running this server. Because this server only ever runs on your own
machine (it reads local browser files directly — there's no remote/hosted
deployment of it), that's the same clock you're living by, so this is
intentional, not a bug to fix. The 24h/30d layer durations are strict
elapsed-time windows, not calendar-day counts — a daylight-saving transition
shifts wall-clock time without changing how long 24 hours actually is.

## Guarantees

- **Never touches a browser bookmark file.** Reading is entirely delegated
  to `bookmarks-mcp`, which is itself read-only. The only files this
  package ever writes are its own `state.json`, `state.json.bak`, and a
  transient lock file.
- **No lifecycle record is ever deleted**, and every state change is
  reversible — see [Honesty about authorization](#honesty-about-authorization)
  for exactly what that does and doesn't protect against.
- **No network calls, no telemetry, no accounts.**

## Design boundaries

- **No background process, no cron, no push notifications.** Everything here
  is computed lazily, the instant you call a tool — that's what makes "no
  daemon" possible. The honest tradeoff: if you don't come ask, the queue
  just quietly lapses. Nobody reminds you.
- **No UI.** This stays an MCP tool, not an app.
- **Bring your own AI.** This server does no inference and charges nothing —
  the AI judging your bookmarks is whatever you've already connected it to.
  What this project provides is the state machine and the prompt, not a
  model.

## Who makes this

Built by the team behind [Burn 451](https://www.burn451.cloud) — the 24h /
30-day mechanic here is modeled on Burn's. The difference: this tool only
runs when you ask it to, right where you're already working. If you want the
same idea running automatically, reminding you daily, and reachable from
your phone, that's what Burn is — this project stays useful on its own
either way.

## License

MIT
