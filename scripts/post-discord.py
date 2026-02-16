#!/usr/bin/env python3
"""Post TACo daily health check results to Discord webhook."""

import glob
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


PAGES_BASE = "https://nucypher.github.io/taco-performance/daily/"


def find_report(cohort_suffix):
    """Find the most recent report file for a cohort (e.g. '_c1.html')."""
    matches = sorted(glob.glob(f"results/reports/*{cohort_suffix}"))
    if matches:
        return os.path.basename(matches[-1])
    return None


def status_emoji(rate):
    if rate >= 95:
        return "\u2705"  # green check
    if rate >= 80:
        return "\u26a0\ufe0f"  # warning
    return "\u274c"  # red X


def fmt_cohort(label, r, report_url=None):
    success = r.get("success", 0)
    total = r.get("total", 0)
    rate = round(r.get("successRate", 0), 1)
    p50 = round(r.get("p50", 0) / 1000, 2)
    p95 = round(r.get("p95", 0) / 1000, 2)
    emoji = status_emoji(rate)
    title = f"**[{label}]({report_url})**" if report_url else f"**{label}**"
    return (
        f"{emoji} {title}\n"
        f"\u2003{success}/{total} passed \u00b7 **{rate}%**\n"
        f"\u2003p50 `{p50}s` \u00b7 p95 `{p95}s`"
    )


def main():
    if len(sys.argv) < 3:
        print("Usage: post-discord.py <cohort1-output.txt> <cohort3-output.txt>")
        sys.exit(1)

    c1 = extract_json_summary(sys.argv[1])
    c3 = extract_json_summary(sys.argv[2])

    c1r = c1.get("results", [{}])[0]
    c3r = c3.get("results", [{}])[0]

    c1_rate = round(c1r.get("successRate", 0), 1)
    c3_rate = round(c3r.get("successRate", 0), 1)

    min_rate = min(c1_rate, c3_rate)
    if min_rate >= 95:
        color = 5832542  # green
    elif min_rate >= 80:
        color = 16750374  # yellow
    else:
        color = 15684432  # red

    from datetime import datetime, timezone

    timestamp = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    c1_report = find_report("_c1.html")
    c3_report = find_report("_c3.html")
    c1_url = PAGES_BASE + c1_report if c1_report else None
    c3_url = PAGES_BASE + c3_report if c3_report else None

    description = (
        f"{fmt_cohort('Simple conditions', c1r, c1_url)}\n\n"
        f"{fmt_cohort('Discord verification', c3r, c3_url)}"
    )

    embed = {
        "embeds": [
            {
                "title": f"Daily Health Check \u2014 {timestamp}",
                "description": description,
                "color": color,
                "footer": {"text": "lynx \u00b7 base-sepolia"},
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
