#!/usr/bin/env bash
#
# Refuse to start a sitting the postage batch cannot finish, and print the command that fixes it.
#
# ## Why this is a gate and not a warning
#
# The rule already existed and was already automatic: `e2e/src/browser/resources.ts` reads the batch
# either side of every browser run and warns at 80% full or under 3 days TTL. ⛔ **It warns at the
# END**, after the broadcast is paid for, which is the one moment the information is worthless.
#
# On 2026-08-12 the batch crossed its written 75% stop threshold and three further sittings ran
# against it, because the only thing standing between the threshold and the spend was somebody
# remembering to look. `can_afford` in the drivers beside this is the shape that works: a precondition
# that refuses, in the same breath as the thing it protects.
#
# ## The thresholds, and where they come from
#
# `utilization` is the **fullest bucket**, not the average. A depth-24 batch has 65536 buckets of 256
# chunks, so a batch is effectively full long before its nominal chunk count. An **immutable** batch
# refuses uploads once a bucket fills, which is loud and stops the run. A **mutable** one silently
# overwrites while every health signal stays green, which is worse and is why the measurement batch
# is immutable.
#
# Usage:
#   deploy/scripts/stamp-guard.sh --batch <id> [--minutes 240] [--port 10075]
set -u

BATCH=""
MINUTES=0
PORT="${STAMP_GUARD_PORT:-10075}"
# The written stop rule: 75% of buckets, or under two days left.
MAX_UTILIZATION_PCT="${MAX_UTILIZATION_PCT:-75}"
MIN_TTL_DAYS="${MIN_TTL_DAYS:-2}"
# Measured 2026-08-12 across 2.8 broadcast hours on a depth-24 batch: 180 to 198, so 6.4 an hour.
# Decides only the sitting-length refusals, never whether the batch is already past the line.
#
# ⚠️ **Measured at depth 24 and now applied to a depth-25 batch, which has not been checked.**
# `bucketDepth` is 16 in both, so the fullest bucket should fill at the same absolute rate and only
# the denominator doubles. That is an argument, not a reading.
BUCKETS_PER_BROADCAST_HOUR="${BUCKETS_PER_BROADCAST_HOUR:-6.4}"

while [ $# -gt 0 ]; do
  case "$1" in
    --batch) BATCH="$2"; shift 2 ;;
    --minutes) MINUTES="$2"; shift 2 ;;
    --port) PORT="$2"; shift 2 ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

[ -n "${BATCH}" ] || { echo "stamp-guard: --batch is required" >&2; exit 2; }

STAMPS="$(curl -s --max-time 10 "http://127.0.0.1:${PORT}/stamps" 2>/dev/null)"
if [ -z "${STAMPS}" ]; then
  echo "stamp-guard: REFUSING, the uploader bee on ${PORT} did not answer /stamps."
  echo "  Unknown capacity is not permission to spend a broadcast against it."
  exit 1
fi

# Parsed here rather than in the callers, so every sitting reads the batch the same way and a batch
# that is not on the node is a refusal rather than an empty string compared against a number.
printf '%s' "${STAMPS}" | BATCH="${BATCH}" MINUTES="${MINUTES}" \
  MAX_UTILIZATION_PCT="${MAX_UTILIZATION_PCT}" MIN_TTL_DAYS="${MIN_TTL_DAYS}" \
  BUCKETS_PER_BROADCAST_HOUR="${BUCKETS_PER_BROADCAST_HOUR}" PORT="${PORT}" python3 -c '
import json, os, sys

batch_id = os.environ["BATCH"]
minutes = float(os.environ["MINUTES"])
max_pct = float(os.environ["MAX_UTILIZATION_PCT"])
min_ttl_days = float(os.environ["MIN_TTL_DAYS"])
per_hour = float(os.environ["BUCKETS_PER_BROADCAST_HOUR"])
port = os.environ["PORT"]

stamps = json.load(sys.stdin).get("stamps", [])
batch = next((b for b in stamps if b["batchID"] == batch_id), None)
if batch is None:
    print(f"stamp-guard: REFUSING, batch {batch_id[:8]} is not on the node.")
    listed = ", ".join(b["batchID"][:8] for b in stamps) or "nothing"
    print("  /stamps lists " + listed + ".")
    print("  Reading the wrong row is how a full batch gets quoted as healthy.")
    sys.exit(1)

buckets = 2 ** (batch["depth"] - batch["bucketDepth"])
used = batch["utilization"]
pct = 100.0 * used / buckets
ttl_days = batch["batchTTL"] / 86400.0
headroom_hours = (buckets * max_pct / 100.0 - used) / per_hour

depth = batch["depth"]
usable = batch["usable"]
immutable = batch["immutableFlag"]
print(f"stamp-guard: {batch_id[:8]} depth {depth} {used}/{buckets} buckets ({pct:.0f}%), "
      f"TTL {ttl_days:.1f}d, usable {usable}, immutable {immutable}")
projected = used + minutes / 60.0 * per_hour
projected_pct = 100.0 * projected / buckets
if minutes > 0:
    print(f"  this sitting is {minutes:.0f} min and costs about "
          f"{minutes / 60.0 * per_hour:.1f} buckets at the measured {per_hour}/broadcast hour, "
          f"ending at {projected_pct:.0f}%")
print(f"  headroom to the {max_pct:.0f}% stop line: {headroom_hours:.1f} broadcast hours")

reasons = []
if pct >= max_pct:
    reasons.append(f"utilization {pct:.0f}% is at or past the {max_pct:.0f}% stop line")
if ttl_days < min_ttl_days:
    reasons.append(f"TTL {ttl_days:.1f}d is under the {min_ttl_days:.0f}d floor")
if not batch["usable"]:
    reasons.append("the batch reports itself unusable")
if minutes > 0 and projected_pct > max_pct:
    reasons.append(
        f"this sitting ends at {projected_pct:.0f}%, past the {max_pct:.0f}% stop line, so the "
        f"mid-flight sampler would cut it short after about {headroom_hours:.1f} broadcast hours"
    )
if minutes > 0 and minutes / 60.0 * per_hour > (buckets - used):
    reasons.append(f"this sitting needs more buckets than the {buckets - used} left")

if not reasons:
    sys.exit(0)

print("")
print("stamp-guard: REFUSING TO START. " + "; ".join(reasons) + ".")
print("")
print("  Diluting adds capacity for no BZZ, by halving the remaining TTL. One depth step doubles")
print(f"  the buckets, so {used}/{buckets} becomes about {used}/{buckets * 2} and TTL")
print(f"  {ttl_days:.1f}d becomes {ttl_days / 2:.1f}d:")
print("")
print(f"    curl -s -XPATCH http://127.0.0.1:{port}/stamps/dilute/{batch_id}/{depth + 1}")
print("")
print("  Topping up buys TTL and NOT capacity, so it does not clear a utilization refusal:")
print("")
print(f"    curl -s -XPATCH http://127.0.0.1:{port}/stamps/topup/{batch_id}/AMOUNT_IN_PLUR")
sys.exit(1)
'
