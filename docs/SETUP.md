# Setting up Claude Command

Everything you need to go from a clone to a working board, and then to turn on
each optional piece. Nothing past section 3 is required — the board works with
no configuration at all, and each later section is something you switch on only
if you want it.

- [1. Requirements](#1-requirements)
- [2. Install](#2-install)
- [3. First run](#3-first-run)
- [4. The Mac app](#4-the-mac-app)
- [5. Configuration reference](#5-configuration-reference)
- [6. Labels](#6-labels)
- [7. Connecting Clio](#7-connecting-clio)
- [8. The time log](#8-the-time-log)
- [9. Calendar](#9-calendar)
- [10. Reports](#10-reports)
- [11. The billing tab](#11-the-billing-tab)
- [12. Where your data lives](#12-where-your-data-lives)
- [13. Troubleshooting](#13-troubleshooting)

---

## 1. Requirements

| | | |
|---|---|---|
| **Claude Code** and/or **Codex** | at least one | The board runs your sessions with the `claude` or `codex` command. Install one, run it once in a terminal to sign in, and pick which one new sessions use with the switch in the header. [Section 5a](#5a-choosing-an-engine). |
| **Node 20+** | required | `node -v`. Older majors fail on `better-sqlite3`'s prebuilt binary with an unreadable `NODE_MODULE_VERSION` error. |
| **macOS 12+** | required | Session discovery is cross-platform, but the terminal, the Finder panel and the calendar helper are Mac-specific. |
| **Xcode command line tools** | optional | Only for the Mac app and the calendar helper. `xcode-select --install`. |

You do **not** need an API key of any kind. The board never calls an API — it
starts `claude` or `codex` processes and reads the transcripts those tools
already write, to `~/.claude/projects/` and `~/.codex/sessions/` respectively.
Your sign-in to whichever you use is the only credential involved.

## 2. Install

```bash
git clone https://github.com/Davemadgett/claude-command.git
cd claude-command
./start.sh
```

`start.sh` installs dependencies on first run, builds the UI, starts the server
on `127.0.0.1:4317`, and opens the board in your browser. Re-run it any time;
it only rebuilds what changed.

Use a different port with `PORT=4400 ./start.sh`.

To stop it, Ctrl-C in that terminal.

## 3. First run

The board finds your existing Claude Code sessions immediately — anything under
`~/.claude/projects/` from the last 7 days, as cards. There is nothing to
import and nothing to connect.

Two boards to start, **Work** and **Personal**, each with **To Do**, **Your
Turn** and **Done**. Rename them, recolor them, add and delete columns: they are
rows in a database, not code.

**+ New session** starts a fresh Claude session. It asks one thing — which
folder to work in — and that answer is the only setup a session needs. Pick it
from *Recent*, walk to it under *Browse*, drag it in from Finder, or type a
path (`downloads` and `~/code/thing` both resolve).

If you see a banner saying Claude Code isn't installed, the board could not find
the `claude` command. Install it, run `claude` once to sign in, and reload.

## 4. The Mac app

`./app/build.sh` wraps the same board in a real app: its own Dock icon and
window, the native Finder panel in the folder picker, and calendar access. It
needs Swift, from the Xcode command line tools.

```bash
xcode-select --install     # once, if you don't have it
./app/build.sh
open "/Applications/Claude Command.app"
```

**⇧⌘N opens another window, ⌘T another tab.** They are all views of the same board, so this is for
spreading the work across displays — the board on one screen, a session's
terminal on another. Each window remembers the section it was showing, and the
whole layout — how many windows, and where each one sat — comes back on the next
launch.

**The keys.** They are menu items, so they work even while a terminal has the
keyboard — and they're all "go there", never toggles, so a second press is
harmless.

| Key | Does |
| --- | --- |
| ⌘N | New session |
| ⌘T | New tab (another view of the board, in this window) |
| ⇧⌘N | New window |
| ⌘F | Find a card on the board by name or matter (Esc clears) |
| ⌘B | Morning Brief |
| ⇧⌘B | Billing (when configured — see Section 11) |
| ⌘U | Usage |
| ⌃⌘F | Full screen |

In a browser (`./start.sh`) ⌘F / ⌘B / ⇧⌘B / ⌘U work the same; ⌘N and ⌘T are
the browser's own there.

The app owns its server — launching starts it, quitting stops it. If a server
is already running it attaches to that one instead and leaves it alone on quit,
so `./start.sh` in a terminal and the app can coexist.

Set `appName` and `bundleId` in `config.json` before building if you want your
own name on it; a fork then builds its own app rather than replacing this one.

## 5. Configuration reference

Configuration lives in `config.json` beside `package.json`. **There is no
`config.json` in a fresh clone, and that is a supported state** — every key has
a default that produces a working board. Copy `config.example.json` and delete
what you do not need.

`config.json` is gitignored, which is what makes it the right place for tokens.

| Key | Default | What it does |
|---|---|---|
| `appName` | `Claude Command` | Window title, header wordmark, and the app bundle's name. |
| `bundleId` | `com.example.claudecommand` | macOS bundle identifier. Change it if you fork. |
| `principal` | `You` | Who sits at the top of the Team org chart. |
| `port` | `4317` | Server port. `PORT=` in the environment wins. |
| `engines.<id>.bin` | auto | Where an engine's command lives, when it is somewhere the board would not think to look. [Section 5a](#5a-choosing-an-engine). |
| `labels.*` | off | Which piece of work a session is about. [Section 6](#6-labels). |
| `timeLog.postedCommand` | off | Hours already recorded elsewhere. [Section 8](#8-the-time-log). |
| `calendars.work` | `[]` | Calendars whose events may name a label. [Section 9](#9-calendar). |
| `reports.dir` | off | A folder of HTML reports to show in the panel. [Section 10](#10-reports). |
| `billing.db` | off | A billing brain (SQLite) to show as the Billing tab. [Section 11](#11-the-billing-tab). |

Point somewhere else entirely with `CC_CONFIG=/path/to/config.json`.

The server reads `config.json` once at startup, so restart after editing it.

## 5a. Choosing an engine

The switch beside **+ New session** decides which coding agent the next session
starts as — **Claude** or **Codex**. It is board-wide, and it survives a restart.

It governs everything that opens a terminal: the new-session dialog, *Start
session* on a hand-written card, a card made from a calendar event, and a
scheduled routine.

**It does not change anything already on the board.** A card reopens in the
engine it was started in, whatever the switch says at the time. Codex cards carry
a small `codex` badge so a mixed board reads at a glance; Claude cards are
unmarked, because on most boards that is the majority and a badge on every card
would say nothing.

An engine that is not installed shows greyed out rather than hidden, so the board
never looks like it was only ever built for one of them.

### If the board can't find `codex`

It asks a login shell first, then checks the usual install locations —
including `/Applications/ChatGPT.app/Contents/Resources/codex`, which is where
the ChatGPT desktop app puts it.

That last one matters because the common way to reach that binary is a shell
alias:

```zsh
alias codex="/Applications/ChatGPT.app/Contents/Resources/codex"
```

An alias lives in `.zshrc`, which a non-interactive shell never reads — and a
spawned process could not run an alias anyway. The board looks in the bundle
directly for that reason, so an alias setup works without any configuration.

For anything stranger — a version manager, a wrapper script of your own — name
the path:

```json
{ "engines": { "codex": { "bin": "/opt/whatever/bin/codex" } } }
```

### Two things to know about Codex sessions

**Codex takes much longer to accept input.** It starts its MCP servers before the
composer is live, which on a machine with several connectors runs to twenty
seconds and more. Typed input before then is dropped, not queued. This only
matters for scheduled routines, which wait accordingly.

**A codex session isn't identifiable until you send the first message.** Codex
names its own thread and writes nothing to disk until something is actually said,
so the board watches for the rollout to appear and attaches it to the card then —
seconds later, or an hour later, whenever you type. Until that happens the card
works normally but offers *Start* rather than *Resume*, because there is no
recorded conversation yet. A session you open and close without saying anything
never produces one at all, which is correct: there is nothing to reopen.

## 6. Labels

**Optional, and off until you configure it.** Skip this whole section if you
just want a board.

A label is the answer to *which piece of work is this session about* — a client,
a case, an account, a product line. Cards show it, the time log groups by it,
the calendar matches events against it, and the folder picker gains a tab that
searches your labels directly.

### Folders as the label list

The simplest setup, and the one that needs no account, no key and no network:

```json
{
  "labels": {
    "root": "~/Projects",
    "noun": "project"
  }
}
```

Every subfolder of `root` is now a label. A session started in one is labelled
by it, automatically.

Two knobs for different filing habits:

- **`depth`** — `1` (the default) means `<root>/<label>`. `2` means
  `<root>/<group>/<label>`: a folder per client, and inside it a folder per
  engagement, where only the leaf is the label.
- **`pattern`** — a regex the leaf name must match. `"^\\d{3,6}-"` accepts
  `01994-Acme` and rejects an `Admin` folder that merely sits in the tree.

`noun` is what the UI calls one. Set it to `matter`, `client`, `account`,
`project` — whatever you actually say out loud. It appears in tab names, menu
items and column headers.

### A command as the label list

For anything with an API, `labels.index: "command"` runs a program of yours that
prints JSON:

```json
{ "labels": { "01994-acme": { "name": "Acme Corp", "url": "https://…" } } }
```

`name`, `url` and `status` are all optional. `url` is what makes the label badge
on a card a deep link into your system.

The board caches the result to `data/labels.json` and refreshes in the
background, so a slow or broken command never blanks the board — it keeps
serving the last good copy. Print `{"error": "…"}` to surface a problem in the
UI rather than an empty list.

Because the contract is only the shape of the output, this works for Jira, Harvest,
a CSV export, or a hardcoded dict. There are two worked examples in
[`examples/`](../examples), both talking to Clio, both about a hundred lines.

### Folders are still separate

`labels.root` matters even when the list comes from a command. The index knows
which labels exist; only your disk knows where their files are. Set both and a
card gets a working link *and* a working **open folder** button.

### Which label a card gets

A session started in a label folder is labelled from the folder — that is the
strongest evidence there is, and it needs no guessing.

Otherwise the board reads what *you typed*. A **key** matching a real label is
applied outright; you had to have meant that label to type its key. A **name**
never is — it raises a `01953-Acme?` chip on the card with a ✓ and a ✕, and a ✕
is remembered so the same guess is not offered twice.

That asymmetry is deliberate. Name matching was tried in the calendar matcher
and abandoned twice: titles are full of people you are meeting *about* rather
than *for*.

`labels.stoplist` stops your own subagents becoming labels. Name them after
people, as most do, and "have Lee check the cites" otherwise reads as a label
called Lee.

You can always set one by hand from a card's **⋯** menu, and a label you set
yourself outranks every inference.

## 7. Connecting Clio

Clio is one worked example of the `command` index, not a built-in integration —
but it is a complete one, and the same steps adapt to any other system.

### Getting a token

1. In Clio, go to **Settings → Developer Applications** and add an application.
2. Give it read access to matters (and activities, for the time log).
3. Run Clio's OAuth flow once and keep the **access token**. Clio's
   [authorization guide](https://docs.developers.clio.com/api-docs/clio-platform/authorization/)
   has the current endpoints and the exact exchange.

Access tokens expire. Clio issues a refresh token alongside; if you plan to
leave this running for months, have your script refresh rather than pasting a
new token periodically.

### Configuring it

```json
{
  "labels": {
    "index": "command",
    "command": ["/usr/bin/python3", "/path/to/claude-command/examples/clio-labels.py"],
    "env": { "CLIO_ACCESS_TOKEN": "…" },
    "root": "~/Dropbox/Clio",
    "depth": 2,
    "pattern": "^\\d{3,6}-",
    "noun": "matter"
  }
}
```

`root` and `depth` describe how your Clio files are laid out **on disk**, which
Clio itself has no way to tell the board. With `depth: 2`, a folder per client
containing a folder per matter, the matter folder is the label.

Set `CLIO_REGION` to `eu`, `ca` or `au` if you are not on the US instance.

Put the token in `labels.env`, not in your shell profile — `config.json` is
gitignored, and the board passes `env` to the command for exactly this reason.

Check it before restarting the board:

```bash
CLIO_ACCESS_TOKEN=… python3 examples/clio-labels.py | head -c 300
```

You should get JSON. An `{"error": …}` tells you what went wrong.

### What it gives you

Every matter becomes a label. Card badges deep-link into Clio, the folder button
opens the matter folder in Finder, the folder picker gains a searchable
**Matters** tab, and the time log groups by matter.

**Nothing is ever written to Clio.** The board reads matters and, optionally,
time entries. It has no write path — the time log shows you a difference and
leaves the entering to you.

## 8. The time log

The **Time** tab reconstructs hours from transcript timestamps. Consecutive
activity counts as working time; a gap longer than the idle threshold does not.
Hours round up to the tenth.

Without labels this is hours per folder per day, which is useful on its own.

With labels, every row says which rule produced it — a label you set by hand,
the session's folder, the folders it *wrote files into*, or a key recognised in
what you typed. That last one is marked *from a prompt* and sits last, because
it is the only rule where nothing was actually done *in* the label. An earlier
version scanned transcripts for any mentioned path and attributed a website
migration to a client whose folder it had merely read; for a time entry, a
confident wrong answer is worse than none.

Set `timeLog.postedCommand` to a program reporting hours already recorded
somewhere else, and the tab subtracts them — leaving only work not yet written
down anywhere. It is called with a start and end date and prints:

```json
{ "entries": [{ "date": "2026-07-28", "label": "01994-Acme", "hours": 1.2 }] }
```

See [`examples/clio-posted-hours.py`](../examples/clio-posted-hours.py). Without
it the tab simply shows everything it found, with no subtraction and no extra
columns.

## 9. Calendar

Mac app only, and it needs the Swift helper (`./app/build.sh`, or `./start.sh`
with Xcode tools installed). macOS will ask permission the first time.

The panel reads your macOS calendars and shows what is coming up alongside the
work on your board. An event ties itself to a label when its title carries the
key. Events that name none stay unattached rather than being guessed at.

`calendars.work` lists the calendars whose events may name a label. Leaving it
empty still shows events; it just never attributes one on its own.

Denied permission by mistake? macOS stops asking. The panel has an **Ask me
again** button that clears the recorded decision.

## 10. Reports

If something else on your machine writes HTML reports — a daily brief, a
generated summary — point the board at the folder and read them in the panel
instead of opening a browser:

```json
{
  "reports": {
    "dir": "~/Reports",
    "pattern": "^report_(\\d{4}-\\d{2}-\\d{2})\\.html$",
    "label": "Daily brief"
  }
}
```

The capture group is the date. Leave `dir` null and the tab is hidden.

## 10½. A board's default label

Right-click a board tab to give that board a default label. Any card on the
board with no label of its own is presumed to be about it — useful for an
"admin" board where everything bills to the firm's own file. The default is
the weakest evidence there is: a label you set by hand, a session running in a
label folder, or a file number typed into the conversation all replace it, and
a card moved off the board leaves the default behind. Clearing it from a card
counts as "not this one" and it is not re-applied.

If a slash command produces the report, add `"runCommand": "/morningbrief"` and
the tab grows a **Run** button. It starts the command in a session the tab
remembers and shows right there, so a report that asks questions on the way —
a billing walkthrough, an approval — has one fixed place to be answered, and the
tab pulses amber while it waits on you. A second click while it is running
reuses the run rather than starting another; **Start over** is the explicit way
to get a fresh one, and **Resume** reopens a run that ended early.

## 11. The billing tab

If a billing agent maintains a SQLite brain of invoices, draft time entries,
open questions, and budgets (the expected tables are in `docs/BILLING.md`),
point the board at it and the tab appears:

```json
{
  "billing": {
    "db": "~/code/clio-assistant/billing/billing.sqlite",
    "snapshots": "~/MadgettLawWiki/raw/metlife-snapshots",
    "runCommand": "/billing",
    "approveCommand": ["/usr/bin/python3", "~/code/clio-assistant/billing/approve_cli.py"],
    "label": "Billing"
  }
}
```

Only `db` is required; the rest each switch on one power. The tab always
*reads*: outstanding bills split into never-issued drafts, awaiting, and
overdue; the agent's open questions; per-matter budget health (cap, approved
excess, billed, paid, and the two leaks — over budget, and approved-but-never-
billed); work seen but never billed. `snapshots` is a folder of carrier-portal
case exports (`*.psv`, newest wins) joined against the brain to surface portal
cases no billing profile can name.

`runCommand` gives the tab a Run button and a remembered session, exactly like
the reports tab — billing questions get one fixed place to be answered, and the
tab pulses while one waits. `approveCommand` arms the one write: the pending
time-entry drafts render as a checked table, and **Approve & post** sends the
selected ids to that command (argv-appended) after a confirm that *is* the
approval. The command owns the posting policy; the board never touches the
practice-management system itself.

## 12. Where your data lives

| | |
|---|---|
| Board database | `data/board.db` (SQLite) |
| Cached label index | `data/labels.json` |
| Your configuration | `config.json` |
| Claude transcripts | `~/.claude/projects/` — **not owned by this app** |

`data/` and `config.json` are both gitignored.

The board never modifies or deletes a Claude Code transcript. Archiving a card,
renaming it, deleting it — all of that touches only `board.db`. Your
conversations are Claude Code's, and they stay that way.

To back up your board, copy `data/board.db`. It runs in WAL mode, so copy it
with `sqlite3 data/board.db ".backup out.db"` rather than `cp` if the server is
running.

To start over, stop the server and delete `data/board.db`.

## 13. Troubleshooting

**"Claude Code isn't installed yet" / "Codex isn't installed yet"** — the board
could not find the command for the engine the switch is set to, on your PATH or
in the usual locations. Install it and run it once to sign in. If it lives
somewhere unusual, either make sure `command -v claude` works in a *login* shell
— which is where the board looks, and which does not read `.zshrc`, so an alias
will not do — or name the path with `engines.<id>.bin`. See
[Section 5a](#5a-choosing-an-engine).

**A codex card offers *Start* instead of *Resume*** — the board never saw that
session say anything, so Codex never opened a thread for it and there is nothing
to resume. Expected for a session opened and closed without a message. If it
happens to a session you did work in, check `curl 127.0.0.1:4317/api/board` for
two cards with the same content: the thread was found under its own id instead of
being attached to the card that started it, and the older card can be archived.

**The board is empty** — new sessions are discovered from the last 7 days of
transcripts. Anything already on the board stays whatever its age, so this only
bites on a fresh install; widen it with
`curl -X PUT 127.0.0.1:4317/api/prefs -H 'content-type: application/json' -d
'{"sinceDays":30}'`. Only interactive sessions become cards, so headless
automation is filtered out deliberately — and on the Codex side, so are threads
belonging to the ChatGPT desktop app, which are that app's windows rather than
this board's.

**A terminal fails with `posix_spawnp failed`** — npm dropped the exec bit on
node-pty's `spawn-helper`. `npm install` runs a `postinstall` that restores it;
run it again.

**`NODE_MODULE_VERSION` mismatch** — your Node major changed since
`npm install`. `rm -rf node_modules && npm install`.

**Port already in use** — something else has 4317. `PORT=4400 ./start.sh`, or
find it with `lsof -nP -iTCP:4317 -sTCP:LISTEN`.

**Cards have no titles and mirrors are empty** — this happens when the server
was launched from *inside* a Claude Code session and the child processes
inherited its markers, which silently turns transcript saving off. The server
strips `CLAUDE_CODE_*` for exactly this reason; if you see it, check nothing
else is re-adding them.

**Labels aren't showing** — they are off until `labels.root` or
`labels.command` is set, and the server only reads config at startup. Check
`curl 127.0.0.1:4317/api/labels`, which reports the index, the count and any
error from your command.

**A card I scheduled to come back hasn't** — returns are swept when the server
starts and once a minute after that, so a card is never lost, but it can only
appear once something is running. If the app was closed on the day it was due,
it is there the next time you open it, at the top of the first column. Anything
still pending shows its date in the Archive.

**The window is blank or stale** — check the server is up with
`curl 127.0.0.1:4317/api/board`. Inside the app bundle, server output is
discarded, so `SB_REQLOG=/tmp/req.log` is the way to see what the window is
actually requesting.

## 14. Keeping it updated on every machine

The repo is the distribution. One machine pushes a fix; every other machine
pulls it in the background and applies it the next time the app starts, the
way any other program updates.

```bash
./app/install-updater.sh          # once per machine
./app/install-updater.sh --remove
```

That installs a LaunchAgent (`<bundleId>.updater`) that runs
`update.sh --if-behind --when-idle` at login and every hour:

- **Nothing happens unless the remote has new commits.** A fetch that finds
  nothing exits silently.
- When there are, it pulls, reinstalls dependencies (the native modules are
  built per machine, for that machine's Node), rebuilds the web bundle, and
  rebuilds the app bundle in `/Applications`.
- **It never interrupts you.** With the app owning the server, the new version
  is on disk and takes effect the next time you open the app. With the server
  under launchd (an always-on install, see below), it restarts the server only
  when no session is live; otherwise that too waits for the next start.
- Log: `~/Library/Logs/<AppName>-updater.log`.

To run the server permanently on a headless or always-on Mac, install a
LaunchAgent labelled `<bundleId>.server` that runs `node server/index.js` in
the repo with `KeepAlive`; the app then attaches to it instead of spawning its
own, and `update.sh` knows to restart that job rather than the app.

A machine that cannot reach the remote (no key yet, no network) just logs the
failed fetch and tries again next hour. `./update.sh` by hand does the same
thing immediately, and relaunches.
