#!/usr/bin/env python3
"""
writes synthetic events.jsonl for synq-gnome screenshots and local testing.
spreads samples across today, earlier this week, and earlier this month.
input:  optional --output PATH (default ~/.local/share/synq-gnome/events.jsonl)
output: JSONL file, one {"title": str, "ts": int} per line, sorted by ts
"""
from __future__ import annotations

import argparse
import json
import os
import time
from datetime import datetime, timedelta


def build_demo_events() -> list[dict]:
    now_dt = datetime.now()
    now = int(time.time())
    events: list[dict] = []

    def slot(days_ago: int, hour: int, minute: int, title: str) -> None:
        when = now_dt.replace(
            hour=hour, minute=minute, second=0, microsecond=0
        ) - timedelta(days=days_ago)
        ts = int(when.timestamp())
        if ts <= now:
            events.append({"title": title, "ts": ts})

    # today: editors, browser tabs, terminal, comms
    slot(0, 9, 0, "main.py - webapp - Visual Studio Code")
    slot(0, 9, 45, "routes.py - webapp - Visual Studio Code")
    slot(0, 10, 20, "localhost:8000 - webapp - Google Chrome")
    slot(0, 10, 50, "Stack Overflow - Google Chrome")
    slot(0, 11, 15, "Pull requests - GitHub - Google Chrome")
    slot(0, 11, 40, "webapp - Terminal")
    slot(0, 12, 10, "__IDLE__")
    slot(0, 13, 0, "test_api.py - webapp - Visual Studio Code")
    slot(0, 13, 45, "Slack | engineering - Google Chrome")
    slot(0, 14, 10, "Inbox (8) - Gmail - Google Chrome")
    slot(0, 14, 40, "models.py - webapp - Visual Studio Code")
    slot(0, 15, 20, "API Reference - MDN Web Docs - Google Chrome")
    slot(0, 15, 50, "webapp - Terminal")
    slot(0, 16, 20, "README.md - webapp - Visual Studio Code")

    # yesterday: reading, writing, media, a little code
    slot(1, 9, 30, "Chapter 4 - Firefox")
    slot(1, 10, 10, "API docs - MDN Web Docs - Firefox")
    slot(1, 11, 0, "notes.odt - LibreOffice Writer")
    slot(1, 11, 45, "playlist - Spotify")
    slot(1, 14, 0, "dashboard.js - webapp - Visual Studio Code")
    slot(1, 15, 30, "Issues - GitHub - Firefox")

    # two days ago: design and meetings
    slot(2, 9, 0, "Design system - Figma - Google Chrome")
    slot(2, 10, 30, "Wireframes - Figma - Google Chrome")
    slot(2, 11, 30, "Standup - Google Meet - Google Chrome")
    slot(2, 13, 0, "Roadmap - Notion - Google Chrome")
    slot(2, 14, 30, "style.css - portfolio - Visual Studio Code")

    # three days ago: backend and database work
    slot(3, 9, 30, "schema.sql - api-server - Visual Studio Code")
    slot(3, 10, 45, "Docker docs - Google Chrome")
    slot(3, 11, 30, "queries.sql - api-server - Visual Studio Code")
    slot(3, 13, 0, "Team chat - Slack - Google Chrome")
    slot(3, 14, 15, "Calendar - Thunderbird")

    # four days ago: data analysis
    slot(4, 10, 0, "analysis.ipynb - Jupyter - Firefox")
    slot(4, 11, 15, "pandas docs - Firefox")
    slot(4, 13, 30, "report.odt - LibreOffice Writer")
    slot(4, 15, 0, "podcast - Spotify")

    # five days ago: learning
    slot(5, 9, 0, "The Rust Book - Firefox")
    slot(5, 10, 30, "exercises.rs - learn-rust - Visual Studio Code")
    slot(5, 12, 0, "YouTube - Google Chrome")
    slot(5, 14, 0, "lib.rs - learn-rust - Visual Studio Code")

    # six days ago: operations
    slot(6, 8, 30, "deploy.sh - infra - Visual Studio Code")
    slot(6, 9, 45, "CI logs - GitHub Actions - Google Chrome")
    slot(6, 11, 0, "Grafana - Google Chrome")
    slot(6, 13, 45, "infra - Terminal")

    # eight days ago (this month): documents
    slot(8, 10, 0, "presentation.odp - LibreOffice Impress")
    slot(8, 11, 30, "Quarterly review - Google Docs - Google Chrome")
    slot(8, 14, 0, "Budget - LibreOffice Calc")

    # twelve days ago: mobile work and design
    slot(12, 9, 30, "App.tsx - mobile-app - Visual Studio Code")
    slot(12, 11, 0, "components.tsx - mobile-app - Visual Studio Code")
    slot(12, 13, 30, "React Native docs - Google Chrome")
    slot(12, 16, 0, "Sketches - Figma - Google Chrome")

    # sixteen days ago: research and writing
    slot(16, 10, 0, "thesis.tex - Overleaf - Firefox")
    slot(16, 12, 0, "Research papers - arXiv - Firefox")
    slot(16, 15, 0, "references.bib - Overleaf - Firefox")

    # twenty days ago: web and infra
    slot(20, 9, 0, "index.html - portfolio - Visual Studio Code")
    slot(20, 10, 30, "Deploy logs - Netlify - Google Chrome")
    slot(20, 12, 0, "nginx.conf - infra - Visual Studio Code")
    slot(20, 15, 0, "Music - Rhythmbox")

    # twenty four days ago: a different language
    slot(24, 9, 30, "main.go - cli-tool - Visual Studio Code")
    slot(24, 11, 0, "Go by Example - Firefox")
    slot(24, 13, 0, "cli-tool - Terminal")

    # twenty eight days ago (month view, within default prune window)
    slot(28, 11, 0, "feature branch - api-server - Visual Studio Code")
    slot(28, 13, 0, "Forum thread - Firefox")
    slot(28, 15, 30, "Wiki - Confluence - Google Chrome")

    events.sort(key=lambda e: e["ts"])
    return events


def summarize(events: list[dict]) -> None:
    from collections import defaultdict

    by_app: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for i in range(len(events) - 1):
        title = events[i]["title"]
        if title == "__IDLE__":
            continue
        gap = events[i + 1]["ts"] - events[i]["ts"]
        if gap <= 0 or gap > 7200:
            continue
        parts = title.split(" - ")
        if len(parts) >= 3:
            app = parts[-1].strip()
            activity = parts[-2].strip()
        elif len(parts) == 2:
            app = parts[1].strip()
            activity = parts[0].strip()
        else:
            app = title.strip()
            activity = ""
        if activity:
            by_app[app][activity] += gap

    print("[INFO] nested activities per app (today-sized gaps only):")
    for app in sorted(by_app, key=lambda a: sum(by_app[a].values()), reverse=True)[:5]:
        acts = by_app[app]
        print(f"  {app}: {len(acts)} sub-rows")


def main() -> None:
    default_out = os.path.expanduser("~/.local/share/synq-gnome/events.jsonl")
    parser = argparse.ArgumentParser(description="generate synq-gnome demo events")
    parser.add_argument("--output", default=default_out, help="target JSONL path")
    parser.add_argument("--dry-run", action="store_true", help="print to stdout only")
    args = parser.parse_args()

    events = build_demo_events()
    text = "".join(json.dumps(e) + "\n" for e in events)

    if args.dry_run:
        print(text, end="")
        print(f"# {len(events)} events", file=__import__("sys").stderr)
        return

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as fh:
        fh.write(text)

    print(f"[INFO] wrote {len(events)} events to {args.output}")
    if events:
        first = datetime.fromtimestamp(events[0]["ts"]).date()
        last = datetime.fromtimestamp(events[-1]["ts"]).date()
        print(f"[INFO] date span: {first} .. {last}")
    summarize(events)


if __name__ == "__main__":
    main()
