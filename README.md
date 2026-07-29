# Claude Command

A kanban board over your Claude Code sessions. Sessions are discovered
automatically from `~/.claude/projects/`; you drag them between columns, and click
one to either work in it live or read a clean mirror of it.

**A Claude session is bottom-up: you are inside one conversation, and it is the
only vantage point on its own work. This is top-down — the board is the vantage
point, every session in flight is visible at once, and you direct work into
sessions rather than discovering it inside them. That inversion is what makes
running several at a time manageable rather than a memory test.**

## Getting started

You need [Claude Code](https://claude.com/claude-code) — run `claude` once in a
terminal to sign in — plus Node 20+ and macOS 12+.

```bash
git clone https://github.com/Davemadgett/claude-command.git
cd claude-command
./start.sh
```

That installs what it needs, builds the UI, and opens the board in your browser.
There is nothing to configure: your existing sessions are on it as soon as it
loads, and **+ New session** starts a fresh one in whatever folder you pick.

### The Mac app

`./app/build.sh` puts the same board in a real app — its own Dock icon, its own
window, the native Finder panel in the folder picker, and calendar access. It
needs Swift, from the Xcode command line tools (`xcode-select --install`).

```bash
./app/build.sh
open "/Applications/Claude Command.app"
```

The app owns its server: launching starts `node server/index.js`, quitting stops
it. If a server is already running (say you ran `./start.sh` in a terminal), the
app attaches to that one and leaves it alone when it quits.

For development, `npm run dev` gives a hot-reloading UI on `:5180` with the API
on `:4317`. Changing the server or the UI needs no app rebuild — quit and reopen
the app, or just reload the window. Only `app/build.sh` rebuilds the Swift shell.

## Configuration

Everything specific to your machine lives in `config.json`, which is gitignored.
**No key is required**, and there is no `config.json` in a fresh clone — the
board works without one, with the optional parts switched off. Copy
`config.example.json` when you want to turn something on.

```json
{
  "appName": "Claude Command",
  "bundleId": "com.example.claudecommand",
  "principal": "Your Name",

  "labels": {
    "index": "folders",
    "root": "~/Projects",
    "depth": 1,
    "noun": "project"
  }
}
```

`appName` and `bundleId` are read by `app/build.sh`, so a fork builds its own app
rather than overwriting somebody else's. Both the window title and the header
mark follow `appName`.

## Labels

**Labels are off until you switch them on, and everything above works without
them.** Skip this section entirely if you just want the board.

A label is the optional answer to *which piece of work is this session about* —
a client, a case, an account, a product line. Cards show it, the time log groups
by it, and the calendar matches events against it. Turning it on is one line:

```json
{ "labels": { "root": "~/Projects", "noun": "project" } }
```

Every subfolder of `root` is now a label, and a session started in one is
labelled by it. Nothing else is required.

Two independent questions, deliberately kept apart:

**Where the list comes from** is `labels.index`:

- `folders` — every subfolder of `labels.root` is a label. No account, no key, no
  network. `depth: 2` means the label is the *second* level (a folder per client,
  a folder per engagement inside it), and `pattern` is a regex the leaf name must
  match, so an "Admin" folder sitting in the tree does not become a label.
- `command` — run any program that prints JSON. This is the escape hatch for
  anything with an API: your program already knows how to authenticate, and this
  only needs the answer.
- `none` — switch labels off entirely.

**Where the files are** is always `labels.root`, whatever the index. Someone
whose label list arrives from an API still has those files in a synced folder
locally, and the index has no way to know that path.

A `command` prints:

```json
{ "labels": { "01994-acme": { "name": "Acme Corp", "url": "https://…" } } }
```

`name`, `url` and `status` are optional; `{"error": "…"}` is reported in the UI
rather than thrown. The result is cached to disk and refreshed in the background,
so a slow or broken command never blocks the board — it keeps serving the last
good copy. There are two worked examples in [`examples/`](examples/), both
talking to Clio, both about forty lines.

Credentials go in `labels.env`, which `config.json` being gitignored makes safe:

```json
"labels": {
  "index": "command",
  "command": ["/usr/bin/python3", "/path/to/examples/clio-labels.py"],
  "env": { "CLIO_USER_ID": "1234567" }
}
```

### Which label a card gets

A card started in a label folder is labelled from the folder. Everything else is
read from what you typed — you almost always name the work in the first breath,
and that sentence is sitting in the transcript.

A **key** that matches a real label is applied outright; you had to have meant
that label to type its key. The **opening turn** settles it when it names exactly
one — it is where you say what you are sitting down to do, and no amount of later
discussion outvotes it. Failing that the session is counted, and where it names
two labels equally often it drops to a suggestion rather than picking one.

Only what you typed is read. Skill bodies, the caveat wrapped round a local
command and a command's own output are all skipped, because documentation
explains itself with examples: a skill's help text reading `file # (01982)` would,
taken as your words, file the session under 01982. Nor does a key in a sentence
overrule the folders the session actually wrote into — where the two disagree the
prompt only gets to raise the question.

A **name** never is. It raises a `01953-Acme?` chip on the card with a ✓ and a ✕,
and a ✕ is remembered so the same guess is not offered twice. Name matching was
tried in the calendar matcher and abandoned twice: titles are full of people you
are meeting *about* rather than *for*. A prompt is no safer.

`labels.stoplist` is how you stop your own subagents becoming labels — name them
after people, as most do, and "have Lee check the cites" otherwise reads as a
label called Lee.

Set one by hand from the card's **⋯** menu — `1953`, `01953` and `01953-Acme` all
name the same label, and anything matching nothing is refused rather than guessed
at. A label you set yourself outranks every inference.

## The sections

**Board** — your sessions as cards. Fills the screen; scroll down for the session
panel. Cards stay deliberately spare — status, label, priority, title, and a way
in. Clicking one selects it and leaves the board where it is; **Open** (or a
double-click) takes you down to the panel.

The chip at the top-left of a card is its **priority**, and clicking it cycles
High → Medium → Low → none. High comes first because that is what you almost
always mean. A card with no priority carries a faint dot in the same place — it
brightens as you approach the card, so the control is visible without a board of
unprioritised cards looking cluttered. The **⋯** menu still lists the levels when
you want to jump straight to one.

High, Medium and Low colour the card's left edge as well as the chip; unset is
its own state, because most cards never need one and defaulting them all to the
middle would make the colour say nothing.

Marking a card **High** also moves it to the top of its column — saying "this one
first" and then dragging it there is the same instruction twice. Only High moves,
and only when you set it: the board is never re-sorted by priority behind your
back, so wherever you drag a card afterwards is where it stays.

**Archive** — every card you have closed, searchable, with the board and column it
came from. Closing never deletes; only the archive can delete, and even that
leaves the Claude transcript untouched.

**Skills** — the skills in `~/.claude/skills`. *Run* opens a session on the board
and invokes the skill there, so you can watch it and answer its prompts.

**Scheduled** — daily routines. *Run now* works the same way. Switching one to
*Auto* runs it at its time, but only while the app is open, and a missed day is
never backfilled. Nothing runs unless you switch it on.

**Live** — only the sessions running right now, for when the board is long.

**Calendar** — what is coming up, and the work on your board attached to it. Mac
app only; it needs the Swift helper.

**Time** — working hours reconstructed from your sessions, grouped by folder — or
by label, if you turned those on. See "Time log" below, because how it decides
matters.

**Team** — the agents in `~/.claude/agents`, as an org chart and a roster.
Reporting lines are read from each agent's own brief: an agent sits under another
because its prompt says it does.

## Summary, live, mirror, files

**Summary** is where a session opens: a few bullets on what Claude was doing,
read straight off the transcript — what it said last, how many files it edited and
which, commands run, subagents dispatched. Nothing is generated, so it costs
nothing and can't claim work that didn't happen.

A session started from this board runs in a pty the server owns, so the terminal
in the panel is the real thing — you type in it, colors and keys work.

A session you started in Terminal.app is a **mirror**: its transcript rendered
read-only. Hit **Resume here** and the board runs `claude --resume <that id>`,
which keeps the same session id — so the card, its history and its column follow
it, and it goes live from that point on.

The mirror opens in **Conversation**: what you asked and what Claude said, with
the machinery taken out. Tool calls become one plain line each ("Wrote
report.docx", "Read 9 files"), code blocks collapse to a marker, and the injected
skill bodies and command caveats that arrive dressed as your own turns are
dropped. **Technical** puts every call, input and output back, unchanged — the
filtering is a reading, never an edit.

**Files** lists what a session produced, in two groups. *Written by this session*
comes from its Write/Edit tool calls and is authoritative. *Also changed while it
ran* is an mtime sweep of its working directory, which is the only way to catch
documents a script generated — no write-tool call ever names those.

Only sessions Claude Code records as interactive (`entrypoint: cli`) become cards.
Automation running as `sdk-cli` is filtered out, or the board would fill with
hundreds of headless runs.

## Boards and columns

Boards are tabs above the columns. Each has its own independent columns.
Right-click a card (or use **⋯**) to move it to another board; it lands in that
board's first column.

Columns are data, not code:

- **Rename** — double-click the name. **Recolor** — click the swatch.
- **Reorder** — drag the `⠿` grip. **Add** — `+ Column`.
- **Delete** — `✕`. Its cards move to the first column rather than being deleted.

Deleting a board relocates its cards too. Nothing here ever modifies or deletes a
Claude Code transcript — archiving and renaming only touch this board's database.

The starting board runs **To Do**, **Your Turn**, **Done**. Your Turn is the
board's inbox — when a session finishes, or stops to ask you something, its card
moves there on its own from any column to its left. Anything to its right is
terminal: nothing is ever pulled back out. A question moves a card after eight
seconds of quiet rather than the minute a finished turn waits, because nothing
more is coming until you answer.

That replaced a longer pipeline of stages describing how work gets done. The
board's job is to say where your attention is owed, and by that measure
everything before "it's back with you" is one pile.

## Time log

Consecutive activity in a transcript counts as working time; a gap longer than the
idle threshold does not. Hours round up to the tenth, the way billing systems do.

Without labels this is hours per folder per day, which is worth having on its
own. The rest of this section is what labels add.

Attribution is deliberately conservative, and every row says which rule produced
it. A label you attached to the card by hand comes first, then the session's
working directory when that is a label folder, then the label folder it **wrote
files into**, and last a key recognised in what you typed, marked *from a prompt*.

That last one sits last because it is the only rule where nothing was actually
done *in* the label. An earlier version scanned transcripts for any mentioned
label path and attributed a website-migration session to a client whose folder it
had merely read — for a time entry, a confident wrong answer is worse than no
answer. It is reported so you can see it and labelled so you can weigh it;
sessions with no rule at all stay unattributed.

Set `timeLog.postedCommand` to a program that reports hours already recorded
elsewhere and the tab will subtract them, leaving only work not yet written down
anywhere. Without it the tab simply shows everything it found. Nothing here posts
anywhere. *Copy as TSV* gives you rows to work from.

## Notes

- Light and dark, toggled from the top bar; the terminal palette follows.
- The server binds `127.0.0.1` only.
- Scrolling to the panel avoids `requestAnimationFrame` and doesn't trust
  `behavior: 'smooth'` — a scroll issued from inside a frame callback is dropped
  here, and smooth scrolling is a no-op in the app's WebView.
- `postinstall` restores the exec bit on node-pty's `spawn-helper`; npm drops it,
  and without it every terminal fails with `posix_spawnp failed`.
- Sessions spawn with the parent's `CLAUDE_CODE_*` markers stripped. Left in
  place, a board launched from inside a Claude session makes its children think
  they're nested agents, which silently turns transcript saving off — and then
  cards never get titles and mirrors stay empty.
- `SB_REQLOG=/path/to/log` logs every request, which is how you see what the app
  window is actually asking for (the bundle discards server output).
- Stopping a session sends `SIGHUP`; the transcript is kept and can be resumed.

## License

[PolyForm Noncommercial 1.0.0](LICENSE) — free to read, run, modify and share for
any noncommercial purpose. Using it in a business, including a law practice, is a
commercial purpose and needs a separate license; open an issue to ask about one.

Contributions welcome; see [CONTRIBUTING.md](CONTRIBUTING.md).
