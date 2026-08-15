"""Read a byte-source sitting: the joined table, the within-arm drift, and the join cost.

Written after the 2026-08-14 night, where every one of these was needed and each had been done by hand
against a different subset of the files. Reading them apart is how a sitting comes to quote a CPU
figure from one arm beside a retrieval figure from another.

The saturation column lives in `node-metrics/*-mainthread.jsonl`, the economics live in the driver's
own log, and only together do they say what an arm cost.

usage:
  read-sitting.py table <sitting-dir>            every column, per arm, warm-up marked
  read-sitting.py drift <sitting-dir> [windows]  utilisation per wall-clock window, and a slope
  read-sitting.py join  <sitting-dir>            opening window of each arm, by broadcast age
"""

import json
import os
import re
import sys
from pathlib import Path

ARM_START = re.compile(r"arm (\d+) \(round (\d+)\): segment bytes from (\w+), watching (\d+)s")
STALLS = re.compile(r"held at [\d.]+s target, max [\d.]+s, stallCount (\d+)")
BEHIND = re.compile(r"([\d.]+)s behind live, (\d+) rebuffers, (\d+) stalled samples")
CPU = re.compile(r"CPU: (\d+) samples, mean ([\d.]+) cores, peak ([\d.]+) cores")
RETRIEVALS = re.compile(r"^\s+retrieval requests\s+(\d+)")
WROTE = re.compile(r"browser: wrote \S*/(browser-watch-\S+)\.md")
PROFILE = re.compile(r"one LIVE broadcast of \d+ min at a [\d.]+s GOP, (\d+x\d+) at (\d+) kbps")

WARMUP_ROUNDS = 1
MIN_SAMPLES_PER_WINDOW = 3
DEFAULT_WINDOWS = 8

# `publish-clock.sh` defaults to 30 and `byte-source-arms.sh` passes it size, bitrate and GOP but
# never a frame rate, so every arm of every byte-source sitting asks for 30.
PUBLISHER_FPS = 30

# ⛔⛔⛔ THE BOUND THAT MAKES A 1080p SITTING READABLE AT ALL.
#
# On 2026-08-05 three of four 1080p rows delivered ~26.5fps against a requested 30, a ratio of 0.883.
# The packet count per segment was right for the GOP every time while the declared duration ran ~13%
# long, so the encoder was falling behind real time rather than dropping frames, and every other
# column looked healthy. A viewer decoding 26.5 frames a second does about 12% LESS work than one
# decoding 30, so on the main-thread axis a starved encoder reads as a cheaper viewer. That is the
# wrong sign on the one question these sittings are run to answer.
#
# ⛔⛔ `phase06-light-vs-ultralight.sh` already guards the delivered segment LENGTH and admits 0.7x to
# 1.4x, so a 13% stretch passes it comfortably. This is a different instrument, not a duplicate one.
#
# The low bound is the measured failure mode. The high bound has never been observed on this rig, the
# healthiest arm seen reads 1.025, so it is a sanity limit rather than a calibrated one: a frame rate
# far above the request means media seconds ran short, which is its own fault and not one to admit
# silently.
MIN_DELIVERED_FPS_RATIO = 0.95
MAX_DELIVERED_FPS_RATIO = 1.15

# ⛔ The opening window is matched in DURATION across arms, so a 5-minute opening is never compared
# against a 40-minute mean. 41/8 is the window `drift` uses, kept identical on purpose.
JOIN_WINDOW_S = 41 * 60 / 8
JOIN_MIN_SAMPLES = 20


def readings(path):
    """Every usable sample in an arm, dropping the trailing summary line."""
    rows = []
    for line in path.read_text(errors="replace").splitlines():
        if not line.strip() or '"summary"' in line:
            continue
        row = json.loads(line)
        if row.get("Timestamp") is not None and row.get("TaskDuration") is not None:
            rows.append(row)
    return rows


def summary_of(path):
    for line in path.read_text(errors="replace").splitlines():
        if '"summary"' in line:
            return json.loads(line)["summary"]
    return None


def bench_dir(root):
    """Where the driver's per-arm watch summaries landed.

    The driver logs the container's own `/repo/docs/bench/...` path, which is this checkout's
    `docs/bench` on the host that ran it. `SITTING_BENCH_DIR` overrides it for reading a sitting whose
    summaries were copied somewhere else.
    """
    override = os.environ.get("SITTING_BENCH_DIR")
    if override:
        return Path(override)
    return Path(__file__).resolve().parents[2] / "docs" / "bench"


def watch_document(bench, stem):
    path = bench / f"{stem}.json"
    return json.loads(path.read_text(errors="replace")) if path.is_file() else None


def delivered_fps(watch):
    """Frames the decoder produced INSIDE the arm's window, over the window's own seconds.

    ⛔⛔⛔ NOT `summary.deliveredFps`, WHICH READ 35.0 WHERE THE ENCODER WAS DELIVERING 30.0.
    `decodedFrames` counts from the start of playback and every arm plays a 60s settle before its
    window opens, so until the fix in PR #200 that field carried the settle's frames over the
    window's media alone. Recomputing from the samples means a sitting recorded before that fix reads
    correctly, and one recorded after it agrees.

    ⚠️ The denominator is the window's WALL seconds rather than its media seconds, so a frozen picture
    depresses this where `summary.deliveredFps` would divide the freeze out of both halves. For a
    guard that is the safe direction: it makes a doubtful arm MORE likely to be refused, never less.
    """
    samples = (watch or {}).get("samples") or []
    counted = [s for s in samples if s.get("decodedFrames") is not None]
    span_s = ((watch or {}).get("summary", {}).get("spanMs") or 0) / 1000
    if len(counted) < 2 or span_s <= 0:
        return None
    return (counted[-1]["decodedFrames"] - counted[0]["decodedFrames"]) / span_s


def same_size(delivered, requested):
    """Whether two resolutions match, given the browser writes `1920×1080` and the driver `1920x1080`."""
    normalise = lambda text: (text or "").lower().replace("×", "x").strip()  # noqa: E731
    return normalise(delivered) == normalise(requested)


def axis_verdict(watch, requested_size):
    """Whether this arm was delivered at the profile the sitting says it was measuring.

    ⛔⛔ A MISSING READING IS `unknown`, NEVER `ok`. "I could not find it" and "there is nothing wrong
    with it" are the same return value only if you write them that way, which is how #41 shipped. An
    arm whose frame rate nobody can read cannot vouch for itself.
    """
    fps = delivered_fps(watch)
    if fps is None:
        return "unknown", None
    resolution = (watch or {}).get("summary", {}).get("resolution")
    if not same_size(resolution, requested_size):
        return f"res {resolution}", fps
    ratio = fps / PUBLISHER_FPS
    if not MIN_DELIVERED_FPS_RATIO <= ratio <= MAX_DELIVERED_FPS_RATIO:
        return f"fps {ratio:.3f}x", fps
    return "ok", fps


def arms_from_log(log_path):
    """One dict per arm, in the order the driver ran them.

    ⛔ Keyed off the driver's own `arm N (round R)` line rather than off file names, so an arm that
    produced no readings still gets a row saying so. A table that silently omits a failed arm reads
    as a sitting where every arm worked.
    """
    arms, current = [], None
    for line in log_path.read_text(errors="replace").splitlines():
        wrote = WROTE.search(line)
        if wrote and current is not None:
            current.setdefault("watch", wrote.group(1))
            continue
        start = ARM_START.search(line)
        if start:
            current = {
                "arm": int(start.group(1)),
                "round": int(start.group(2)),
                "cond": start.group(3),
                "watchS": int(start.group(4)),
            }
            arms.append(current)
            continue
        if current is None:
            continue
        for pattern, keys in (
            (STALLS, ("stalls",)),
            (BEHIND, ("behindS", "rebuffers", "stalledSamples")),
            (CPU, ("cpuSamples", "cpuMean", "cpuPeak")),
            (RETRIEVALS, ("retrievals",)),
        ):
            found = pattern.search(line)
            # ⛔ `setdefault`, not assignment: `retrieval requests` appears again in the sitting-level
            # diff after the last arm, and the FIRST match inside an arm block is that arm's.
            if found:
                for key, value in zip(keys, found.groups()):
                    current.setdefault(key, float(value) if "." in value else int(value))
    return arms


def jsonl_for(metrics_dir, arm_number):
    found = sorted(metrics_dir.glob(f"arm{arm_number:02d}-*-mainthread.jsonl"))
    return found[0] if found else None


def dashed(value, places=3):
    """A missing reading prints as a dash, never 0.000, which would read as an idle thread."""
    return "—" if value is None else f"{value:.{places}f}"


def signed(value, places=3):
    """⭐ For a slope the SIGN is the finding. `0.056` and `-0.056` are creeping and settling, and a
    reader scanning a column should not have to look twice to tell them apart."""
    return "—" if value is None else f"{value:+.{places}f}"


def windowed(rows, count):
    """Utilisation of each equal WALL-CLOCK window, None where a window is too sparse to trust.

    ⛔⛔ Windows are cut on wall clock, not on sample index. Sampling can stutter, and equal-count
    windows would then cover unequal spans and report a trend built out of the stutter.
    """
    span = (rows[-1]["Timestamp"] - rows[0]["Timestamp"]) / count
    if span <= 0:
        return []
    out = []
    for index in range(count):
        lo = rows[0]["Timestamp"] + index * span
        hi = lo + span
        inside = [r for r in rows if lo <= r["Timestamp"] <= hi]
        if len(inside) < MIN_SAMPLES_PER_WINDOW:
            out.append(None)
            continue
        wall = inside[-1]["Timestamp"] - inside[0]["Timestamp"]
        work = inside[-1]["TaskDuration"] - inside[0]["TaskDuration"]
        out.append(work / wall if wall > 0 else None)
    return out


def slope_per_hour(rows):
    """Least squares fit of per-interval utilisation against elapsed hours."""
    points = []
    for index in range(1, len(rows)):
        wall = rows[index]["Timestamp"] - rows[index - 1]["Timestamp"]
        if wall <= 0:
            continue
        use = (rows[index]["TaskDuration"] - rows[index - 1]["TaskDuration"]) / wall
        points.append(((rows[index]["Timestamp"] - rows[0]["Timestamp"]) / 3600.0, use))
    if len(points) < 3:
        return None
    mean_x = sum(x for x, _ in points) / len(points)
    mean_y = sum(y for _, y in points) / len(points)
    denom = sum((x - mean_x) ** 2 for x, _ in points)
    return None if denom == 0 else sum((x - mean_x) * (y - mean_y) for x, y in points) / denom


def heap_floor(rows):
    """Post-GC floor at the start, and how far that floor moved by the end, in MB.

    ⛔⛔ NOT first-to-last. The heap is garbage collected, so two endpoints measure where in the GC
    cycle those samples happened to fall. Read that way on 2026-08-14, the gateway arms appeared to
    grow 28.7 MB against weeb3's 14.5, which would have been published as the gateway leaking twice
    as fast. Taking the MINIMUM of each quartile approximates the heap just after a collection, and a
    floor that climbs is memory that was never reclaimed. That reverses the sign.
    """
    sized = [r["JSHeapUsedSize"] / 1e6 for r in rows if r.get("JSHeapUsedSize")]
    if len(sized) < 8:
        return None, None
    quartile = max(2, len(sized) // 4)
    start = min(sized[:quartile])
    return start, min(sized[-quartile:]) - start


def off_main_fraction(rows):
    """Share of the renderer's CPU that is NOT on the main thread, over the whole arm.

    ⛔⛔ NOT a decomposition of weeb-3. The renderer also rasters and composites, and video decode is
    in the GPU process entirely, so a gateway arm reads ~0.80 off-main from ordinary playback with no
    node in the tab at all. Only the DIFFERENCE between conditions says anything.
    """
    if len(rows) < 2:
        return None
    process = rows[-1]["ProcessTime"] - rows[0]["ProcessTime"]
    main = rows[-1]["TaskDuration"] - rows[0]["TaskDuration"]
    return None if process <= 0 else max(0.0, (process - main) / process)


def requested_size(log_path):
    """The resolution the sitting told the publisher to produce, from its own opening line."""
    found = PROFILE.search(log_path.read_text(errors="replace"))
    return found.group(1) if found else None


def cmd_table(root):
    log_path = root / "byte-source-arms.log"
    metrics = root / "node-metrics"
    bench = bench_dir(root)
    wanted = requested_size(log_path)
    kept, refused = {}, []
    header = (f"{'arm':>3} {'rnd':>3} {'cond':<8} {'kept':<7} {'retrievals':>11} {'cores':>6}"
              f" {'peak':>6} {'thread':>7} {'thrPeak':>8} {'stalls':>7} {'behindS':>8} {'complete':>9}"
              f" {'fps':>6} {'axis':>12}")
    print(header)
    print("-" * len(header))
    for arm in arms_from_log(log_path):
        path = jsonl_for(metrics, arm["arm"])
        summary = (summary_of(path) or {}) if path else {}
        counted = arm["round"] > WARMUP_ROUNDS
        verdict, fps = axis_verdict(watch_document(bench, arm["watch"]) if arm.get("watch") else None, wanted)
        if counted and verdict != "ok":
            refused.append((arm, verdict))
        print(" ".join((
            f"{arm['arm']:>3}", f"{arm['round']:>3}", f"{arm['cond']:<8}",
            f"{'counted' if counted else 'warm-up':<7}", f"{arm.get('retrievals', '—'):>11}",
            f"{arm.get('cpuMean', '—'):>6}", f"{arm.get('cpuPeak', '—'):>6}",
            f"{dashed(summary.get('mean')):>7}", f"{dashed(summary.get('peak')):>8}",
            f"{arm.get('stalls', '—'):>7}", f"{arm.get('behindS', '—'):>8}",
            f"{str(summary.get('complete', '—')):>9}",
            f"{dashed(fps, 1):>6}", f"{verdict:>12}",
        )))
        if counted and verdict == "ok" and summary.get("mean") is not None:
            kept.setdefault(arm["cond"], []).append((summary["mean"], summary["peak"], arm.get("retrievals")))

    print()
    for cond, rows in kept.items():
        print(f"{cond:<8} n={len(rows)}  thread {min(r[0] for r in rows):.3f}-{max(r[0] for r in rows):.3f}"
              f"  peak {min(r[1] for r in rows):.3f}-{max(r[1] for r in rows):.3f}")
    if refused:
        print(f"\n⛔ REFUSING TO SUMMARISE. {len(refused)} counted arm(s) were not delivered at "
              f"{wanted} {PUBLISHER_FPS}fps, which is the profile this sitting claims to measure:")
        for arm, verdict in refused:
            print(f"    arm {arm['arm']} ({arm['cond']}): {verdict}")
        print("  A viewer decoding fewer frames does LESS work, so a starved arm reads as a CHEAPER")
        print("  viewer and would answer the saturation question in the wrong direction.")
        return 1
    gateway, weeb3 = kept.get("gateway", []), kept.get("weeb3", [])
    if gateway and weeb3:
        # ⛔ Overlap is stated before any ratio. Two ranges that touch mean the sitting did not
        # separate the conditions, whatever the ratio of the means happens to say.
        overlap = (max(min(r[0] for r in gateway), min(r[0] for r in weeb3))
                   <= min(max(r[0] for r in gateway), max(r[0] for r in weeb3)))
        mean = lambda rows, i: sum(r[i] for r in rows) / len(rows)  # noqa: E731
        print(f"\nthread ranges overlap: {overlap}")
        print(f"weeb3/gateway MAIN THREAD mean {mean(weeb3, 0) / mean(gateway, 0):.2f}x")
        if all(r[2] for r in gateway + weeb3):
            print(f"gateway retrievals saved  {mean(gateway, 2) / mean(weeb3, 2):.1f}x fewer")
    return 0


def cmd_drift(root, count):
    """⭐ What a viewer pays for WATCHING longer, read inside each arm against its own start."""
    for path in sorted((root / "node-metrics").glob("*-mainthread.jsonl")):
        rows = readings(path)
        arm = path.name.replace("-mainthread.jsonl", "")
        if len(rows) < count * MIN_SAMPLES_PER_WINDOW:
            print(f"{arm:<28} only {len(rows)} usable readings, too few for {count} windows")
            continue
        cells = windowed(rows, count)
        slope = slope_per_hour(rows)
        floor_start, floor_grew = heap_floor(rows)
        minutes = (rows[-1]["Timestamp"] - rows[0]["Timestamp"]) / 60
        print(f"{arm:<28} {minutes:5.1f}min  {' '.join(dashed(c) for c in cells)}"
              f"   slope/hr {signed(slope)}   heapFloor {dashed(floor_grew, 1)}MB"
              f"   offMain {dashed(off_main_fraction(rows))}")


def cmd_join(root):
    """⭐⭐⭐ What a viewer pays for JOINING a broadcast already running.

    Each arm is a fresh browser started later than the last, so the opening window of every arm is one
    observation of the join cost at that broadcast age. A FLAT column means joining is free and the
    cost is per SESSION.

    ⚠️ Read the counted arms only. Both warm-up arms are the LOW anchors, and warm-up arms are
    discarded because the first arms of a sitting run differently. Including them manufactures a
    broadcast-age trend that is really the warm-up effect.
    """
    metrics = root / "node-metrics"
    by_arm = {a["arm"]: a for a in arms_from_log(root / "byte-source-arms.log")}
    first_start = None
    print(f"{'arm':<28}{'cond':<9}{'kept':<9}{'joins at':>10}{'n':>5}{'JOIN COST':>11}")
    for path in sorted(metrics.glob("*-mainthread.jsonl")):
        rows = readings(path)
        name = path.name.replace("-mainthread.jsonl", "")
        number = int(name[3:5])
        arm = by_arm.get(number, {})
        kept = "counted" if arm.get("round", 1) > WARMUP_ROUNDS else "warm-up"
        if len(rows) < JOIN_MIN_SAMPLES:
            print(f"{name:<28}{arm.get('cond', '?'):<9}{kept:<9}{'—':>10}{len(rows):>5}{'too few':>11}")
            continue
        if first_start is None:
            first_start = rows[0]["Timestamp"]
        inside = [r for r in rows if r["Timestamp"] - rows[0]["Timestamp"] <= JOIN_WINDOW_S]
        wall = inside[-1]["Timestamp"] - inside[0]["Timestamp"]
        work = inside[-1]["TaskDuration"] - inside[0]["TaskDuration"]
        age = f"{(rows[0]['Timestamp'] - first_start) / 60:.0f}min"
        print(f"{name:<28}{arm.get('cond', '?'):<9}{kept:<9}{age:>10}{len(inside):>5}"
              f"{dashed(work / wall if wall > 0 else None):>11}")
    print("\n⭐ A FLAT column across the COUNTED arms means joining a long broadcast is free.")


def main():
    if len(sys.argv) < 3:
        print(__doc__)
        return 2
    command, root = sys.argv[1], Path(sys.argv[2])
    if not (root / "byte-source-arms.log").is_file():
        print(f"no byte-source-arms.log under {root}, so this is not a sitting directory")
        return 1
    if command == "table":
        return cmd_table(root)
    elif command == "drift":
        cmd_drift(root, int(sys.argv[3]) if len(sys.argv) > 3 else DEFAULT_WINDOWS)
    elif command == "join":
        cmd_join(root)
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
