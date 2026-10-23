# Changelog

All notable changes to Claude Command are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/): a MAJOR bump when the config file
or the API changes incompatibly, MINOR for new features, PATCH for fixes.
Entries describe what changed for the person using the board, not the commit.

## [Unreleased]

### Added
- `CHANGELOG.md`, `docs/RELEASING.md`, and a single version number read from
  `package.json` into the app bundle at build time.
- Builds are signed with a Developer ID Application certificate and the
  hardened runtime when the identity is in the Keychain (first signed build
  2026-10-22). The app's identity is now its Team ID and bundle ID, so macOS
  permissions granted to it survive a rebuild.

### Planned
- The app bundle owns its server: Node, the server, and the web build ship
  inside the bundle, the always-on server is the app's own launch agent, and
  the whole thing is signed with one stable identity so macOS permissions
  survive updates. Design: the firm wiki's `mac-onboarding-design`.
- Signed, notarized releases from GitHub Actions; the background updater
  downloads releases instead of rebuilding from source.

## [1.0.0] — 2026-10-11

The first version that runs unattended on more than one Mac.

### Added
- **Background updater.** `app/install-updater.sh` installs a launch agent
  that runs `update.sh --if-behind --when-idle` at login and hourly: nothing
  happens unless the remote has new commits; then dependencies, the web
  bundle, and the app are rebuilt and the server restarted only when no
  session is live. (SETUP §14.)
- **Always-on server.** `update.sh` recognises a server running under launchd
  (`<bundleId>.server`) and restarts that job instead of relaunching the app.
- **Files tab rework**, billing and usage panels, and the Codex engine as an
  alternative to Claude Code for a session.
- **Per-machine deployment.** `configure.sh <template>` renders `config.json`
  from a template with `{{HOME}}` and path placeholders resolved on that
  machine; `update.sh` pulls, installs, builds, and relaunches.

### Changed
- The label-folder index is built by a child process with a 20-second budget
  (`server/providers/folders-walk.js`). A cloud folder that never materializes
  no longer freezes the whole board; the last good index is kept and the walk
  is retried on the next refresh. (DESIGN §9.9.)
- `better-sqlite3` upgraded to 13.x so the native module builds on Node 26.

## [0.1.0] — 2026-07-29

### Added
- Initial public release under the PolyForm Noncommercial license: the
  session board (Claude Code sessions as cards), the Swift app shell, the
  no-Xcode browser path (`start.sh`), labels from folders or from a command,
  Clio examples, calendar and time-log panels, and the setup guide.

[Unreleased]: https://github.com/Davemadgett/claude-command/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/Davemadgett/claude-command/compare/v0.1.0...v1.0.0
[0.1.0]: https://github.com/Davemadgett/claude-command/releases/tag/v0.1.0
