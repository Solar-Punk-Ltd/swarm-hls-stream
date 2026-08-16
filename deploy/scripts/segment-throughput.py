#!/usr/bin/env python3
"""Segment bytes per second a browser arm actually moved, from its own request log.

## ⛔⛔⛔ WHY NOT THE RUN'S `segments` TALLY

`weeb3-native.ts` documents its `SegmentTally` as weeb-3's log panel: a rolling window that reads
about 24 whatever the arm length. Measured 2026-08-16, one arm reported **24** while its request log
carried **671** segment fetches, and a 660-second live arm reported the same 24 against **1,439**.
The tally is useful for the failed count and the mean segment size and for nothing with a denominator.

## Why this is the column that makes two arms comparable

A thread reading is only interesting next to the work that produced it. On 2026-08-16 a live arm and
a recording arm both moved **2.77 Mbps** while their main threads read 0.768 and 0.249, which is what
turned "the gateway-less viewer costs more as the broadcast ages" into a question about live playback
rather than about retrieval volume.

⭐ The median of 30-second buckets, not the mean over the arm. A recording arm opens with a
pre-buffer burst, measured at 7.15 Mbps over its first thirty seconds before settling to 2.76, and a
mean over the whole arm reports neither number.

⚠️ Every segment the page fetches is on weeb-3's own origin, because a service worker serves
`hls/bytes/<reference>` from the node in the tab. That is why the path is matched rather than the
host, and it is why a gateway-less claim still needs the gateway's own counters beside it.

Usage:
  deploy/scripts/segment-throughput.py <run.requests.json>...
"""

import json
import os
import statistics as st
import sys

BUCKET_MS = 30_000
SEGMENT_PATH = "/hls/bytes/"
MIN_BUCKETS = 3


def segment_rows(path):
    with open(path) as handle:
        return [row for row in json.load(handle) if SEGMENT_PATH in row.get("url", "")]


def steady_mbps(path):
    """Median 30-second segment throughput in Mbps, or None when the arm is too short to have one."""
    rows = segment_rows(path)
    if not rows:
        return None
    first = min(row["startedAtMs"] for row in rows)
    buckets = {}
    for row in rows:
        key = int((row["startedAtMs"] - first) // BUCKET_MS)
        buckets[key] = buckets.get(key, 0) + (row.get("bytes") or 0)
    if len(buckets) < MIN_BUCKETS:
        return None
    # The final bucket is a partial one and would drag the median down for no reason.
    full = [buckets[key] for key in sorted(buckets)[:-1]]
    return st.median(full) * 8 / (BUCKET_MS / 1000) / 1e6


def main(argv):
    if not argv:
        print("usage: segment-throughput.py <run.requests.json>...", file=sys.stderr)
        return 2
    print(f"{'run':<34}{'steady Mbps':>12}{'fetches':>9}{'span s':>8}{'total MB':>10}")
    for path in argv:
        rows = segment_rows(path)
        if not rows:
            print(f"{os.path.basename(path):<34}{'no segment fetches':>39}")
            continue
        span = (max(r["startedAtMs"] for r in rows) - min(r["startedAtMs"] for r in rows)) / 1000
        total = sum(r.get("bytes") or 0 for r in rows)
        mbps = steady_mbps(path)
        print(f"{os.path.basename(path)[:34]:<34}"
              f"{('-' if mbps is None else f'{mbps:.2f}'):>12}{len(rows):>9}{span:>8.0f}{total / 1e6:>10.1f}")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
