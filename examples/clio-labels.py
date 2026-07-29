#!/usr/bin/env python3
"""Example label command: every Clio matter, as JSON on stdout.

This is what `labels.index: "command"` expects. Point config.json at it:

    "labels": {
      "index": "command",
      "command": ["/usr/bin/python3", "/path/to/examples/clio-labels.py"],
      "env": { "CLIO_ACCESS_TOKEN": "…" },
      "noun": "matter",
      "root": "~/Dropbox/Clio",
      "depth": 2
    }

`root` and `depth` are separate from the index and still worth setting: they are
how the board finds a matter's *folder* on your disk. Clio knows the matter list;
only you know where the files are.

The contract is only the shape of the output, so the same idea works for Jira
projects, Harvest clients, a CSV, or a hardcoded dict:

    {"labels": {"<key>": {"name": "...", "url": "...", "status": "..."}}}

`name`, `url` and `status` are optional. Print {"error": "..."} to have the
board show a problem instead of an empty list — it keeps serving the last cached
copy either way, which is why a broken command never blanks the board.

Getting a token: register an app in the Clio developer portal, run the OAuth
flow once, and keep the access token. See docs/SETUP.md. Put it in `labels.env`
rather than in your shell profile — config.json is gitignored.

Set CLIO_REGION if you are not on the US instance: eu, ca or au.
"""
import json
import os
import sys
import urllib.error
import urllib.request

TIMEOUT = 30


def base_url() -> str:
    region = (os.environ.get("CLIO_REGION") or "").strip().lower()
    host = f"{region}.app.clio.com" if region in {"eu", "ca", "au"} else "app.clio.com"
    return f"https://{host}/api/v4"


def get_all(url: str, token: str) -> list:
    """Every page of a Clio collection.

    Clio pages with an opaque cursor: the response carries the URL of the next
    page in meta.paging.next and omits it on the last one. The requests have to
    be serial — you cannot know page 3 exists until page 2 comes back.
    """
    out: list = []
    while url:
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            payload = json.load(resp)
        out.extend(payload.get("data") or [])
        url = ((payload.get("meta") or {}).get("paging") or {}).get("next")
    return out


def from_api(token: str) -> list:
    fields = "id,display_number,description,status"
    return get_all(f"{base_url()}/matters.json?fields={fields}&limit=200", token)


def from_local_client() -> list:
    """Fallback for anyone who already has a configured Clio client on disk.

    Kept because redoing OAuth for a script is a chore when something else in
    your own toolbox already holds the credentials.
    """
    sys.path.insert(0, os.path.expanduser(os.environ.get("CLIO_ASSISTANT", "~/code/clio-assistant")))
    from clio_client import Clio  # noqa: E402

    return Clio().search_matters("", limit=5000, fields="id,display_number,description,status")


def main() -> int:
    token = os.environ.get("CLIO_ACCESS_TOKEN")

    try:
        matters = from_api(token) if token else from_local_client()
    except urllib.error.HTTPError as exc:
        hint = " — the token may have expired" if exc.code in (401, 403) else ""
        print(json.dumps({"error": f"Clio returned {exc.code}{hint}"}))
        return 1
    except ImportError:
        print(json.dumps({"error": "set CLIO_ACCESS_TOKEN in labels.env — see docs/SETUP.md"}))
        return 1
    except Exception as exc:
        print(json.dumps({"error": f"Clio request failed: {exc}"}))
        return 1

    host = base_url().rsplit("/api/", 1)[0]
    out = {}
    for m in matters:
        number = (m.get("display_number") or "").strip()
        if not number or not m.get("id"):
            continue
        out[number] = {
            "name": m.get("description"),
            "url": f"{host}/nc/#/matters/{m['id']}",
            "status": m.get("status"),
        }

    print(json.dumps({"labels": out}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
