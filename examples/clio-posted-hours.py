#!/usr/bin/env python3
"""Example posted-hours command: time already recorded elsewhere.

This is what `timeLog.postedCommand` expects. Point config.json at it:

    "timeLog": {
      "postedCommand": ["/usr/bin/python3", "/path/to/examples/clio-posted-hours.py"],
      "env": { "CLIO_ACCESS_TOKEN": "…", "CLIO_USER_ID": "1234567" }
    }

It is called with two arguments, a start and an end date (YYYY-MM-DD), and
prints:

    {"entries": [{"date": "2026-07-28", "label": "01994-Acme", "hours": 1.2}]}

`label` must match a label key. `billed`, `nonBillable` and `note` are optional
and only affect display. The Time tab subtracts these hours from the ones it
reconstructs from transcripts, so what is left is work not yet written down
anywhere — which is the only part worth looking at.

Nothing here writes to Clio. The board never posts time; it only ever reads,
compares, and shows you the difference.

CLIO_USER_ID is your own user id — without it this would report the whole
firm's time as though it were yours. Find it at /api/v4/users/who_am_i.json.
Set CLIO_REGION if you are not on the US instance: eu, ca or au.
"""
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

TIMEOUT = 30


def base_url() -> str:
    region = (os.environ.get("CLIO_REGION") or "").strip().lower()
    host = f"{region}.app.clio.com" if region in {"eu", "ca", "au"} else "app.clio.com"
    return f"https://{host}/api/v4"


def get_all(url: str, token: str) -> list:
    """Every page of a Clio collection — see the note in clio-labels.py."""
    out: list = []
    while url:
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            payload = json.load(resp)
        out.extend(payload.get("data") or [])
        url = ((payload.get("meta") or {}).get("paging") or {}).get("next")
    return out


def from_api(token: str, user_id: str, date_from: str, date_to: str) -> list:
    query = urllib.parse.urlencode(
        {
            "fields": "id,date,quantity,note,billed,non_billable,matter{display_number,description}",
            "type": "TimeEntry",
            "user_id": user_id,
            "start_date": date_from,
            "end_date": date_to,
            "limit": 200,
        }
    )
    return get_all(f"{base_url()}/activities.json?{query}", token)


def from_local_client(user_id: str, date_from: str, date_to: str) -> list:
    """Fallback for anyone who already has a configured Clio client on disk."""
    sys.path.insert(0, os.path.expanduser(os.environ.get("CLIO_ASSISTANT", "~/code/clio-assistant")))
    from clio_client import Clio  # noqa: E402

    return Clio().list_time_entries(
        user_id=int(user_id), date_from=date_from, date_to=date_to, limit=1000
    )


def main() -> int:
    if len(sys.argv) < 3:
        print(json.dumps({"error": "usage: clio-posted-hours.py <from> <to>"}))
        return 1

    date_from, date_to = sys.argv[1], sys.argv[2]

    user_id = os.environ.get("CLIO_USER_ID")
    if not user_id:
        print(json.dumps({"error": "set CLIO_USER_ID to the user whose time to read"}))
        return 1

    token = os.environ.get("CLIO_ACCESS_TOKEN")

    try:
        entries = (
            from_api(token, user_id, date_from, date_to)
            if token
            else from_local_client(user_id, date_from, date_to)
        )
    except urllib.error.HTTPError as exc:
        hint = " — the token may have expired" if exc.code in (401, 403) else ""
        print(json.dumps({"error": f"Clio returned {exc.code}{hint}"}))
        return 1
    except ImportError:
        print(json.dumps({"error": "set CLIO_ACCESS_TOKEN in timeLog.env — see docs/SETUP.md"}))
        return 1
    except Exception as exc:
        print(json.dumps({"error": f"Clio request failed: {exc}"}))
        return 1

    out = []
    for e in entries:
        matter = e.get("matter") or {}
        out.append(
            {
                "date": (e.get("date") or "")[:10],
                "label": matter.get("display_number"),
                "labelName": matter.get("description"),
                # Clio stores a TimeEntry quantity in seconds: 5400 @ $200 = $300.
                "hours": round(float(e.get("quantity") or 0) / 3600.0, 4),
                "billed": bool(e.get("billed")),
                "nonBillable": bool(e.get("non_billable")),
                "note": (e.get("note") or "")[:200],
            }
        )

    print(json.dumps({"entries": out}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
