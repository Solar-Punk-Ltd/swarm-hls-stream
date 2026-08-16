#!/usr/bin/env python3
"""Join a recording-timeline sweep's arms to their thread column and their actual playhead.

## ⛔⛔⛔ THE `landed` COLUMN IS A CHECK ON THE DESIGN, NOT A RESULT

The sweep varies `WEEB3_NATIVE_START_S` to move the playhead inside a fixed timeline. weeb-3 decides
its own restart position, so a driver ASKING for a playhead is not the same as a session having one.
If every arm lands at the same `currentTime`, that factor never varied, and a flat thread column
would then read as "playhead position does not matter" when it means "playhead position was never
tested".

`asked` and `landed` are printed side by side for exactly that reason. Read them before reading
anything to their right. A constant across a wide range is a red flag when the varying quantity never
entered the statistic.

Usage:
  deploy/scripts/read-recording-timeline.py <sweep-dir> <artefact-dir>
"""

import datetime as dt
import importlib.util
import json
import os
import statistics as st
import sys

HERE = os.path.dirname(os.path.abspath(__file__))


def _load_module(name, filename):
    """Sibling scripts are hyphenated because they are commands, so they cannot be imported by name."""
    spec = importlib.util.spec_from_file_location(name, os.path.join(HERE, filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


SLOPE = _load_module("main_thread_slope", "main-thread-slope.py")
THROUGHPUT = _load_module("segment_throughput", "segment-throughput.py")


def parse_iso(text):
    return dt.datetime.fromisoformat(text.replace("Z", "+00:00"))


def read_state(path, since_override):
    """The sweep's own start time and its arm rows.

    ⛔ The start time is read, never inferred. A filesystem timestamp on a file the sweep is still
    appending to is the time of the last write, and using it as a lower bound excluded every artefact
    the sweep had produced. Refusing is better than a bound that quietly matches the wrong runs: the
    proof arm that preceded this sweep sat fourteen minutes before its first arm, well inside any
    margin loose enough to be safe.
    """
    started = since_override
    rows = []
    with open(path) as handle:
        first = handle.readline().rstrip("\n")
        if first.startswith("# started "):
            started = started or first[len("# started "):]
            first = handle.readline().rstrip("\n")
        header = first.split("\t")
        for line in handle:
            values = line.rstrip("\n").split("\t")
            if len(values) == len(header):
                rows.append(dict(zip(header, values)))
    if started is None:
        raise SystemExit(
            f"{path} carries no '# started <ISO>' line, so pass the sweep start as the third argument. "
            "Guessing it from file times matches runs that were not part of this sweep."
        )
    return parse_iso(started), rows


def artefacts_between(directory, started):
    """Native-run artefacts measured at or after the sweep started, oldest first."""
    found = []
    for name in sorted(os.listdir(directory)):
        if not name.startswith("weeb3-native-") or not name.endswith(".json"):
            continue
        if name.endswith(".requests.json"):
            continue
        path = os.path.join(directory, name)
        try:
            run = json.load(open(path))
        except (json.JSONDecodeError, OSError):
            continue
        measured = run.get("measuredAt")
        if measured and parse_iso(measured) >= started:
            found.append((parse_iso(measured), run, path))
    return [(run, path) for _, run, path in sorted(found, key=lambda triple: triple[0])]


def thread_column(metrics_dir, slug_prefix):
    for name in sorted(os.listdir(metrics_dir)):
        if not (name.startswith(slug_prefix) and name.endswith("mainthread.jsonl")):
            continue
        windows = SLOPE.window_medians(SLOPE.read_fractions(os.path.join(metrics_dir, name)))
        if len(windows) < 2:
            return None
        values = [w[1] for w in windows]
        return {
            "windows": len(values),
            "median": st.median(values),
            "first": st.median(values[: SLOPE.EDGE_WINDOWS]),
            "last": st.median(values[-SLOPE.EDGE_WINDOWS :]),
        }
    return None


def requests_sibling(run_path):
    """The `.requests.json` written beside every run artefact."""
    return run_path[: -len(".json")] + ".requests.json"


def cell(value, spec):
    return format(value, spec) if value is not None else "-"


def rows_for(sweep_dir, artefact_dir, start_override):
    """Every successful arm of one sweep, joined to its artefact and its thread column."""
    metrics_dir = os.path.join(sweep_dir, "node-metrics")
    started, arms = read_state(os.path.join(sweep_dir, "recording-timeline-state.tsv"), start_override)
    ok_arms = [arm for arm in arms if arm["status"] == "ok"]
    files = artefacts_between(artefact_dir, started)
    if len(files) != len(ok_arms):
        print(f"⚠️ {sweep_dir}: {len(ok_arms)} arms succeeded and {len(files)} artefacts were found, "
              "so the join may be shifted", file=sys.stderr)
    out = []
    for index, arm in enumerate(ok_arms):
        run, run_path = files[index] if index < len(files) else ({}, None)
        if run and run.get("topic") and run["topic"] != arm["topic"]:
            print(f"⛔ arm {arm['arm']} is labelled {arm['topic'][:8]} and its artefact says "
                  f"{run['topic'][:8]}, so this join is shifted", file=sys.stderr)
        served = run.get("offShellServedBytes")
        out.append({
            "arm": arm,
            "sample": (run.get("samples") or [{}])[0],
            "thread": thread_column(metrics_dir, "arm%02d-" % int(arm["arm"])),
            "mbps": THROUGHPUT.steady_mbps(requests_sibling(run_path)) if run_path else None,
            "realtime": run.get("realtimeRatio"),
            "stalls": run.get("stalls"),
            "offShell": sum(served.values()) if served is not None else None,
        })
    return out


def grouped(rows):
    """Per condition, every arm's steady reading, so a null is shown rather than averaged into one.

    ⛔ No mean and no standard error. Three arms per condition is what this sweep has, and a spread
    of three numbers is the honest presentation of three numbers.
    """
    order, by_label = [], {}
    for row in rows:
        label = row["arm"]["label"]
        if label not in by_label:
            order.append(label)
            by_label[label] = []
        by_label[label].append(row)
    print()
    print(f"{'condition':<18}{'n':>3}{'timeline':>10}{'landed':>8}   "
          f"{'steady thread, each arm':<30}{'Mbps, each arm':<24}")
    for label in order:
        group = by_label[label]
        steady = ", ".join(f"{r['thread']['last']:.3f}" for r in group if r["thread"])
        rates = ", ".join(f"{r['mbps']:.2f}" for r in group if r["mbps"] is not None)
        first = group[0]
        print(f"{label:<18}{len(group):>3}"
              f"{cell(first['sample'].get('seekableEnd'), '10.0f')}"
              f"{cell(first['sample'].get('currentTime'), '8.0f')}   {steady:<30}{rates:<24}")


def main(argv):
    if len(argv) < 2:
        print("usage: read-recording-timeline.py <artefact-dir> <sweep-dir>[@<start-iso>]...", file=sys.stderr)
        return 2
    artefact_dir = argv[0]
    rows = []
    for spec in argv[1:]:
        sweep_dir, _, start_override = spec.partition("@")
        rows.extend(rows_for(sweep_dir, artefact_dir, start_override or None))
    print(f"{'arm':<18}{'asked':>7}{'landed':>8}{'timeline':>10}{'win':>5}{'thread':>8}"
          f"{'first3':>8}{'last3':>8}{'Mbps':>7}{'realtime':>10}{'stalls':>7}{'offshell':>9}")
    for row in rows:
        arm, thread = row["arm"], row["thread"]
        print(
            f"{arm['label']:<18}{arm['start_s']:>7}"
            f"{cell(row['sample'].get('currentTime'), '8.0f')}"
            f"{cell(row['sample'].get('seekableEnd'), '10.0f')}"
            f"{cell(thread and thread['windows'], '5d')}"
            f"{cell(thread and thread['median'], '8.3f')}"
            f"{cell(thread and thread['first'], '8.3f')}"
            f"{cell(thread and thread['last'], '8.3f')}"
            f"{cell(row['mbps'], '7.2f')}"
            f"{cell(row['realtime'], '10.4f')}"
            f"{cell(row['stalls'], '7d')}"
            f"{cell(row['offShell'], '9d')}"
        )
    grouped(rows)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
