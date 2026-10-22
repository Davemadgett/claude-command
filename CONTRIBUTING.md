# Contributing

Thanks for looking. This started as one person's tool and became general because
generalising it made it better, so outside use is the point rather than a
side effect.

## Getting set up

```bash
npm install
npm run dev                            # UI on :5180, API on :4317
```

`config.json` is optional and there is deliberately no default one — the board
has to work without it. If you add a feature that reads config, give it a working
default and check it still behaves with no `config.json` at all.

`npm run dev` is the fast loop. `./app/build.sh` is only needed when you change
the Swift shell in `app/` — server and UI changes just need the window reloaded.

Before opening a PR:

```bash
npm run build              # tsc + vite; must be clean
npm --prefix web run lint  # oxlint
node --check server/*.js
```

There are no unit tests yet. If you are changing the label detector or the time
log, say in the PR what you ran it against and what came out — those two are the
places where a plausible wrong answer is worse than no answer, and both have
already been wrong once in ways that looked fine.

## House style

The code is commented more heavily than most, and the comments explain **why**
rather than what. Most of them exist because something was tried and failed:
surname matching in the calendar, scanning whole transcripts for label paths in
the time log, letting expanded skill bodies count as user speech. If you remove
a guard, the comment above it is usually the reason it is there — and if you add
one, please leave the same kind of note behind.

Prose in comments and docs is plain sentences, not bullet fragments, and avoids
exclamation marks and hedging. Match what is around you.

## Things that will get a PR sent back

- **Anything that writes to a Claude Code transcript.** This app reads
  `~/.claude/projects` and never modifies it. Archiving, renaming and deleting
  touch only this board's own SQLite database.
- **Hardcoded personal paths, names or account ids.** They belong in
  `config.json`, which is gitignored. If a feature needs a new setting, add it to
  `DEFAULTS` in `server/config.js` with a default that leaves the feature off.
- **A vendor-specific adapter in `server/`.** Use the `command` label index
  instead — it takes any program that prints JSON, so an integration is forty
  lines in `examples/` rather than a dependency here. See
  `examples/clio-labels.py`.
- **Committing anything under `data/`.** It holds the board database and cached
  label indexes, and a label index is a list of real client names.

## Reporting a bug

Say what you expected, what happened, and what `config.json` looked like with any
paths and credentials removed. `SB_REQLOG=/tmp/req.log` logs every request the
app window makes, which is usually the fastest way to see what it actually asked
for — the app bundle discards server output otherwise.

## Security

Do not open a public issue for anything involving credentials or data exposure.
Email the address on the commits instead.

## Versions and releases

`package.json` carries the one version number; `app/build.sh` reads it into
the bundle. Every user-visible change gets a line under `Unreleased` in
`CHANGELOG.md`, written for the person using the board. A release is a tag
(`v1.2.0`) plus a signed, notarized zip on GitHub Releases; the procedure,
including the signing prerequisites and the no-certificate fallback, is
`docs/RELEASING.md`.
