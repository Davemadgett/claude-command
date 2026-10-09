# Claude Command — system documentation

A native Mac application that turns Claude Code terminal sessions into a kanban
board, and ties that board to the work those sessions are actually about: the
folders on disk, the calendar, and — optionally — whatever system already holds
your list of clients, cases or projects.

Roughly 7,300 lines across a Node server, a React front end, and a Swift app
shell.

This document is the *why*. It was written for one law firm and then generalised,
and that history shows in the examples: labels look like `01994-Acme` because
they started life as matter numbers. Read them as "whatever your work is filed
under". The README is the *how*.

---

## 1. Philosophy: sessions are bottom-up, this is top-down

A Claude Code session is **bottom-up** by nature. You open a terminal and you are
*inside* one conversation. Context is established from within it, work emerges
outward from it, and the only vantage point on that work is the session itself.
That is exactly the right shape for a single piece of work, and exactly the wrong
shape for a practice. Two sessions are a pair of windows. Six are a memory test.
Nothing above them knows they exist, so holding the whole picture is your job —
and that is the first thing to go on a busy day.

Claude Command inverts it. **The board is the vantage point.** Every session in
flight is visible at once, carrying its label, its stage, its deadline and its
state, and you direct work *into* sessions instead of discovering it inside them.

| Bottom-up — inside a session | Top-down — above the board |
|---|---|
| The unit of attention is the conversation you're in | The unit is the portfolio of work in flight |
| Context is re-established inside every session | Context is attached above and handed down |
| "Is it finished?" means going to look | Finished work moves itself into review |
| More parallelism means more windows to hold in your head | More parallelism means more rows to scan |
| The session is where the work lives | The session is a means; the card is the record |

### What the inversion buys

**Directed parallelism.** You can keep six sessions going because you are no
longer the thing holding them together. The board holds them; review lanes raise
the ones that want you. This is the same move as a well-scoped agent roster — one
drafts, another checks, a third formats — applied to sessions rather than to
specialists.

**Context flows downward.** A session started from a calendar event opens *in that
label's folder*, with the deadline already on its card. The session doesn't have
to work out where it is; that was decided above it.

**Work outlives sessions.** Resume a transcript and the card follows it. Close a
card and it is in the Archive, not gone. The session is disposable. The record is
not.

### What the inversion demands

Every significant design decision in this system falls out of that inversion:

- **Cards stay spare.** You are scanning a portfolio, not reading a document.
  Status, label, title, a way in — detail lives one click down.
- **Selecting must not teleport you.** Clicking a card selects it and leaves the
  board where it is; only *Open* takes you into the work. Top-down means you
  choose when to descend.
- **Summary before transcript.** A session opens on what it *did*, not on a wall
  of conversation, because triage happens from above.
- **Labels have to be trustworthy.** A view from above is worth nothing if the
  labels lie — which is why label attribution refuses to guess (§6).
- **The board never acts on its own.** Top-down control means *you* direct.
  Routines run only when switched on, nothing is written to any external system, and no transcript is
  ever altered (§13).

---

## 2. What problem this solves

Claude Code sessions are invisible. They live in terminal windows that get buried,
and once closed the work in them is hard to find again. Meanwhile the real
context — which label, which folder, which deadline, which hours — lives
in four other systems that never see the sessions at all.

Claude Command makes every session a card, and every card carry its context:

| The question | Where the answer comes from |
|---|---|
| What am I working on? | Sessions discovered from `~/.claude/projects/` |
| Which label is this? | The folder it ran in, or the label folder it wrote files into |
| What did Claude actually do? | Tool calls counted from the transcript |
| What did it produce? | Write-tool calls, document paths named in the transcript that changed during the session, plus an mtime sweep of a project cwd |
| Where are the documents? | The label's folder, indexed from disk |
| Where does it live upstream? | Deep link, from the label index |
| What's due? | macOS Calendar, matched on file number |
| What haven't I billed? | Transcript activity, minus what is already recorded elsewhere |

---

## 3. Architecture

Three processes, one of which owns the other two.

```
┌──────────────────────────────────────────────────────────────┐
│  Claude Command.app          (Swift / AppKit / WKWebView)      │
│  • owns the windows, menus, zoom, JS dialogs                 │
│  • spawns and reaps the node server                          │
│  • opens external links in the default browser               │
└───────────────┬──────────────────────────────────────────────┘
                │ spawns (and kills on quit)
┌───────────────▼──────────────────────────────────────────────┐
│  node server/index.js      127.0.0.1:4317                    │
│  • REST API + WebSocket terminal multiplexer                 │
│  • SQLite board state, transcript scanning, integrations     │
│  • owns every live PTY                                       │
└───────────────┬──────────────────────────────────────────────┘
                │ node-pty
        ┌───────▼────────┐   ┌──────────────┐   ┌─────────────┐
        │ claude session │   │ calendar-dump│   │ python3     │
        │ (real PTY)     │   │ (EventKit)   │   │ label cmd   │
        └────────────────┘   └──────────────┘   └─────────────┘
```

**Why the app owns the server.** Launching starts `node server/index.js`; quitting
terminates it. If a server is already listening (say you ran `npm run dev` in a
terminal), the app *adopts* it and deliberately leaves it running on quit — it
belongs to someone else.

**Why a real app and not a browser tab.** A Dock icon you can find, its own window
and zoom, and — the deciding factor — a place to hold the PTYs that isn't a tab
you might close by accident.

### More than one window

⇧⌘N opens another board window, ⌘T another tab of one. Every window is a view
of the same server, so a card moved in one moves in the other; what differs is
where each window is pointed. (The other keys — ⌘N new session, ⌘F find card,
⌘B brief, ⇧⌘B billing, ⌘U usage — are menu items too, calling into a small `window.__app` bridge the page exposes;
a menu key equivalent is the only kind that still fires while xterm has focus.) On a desk with several displays that is the whole point — the board on
one screen, a session's terminal on another, the calendar on a third — and it is
why the board never had to grow its own split-pane layout.

Three things make that usable rather than merely possible:

- **A new window opens on a screen that hasn't got one yet** — the display under
  the pointer if it is free, otherwise the first free display, and only when
  every display is occupied does it cascade off the last window.
- **The layout comes back.** Every open window's frame is written to
  `boardWindowFrames` on quit, and on the way out of the *last* close, so
  quitting by closing windows restores what you had rather than erasing it. An
  empty list is never saved. Frames that land on a display that is no longer
  attached are pulled back on screen by `ensureOnScreen`.
- **Each window remembers its own section.** The shell opens window *N* as
  `/?w=N`, and `perWindow()` in the web app keys `view` and `boardId` by that
  number, so window 2 stays on the calendar while window 1 stays on the board.
  Window 1 uses the unsuffixed keys, so nothing already saved is lost and a plain
  browser tab is unaffected.

Sheets — the JS dialogs and the folder picker — attach to the window that asked,
not to whichever window is frontmost, which is why the bridge and the UI delegate
live on the window object rather than on the app delegate. The message handler is
registered through a weak `BridgeProxy`, because `WKUserContentController` retains
its handlers and a closed window would otherwise never be freed.

Zoom is per window (a laptop screen and a 32" display want different sizes); the
last zoom set is what the next new window opens at.

One thing macOS does on its own: if the app had a window in full screen, the
first window of a relaunch is adopted back into that Space, whatever frame it was
given. Later windows are placed as asked.

### Ports and paths

| | |
|---|---|
| Server | `127.0.0.1:<port>` (loopback only, 4317 by default) |
| Repo | wherever you cloned it |
| App bundle | `/Applications/<appName>.app` |
| Board state | `<repo>/data/board.db` (SQLite, WAL) |
| Label cache | `<repo>/data/labels.json` |
| Calendar helper | `<repo>/bin/calendar-dump` |

---

## 4. Core concepts

### Session
A conversation with a coding agent, discovered by scanning what that agent wrote
to disk — `~/.claude/projects/*/*.jsonl` for Claude Code, `~/.codex/sessions/
YYYY/MM/DD/rollout-*.jsonl` for Codex. Never created by the board unless you ask
for one. Transcripts are **read only** — nothing in this system edits or deletes
them.

Only interactive sessions become cards. Claude Code marks those `entrypoint:
cli`; automation pipelines run as `sdk-cli`, and including them would bury the
board under hundreds of headless runs. The Codex equivalent is the `originator`
field: `codex-tui` is a terminal session, and anything else — `Codex Desktop`,
`codex_work_desktop` — is the ChatGPT app's own window, which is somebody else's
surface and not a card here.

### Engine
Which coding agent a session is: **Claude Code** or **Codex**. One switch in the
header decides what the next session starts as, and it governs every path that
opens a terminal — the new-session dialog, a hand-written card, a calendar event,
a scheduled routine. See §4a.

### Card
A session's representation on the board. Cards are deliberately spare — status,
label, title, when it last moved, and a way in. Everything else is one click away.

Card state lives in SQLite keyed by session id: which column, what position, a
title override, notes, archived flag. Discovery is idempotent — a session seen for
the first time gets a card in the first column of the default board.

### Manual card
A card you type in yourself, with no session behind it. Created from a column's
**+ Add a card**, or from a calendar event. A manual card can be promoted: *Start
session* attaches a real session to it, keeping its column, position, title and
notes rather than creating a second card.

### Board
A tab holding its own independent columns. Ships with **Cases**, **Personal**, and
**Admin**. A card moves between boards from its **⋯** menu.

### Column and review lane
Columns are data, not code — rename, recolor, reorder, add, delete, all from the
UI. Deleting one relocates its cards rather than dropping them.

A **review lane** is a narrow column bound to the work column on its left. When
Claude finishes in that column, the card moves into the lane automatically. Cases
has lanes on *Strategy & Intake* and *Document Drafting*; *Filing* and *Complete*
are terminal stages and have none. Any column can gain or lose a lane with the ✓
in its header.

---

## 4a. Two engines

The board runs Claude Code sessions and Codex sessions. A switch beside **+ New
session** decides which one the next session is; it is board-wide and persists
across restarts.

**The switch is about what starts next, not about what already exists.** A card
reopens in the engine it was started in, whatever the switch says now. Anything
else would either fail outright or — worse — quietly open an unrelated
conversation under a card you trusted.

Only Codex cards carry an engine badge. A board that is almost entirely Claude
gains nothing from a "Claude" badge on every card; what you need to see is the
one that is different.

### Where the two genuinely differ

Almost all of the difference is in one fact, and everything else follows from it.

**Claude Code accepts `--session-id`.** The board picks an id, hands it over, and
the transcript appears under that name. One id is both the card key and the
conversation's name.

**Codex names its own thread.** There is no flag to override it and no way to ask
the process what it got. So a codex card keeps the id the board gave it, and the
thread id is recorded beside it — `cards.engine_thread` — once the rollout shows
up on disk.

Finding it is `server/adopt.js`, and the shape of that file is dictated by a
measured fact: **Codex writes nothing to `~/.codex/sessions` when it launches.**
Not a header, not an empty file. The rollout appears when the first message is
actually sent — after the trust prompt on a new folder, after the MCP servers
finish starting (twenty seconds and up on a machine with several connectors),
and after you have finished deciding what to type. So the watch lives as long as
the session does rather than for a fixed window: a card that gets adopted an hour
late still works, and a fixed window would have produced a card that behaves
perfectly right up until the day you try to reopen it.

A session closed without a word said produces no thread at all. Nothing breaks
and nothing lies — the card keeps its own id and offers *Start* rather than
*Resume*, because there is no conversation to resume.

### What is weaker on the Codex side, and why it is left that way

**File attribution.** A Claude session announces every write as a Write/Edit tool
call with the path in it. Codex records `apply_patch` with full paths — which the
board reads — but it can also write by running a shell command, which is recorded
only as the command. A codex session that generates a document from a script is
therefore attributed by its working directory alone, and if that directory is not
a label folder it stays unattributed.

That is the same trade the rest of this program makes, and it is deliberate: an
unattributed session is honest, a wrongly attributed one bills the wrong client.
Nothing was added here that guesses a label from a path the session merely read.

**Usage and spend.** The Usage tab reads Claude Code's own token accounting and
plan limits. Codex records its token counts in a different vocabulary against a
different plan, and mixing the two into one number would produce a figure that
means nothing. Codex sessions are simply absent from that tab.

### Where the code lives

| File | What it owns |
|---|---|
| `server/engines.js` | The registry: binary, resume syntax, which engine is current |
| `server/codex.js` | Reading rollouts — sessions, transcript, files, time, prompts |
| `server/adopt.js` | Finding the thread a started session turned out to be |
| `server/sessions-io.js` | The three primitives both readers share |
| `server/pty.js` | Resolving each binary; spawning with the right arguments |

`server/sessions.js` merges the two scans and hands on one kind of object, so the
board, the cards, the mirror and the time log never branch on which engine wrote
what.

### Finding the binaries

A login shell is asked first, then a list of well-known locations. The case the
login shell misses is a shell **alias**, and it is not exotic: the ChatGPT desktop
app ships the Codex CLI inside its bundle, and the usual way to reach it is
`alias codex="/Applications/ChatGPT.app/Contents/Resources/codex"` in `.zshrc` —
which a non-interactive shell never reads and a spawned process could not execute
anyway. That bundle path is in the candidate list for exactly that reason.
Anything stranger is what `engines.<id>.bin` in `config.json` is for.

---

## 5. The sections

### Board
Fills the screen. Scroll down for the session panel; the header stays pinned.
Clicking a card selects it without moving the board — **Open**, or a double-click,
takes you down to the panel.

The panel has four modes:

- **Summary** — where a session opens. A few bullets on what Claude was doing,
  read off the transcript: what it said last, files edited and which, commands
  run, subagents dispatched. Nothing is model-generated, so it costs nothing and
  cannot claim work that didn't happen.
- **Terminal** — a live PTY. Real keys, real colour, real interruption.
  The button beside it reads **Resume here** when there is a conversation to pick
  up and **Start session** when there isn't — a card can exist before its
  conversation does, because Claude Code writes no transcript until the first
  message. The label is a hint only: `/api/sessions/:id/start` decides from
  whether a transcript file exists, so asking to resume something that was never
  started begins it instead of failing with *"No conversation found with session
  ID"*. Either way the session keeps the card's id, so the card follows it.
- **Mirror** — the rendered transcript for a session the board doesn't own.
- **Files** — what the session produced. The current .pdf and .docx files are the
  list — a copy in a `_Superseded/` folder (or moved into one after the session
  wrote it), a scratchpad working copy, or a file since removed is folded into a
  collapsed group, so the top row is the document to open;
  markdown sits behind a toggle that is off by default, and scripts and other
  files behind a second. Three sources, each labelled on its row: *written* (a
  Write call), *generated* (a document path the transcript names — in a command,
  a script's output, or the reply — that changed at or after the moment the
  transcript first named it, so a file that predates the session stays out; this is how script-built .docx in a Dropbox matter
  folder gets found — and a bare `SAVED 01 First Amended Complaint.docx` with
  no folder is resolved against every folder the session itself named, because
  that is how build scripts announce their output), *arrived during the session* (named in the transcript,
  already on disk when named, but newer than the session's start — a Court
  Watch download the session then handled), and *changed while it ran* (the
  mtime sweep of the cwd). The sweep is skipped when the cwd
  is the home folder, because there it would list every court PDF that landed in
  Downloads as if the session had made it.

### Live
Every running session side by side, each a real terminal. A tile is *working*
while Claude is producing output and *idle* once the transcript goes quiet.

Every tile is also a `claude` process holding its conversation in memory —
250–500 MB each — and sessions started from the board are never closed on their
own, so a board left up for a week accumulates dozens and several gigabytes.
The header says how many and how much; **✕** closes one and the sweep closes
everything idle past a threshold. Closing is not destructive and the wording
says so: the process ends, the transcript, the card and the ability to resume
all stay. The sweep never touches a *working* session however long its
transcript has been quiet, because that is the one case where idle time lies.

### Usage
What the sessions are actually spending, refreshed every few seconds (§8.5).

### Calendar
Upcoming events from every macOS calendar, grouped by day, each label event
carrying its upstream link, its folder, and the cards on your board for that
label. An event with no card offers **+ Card** and **+ Card & session**; the
session starts in that label's folder. Past events don't offer either.

### Skills
The skills in `~/.claude/skills`. *Run* opens a session on the board and types the
command into it, so you can watch it work and answer its prompts.

### Scheduled
Daily routines. *Run now* works like Skills. *Auto* runs one at its set time —
**only while the app is open**, and a missed day is never backfilled. Nothing runs
unless switched on. For automation that must run regardless, use launchd.

### Time
Working hours reconstructed from transcripts, netted against whatever already records them (§8).

### Team
The agents in `~/.claude/agents` as an org chart and roster. Reporting lines are
read from each agent's own brief — an agent sits under another because its prompt
says so, not because a second list says it.

### Archive
Every closed card, searchable, showing the board and column it came from.
Restoring puts it back where it was; if that column is gone it lands in the first
one and says so.

### New session
Three decisions, in the order they label.

**Which folder.** This is the only genuinely technical question the app asks, and
it is asked in the plainest terms available: *the folder Claude can read and
write*. Four ways to answer it:

- **Browse…** opens a picker with three sources — **Labels** (all ~620 label
  folders on disk, searchable by file number or client name; this is the right
  answer for case work), **Recent** (folders sessions actually ran in), and
  **Browse** (walk the folder tree from Home, Desktop, Documents, Downloads,
  synced folders or code).
- **The Finder chooser**, offered at the top of the picker when running in the
  Mac app — a real `NSOpenPanel`, so Cmd-Shift-G, favourites and iCloud all work.
  Absent in a browser, where no web page can open one.
- **Drag a folder from Finder** onto the field. Finder supplies a `file://` URL,
  which the server decodes.
- **Type it.** Deliberately forgiving (§ below).

**What to call the card** — optional; blank means the session titles itself from
what you ask it.

**Where the card goes** — every column on *every* board, grouped by board. A new
session can start on any board, not only the first.

#### Typed folders are interpreted, not just validated
`server/paths.js` accepts anything that unambiguously names a real folder:

| Typed | Resolves to |
|---|---|
| `downloads` | `~/Downloads` — relative paths read against home, case-insensitively |
| `~/Desktop` | `~/Desktop` |
| `01953-Acme` | that label's folder |
| `file:///Users/you/Downloads` | `~/Downloads` — a Finder drag |
| `'~/My Folder'`, `~/My\ Folder` | quoting and shell escaping are stripped |

The resolved path is shown under the field *before* the session starts, with the
label number if it is one, so a wrong guess is visible rather than discovered
afterwards. What can't be resolved says what to do instead.

Two reasons for the leniency. The failure it replaces was silent: `resolve()`
against the *server's* cwd turned a typo into "no such directory", and a plain
`existsSync` fallback would have started the session in the wrong place without
saying so. And the correct casing labels downstream — the boot volume is
case-insensitive, so `~/downloads` opens fine but then fails to match a label
path anywhere else in the app. Every resolved path is canonicalised through
`realpathSync.native` for that reason.

---

## 6. Label attribution — the most important rules

Everything downstream (links, folders, deadlines, hours) hangs off knowing
which label a session belongs to. **These rules were arrived at by getting them
wrong first**, and the failures are recorded here because the temptation to
"improve" them will recur.

### Rule 1 — the working directory, when it names a label
`<root>/<group>/<label>/` is authoritative. Reported as *from folder*.

### Rule 2 — otherwise, label folders the session WROTE files into
Most sessions launch from `~`, so the cwd says nothing. The label whose folder
received the most write-tool calls wins. Reported as *from files*.

> **Rejected: scanning transcripts for any mentioned label path.**
> The first version did this and attributed a website migration to
> **01982-Dunn**, because that session had *read* something in the Dunn folder.
> It inflated label time from 20.1 to 32.0 hours. Reading is not working.

### Rule 3 — for calendar events, the file number in the title, and nothing else
Events often name the label outright: *"Mediation Neutral Selection Deadline
(01953-Acme)"*. A number counts only when it is a label that actually exists,
which stops docket numbers, dates and times matching by accident.

> **Rejected twice: matching the party name.**
> First attempt tied *"Acme v. Bolt"* to **00164-Acme** — an arbitrary Acme among
> many. Narrowed to names belonging to exactly one label, it then tied that same
> hearing to **01545-Vance**, because the title named the presiding judge, whose
> surname was also Vance. It had matched the judge. Event titles are full of
> judges, opposing parties and venues.

**The principle:** an unattributed session is honest. A confidently wrong
attribution puts a real deadline against the wrong label, or attributes hours to
work done for someone else. Where the system doesn't know, it says so, and the UI
labels every inference with where it came from.

---

## 7. Integrations

### The label index

Where the list of labels comes from is a plug, not a dependency. Two providers
ship:

- **`folders`** — the default. Walks `labels.root` to `labels.depth` and treats
  each leaf as a label. No account, no key, no network, and it is what most
  people should use.
- **`command`** — runs any program that prints `{"labels": {…}}` on stdout,
  cached to disk and refreshed every 12 hours in the background.

The `command` shape was chosen over writing an adapter per vendor. An adapter
means carrying somebody's API client into this repo and watching it rot the next
time that vendor renames a field; a command means the integration lives in forty
lines outside the repo, in whatever language already has credentials. The two in
`examples/` talk to Clio and were the original hardcoded integration.

The board never blocks on a command. It is spawned in the background, killed
after 60 seconds, and the last good result is served throughout — a stale link
beats a hung UI, and a broken command must degrade to "no labels", never to "no
board".

> An index that supplies a `status` lets finished work be excluded from name
> matching. One that does not — folders on disk — reports none, and everything
> it knows counts. The detector treats a missing status as open rather than
> skipping the label, which is the difference between the folders provider
> working and silently matching nothing.

### Label folders

Folders are resolved from disk **whatever the index is**, because an index that
lives on somebody's server has no way to know where the files landed on yours.
`labels.root` is walked to `labels.depth` into a label→path map, rebuilt every 10
minutes. The folder icon opens it in Finder.

> Indexed rather than reconstructed. The parent folder doesn't reliably match
> the label — in the install this was written for, one matter lived under a
> client folder named for an entirely different party. Building a path by
> concatenating the label key would point at a folder that isn't there.

### Calendar
macOS EventKit via a small Swift helper — **no OAuth, no new scopes, no token to
keep alive**, because the calendars are already synced into macOS Calendar.
Cached 5 minutes. `calendars.work` names the ones whose events may carry a label;
an empty list still shows events but never attributes one.

**Recovering from a denied prompt.** macOS asks for calendar permission once. If
the answer is no, EventKit stops asking and returns false forever — the section
just breaks, and the only documented route back is System Settings. So the helper
reports a denial distinctly (`{"error": …, "denied": true}`), and the Calendar
section replaces its listing with **Ask me again**, which runs
`tccutil reset Calendar <bundle id>` and immediately re-reads — clearing the
recorded answer is what makes the system put its dialog back up. A link to the
Privacy pane sits beside it for the case where the reset isn't enough.

It is a button, not automatic. Re-prompting on every visit would mean a
deliberate "no" could never be made to stick, and a permission dialog that
reappears until you give in is a dark pattern.

### Reports
Point `reports.dir` at a folder of dated HTML and the panel iframes it verbatim,
with a date picker back through whatever is there. Deliberately dumb: it
generates nothing and renders nothing of its own, so what you see is the real
file. Off unless configured, in which case the tab hides rather than showing an
empty shell.

---

## 8. Time log

Consecutive transcript activity counts as working time; a gap longer than the idle
threshold (default 10 minutes) does not. Hours round **up to the tenth**, the way
billing systems do.

Tracked time is then netted against time already recorded elsewhere for the same
label and day, so the tab shows what is **not yet entered**.

**This is a starting point for a time entry, not an entry.** Nothing posts
anywhere. *Copy as TSV* gives rows to work from.

Known limit: matching is by label *and day*. Time logged on a different date than
it was worked won't net out.

---

## 8.5 Usage

Every assistant turn Claude Code writes carries the API's own `usage` block —
input, output, cache reads, cache writes, a model and a timestamp. That is the
only token ledger on the machine, and it is exact: these are the numbers
Anthropic billed, not an estimate of them.

**Two things it is not, and the panel says both in its own footer.**

The token counts are not a plan meter, and no arithmetic turns them into one:
the plan is an allowance measured in Anthropic's units, not in tokens. So the
token bars are scaled against *the busiest equivalent stretch of the same
window* — "78% of your busiest 5 hours this week" is a question this data can
answer, where "78% of your limit" would be invented. The real headroom figure
comes from somewhere else entirely; see the plan meter below.

And the dollars are list API prices for the tokens spent, not what a
subscription paid. They are there because *4.8M tokens* says nothing about
whether one matter is expensive and another isn't, and *$386* does.

Three things make it cheap enough to poll every 5 seconds:

- **Incremental reads.** A transcript only ever grows, so each pass reads the
  bytes appended since the last one and remembers the offset, stopping at the
  last complete line so a half-written one isn't lost. First pass over a week:
  about a second for ~400 MB. Every pass after it: a `stat()` per file.
- **Regex, not `JSON.parse`.** Nearly all of that is prompts and tool output
  this never looks at; parsing all of it to read six integers costs roughly
  fifty times as much. Every field sits at a fixed place relative to `"usage"`
  — the model before it, the timestamp and requestId after — so the first match
  on the correct side is the top-level one and the repeats inside `iterations`
  are never picked up.
- **requestId is the unit, not the line.** Claude Code writes one line per
  content block of the same assistant turn, each carrying an identical copy of
  the usage. Counting lines multiplies the bill by however many blocks the turn
  happened to have.

**Two double-counting traps, both handled, both silent if they aren't.** A
subagent's result is echoed back into the *parent* transcript as a `user` line
whose `toolUseResult` carries a copy of the subagent's usage — the sidechain
transcript bills those tokens, so lines carrying a tool result are skipped. And
the discriminator has to be `"role":"assistant"` inside `message`, not the
top-level `"type":"assistant"`, which on a real assistant line comes *after* the
usage block. The invariant to test against: `byLabel` and `byModel` must each
sum exactly to the week total.

**The walk has to be recursive, and that is not a detail.** Transcripts live at
`projects/<project>/<sessionId>.jsonl`, but a session's subagents write to
`projects/<project>/<sessionId>/subagents/agent-*.jsonl` — one level down. On
this machine that nesting holds **40% of every token ever spent** (2.5B of 6.4B;
19,449 of 37,217 billed requests), because a subagent does its own reading and
its own thinking and hands back only a summary. A walk that stopped at the top
level combined with the `toolUseResult` skip above to drop that spend at *both*
ends: the parent's copy was skipped as a duplicate of a file that was never
read. The skip is only correct if the sidechain is scanned.

Subagent spend is attributed to the session that spawned it — the directory
holding `subagents/` is named for it — not to its own id. The work was done for
that matter, and `agent-a95a89bee0a15240a` is a name nothing else on the board
can resolve. requestIds were checked for cross-file reuse before relying on
this: across 37,316 distinct ids, **zero** appear in more than one transcript,
so per-file dedupe is exact and a whole-history scan cannot double-count.

### 8.5.2 Week over week (`server/history.js`)

`buildUsage` answers "what is happening now" and holds eight days to do it.
`buildHistory` answers the slower question — is this week heavier than the last
five — and to do that it reads *everything*: ~1.5 GB across ~880 transcripts.

**The weeks are the plan's weeks.** The subscription resets on a Friday evening,
so a Monday-to-Sunday chart would cut every week in two and neither half would
mean anything. The boundary comes from the same `weekly_all` reset that feeds the
plan meter, rounded to the minute, and is remembered in the cache file — the
chart keeps its shape while the machine is offline, and says so (`anchorSource`
is `plan`, `remembered`, or `assumed`).

Three things make a full scan affordable:

- **It is genuinely fast.** Regexes over lines that mostly don't match: the whole
  history reads in about 3.4 s.
- **It happens once.** Every file's 5-minute buckets are cached against its size
  and mtime and written to `data/usage-history.json`, so a restart re-reads only
  what changed — for a transcript finished last Tuesday, nothing. Cold 3.4 s,
  warm 0 ms. The cache carries a fingerprint of the price table, because it
  stores *costs*, and an edit to the prices would otherwise leave last month
  charted at rates that no longer apply.
- **It yields.** 3.4 s of straight-line work would freeze the board for 3.4 s —
  there is one thread. The scan hands control back every dozen files, and reads
  each file in 8 MB chunks so a 200 MB transcript doesn't spike memory (248 MB
  heap for the full pass; slurping whole files instead reached 2.8 GB).

**A half-finished week cannot be compared to a finished one**, and a chart that
tries is worse than no chart — every Monday would look like a quiet week. So
each past week also reports `toDate`: what it had spent by the same hour the
current week has reached. The current bar carries a tick at last week's `toDate`
and a hollow cap at the current pace's projection, and the legend states the
comparison in words.

Attribution reuses §6 unchanged, including its "unattributed is better than
wrong" rule — the unattributed row is shown rather than hidden, because on a
week of work it is usually the largest one and pretending otherwise would make
every other row look bigger than it is.

### 8.5.1 Plan limits (`server/limits.js`)

The percentages at the top of the panel are the only figures in it that do not
come from disk. They are the same ones Claude Code prints under
`/status → Usage`, fetched the same way it fetches them:
`GET https://api.anthropic.com/api/oauth/usage`, authorized with the OAuth
token Claude Code stores in the login keychain under `Claude Code-credentials`.
`security` inherits the server's keychain access, so the read is silent for a
server the same user started and simply fails — rather than prompting — for one
that isn't.

Three deliberate constraints:

- **No token refresh, ever.** The credential belongs to Claude Code; racing it
  over a refresh could sign the whole machine out. An expired or rejected token
  is reported as a message and waited out — any running session renews it within
  the hour and writes the new one back, where the next poll finds it.
- **Render whatever comes back.** The response carries a `limits` array
  (`session`, `weekly_all`, and a `weekly_scoped` row per model), not fixed
  keys, so a new cap or a promo window appears on the wall without a code
  change. Nothing here names the limits it knows about today.
- **Failure is local.** The meter is a separate endpoint and a separate poll
  from `/api/usage`, cached 60 s on success and 15 s on failure. An offline
  machine loses three bars; the token counts underneath are still exact.

One formatting trap worth keeping: weekly resets come back at `:59:59`, which
truncates to the hour before and reads an hour early. Round to the nearest
minute before formatting, as `/status` does.

---

## 9. Data model

SQLite at `data/board.db`. Only board state lives here — everything else is derived
from disk or fetched live.

```
boards    id, name, position
columns   id, name, position, color, wip_limit, board_id, review_of
cards     session_id, column_id, position, title, notes, cwd,
          archived, archived_at, pinned, manual, auto_moved_activity, updated_at
routines  id, name, command, cwd, time_of_day, enabled,
          last_run_at, last_session_id, position
settings  key, value
```

- `cards.session_id` is the Claude session UUID, or `manual_<uuid>` for a
  hand-made card. Promoting a manual card rewrites this key in place.
- `columns.review_of` points at the work column a review lane belongs to.
- `cards.auto_moved_activity` records the activity timestamp a card was last
  auto-moved for, so a card dragged back out of review doesn't jump straight in
  again.

Schema changes are applied as guarded `ALTER TABLE`s at startup, and one-time
reshapes are keyed on a `settings` flag so they never fight a later manual edit.

---

### 9.9 Never walk a cloud mount on the event loop (2026-10-09)

The label-folder index (`providers/folders.js`) used to `readdirSync` the
labels root — the Clio tree on Dropbox — every ten minutes, on the label
watcher's timer. On srv1 one matter folder was a cloud-only placeholder whose
`open()` never returned: the main thread sat in the kernel at 0 % CPU, every
request timed out, SIGTERM was ignored, and only `kill -9` ended it. It looked
like an app problem (it struck a few minutes after the window attached) and was
not one. Node's `--trace-sync-io` found it: the last sync call logged before the
silence was `walk()` in `folders.js`.

The walk now runs in a child process (`folders-walk.js`) that streams leaves as
it finds them; the parent keeps whatever arrived when the 20-second clock runs
out, merges it over the previous index, and tries again at the next refresh.
Callers still get a `Map` synchronously — the last good one. The same hazard
remains in `sessions.js`'s mtime sweep of a session's cwd, which is bounded by
depth and count but not by time.

## 10. Server modules

| Module | Responsibility |
|---|---|
| `index.js` | HTTP + WebSocket API, board assembly |
| `db.js` | SQLite schema, migrations, board/column/card operations |
| `sessions.js` | Transcript discovery, parsing, summaries, label inference |
| `pty.js` | Live terminals — spawn, buffer, multiplex, reap |
| `review.js` | Sweeps finished sessions into review lanes |
| `timelog.js` | Working-time reconstruction and netting |
| `usage.js` | Token spend from transcript `usage` blocks, incrementally |
| `limits.js` | Plan headroom from Anthropic, via Claude Code's keychain token |
| `history.js` | Whole-history spend by plan week, cached per transcript on disk |
| `providers/command.js` | Label index from an external program |
| `providers/folders.js` | Label index and folder map from disk |
| `config.js` | Everything specific to one machine |
| `paths.js` | Interpreting typed folders, browsing, Finder-style shortcuts |
| `calendar.js` | EventKit helper, event→label matching |
| `skills.js` / `agents.js` | Read `~/.claude/skills` and `~/.claude/agents` |
| `routines.js` | Daily routines and the in-process scheduler |
| `brief.js` | Locates morning briefs; owns the one session that writes them |
| `caffeinate.js` | Display-awake toggle |

---

## 11. Traps worth remembering

Things that cost real debugging time and will bite again.

**node-pty's `spawn-helper` loses its exec bit.** npm drops it; every terminal
then fails with `posix_spawnp failed`. A `postinstall` restores it.

**`CLAUDE_CODE_*` markers must be stripped from spawned sessions.** A board
launched from inside a Claude session passes its markers to children, which makes
them think they're nested agents — and *silently turns transcript saving off*.
Cards then never get titles and mirrors stay empty. Verified by A/B test.

**WKWebView answers `prompt()` with null and `confirm()` with false** unless the
app puts up a panel. Renaming cards and boards, and every delete confirmation,
did nothing at all until native sheets were implemented. This worked in Chrome
throughout, which is exactly why it was missed.

**A scroll issued inside `requestAnimationFrame` is discarded here**, and
`behavior: 'smooth'` is a no-op in the app's WebView. Scrolling to the panel uses
a direct call, a retry, and a hard fallback.

**`.fullSizeContentView` made the window immovable.** The web view covered the
title bar and the resize edges, so the window could be neither dragged nor
resized. It now uses a standard title bar.

**Test in the app, not in Chrome.** Chrome is a convenience for development. Three
separate bugs — dialogs, scrolling, window chrome — existed *only* in the app.

**A web page cannot open a folder chooser.** `<input type="file">` hands
JavaScript a *file*, never a path, and `webkitdirectory` is no better. The Finder
panel exists only because the app opens a real `NSOpenPanel` through a
`WKScriptMessageHandlerWithReply` bridge (`window.webkit.messageHandlers.host`)
and hands the path back. Anything that depends on it must degrade — the picker's
Labels/Recent/Browse tabs work everywhere, and the Finder button appears only
when `hasNative()` says the bridge is there.

**Bridge code has the same silent-failure shape as `prompt()`.** It was tested,
before shipping, with a temporary self-test that posted its results to the server:
the round trip returned `pong`, an unknown command rejected with a message, the
panel was confirmed on screen via `window.attachedSheet != nil`, and a cancel
returned `undefined` — which `native.ts` maps to null. A cancelled panel and a
broken bridge look identical from JavaScript, so "it did nothing" proves nothing.

**`caffeinate` is spawned with `-w <server pid>`** so it dies with the server. A
bare `caffeinate -d` orphaned by a crash leaves the Mac permanently awake with
nothing left to switch it off.

**A card can outlive nothing at all.** Cards exist before conversations do:
`+ New session` creates one immediately, but Claude Code writes no transcript
until the first message, so abandoning a session and coming back after a restart
leaves a card whose id names a conversation that never existed. Anything that
assumes a card implies a transcript — resume, mirror, summary, label inference —
has to cope with `path === null`.

**Nothing may pass an unexpanded `~` to `startTerm`.** It falls back to the home
directory for any path it cannot stat, so a literal `~/Downloads` starts the
session in the wrong place and says nothing. Every caller resolves paths first.

**A failing helper's real error is on its stdout, not in the exception.**
`execFileSync` throws `Command failed: …/calendar-dump 21 1` — which is what the
UI showed a denied calendar as, saying nothing about permission. The helper's own
JSON explanation was sitting in `err.stdout` unread. Any helper that reports
failures as data needs its stdout parsed in the catch block.

**Review lanes flood on first run.** Every dormant session looks "finished". The
first sweep moved 34 historical sessions into Review before a 4-hour recency
window was added.

---

## 12. Operating it

```bash
./start.sh                                # browser, no Xcode needed
open "/Applications/Claude Command.app"   # the Mac app, once built
./app/build.sh                            # rebuild the app after a Swift change
npm run dev                               # hot-reload UI on :5180, API on :4317
SB_REQLOG=/tmp/req.log node server/index.js   # see what a window is asking for
```

`start.sh` is the path with no build tools in it: Node installs the deps, Vite
builds the UI, and the board opens in a browser. The Swift shell and the calendar
helper are the only pieces that need Xcode, and both are optional.

`app/build.sh` builds the UI, regenerates the icon, compiles the Swift shell and
the calendar helper, writes `Info.plist`, and ad-hoc signs the bundle.

**Diagnosing a blank or stale window:** check the server is up
(`curl 127.0.0.1:4317/api/board`), then check what the window is requesting with
`SB_REQLOG`. The app bundle discards server output, so that flag is the only way
to see it.

**If the app is force-killed** the server survives and keeps running. Relaunching
adopts it. To clear it: `kill $(lsof -ti tcp:4317 -sTCP:LISTEN)`.

---

## 13. Deliberate non-goals

- **Nothing is written to any external system.** Time is surfaced for review only.
- **Nothing runs on its own** unless a routine is explicitly switched on, and then
  only while the app is open.
- **No transcript is ever modified or deleted.** Archiving and renaming touch only
  this system's database. Even a permanent delete removes the card, never the
  session behind it.
- **No credentials of its own.** A label command brings its own auth; the
  calendar is read through the OS.
- **No cloud, no sync, no telemetry.** Loopback only.

---

## 14. Where this could go

Left undone deliberately, in rough order of value:

1. **launchd for routines**, so a scheduled run happens whether or not the app is
   open — the current scheduler only fires while it is.
2. **A write side to the time log.** Everything needed to push an approved entry
   back is already there; what is missing is an approval step worth trusting, and
   shipping the write without it would break the promise in §13.
3. **Web links alongside the Finder ones**, for reading a label's folder from a
   phone.
4. **Board-level WIP limits** — the column already carries the field, unused.
5. **Tests.** There are none. The label detector and the time log are the two
   places where a plausible wrong answer is worse than no answer, and both have
   been wrong once in ways that looked entirely reasonable.
