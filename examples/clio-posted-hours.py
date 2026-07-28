#!/usr/bin/env python3
"""Example posted-hours command: time already recorded elsewhere.

This is what `timeLog.postedCommand` expects. Point config.json at it:

    "timeLog": {
      "postedCommand": ["/usr/bin/python3", "/path/to/examples/clio-posted-hours.py"]
    }

It is called with two arguments, a start and an end date (YYYY-MM-DD), and
prints:

    {"entries": [{"date": "2026-07-28", "label": "01994-Acme", "hours": 1.2}]}

`label` must match a label key. `billed`, `nonBillable` and `note` are optional
and only affect display. The Time tab subtracts these hours from the ones it
reconstructs from transcripts, so what is left is work not yet written down
anywhere — which is the only part worth looking at.

Set CLIO_USER_ID to your own user, and CLIO_ASSISTANT if your client lives
somewhere other than ~/code/clio-assistant.
"""
import json
import os
import sys

sys.path.insert(0, os.path.expanduser(os.environ.get("CLIO_ASSISTANT", "~/code/clio-assistant")))


def main() -> int:
    if len(sys.argv) < 3:
        print(json.dumps({"error": "usage: clio-posted-hours.py <from> <to>"}))
        return 1

    date_from, date_to = sys.argv[1], sys.argv[2]

    user_id = os.environ.get("CLIO_USER_ID")
    if not user_id:
        print(json.dumps({"error": "set CLIO_USER_ID to the user whose time to read"}))
        return 1

    try:
        from clio_client import Clio
    except Exception as exc:
        print(json.dumps({"error": f"clio_client unavailable: {exc}"}))
        return 1

    try:
        client = Clio()
        entries = client.list_time_entries(
            user_id=int(user_id), date_from=date_from, date_to=date_to, limit=1000
        )
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
