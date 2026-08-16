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


def main(argv):
    if len(argv) < 2:
        print("usage: read-recording-timeline.py <sweep-dir> <artefact-dir> [sweep-start-iso]", file=sys.stderr)
        return 2
    sweep_dir, artefact_dir = argv[0], argv[1]
    metrics_dir = os.path.join(sweep_dir, "node-metrics")
    started, arms = read_state(
        os.path.join(sweep_dir, "recording-timeline-state.tsv"), argv[2] if len(argv) > 2 else None
    )
    ok_arms = [arm for arm in arms if arm["status"] == "ok"]
    files = artefacts_between(artefact_dir, started)

    if len(files) != len(ok_arms):
        print(f"⚠️ {len(ok_arms)} arms succeeded and {len(files)} artefacts were found, so the join may be shifted",
              file=sys.stderr)

    print(f"{'arm':<18}{'asked':>7}{'landed':>8}{'timeline':>10}{'win':>5}{'thread':>8}"
          f"{'first3':>8}{'last3':>8}{'Mbps':>7}{'realtime':>10}{'stalls':>7}{'offshell':>9}")
    for index, arm in enumerate(ok_arms):
        run, run_path = files[index] if index < len(files) else ({}, None)
        first_sample = (run.get("samples") or [{}])[0]
        thread = thread_column(metrics_dir, "arm%02d-" % int(arm["arm"]))
        off_shell = sum((run.get("offShellServedBytes") or {}).values())
        print(
            f"{arm['label']:<18}{arm['start_s']:>7}"
            f"{cell(first_sample.get('currentTime'), '8.0f')}"
            f"{cell(first_sample.get('seekableEnd'), '10.0f')}"
            f"{cell(thread and thread['windows'], '5d')}"
            f"{cell(thread and thread['median'], '8.3f')}"
            f"{cell(thread and thread['first'], '8.3f')}"
            f"{cell(thread and thread['last'], '8.3f')}"
            f"{cell(THROUGHPUT.steady_mbps(requests_sibling(run_path)) if run_path else None, '7.2f')}"
            f"{cell(run.get('realtimeRatio'), '10.4f')}"
            f"{cell(run.get('stalls'), '7d')}"
            f"{off_shell:>9}"
        )
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
