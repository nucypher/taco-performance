#!/usr/bin/env python3
"""Post TACo daily health check results to Discord webhook."""

import json
import os
import sys


def extract_json_summary(filepath):
    """Extract the JSON summary from runner output."""
    try:
        with open(filepath) as f:
            text = f.read()
        # The runner prints a pretty-printed JSON object as the last block,
        # possibly followed by a "[taco-perf] Done!" line.
        # Find the last top-level '{' and matching '}'.
        start = text.rfind("\n{")
        if start != -1:
            end = text.rfind("}")
            if end != -1:
                return json.loads(text[start : end + 1])
    except Exception as e:
        print(f"Warning: Could not parse {filepath}: {e}")
    return {
        "results": [{"success": 0, "total": 0, "successRate": 0, "p50": 0, "p95": 0}]
    }


def main():
    if len(sys.argv) < 3:
        print("Usage: post-discord.py <cohort1-output.txt> <cohort3-output.txt>")
        sys.exit(1)

    c1 = extract_json_summary(sys.argv[1])
    c3 = extract_json_summary(sys.argv[2])

    c1r = c1.get("results", [{}])[0]
    c3r = c3.get("results", [{}])[0]

    c1_success = c1r.get("success", 0)
    c1_total = c1r.get("total", 0)
    c1_rate = round(c1r.get("successRate", 0), 1)
    c1_p50 = round(c1r.get("p50", 0) / 1000, 2)
    c1_p95 = round(c1r.get("p95", 0) / 1000, 2)

    c3_success = c3r.get("success", 0)
    c3_total = c3r.get("total", 0)
    c3_rate = round(c3r.get("successRate", 0), 1)
    c3_p50 = round(c3r.get("p50", 0) / 1000, 2)
    c3_p95 = round(c3r.get("p95", 0) / 1000, 2)

    min_rate = min(c1_rate, c3_rate)
    if min_rate >= 95:
        color = 5832542  # green
    elif min_rate >= 80:
        color = 16750374  # yellow
    else:
        color = 15684432  # red

    from datetime import datetime, timezone

    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    description = (
        f"**Cohort 1** (simple conditions)\n"
        f"  {c1_success}/{c1_total} succeeded ({c1_rate}%)\n"
        f"  p50 {c1_p50}s  p95 {c1_p95}s\n\n"
        f"**Cohort 3** (Discord verification)\n"
        f"  {c3_success}/{c3_total} succeeded ({c3_rate}%)\n"
        f"  p50 {c3_p50}s  p95 {c3_p95}s\n\n"
        f"Domain: lynx"
    )

    embed = {
        "embeds": [
            {
                "title": f"TACo Daily Health Check \u2014 {timestamp}",
                "description": description,
                "color": color,
            }
        ]
    }

    webhook_url = os.environ.get("DISCORD_WEBHOOK_URL", "")
    if webhook_url:
        import subprocess

        result = subprocess.run(
            [
                "curl",
                "-s",
                "-o",
                "/dev/null",
                "-w",
                "%{http_code}",
                "-X",
                "POST",
                "-H",
                "Content-Type: application/json",
                "-d",
                json.dumps(embed),
                webhook_url,
            ],
            capture_output=True,
            text=True,
        )
        status = result.stdout.strip()
        if status in ("200", "204"):
            print(f"Posted to Discord (HTTP {status})")
        else:
            print(f"Discord webhook failed (HTTP {status})")
            print(result.stderr)
            sys.exit(1)
    else:
        print("DISCORD_WEBHOOK_URL not set, skipping")
        print(json.dumps(embed, indent=2))


if __name__ == "__main__":
    main()
