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
  read-sitting.py shape <dir> [<dir>...]         the whole distribution, with the count behind each
  read-sitting.py load  <sitting-dir> [creep]    how much HOST LOAD moves the thread, and whether it
                                                 could fake a creep of the given cores per hour
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


# The thread series runs from the arm opening to the stop file, so it covers the watch window PLUS the
# settle and normally reads above 1.0. Materially short of the window is a sampler that stopped early.
MIN_THREAD_COVERAGE = 0.9


def coverage_verdict(summary, watch_s):
    """Whether the thread series actually spans the arm it is labelled with.

    ⛔⛔⛔ `complete` IN THE SUMMARY DOES NOT MEAN THIS. It reports whether every scriptable target was
    sampled. A sampler whose CDP connection dies mid-arm still runs its `finally`, writes
    `complete: true` beside a short `wallS`, and leaves a perfectly well-formed series covering part of
    the arm. On six-minute arms that was a small lie. On a three-hour arm it is a slope fitted over
    forty minutes and published as three hours.

    ⚠️ An arm with no series at all is not refused here. It carries no mean, so it never reaches the
    headline, and `axis` already refuses an arm nobody could check.
    """
    if not summary or summary.get("wallS") is None or not watch_s:
        return "ok", None
    if summary.get("stoppedEarly"):
        return f"stopped early: {str(summary['stoppedEarly'])[:24]}", summary["wallS"] / watch_s
    covered = summary["wallS"] / watch_s
    if covered < MIN_THREAD_COVERAGE:
        return f"covered {summary['wallS']:.0f}s of {watch_s}s", covered
    return "ok", covered


def requested_size(log_path):
    """The resolution the sitting told the publisher to produce, from its own opening line."""
    found = PROFILE.search(log_path.read_text(errors="replace"))
    return found.group(1) if found else None


def cmd_table(root):
    log_path = root / "byte-source-arms.log"
    metrics = root / "node-metrics"
    bench = bench_dir(root)
    wanted = requested_size(log_path)
    kept, refused, truncated = {}, [], []
    header = (f"{'arm':>3} {'rnd':>3} {'cond':<8} {'kept':<7} {'retrievals':>11} {'cores':>6}"
              f" {'peak':>6} {'thread':>7} {'thrPeak':>8} {'stalls':>7} {'behindS':>8} {'complete':>9}"
              f" {'cover':>6} {'fps':>6} {'axis':>12}")
    print(header)
    print("-" * len(header))
    for arm in arms_from_log(log_path):
        path = jsonl_for(metrics, arm["arm"])
        summary = (summary_of(path) or {}) if path else {}
        counted = arm["round"] > WARMUP_ROUNDS
        verdict, fps = axis_verdict(watch_document(bench, arm["watch"]) if arm.get("watch") else None, wanted)
        if counted and verdict != "ok":
            refused.append((arm, verdict))
        covered, coverage = coverage_verdict(summary, arm.get("watchS"))
        if counted and covered != "ok":
            truncated.append((arm, covered))
        print(" ".join((
            f"{arm['arm']:>3}", f"{arm['round']:>3}", f"{arm['cond']:<8}",
            f"{'counted' if counted else 'warm-up':<7}", f"{arm.get('retrievals', '—'):>11}",
            f"{arm.get('cpuMean', '—'):>6}", f"{arm.get('cpuPeak', '—'):>6}",
            f"{dashed(summary.get('mean')):>7}", f"{dashed(summary.get('peak')):>8}",
            f"{arm.get('stalls', '—'):>7}", f"{arm.get('behindS', '—'):>8}",
            f"{str(summary.get('complete', '—')):>9}",
            f"{dashed(coverage):>6}",
            f"{dashed(fps, 1):>6}", f"{verdict:>12}",
        )))
        if counted and verdict == "ok" and covered == "ok" and summary.get("mean") is not None:
            kept.setdefault(arm["cond"], []).append((summary["mean"], summary["peak"], arm.get("retrievals")))

    print()
    for cond, rows in kept.items():
        print(f"{cond:<8} n={len(rows)}  thread {min(r[0] for r in rows):.3f}-{max(r[0] for r in rows):.3f}"
              f"  peak {min(r[1] for r in rows):.3f}-{max(r[1] for r in rows):.3f}")
    if truncated:
        print(f"\n⛔ REFUSING TO SUMMARISE. {len(truncated)} counted arm(s) have a thread series that "
              f"does not span the arm it is labelled with:")
        for arm, why in truncated:
            print(f"    arm {arm['arm']} ({arm['cond']}): {why}")
        print("  A sampler that stops early still writes complete:true beside a short wallS, so the")
        print("  series looks whole. Every per-hour figure read off it would be fitted over the part")
        print("  that survived and published as the whole arm.")
        return 1
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


# ⛔⛔⛔ BELOW THIS MANY SAMPLES ABOVE THE CUT, A QUANTILE IS NOT A DISTRIBUTION.
#
# On 2026-08-15 the 720p and 1080p sittings were compared quantile by quantile. p90 moved 1.60x with
# the bytes and p99 moved 1.03x, which reads as a tail that bitrate does not touch, and that is a
# mechanism worth a paid sitting to chase. With 253 pooled intervals per condition, p99 is the
# THIRD-HIGHEST VALUE. The invariance was three windows.
#
# ⭐ What survived the check is stronger than the claim it killed: every quantile from q25 to q90
# moves by ONE factor, 1.60x to 1.64x, so the distribution scales uniformly rather than changing
# shape. A second claim died in the same pass, "the crest factor is compressing", which was
# mean-against-max where p90/p50 reads 1.129 against 1.105 and has not moved.
#
# The count is printed for every row rather than the thin ones being hidden, because a reader who
# cannot see p99 will compute it by hand from the same file.
MIN_SAMPLES_FOR_QUANTILE = 20
SHAPE_QUANTILES = (0.25, 0.50, 0.75, 0.90, 0.95, 0.975, 0.99)


def utilisations(path):
    """Every per-interval utilisation in one arm, as fractions of one thread."""
    rows = readings(path)
    out = []
    for index in range(1, len(rows)):
        wall = rows[index]["Timestamp"] - rows[index - 1]["Timestamp"]
        if wall > 0:
            out.append((rows[index]["TaskDuration"] - rows[index - 1]["TaskDuration"]) / wall)
    return out


def off_profile(root):
    """Counted arms the axis guard would not vouch for, as `{arm number: verdict}`.

    ⛔ `table` and `shape` read the same sitting, so they must agree about which arms count. On
    2026-08-15 this pooled 254 gateway intervals where the guard had already refused one of the arms
    that produced them, and two views of one dataset disagreeing about its own membership is how a
    figure from a discarded arm ends up beside one from a kept arm.
    """
    log = root / "byte-source-arms.log"
    bench, wanted = bench_dir(root), requested_size(log)
    verdicts = {}
    for arm in arms_from_log(log):
        if arm["round"] <= WARMUP_ROUNDS:
            continue
        watch = watch_document(bench, arm["watch"]) if arm.get("watch") else None
        verdict, _ = axis_verdict(watch, wanted)
        if verdict != "ok":
            verdicts[arm["arm"]] = verdict
    return verdicts


def pooled(root, cond, skip=()):
    """Every counted arm of one condition, pooled. Warm-up rounds are never in here."""
    out = []
    for path in sorted((root / "node-metrics").glob(f"*-{cond}-mainthread.jsonl")):
        if f"-round{WARMUP_ROUNDS}-" in path.name or int(path.name[3:5]) in skip:
            continue
        out.extend(utilisations(path))
    return sorted(out)


def quantile(ordered, q):
    return ordered[min(len(ordered) - 1, int(q * len(ordered)))] if ordered else None


# A thread reading is joined to the nearest load sample inside this many seconds. The sampler runs at
# METRICS_INTERVAL_S=30, so anything further away has no sample of its own.
LOAD_JOIN_TOLERANCE_S = 30
# Refuse to align two series whose spans disagree by more than this. They are meant to cover the same
# arm, and spans that do not match mean they do not.
MAX_SPAN_DISAGREEMENT_S = 60
MIN_POINTS_FOR_SENSITIVITY = 20


def load_samples(series_dir):
    """(epoch seconds, one-minute load average) from one arm's mid-flight node-metrics samples."""
    out = []
    for path in sorted(series_dir.glob("sample-*.json")):
        try:
            sample = json.loads(path.read_text())
            out.append((sample["atMs"] / 1000, float(sample["hostLoad"].split()[0])))
        except (ValueError, KeyError, IndexError):
            continue
    return out


def clock_offset(rows, samples):
    """Seconds to add to a CDP timestamp to reach the sampler's epoch clock.

    ⛔⛔⛔ THE TWO FILES DO NOT SHARE A CLOCK. `*-mainthread.jsonl` carries CDP's `Timestamp`, which is
    the host's monotonic clock, while `sample-NNNN.json` carries `atMs`, which is epoch. Joining them
    on the raw numbers silently pairs every thread reading with the same one sample.

    The offset is taken from the sitting rather than from `/proc/uptime`, which is only readable on the
    host, only correct until it reboots, and wrong for anyone reading the sitting anywhere else. Both
    series cover one arm, so centring them recovers the offset to within the few seconds by which the
    sampler leads the browser, which is well inside a 30s sampling interval and further inside a
    one-minute load average.

    Returns None when the two spans disagree enough that they cannot be the same window.
    """
    if len(rows) < 2 or len(samples) < 2:
        return None
    thread_span = rows[-1]["Timestamp"] - rows[0]["Timestamp"]
    sample_span = samples[-1][0] - samples[0][0]
    if abs(thread_span - sample_span) > MAX_SPAN_DISAGREEMENT_S:
        return None
    thread_middle = (rows[-1]["Timestamp"] + rows[0]["Timestamp"]) / 2
    sample_middle = (samples[-1][0] + samples[0][0]) / 2
    return sample_middle - thread_middle


def utilisation_against_load(mainthread_path, series_dir):
    """(hours since the arm opened, utilisation, host load) for every interval with a load sample."""
    rows = readings(mainthread_path)
    samples = load_samples(series_dir)
    offset = clock_offset(rows, samples)
    if offset is None:
        return []

    out = []
    for index in range(1, len(rows)):
        wall = rows[index]["Timestamp"] - rows[index - 1]["Timestamp"]
        if wall <= 0:
            continue
        at = offset + (rows[index]["Timestamp"] + rows[index - 1]["Timestamp"]) / 2
        nearest = min(samples, key=lambda pair: abs(pair[0] - at))
        if abs(nearest[0] - at) <= LOAD_JOIN_TOLERANCE_S:
            utilisation = (rows[index]["TaskDuration"] - rows[index - 1]["TaskDuration"]) / wall
            out.append((at, utilisation, nearest[1]))
    return [((at - out[0][0]) / 3600, utilisation, load) for at, utilisation, load in out]


def slope_of(xs, ys, lost_degrees=2):
    """Least squares slope of ys on xs, with its standard error. None when xs does not vary."""
    n = len(xs)
    if n <= lost_degrees:
        return None, None
    mean_x, mean_y = sum(xs) / n, sum(ys) / n
    spread = sum((x - mean_x) ** 2 for x in xs)
    if spread <= 0:
        return None, None
    beta = sum((xs[i] - mean_x) * (ys[i] - mean_y) for i in range(n)) / spread
    residual = [ys[i] - mean_y - beta * (xs[i] - mean_x) for i in range(n)]
    variance = sum(r * r for r in residual) / (n - lost_degrees)
    return beta, (variance / spread) ** 0.5


def correlation(xs, ys):
    n = len(xs)
    mean_x, mean_y = sum(xs) / n, sum(ys) / n
    spread = (sum((x - mean_x) ** 2 for x in xs) * sum((y - mean_y) ** 2 for y in ys)) ** 0.5
    return sum((xs[i] - mean_x) * (ys[i] - mean_y) for i in range(n)) / spread if spread else None


def cmd_load(root, creep_per_hour=None):
    """Whether the shared host, rather than the session ageing, could account for a within-arm creep.

    ⭐ THE OBJECTION THIS ANSWERS. A single long arm on a box carrying other people's work can read a
    rising thread because the session is ageing or because the neighbours got busier, and those look
    identical in one column. The sampler has been recording `/proc/loadavg` beside every arm all
    along, so the question is answerable from the same files rather than by assurance.

    ⛔ The pooled figure demeans each arm first. Pooling raw would let differences BETWEEN arms, which
    have their own mean load and their own mean utilisation, masquerade as a sensitivity no single arm
    exhibits.
    """
    by_condition = {}
    print(f"{'arm':<28}{'n':>5}{'load range':>14}{'corr(t,load)':>14}{'dU/dLoad':>12}{'+- se':>10}")
    print("-" * 83)

    for path in sorted((root / "node-metrics").glob("*-mainthread.jsonl")):
        arm = path.name[: -len("-mainthread.jsonl")]
        if f"-round{WARMUP_ROUNDS}-" in arm:
            continue
        points = utilisation_against_load(path, root / "node-metrics" / f"{arm}-series")
        if len(points) < MIN_POINTS_FOR_SENSITIVITY:
            print(f"{arm:<28}{len(points):>5}   no usable load series")
            continue

        hours = [h for h, _, _ in points]
        utilisation = [u for _, u, _ in points]
        load = [l for _, _, l in points]
        beta, error = slope_of(load, utilisation)
        print(
            f"{arm:<28}{len(points):>5}{min(load):>7.1f}-{max(load):<6.1f}"
            f"{correlation(hours, load):>14.3f}{beta:>12.5f}{error:>10.5f}"
        )
        by_condition.setdefault("weeb3" if "weeb3" in arm else "gateway", []).append(points)

    print("\nWITHIN-ARM, every arm demeaned first so no between-arm term survives")
    for condition, arms in sorted(by_condition.items()):
        load, utilisation = [], []
        for points in arms:
            mean_load = sum(p[2] for p in points) / len(points)
            mean_utilisation = sum(p[1] for p in points) / len(points)
            load.extend(p[2] - mean_load for p in points)
            utilisation.extend(p[1] - mean_utilisation for p in points)

        beta, error = slope_of(load, utilisation, lost_degrees=len(arms) + 1)
        bound = abs(beta) + 2 * error
        print(
            f"  {condition:<8} {len(arms)} arms, n={len(load):<5} "
            f"dU/dLoad = {beta:+.5f} +- {error:.5f} cores per unit  (t = {beta / error:+.2f})"
        )
        print(f"           upper bound {bound:.5f} at two standard errors")
        if creep_per_hour:
            print(
                f"           ⭐ to fake {creep_per_hour:+.3f} cores/hr, host load would have to rise "
                f"{creep_per_hour / bound:.0f} units per hour, monotonically, even at that bound"
            )
    return 0


def cmd_shape(roots):
    """The whole distribution per condition, and how it moved between sittings.

    ⭐ Read the ratio column against the count beside it. A distribution that scales UNIFORMLY says
    the thread is doing proportionally more of one thing, and then the mean, the median and p90 all
    carry the same information. A ratio that changes only in the top percent is describing whichever
    handful of windows happened to land there.
    """
    # ⚠️ An arm that FAILED the profile is dropped, an arm nobody could CHECK is kept and named. The
    # two differ because the stakes differ: `table` withholds a headline, which nothing else can undo,
    # while dropping every unverifiable arm here would leave an older sitting with no distribution at
    # all and no way to see why.
    dropped = {}
    for root in roots:
        verdicts = off_profile(root)
        dropped[root.name] = verdicts
        failed = {arm: v for arm, v in verdicts.items() if v != "unknown"}
        unknown = sorted(arm for arm, v in verdicts.items() if v == "unknown")
        if failed:
            print(f"⛔ {root.name}: dropping arm(s) the axis guard refused: "
                  + ", ".join(f"{arm} ({v})" for arm, v in sorted(failed.items())))
        if unknown:
            print(f"⚠️  {root.name}: arm(s) {unknown} have no readable frame rate and are KEPT unchecked")

    for cond in ("gateway", "weeb3"):
        sets = []
        for root in roots:
            skip = tuple(arm for arm, v in dropped[root.name].items() if v != "unknown")
            sets.append((root.name, pooled(root, cond, skip)))
        sets = [(name, values) for name, values in sets if values]
        if not sets:
            continue
        print(f"\n{cond}   " + "   ".join(f"{name} n={len(values)}" for name, values in sets))
        header = f"  {'quantile':>10}" + "".join(f"{name[:12]:>13}" for name, _ in sets)
        print(header + f"{'ratio':>9}{'samples above':>15}")
        for q in SHAPE_QUANTILES:
            cells = [quantile(values, q) for _, values in sets]
            above = min(len(values) - int(q * len(values)) for _, values in sets)
            ratio = f"{cells[-1] / cells[0]:>8.2f}x" if len(cells) > 1 and cells[0] else f"{'':>9}"
            thin = "  <-- thin" if above < MIN_SAMPLES_FOR_QUANTILE else ""
            print(f"  {q:>10.3f}" + "".join(f"{value:>13.3f}" for value in cells)
                  + ratio + f"{above:>15}{thin}")
    print(f"\n⛔ A ratio backed by fewer than {MIN_SAMPLES_FOR_QUANTILE} samples above the cut describes"
          " a handful of windows,\n   not a distribution. On 2026-08-15 a p99 built on THREE of them"
          " read as a tail\n   bitrate could not touch, and it was nothing.")
    return 0


def main():
    if len(sys.argv) > 2 and sys.argv[1] == "shape":
        roots = [Path(arg) for arg in sys.argv[2:]]
        missing = [str(root) for root in roots if not (root / "byte-source-arms.log").is_file()]
        if missing:
            print(f"not a sitting directory: {', '.join(missing)}")
            return 1
        return cmd_shape(roots)
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
    elif command == "load":
        return cmd_load(root, float(sys.argv[3]) if len(sys.argv) > 3 else None)
    else:
        print(__doc__)
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
