#!/usr/bin/env python3
"""Example label command: every Clio matter, as JSON on stdout.

This is what `labels.index: "command"` expects. Point config.json at it:

    "labels": {
      "index": "command",
      "command": ["/usr/bin/python3", "/path/to/examples/clio-labels.py"]
    }

The contract is only the shape of the output, so the same idea works for Jira
projects, Harvest clients, a CSV, or a hardcoded dict:

    {"labels": {"<key>": {"name": "...", "url": "...", "status": "..."}}}

`name`, `url` and `status` are optional. Print {"error": "..."} to have the
board show a problem instead of an empty list — it will keep serving the last
cached copy either way, which is why a broken command never blanks the board.

This particular example borrows credentials from an existing clio_client rather
than re-implementing OAuth. Set CLIO_ASSISTANT if yours lives elsewhere.
"""
import json
import os
import sys

sys.path.insert(0, os.path.expanduser(os.environ.get("CLIO_ASSISTANT", "~/code/clio-assistant")))


def main() -> int:
    try:
        from clio_client import Clio
    except Exception as exc:
        print(json.dumps({"error": f"clio_client unavailable: {exc}"}))
        return 1

    try:
        client = Clio()
        # An empty query returns everything; paginate through the lot.
        matters = client.search_matters(
            "", limit=5000, fields="id,display_number,description,status"
        )
    except Exception as exc:
        print(json.dumps({"error": f"Clio request failed: {exc}"}))
        return 1

    out = {}
    for m in matters:
        number = (m.get("display_number") or "").strip()
        if not number or not m.get("id"):
            continue
        out[number] = {
            "name": m.get("description"),
            "url": f"https://app.clio.com/nc/#/matters/{m['id']}",
            "status": m.get("status"),
        }

    print(json.dumps({"labels": out}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
