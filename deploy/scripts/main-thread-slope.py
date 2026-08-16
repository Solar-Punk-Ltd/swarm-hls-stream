#!/usr/bin/env python3
"""Read whether a page's main-thread cost moved WITHIN an arm, from the sampler's own JSONL.

`browser-cpu.sh` reports one mean and one peak per arm. Those answer what an arm cost and say
nothing about whether it was rising, which is a different question and the one a creep claim needs.

## ⛔⛔⛔ Why the samples are collapsed into windows first

The sampler writes `Performance.getMetrics` every five seconds, and consecutive readings of a
browser's task time are strongly autocorrelated. Fitting a line straight through them gives an
ordinary-least-squares standard error that assumes independence and is therefore far too small.

On the 2026-08-16 gateway-less sitting that difference decided a result. Per sample, the last native
arm reads `+0.176 of one thread over the arm, t = 5.28`. On sixty-second window medians the same arm
reads `+0.151 +/- 0.114, t = 1.32`, and the median of its first three windows is HIGHER than the
median of its last three. The whole apparent climb was one low opening window, 0.36 against 0.73 to
0.84 for the eleven that followed, which is the page still settling.

Windowing is also what `drift-holds-and-bends-2026-08-15` used, so this keeps one method rather than
letting each write-up pick the one that answers it.

⚠️ A window median is robust to that opening sample but it does not make four windows into a
measurement. Read the reported `windows` count before quoting a slope.

Usage:
  deploy/scripts/main-thread-slope.py <dir-or-file>...
"""

import json
import math
import os
import statistics as st
import sys

WINDOW_SECONDS = 60.0
# Below this a window's median is one or two readings wearing a robust statistic's name.
MIN_SAMPLES_PER_WINDOW = 6
EDGE_WINDOWS = 3


def read_fractions(path):
    """Per-interval fraction of one thread, as (elapsed seconds, fraction) pairs.

    The sampler writes cumulative counters plus a trailing summary line, so a difference of
    consecutive rows is what a fraction of one thread means here.
    """
    rows = []
    for line in open(path):
        line = line.strip()
        if not line:
            continue
        row = json.loads(line)
        if "Timestamp" in row:
            rows.append(row)
    start = rows[0]["Timestamp"] if rows else 0.0
    out = []
    for before, after in zip(rows, rows[1:]):
        span = after["Timestamp"] - before["Timestamp"]
        if span > 0:
            out.append(
                (after["Timestamp"] - start, (after["TaskDuration"] - before["TaskDuration"]) / span)
            )
    return out


def window_medians(fractions):
    buckets = {}
    for elapsed, fraction in fractions:
        buckets.setdefault(int(elapsed // WINDOW_SECONDS), []).append(fraction)
    keys = sorted(k for k in buckets if len(buckets[k]) >= MIN_SAMPLES_PER_WINDOW)
    return [((k + 0.5) * WINDOW_SECONDS, st.median(buckets[k])) for k in keys]


def least_squares(xs, ys):
    n = len(xs)
    mean_x, mean_y = sum(xs) / n, sum(ys) / n
    sxx = sum((x - mean_x) ** 2 for x in xs)
    sxy = sum((x - mean_x) * (y - mean_y) for x, y in zip(xs, ys))
    slope = sxy / sxx
    intercept = mean_y - slope * mean_x
    residuals = [y - (intercept + slope * x) for x, y in zip(xs, ys)]
    return slope, math.sqrt((sum(r * r for r in residuals) / (n - 2)) / sxx)


def jsonl_files(argv):
    for arg in argv:
        if os.path.isdir(arg):
            for name in sorted(os.listdir(arg)):
                if name.endswith("mainthread.jsonl"):
                    yield os.path.join(arg, name)
        else:
            yield arg


def main(argv):
    paths = list(jsonl_files(argv))
    if not paths:
        print("main-thread-slope: nothing to read", file=sys.stderr)
        return 2
    header = ("arm", "win", "median", "rise", "+/-", "t", "per hr", "first3", "last3", "delta")
    print(f"{header[0]:<26}{header[1]:>4}{header[2]:>8}{header[3]:>9}{header[4]:>8}"
          f"{header[5]:>7}{header[6]:>9}{header[7]:>8}{header[8]:>8}{header[9]:>8}")
    for path in paths:
        name = os.path.basename(path).replace("-mainthread.jsonl", "")
        windows = window_medians(read_fractions(path))
        if len(windows) < 4:
            print(f"{name:<26}{len(windows):>4}  too few windows to fit a slope")
            continue
        xs = [w[0] for w in windows]
        ys = [w[1] for w in windows]
        slope, stderr = least_squares(xs, ys)
        span = xs[-1] - xs[0]
        first = st.median(ys[:EDGE_WINDOWS])
        last = st.median(ys[-EDGE_WINDOWS:])
        print(
            f"{name:<26}{len(windows):>4}{st.median(ys):>8.3f}{slope * span:>+9.4f}"
            f"{stderr * span:>8.4f}{slope / stderr:>7.2f}{slope * 3600:>+9.4f}"
            f"{first:>8.3f}{last:>8.3f}{last - first:>+8.3f}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
