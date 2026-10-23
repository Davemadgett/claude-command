# Releasing Claude Command

How a change becomes a version people can install. Short version: bump the
version, write the changelog entry, tag, build a signed and notarized app,
publish the zip as a GitHub release. The background updater on each machine
(SETUP §14) picks the release up.

## Versioning

`package.json` holds the one version number. `app/build.sh` reads it into the
app bundle (`CFBundleShortVersionString` and `CFBundleVersion`), so the Finder,
the About box, and the release tag always agree. Semantic versioning:

| Bump | When |
|---|---|
| MAJOR | `config.json` keys change incompatibly, or the HTTP API the web UI and any integration depend on changes |
| MINOR | A new feature, panel, engine, or provider |
| PATCH | A fix with no new surface |

Tags are `v<version>` (`v1.0.0`). A tag is a release; nothing is released
without one.

## 1. Before tagging

1. `CHANGELOG.md`: move the `Unreleased` entries under a new `## [x.y.z] — YYYY-MM-DD`
   heading, add the compare link at the bottom, leave `Unreleased` empty.
2. `package.json`: set `"version"`.
3. Check the public-repo rule: no client name, matter number, or firm path in
   the diff, the changelog, or the docs (`git diff v<prev>..HEAD | grep -nE '0[0-9]{4}-[A-Z]'`
   should print nothing).
4. Commit as `Release x.y.z`, then `git tag -a vx.y.z -m "x.y.z"` and push the
   commit and the tag.

## 2. Build, sign, notarize

Prerequisites on the build machine (once):

- Xcode command line tools (`xcode-select --install`).
- The **Developer ID Application** certificate in the login Keychain, plus
  Apple's **Developer ID G2** intermediate (without it the identity shows as
  "0 valid identities" even though the key and certificate pair). The firm's
  certificate: `Developer ID Application: David Madgett (37LD23JKD7)`, issued
  2026-10-22, expires 2027-11-21. Its private key was generated on the MacBook
  on 2026-10-21; the key, the request, the certificate and the intermediate
  are kept in the repo's git-ignored `.signing/`. To set up another build
  machine: export the identity from Keychain Access as a `.p12`, import it
  there, and import `.signing/DeveloperIDG2CA.cer` too.
  `security find-identity -v -p codesigning` must report 1 valid identity.
- Notarization credentials stored once with
  `xcrun notarytool store-credentials "claude-command-notary" --apple-id <Apple ID> --team-id 37LD23JKD7`
  using an app-specific password from account.apple.com. The password goes
  into the Keychain through that command and nowhere else.
- Renewal: the certificate expires 2027-11-21. Generate a new request from
  the existing key (`openssl req -new -key .signing/developer_id.key ...`),
  create a new Developer ID Application certificate at developer.apple.com,
  import it, rebuild. The Team ID does not change, so permissions survive.

Then:

```bash
./app/build.sh                                   # SIGN_IDENTITY picks the Developer ID cert when present
APP="/Applications/$(node -p 'require("./config.json").appName||"Claude Command"').app"
ditto -c -k --keepParent "$APP" "Claude-Command-$(node -p 'require("./package.json").version').zip"
xcrun notarytool submit Claude-Command-*.zip --keychain-profile claude-command-notary --wait
xcrun stapler staple "$APP"                      # attach the ticket to the bundle
ditto -c -k --keepParent "$APP" "Claude-Command-$(node -p 'require("./package.json").version').zip"   # re-zip the stapled app
spctl -a -vv "$APP"                              # expect: accepted, source=Notarized Developer ID
```

`build.sh` signs with the Developer ID identity when `SIGN_IDENTITY` is set or
a "Developer ID Application" identity is in the Keychain, with the hardened
runtime and the entitlements Node's native modules need; otherwise it falls
back to an ad-hoc signature, which is fine for a local build and wrong for a
release (an ad-hoc identity changes every build, so macOS forgets the app's
permissions each time).

## 3. Publish

```bash
gh release create vx.y.z Claude-Command-x.y.z.zip --title "x.y.z" --notes-file <(sed -n '/^## \[x.y.z\]/,/^## \[/p' CHANGELOG.md | sed '$d')
```

The release notes are the changelog section, verbatim.

## 4. After publishing

- Each machine's updater fetches the release within the hour (today it still
  pulls source and rebuilds; switching it to download the release zip is the
  Phase 2 item in the firm's `mac-onboarding-design`).
- On the server, the always-on job restarts when no session is live.
- Open the About box on one machine and confirm the version.

## Manual fallback (no CI, no notarization credentials yet)

The certificate exists since 2026-10-22, so every build on the MacBook is
Developer ID signed. Until the notarization profile is stored, a release is
the same steps without `notarytool` and `stapler`: the zip is attached to the
GitHub release, and the bundle opens on any Mac it is copied to by scp or
AirDrop (no quarantine flag). A copy downloaded in a browser is rejected by
Gatekeeper as "Unnotarized Developer ID" and needs "Open Anyway" in Privacy &
Security once. Say so in the release notes.

## CI (planned)

A GitHub Actions workflow on `v*` tags will run the same steps on a macOS
runner, with the certificate (`.p12`) and the notarization password as
repository secrets. Until it exists, the MacBook is the build machine.
