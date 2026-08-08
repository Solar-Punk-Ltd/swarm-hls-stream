#!/bin/bash
# Does an unfunded gateway's debt accumulate under sustained retrieval, and do its peers pin against
# a common ceiling? That is the mechanism Phase 0.6 closed on, and this answers it without a broadcast.
#
# ## Why this costs almost nothing
#
# Retrieval is the only half of the pipeline under test, and the segments it retrieves are already on
# Swarm: 1884 references taken from the request log of the 2026-08-08 unfunded arm. So there is no
# encoder, no publisher, no upload and **no postage**, and the arm that matters has no chequebook to
# spend from. Only the funded control arms cost anything, at roughly 0.00085 BZZ per MB, against a
# gateway holding 6.8. The uploader chequebook, which is the binding one at 2.32 BZZ, is untouched.
#
# ## What it cannot say
#
# These are archived segments, not the live edge, so the transfer times here are **not** viewer
# latency and must not be quoted as it. What they are comparable to is each other, arm against arm,
# on the same references in the same order.
#
# The gateway is restored to the arm it was found in by an EXIT trap on every path.
set -u

OUT_DIR="${OUT_DIR:-/home/solarpunk/retrieval-probe}"
STACK_DIR="${STACK_DIR:-/home/solarpunk/swarm-hls-stream-latbench}"
COMPOSE_DIR="${STACK_DIR}/deploy"
ENV_FILE="${STACK_DIR}/.env"
COMPOSE_PROJECT="${COMPOSE_PROJECT:-latbench}"
GATEWAY_BEE_PORT="${GATEWAY_BEE_PORT:-10077}"
REFS="${REFS:-/home/solarpunk/phase06/refs.txt}"
ACCT="${ACCT:-/home/solarpunk/phase06/acct2.sh}"
# The node's own view of why a retrieval was slow, which nothing measured at the client can supply.
# `bee_accounting_accounting_blocks_count` is bee's own words for the mechanism under test: "temporarily
# skipping a peer to avoid crossing their disconnect thresholds". With the attempt histogram beside it,
# a one-second stall can finally be attributed to a peer refusing rather than to a slow network.
METRICS="${METRICS:-/home/solarpunk/phase06/metrics.sh}"

SEGMENTS="${SEGMENTS:-400}"
ROUNDS="${ROUNDS:-2}"

# The arms of one round, as `label:swap:idleSecondsBefore[:cacheCapacity[:viewers[:paceMs[:spread[:jitterMs]]]]]`, in order.
#
# ⭐ The cache field exists because every arm this project has ever run set `--cache-capacity=0`, so
# nothing cached and every chunk was re-fetched. It was excluded on purpose while the funding question
# was open, two variables at once answering neither, and it is now the untested lever most likely to
# matter when many viewers sit behind one gateway. Omit the field to leave the node's cache setting
# alone. An unfunded pair costs nothing:
#   ARM_PLAN='U0:false:0:0 UC:false:0:1000000'
#
# The idle field exists because of what the first sitting could not explain. Three unfunded arms
# differed by 15% at the median and by **2.3x** in the share of segments missing the segment budget, so
# whatever varies run to run lives in the tail. The leading hypothesis is a refill rate: an unfunded
# node saturates its allowance in about forty seconds and then runs at the rate that allowance refills,
# which would make **time spent idle beforehand** the term that moves it.
#
# ⭐ A plan of unfunded arms only costs **nothing at all**, because a node with no chequebook cannot
# spend, and it needs no recreate between arms either, which removes the peer-reconnect artifact along
# with the cost. Interleave long and short idles rather than ordering them, so drift across the sitting
# separates from the effect:
#   ARM_PLAN='U:false:60 U:false:600 U:false:60 U:false:600'
ARM_PLAN="${ARM_PLAN:-L:true:0 U:false:0}"

# The per-segment budget a retrieval has to land inside. Default is 267ms, which is what an eight-frame
# GOP at 30fps gives a 0.25s profile, the one that ships.
#
# ⛔ This is the headline the first sitting nearly missed. Across six arms the median penalty was 2.9x
# and the share of segments over budget was **45x**, 0.3% against 15.0%. A buffer drains on late
# segments, not on typical ones, so a median is the wrong statistic for the failure being predicted.
BUDGET_MS="${BUDGET_MS:-267}"

# How long to watch the node do nothing, to learn what it costs to do nothing, before an arm starts.
CPU_IDLE_WINDOW_S="${CPU_IDLE_WINDOW_S:-15}"

# How many times one arm walks the reference list, each pass timed on its own.
#
# ⛔ This exists because a cache arm without it measures nothing. One pass fetches every reference
# exactly once, so no cache can ever hit, and a cache-on arm would come out identical to a cache-off
# one for a reason that has nothing to do with caching. Two passes ask the question a shared gateway
# actually poses: does the second viewer benefit from what the first one fetched.
PASSES="${PASSES:-1}"

# How many viewers walk the list at once, against one gateway.
#
# ⭐ This is the cheap half of the concurrency question. LAT-11 measured 1 against 8 viewers on a live
# broadcast and found the gateway serves the extra seven almost for free in retrieval (1.09x chunks)
# and expensively in request handling (1.84x CPU), with the ceiling inside bee rather than in the
# network or the wallet. Nothing between 2 and 8, or above 8, has ever been measured, and here it needs
# no broadcast and no postage at all.
#
# ⛔ Sweep this by ALTERNATING against a reference concurrency, never as a ladder. Relabelling eight
# unchanged past runs as if the viewer count had varied moved the metric by up to 1.95x with nothing
# happening, so a ladder cannot resolve anything under ~2x:
#   ARM_PLAN='U1:false:0:0:1 U8:false:0:0:8 U1:false:0:0:1 U8:false:0:0:8'
VIEWERS="${VIEWERS:-1}"

# The interval between the STARTS of one viewer's consecutive fetches, in milliseconds. Set it to the
# segment duration to make a walk behave like a player rather than a load generator.
#
# ⛔ Every arm this project ran before 2026-08-08 fetched flat out, which is not what a viewer does. A
# player asks for one segment per segment duration because that is the rate the encoder produces them
# at, so a flat-out walk overstates the load one viewer places on a gateway and understates how many
# viewers a gateway can hold. Every per-MB and per-second figure the probe has ever reported carries
# that error.
#
# ⭐ Start-to-start, not a sleep between fetches. The next segment appears one duration after the last
# one did no matter how long the fetch took, so a fetch that overruns eats its own slack and the next
# one starts immediately. `nextAt` therefore advances by exactly PACE_MS whatever happens, and
# `now - nextAt` at the start of a fetch is the viewer's accumulated lag behind real time. ⭐⭐ That
# lag IS buffer depletion in milliseconds, and it is the quantity that decides whether a viewer
# stalls. A late segment share cannot see it, because a run of late segments and one late segment
# repeated far apart give the same share and only the first empties a buffer.
#
# ⚠️ Every viewer in a paced arm fires on the same schedule, so N viewers arrive as a burst of N every
# interval rather than spread across it. For live HLS that is the honest shape, because a segment
# becomes available to everyone at the same instant and every player asks for it then. A VOD or DVR
# audience is scattered instead, and this will read harsher than that case.
#
# 0 keeps the flat-out behaviour, so every earlier arm stays reproducible.
#
# ⛔ Set this PER ARM and interleave, never one sitting paced against another sitting flat out. That is
# the ladder mistake the viewer sweep already paid for: relabelling eight unchanged runs moved the
# metric by up to 1.95x with nothing happening, so a difference measured across sittings cannot be
# told from drift. The arm field is the 6th:
#   ARM_PLAN='F:false:0:0:32:0 P:false:0:0:32:267 F:false:0:0:32:0 P:false:0:0:32:267'
PACE_MS="${PACE_MS:-0}"

# How many distinct playback positions the viewers are spread across. 1 is every viewer watching the
# same instant, which is what every arm before this measured.
#
# ⛔ This decides whether "pool viewers behind gateways" is true for a real audience. Synchronised
# viewers all ask for the same chunk at the same moment, so bee merges them into ONE network retrieval,
# and that merging is what made sixteen viewers cost the network what one costs. A real audience is
# offset by join time, poll interval and buffer depth, so its viewers ask for DIFFERENT chunks at any
# instant and there is nothing to merge.
#
# ⭐ The prediction this exists to test: with the cache off, spreading N viewers across S positions
# should cost about S times the network retrievals, because the cohorts arrive too far apart to be
# merged in flight. With the cache on it should cost one, because the first cohort leaves the chunk
# behind for the rest. **That would make the cache the mechanism a scattered audience runs on, where a
# synchronised one runs on pooling.**
#
# Viewer v starts `((v-1) mod spread) * pace` milliseconds late, so it is one segment behind the cohort
# before it. Requires a pace: without one there is no playback position to be spread across.
SPREAD="${SPREAD:-1}"

# A fresh uniform random offset in front of EVERY fetch, in milliseconds, re-drawn each time.
#
# ⭐ This is what the client actually ships, and `spread` is not. `spread` gives each viewer one fixed
# offset held for the whole session, which models an audience that joined at different moments. This
# models `RequestJitter`: a bounded random delay drawn again for each request. The shipped bound is
# **60ms**, against the 4.3 seconds of spread the cohort finding was measured at, so the two are 70x
# apart and the shipped default has never been tested against a herd.
#
# Added to the deadline rather than to the schedule, so it perturbs each request without the schedule
# drifting, and lag is measured against the jittered deadline because the offset is deliberate.
JITTER_MS="${JITTER_MS:-0}"

mkdir -p "${OUT_DIR}"
LOG="${OUT_DIR}/probe.log"
STATE="${OUT_DIR}/probe-state.tsv"
SERIES="${OUT_DIR}/probe-series.tsv"
METRICS_TSV="${OUT_DIR}/probe-metrics.tsv"

say() { printf '%s %s\n' "$(date -u +%H:%M:%S)" "$*" | tee -a "${LOG}"; }

BASELINE_SWAP="$(grep '^BEE_GATEWAY_SWAP_ENABLE=' "${ENV_FILE}" | cut -d= -f2)"
CURRENT_ARM_SWAP="${BASELINE_SWAP}"
ARM_CHANGED=0

CACHE_KEY=BEE_GATEWAY_CACHE_CAPACITY
# Absent from the env file is a distinct state from present-and-zero, and restoring the wrong one
# leaves the stack subtly different from how it was found.
if grep -q "^${CACHE_KEY}=" "${ENV_FILE}"; then
  CACHE_WAS_PRESENT=1
  BASELINE_CACHE="$(grep "^${CACHE_KEY}=" "${ENV_FILE}" | cut -d= -f2)"
else
  CACHE_WAS_PRESENT=0
  BASELINE_CACHE=0 # the compose default
fi
CURRENT_ARM_CACHE="${BASELINE_CACHE}"

set_env_value() {
  local key="$1" value="$2"
  if grep -q "^${key}=" "${ENV_FILE}"; then
    sed -i "s/^${key}=.*/${key}=${value}/" "${ENV_FILE}"
  else
    printf '%s=%s\n' "${key}" "${value}" >>"${ENV_FILE}"
  fi
}

CONTAINER="${COMPOSE_PROJECT}-bee-gateway-1"

# CPU seconds the gateway process has burned since it started, read from /proc rather than sampled, so
# it is an exact total and not a guess between two snapshots.
#
# ⭐ This is the number that sizes a fleet. An unfunded node spends ~37 extra peer-selection iterations
# per chunk and every one of them is local, so what limits running many of these is host CPU and node
# density rather than network capacity. Nothing had measured it.
gateway_cpu_seconds() {
  local pid ticks
  pid="$(docker inspect --format '{{.State.Pid}}' "${CONTAINER}" 2>/dev/null)"
  if [ -z "${pid}" ] || [ ! -r "/proc/${pid}/stat" ]; then
    printf '0'
    return
  fi
  # The comm field is parenthesised and may contain spaces, so count fields after the last ')'.
  ticks="$(sed 's/.*) //' "/proc/${pid}/stat" | awk '{print $12+$13}')"
  awk -v t="${ticks:-0}" -v h="$(getconf CLK_TCK)" 'BEGIN{printf "%.2f", (h>0)?t/h:0}'
}

# The host's own run queue, which the gateway's CPU counter cannot see. Two different things need it.
#
# ⛔ A probe client is a process too. Past ~one runnable task per core the box starts descheduling the
# curl loops as readily as the node, and an arm that read slow because its own clients were starved is
# not a measurement of the gateway at all. Recording it per arm is what makes that visible afterwards
# instead of inferring a knee that was really the harness.
#
# ⛔ It is also the only thing keeping a high-concurrency sweep off the machine's other tenants. This
# host carries forty other bee nodes and eight unrelated stacks, and they are not ours to slow down.
host_load() { awk '{print $1}' /proc/loadavg; }

# The instantaneous runnable count, which is the fourth field's numerator. The one-minute average above
# is smooth and lags by about a minute, which a sitting of 45-second arms cannot afford.
#
# ⛔ Measured: four identical 128-viewer arms back to back reported peaks of 19.56, 25.12, 28.79 and
# 44.50. The load was not climbing, the average was still converging toward it, so the early arms
# under-read by more than 2x and the ceiling tripped two arms after the box was already full.
host_runnable() { awk '{split($4, r, "/"); print r[1]}' /proc/loadavg; }

# Above this many runnable tasks the run stops rather than starting a hotter arm. Ordering an arm plan
# by ascending viewer count is what makes that a real guard: the first arm to push the box too far is
# the last one that runs.
# One runnable task per core, which is where the box stops having spare capacity and starts making
# everything queue, the neighbours included. A number rather than a fraction of one because that is the
# threshold that means something: below it the run queue drains, above it it grows.
LOAD_CEILING="${LOAD_CEILING:-$(nproc)}"
LOAD_SAMPLE_S="${LOAD_SAMPLE_S:-2}"

# ⛔ The guard reads the MEAN of an arm's runnable samples, and the choice is measured rather than
# assumed. Paced viewers fire together and then all block on the network, so the run queue is bimodal:
# one arm's samples ran 1, 3, 5, 7, 28, 42, 65, 106, 152. The median of that is 14 and the peak is 152,
# and neither describes the box. The mean is 31.9, and the one-minute load average for the same arm
# converged to 35.27, so the mean estimates the same quantity the load average does while costing none
# of its lag.
#
# ⚠️ A median guard would have let a saturated box through and a peak guard would have stopped a
# comfortable one on a single transient. The peak is still reported, because for "was my own probe
# descheduled" the worst instant is the interesting one.
mean_of() {
  awk '{n++; s += $1} END {if (n == 0) print 0; else printf "%d", s / n}'
}

# How far the box must quieten between arms, and how long to wait for it.
#
# ⭐ This is measurement hygiene before it is courtesy. Arms run back to back with no settle inherit the
# previous arm's queue, so an arm's reading depends on what ran before it and identical arms stop being
# comparable. Settling first is also what keeps a long sitting from holding a shared machine at capacity
# for its whole duration rather than only during its arms.
#
# ⛔ The target is relative to what the machine was already doing, not a fraction of its cores. This host
# runs forty other bee nodes and its own idle run queue sits near a third of nproc, so an absolute target
# would never be reached and every arm would pay the full timeout for nothing.
LOAD_SETTLE_MAX_S="${LOAD_SETTLE_MAX_S:-120}"

# Median of three rather than one sample, because the instantaneous count is noisy: two reads seconds
# apart on an idle box gave 47 and 30.
baseline_runnable() {
  local a b c
  a="$(host_runnable)"
  sleep 2
  b="$(host_runnable)"
  sleep 2
  c="$(host_runnable)"
  printf '%s\n%s\n%s\n' "${a}" "${b}" "${c}" | sort -n | sed -n 2p
}

# Waits for the box to quieten back to what the neighbours alone were doing, and says so rather than
# silently giving up when it does not.
settle_host() {
  local waited=0 now target="${LOAD_SETTLE:-$((BASELINE_RUNNABLE + 8))}"
  while [ "${waited}" -lt "${LOAD_SETTLE_MAX_S}" ]; do
    now="$(host_runnable)"
    if [ "${now}" -le "${target}" ]; then
      [ "${waited}" -gt 0 ] && say "  box settled to ${now} runnable after ${waited}s"
      return 0
    fi
    sleep 5
    waited=$((waited + 5))
  done
  say "  ⚠️ box did not settle to ${target} runnable within ${LOAD_SETTLE_MAX_S}s, now $(host_runnable)"
  return 0
}

# Samples until the flag file goes away. The flag rather than a kill, so the sampler can never outlive
# the arm and leak into the next one's reading.
#
# The parent check is the backstop for the path the flag cannot cover: a run killed mid-arm never gets
# to remove it, and a sampler looping on a flag nobody will ever clear is a process left on a shared
# host. It notices within one sample interval.
sample_host_load() {
  local out="$1" flag="$2" parent="$$"
  while [ -e "${flag}" ] && kill -0 "${parent}" 2>/dev/null; do
    printf '%s %s\n' "$(host_load)" "$(host_runnable)" >>"${out}"
    sleep "${LOAD_SAMPLE_S}"
  done
}

recreate_gateway() {
  (
    cd "${COMPOSE_DIR}" || exit 1
    BEE_GATEWAY_API_PORT="${GATEWAY_BEE_PORT}" \
      BEE_GATEWAY_P2P_PORT="$((GATEWAY_BEE_PORT + 1))" \
      docker compose -p "${COMPOSE_PROJECT}" \
      -f docker-compose.yml -f docker-compose.host.yml -f docker-compose.nat.yml \
      --env-file "${ENV_FILE}" \
      --profile bee-gateway \
      up -d --no-deps --force-recreate bee-gateway
  ) >>"${LOG}" 2>&1
}

wait_for_gateway_api() {
  local deadline=$(($(date -u +%s) + 240))
  while [ "$(date -u +%s)" -lt "${deadline}" ]; do
    if curl -s -o /dev/null --max-time 5 "http://127.0.0.1:${GATEWAY_BEE_PORT}/health"; then
      return 0
    fi
    sleep 3
  done
  say "  the gateway API did not answer within 240s of the recreate"
  return 1
}

set_arm() {
  # An arm the node is already in needs no recreate, and skipping it is not only faster: a recreate
  # drops every peer connection, which is the whole of the warm-up artifact this script now discards.
  # A plan whose arms share a swap setting is measured on one continuous node.
  #
  # FORCE_RECREATE exists to make the recreate itself the variable. A sweep of unfunded arms found
  # 1.9-3.4% of segments late where an interleaved sitting found 8.4-19.5%, and two things differed:
  # those arms idled before measuring, and they were not preceded by a funded arm. Recreating every
  # arm and varying only the idle separates them, and still costs nothing.
  local wantSwap="$1" wantCache="$2"
  if [ "${FORCE_RECREATE:-0}" = "0" ] && [ "${wantSwap}" = "${CURRENT_ARM_SWAP}" ] &&
    [ "${wantCache}" = "${CURRENT_ARM_CACHE}" ] && arm_confirmed_on_node && cache_confirmed_on_node; then
    say "  gateway is already at swap=${wantSwap} cache=${wantCache}, leaving it up"
    return 0
  fi

  CURRENT_ARM_SWAP="${wantSwap}"
  CURRENT_ARM_CACHE="${wantCache}"
  say "  setting swap=${CURRENT_ARM_SWAP} cache=${CURRENT_ARM_CACHE} and recreating the gateway"
  sed -i "s/^BEE_GATEWAY_SWAP_ENABLE=.*/BEE_GATEWAY_SWAP_ENABLE=${CURRENT_ARM_SWAP}/" "${ENV_FILE}" || return 1
  set_env_value "${CACHE_KEY}" "${CURRENT_ARM_CACHE}" || return 1
  ARM_CHANGED=1
  recreate_gateway || { say "  compose failed to recreate the gateway"; return 1; }
  wait_for_gateway_api || return 1
  return 0
}

# The cache setting read off the running container's own arguments, for the same reason the swap arm is
# read off the node: an env file says what was asked for, not what is running.
cache_confirmed_on_node() {
  local args
  args="$(docker inspect --format '{{join .Args " "}}' "${CONTAINER}" 2>/dev/null)"
  case "${args}" in
    *"--cache-capacity=${CURRENT_ARM_CACHE} "* | *"--cache-capacity=${CURRENT_ARM_CACHE}") return 0 ;;
  esac
  say "  the node is not running --cache-capacity=${CURRENT_ARM_CACHE}"
  return 1
}

# The arm read off the node rather than off the intent. A funded gateway answers /chequebook/balance
# with a balance; one started with swap disabled has no chequebook and refuses.
arm_confirmed_on_node() {
  local body
  body="$(curl -s -m 5 "http://127.0.0.1:${GATEWAY_BEE_PORT}/chequebook/balance" 2>/dev/null)"
  case "${CURRENT_ARM_SWAP}" in
    true) case "${body}" in *availableBalance*) return 0 ;; esac ;;
    false) case "${body}" in *availableBalance*) : ;; *) return 0 ;; esac ;;
  esac
  say "  the node does not have the shape this arm requires: ${body:0:80}"
  return 1
}

restore_gateway() {
  if [ "${ARM_CHANGED}" = "0" ] && [ "${CURRENT_ARM_SWAP}" = "${BASELINE_SWAP}" ] &&
    [ "${CURRENT_ARM_CACHE}" = "${BASELINE_CACHE}" ]; then
    return
  fi
  say "restoring the gateway to swap=${BASELINE_SWAP} cache=${BASELINE_CACHE}"
  sed -i "s/^BEE_GATEWAY_SWAP_ENABLE=.*/BEE_GATEWAY_SWAP_ENABLE=${BASELINE_SWAP}/" "${ENV_FILE}"
  if [ "${CACHE_WAS_PRESENT}" = "1" ]; then
    set_env_value "${CACHE_KEY}" "${BASELINE_CACHE}"
  else
    # It was never in the file, so leaving it behind at the compose default is still a change.
    sed -i "/^${CACHE_KEY}=/d" "${ENV_FILE}"
  fi
  CURRENT_ARM_SWAP="${BASELINE_SWAP}"
  CURRENT_ARM_CACHE="${BASELINE_CACHE}"
  recreate_gateway
  wait_for_gateway_api
  if arm_confirmed_on_node && cache_confirmed_on_node; then
    say "gateway restored and confirmed on the node"
  else
    say "⛔ THE GATEWAY DID NOT COME BACK IN ITS ORIGINAL SHAPE. Check it by hand."
  fi
}
trap restore_gateway EXIT

acct() { bash "${ACCT}" "${GATEWAY_BEE_PORT}" 2>/dev/null; }
metrics() { bash "${METRICS}" "${GATEWAY_BEE_PORT}" 2>/dev/null; }

# One retrieval whose timing is thrown away, so the arm is measured against a node that has its peers
# rather than one that is still finding them.
warmup_fetch() {
  local ref took
  ref="$(head -1 "${REFS}")"
  took="$(curl -s -o /dev/null -m 60 -w '%{time_total}' "http://127.0.0.1:${GATEWAY_BEE_PORT}/bytes/${ref}")"
  say "  discarded a warm-up retrieval of ${took}s before timing anything"
}

# `count median p90 late lateShare` for one file of per-retrieval milliseconds, space separated.
#
# ⛔ The share over budget is the headline and the median is not. Across six arms the median penalty
# was 2.9x where the share over budget was 45x, because a buffer drains on late segments rather than
# on typical ones.
summarise_times() {
  sort -n "$1" | awk -v b="${BUDGET_MS}" '
    {v[NR]=$1; if($1>b) late++}
    END{
      if(NR==0){print "0 0 0 0 0.0"; exit}
      printf "%d %d %d %d %.1f", NR, v[int(NR/2)+1], v[int(NR*0.9)], late+0, 100*(late+0)/NR
    }'
}

say_times() {
  local label="$1" c m p l s
  read -r c m p l s <<<"$(summarise_times "$2")"
  say "  ${label}: ${c} segments, median ${m}ms, p90 ${p}ms, ⭐ ${l} over ${BUDGET_MS}ms = ${s}%"
}

epoch_ms() { date +%s%3N; }

# Sleep until an absolute epoch-millisecond deadline, or return 1 immediately if it has already passed.
# A caller that gets 1 back is behind real time, which is the signal rather than an error.
sleep_until_ms() {
  local deadline="$1" now wait secs
  now="$(epoch_ms)"
  wait=$((deadline - now))
  [ "${wait}" -le 0 ] && return 1
  # Formatted in bash rather than through awk, because this runs once per fetch and a fork per fetch
  # would be load the probe is supposed to be measuring.
  printf -v secs '%d.%03d' $((wait / 1000)) $((wait % 1000))
  sleep "${secs}"
  return 0
}

# `count maxLagMs finalLagMs behind behindShare` for one file of per-fetch lag milliseconds.
#
# ⭐ maxLag is how deep a buffer has to be for this viewer never to stall. finalLag says whether the
# viewer was still losing ground when the walk ended: a large max that returns to zero is a viewer that
# recovered, and one that ends at its maximum is a viewer heading for a stall.
summarise_lag() {
  awk '
    {v=$1; if(v>max) max=v; if(v>0) behind++; last=v; n++}
    END{
      if(n==0){print "0 0 0 0 0.0"; exit}
      printf "%d %d %d %d %.1f", n, max+0, last+0, behind+0, 100*(behind+0)/n
    }' "$1"
}

# One viewer's walk of the reference list. Runs in a subshell when VIEWERS > 1, so it hands its byte
# total back through a file rather than a variable. Only the first viewer writes the accounting series,
# because N concurrent samplers would be load of their own.
fetch_walk() {
  local timesFile="$1" bytesFile="$2" seriesRound="$3" tag="$4" startedAt="$5" writeSeries="$6"
  local lagFile="$7" pace="$8" viewerIndex="${9:-1}" spread="${10:-1}" jitter="${11:-0}"
  local n=0 sum=0 out ms b nextAt=0 nowMs offsetMs target drawn=0
  # Seeded per viewer so the draws are reproducible and provably independent of each other.
  #
  # ⚠️ Checked rather than assumed, because the failure it guards against would be invisible: viewers
  # drawing one shared sequence would make the jitter a herd that had been moved rather than broken,
  # and every number would look fine. Bash 5.1.16 on this host already re-seeds each subshell, so the
  # naive version happens to work here. This does not depend on that.
  RANDOM=$((viewerIndex * 7919 + SEGMENTS))
  # Held back so this viewer sits a whole number of segments behind the cohort in front of it, which is
  # what an audience that joined at different moments looks like.
  if [ "${pace}" -gt 0 ] && [ "${spread}" -gt 1 ]; then
    offsetMs=$(((viewerIndex - 1) % spread * pace))
    [ "${offsetMs}" -gt 0 ] && sleep_until_ms "$(($(epoch_ms) + offsetMs))"
  fi
  while read -r ref; do
    n=$((n + 1))
    [ "${n}" -gt "${SEGMENTS}" ] && break
    if [ "${pace}" -gt 0 ]; then
      # Re-drawn every fetch, because that is what the client does: a fresh uniform offset in front of
      # each request rather than one offset held for the session. Added to the deadline rather than to
      # `nextAt`, so the schedule itself never drifts and the jitter cannot accumulate.
      drawn=0
      [ "${jitter}" -gt 0 ] && drawn=$((RANDOM % jitter))
      if [ "${nextAt}" -eq 0 ]; then
        # The first fetch defines t=0 rather than being measured against a deadline set just before it,
        # which would charge every viewer a few milliseconds of lag it did not incur.
        nextAt="$(epoch_ms)"
        printf '0\n' >>"${lagFile}"
      else
        # ⭐ Measured against the JITTERED deadline. The offset is deliberate, so charging it as lag
        # would report the fix as the very buffer drain it exists to prevent.
        target=$((nextAt + drawn))
        if sleep_until_ms "${target}"; then
          printf '0\n' >>"${lagFile}"
        else
          nowMs="$(epoch_ms)"
          printf '%s\n' "$((nowMs - target))" >>"${lagFile}"
        fi
      fi
      # Advances by the segment duration whether or not the last fetch kept up. That is what makes the
      # gap cumulative, and a viewer that never catches up is a viewer whose buffer drains to nothing.
      nextAt=$((nextAt + pace))
    fi
    out="$(curl -s -o /dev/null -m 30 -w '%{time_total} %{size_download}' "http://127.0.0.1:${GATEWAY_BEE_PORT}/bytes/${ref}")"
    ms="$(printf '%s\n' "${out}" | awk '{printf "%d", $1*1000}')"
    b="$(printf '%s\n' "${out}" | awk '{print $2}')"
    printf '%s\n' "${ms}" >>"${timesFile}"
    sum=$((sum + b))
    # A time series rather than only endpoints, so a debt that grows and then settles is visible.
    if [ "${writeSeries}" = 1 ] && [ $((n % 50)) = 0 ]; then
      printf '%s\t%s\t%s\t%s\t%s\n' "${seriesRound}" "${tag}" "${n}" \
        "$(($(date +%s) - startedAt))" "$(acct)" >>"${SERIES}"
    fi
  done <"${REFS}"
  printf '%s\n' "${sum}" >"${bytesFile}"
}

# One arm: the same references in the same order every time, so the work is identical and only the
# node's ability to pay for it differs.
run_arm() {
  local round="$1" label="$2" swap="$3" idle="${4:-0}" cache="${5:-}" viewers="${6:-}" pace="${7:-}"
  local spread="${8:-}" jitterMs="${9:-}"
  [ -n "${cache}" ] || cache="${CURRENT_ARM_CACHE}"
  [ -n "${viewers}" ] || viewers="${VIEWERS}"
  [ -n "${pace}" ] || pace="${PACE_MS}"
  [ -n "${spread}" ] || spread="${SPREAD}"
  [ -n "${jitterMs}" ] || jitterMs="${JITTER_MS}"
  say "round ${round} arm ${label}: ${SEGMENTS} segments, ${idle}s idle first, cache ${cache}, ${viewers} viewer(s), pace ${pace}ms, spread ${spread}, jitter ${jitterMs}ms"

  local was="${CURRENT_ARM_SWAP}/${CURRENT_ARM_CACHE}"
  [ "${FORCE_RECREATE:-0}" = "1" ] && was="forced"
  set_arm "${swap}" "${cache}" || return 1
  arm_confirmed_on_node || return 1
  cache_confirmed_on_node || return 1

  # After the recreate rather than before it, so the idle is time the node spent up and unfunded, which
  # is the quantity under test. Idling and then restarting would measure nothing.
  if [ "${idle}" -gt 0 ]; then
    say "  idling ${idle}s with the node up, then measuring"
    sleep "${idle}"
    say "  accounting after the idle: $(acct)"
  fi

  local before after mBefore mAfter n=0 bytes=0 started ended
  before="$(acct)"
  [ -n "${before}" ] || before="NONE"
  say "  accounting before: ${before}"

  # ⛔ Discarded, and it is not optional. Every arm of the first run opened with a segment that took
  # 8.2 to 9.9 seconds, in the funded arms as much as the unfunded ones, because the arm begins with a
  # container recreate and bee answers `/health` well before its retrieval path has peers again. It is
  # an artifact of flipping the arm, present in both, and left in the sample it moves every maximum,
  # every p99 and every elapsed figure the run reports.
  if [ "${was}" != "${CURRENT_ARM_SWAP}/${CURRENT_ARM_CACHE}" ]; then
    warmup_fetch
  fi

  # ⛔ Read AFTER the warm-up, not before it. The warm-up's own retrieval is 8-10 seconds of a node
  # rebuilding its peer set, and a proving run showed those chunks landing in `durLe1` as seventeen
  # requests over a second: an 11.6% one-second-stall rate that was entirely the discarded fetch, in
  # the counter added to measure the real one.
  mBefore="$(metrics)"
  [ -n "${mBefore}" ] || mBefore="NONE"

  # bee burns CPU on peers, syncing and its own housekeeping whether or not anything is retrieving, and
  # a freshly recreated node burns more. Measuring that rate first and subtracting it is what turns the
  # arm's CPU total into a retrieval cost. Without it two identical funded arms came out 0.57s and
  # 0.91s on startup noise alone.
  local cpuBefore cpuAfter cpuUsed cpuIdleRate idleA idleB
  idleA="$(gateway_cpu_seconds)"
  sleep "${CPU_IDLE_WINDOW_S}"
  idleB="$(gateway_cpu_seconds)"
  cpuIdleRate="$(awk -v a="${idleA}" -v b="${idleB}" -v w="${CPU_IDLE_WINDOW_S}" \
    'BEGIN{printf "%.4f", (w>0)?(b-a)/w:0}')"
  say "  gateway idles at ${cpuIdleRate} CPU-seconds per second"
  cpuBefore="$(gateway_cpu_seconds)"

  : >"${OUT_DIR}/times-${round}-${label}.txt"
  local lagFile="${OUT_DIR}/lag-${round}-${label}.txt"
  local finalsFile="${OUT_DIR}/lag-final-${round}-${label}.txt"
  : >"${lagFile}"
  : >"${finalsFile}"

  local loadFile="${OUT_DIR}/load-${round}-${label}.txt" loadFlag loadBefore loadMax runMax runMean
  loadFlag="${loadFile}.on"
  : >"${loadFile}"
  : >"${loadFlag}"
  loadBefore="$(host_load)"
  say "  host load before the arm: ${loadBefore} avg, $(host_runnable) runnable, across $(nproc) cores"
  sample_host_load "${loadFile}" "${loadFlag}" &
  local loadSampler=$!

  started="$(date +%s)"
  local pass v walkers
  for pass in $(seq 1 "${PASSES}"); do
    local passFile="${OUT_DIR}/times-${round}-${label}-p${pass}.txt"
    : >"${passFile}"
    # Concurrent viewers walk the SAME list, because that is the topology a live event has: many
    # viewers behind one gateway asking for the same segments at the same moment.
    walkers=()
    for v in $(seq 1 "${viewers}"); do
      : >"${passFile}.v${v}"
      : >"${passFile}.l${v}"
      fetch_walk "${passFile}.v${v}" "${passFile}.b${v}" "${round}" "${label}.${pass}.v${v}" \
        "${started}" "$([ "${v}" = 1 ] && echo 1 || echo 0)" "${passFile}.l${v}" "${pace}" \
        "${v}" "${spread}" "${jitterMs}" &
      walkers+=("$!")
    done
    # ⛔ The viewers by name, not a bare `wait`. A bare one also waits for the load sampler, which does
    # not exit until the arm is over, so the arm would be waiting on the thing waiting for the arm.
    wait "${walkers[@]}"
    for v in $(seq 1 "${viewers}"); do
      cat "${passFile}.v${v}" >>"${passFile}"
      cat "${passFile}.l${v}" >>"${lagFile}"
      # Each viewer's own last lag, so the final figure is one viewer's standing rather than whichever
      # viewer happened to be concatenated last.
      tail -1 "${passFile}.l${v}" 2>/dev/null >>"${finalsFile}"
      bytes=$((bytes + $(cat "${passFile}.b${v}" 2>/dev/null || echo 0)))
    done
    cat "${passFile}" >>"${OUT_DIR}/times-${round}-${label}.txt"
    # Each pass reported on its own, because the whole point of a second pass is that it should differ.
    say_times "pass ${pass}" "${passFile}"
  done
  ended="$(date +%s)"
  rm -f "${loadFlag}"
  wait "${loadSampler}" 2>/dev/null || true
  # The peak rather than the mean: a box that spent thirty seconds saturated descheduled the probe's
  # clients for thirty seconds, and an average over a long arm hides exactly that.
  loadMax="$(awk '{print $1}' "${loadFile}" 2>/dev/null | sort -g | tail -1)"
  runMax="$(awk '{print $2}' "${loadFile}" 2>/dev/null | sort -g | tail -1)"
  runMean="$(awk '{print $2}' "${loadFile}" 2>/dev/null | mean_of)"
  [ -n "${loadMax}" ] || loadMax=0
  [ -n "${runMax}" ] || runMax=0
  [ -n "${runMean}" ] || runMean=0
  cpuAfter="$(gateway_cpu_seconds)"
  cpuUsed="$(awk -v a="${cpuBefore}" -v b="${cpuAfter}" 'BEGIN{printf "%.2f", b-a}')"
  local cpuRetrieval
  cpuRetrieval="$(awk -v u="${cpuUsed}" -v r="${cpuIdleRate}" -v s="$((ended - started))" \
    'BEGIN{v=u-(r*s); printf "%.2f", (v>0)?v:0}')"

  after="$(acct)"
  [ -n "${after}" ] || after="NONE"
  mAfter="$(metrics)"
  [ -n "${mAfter}" ] || mAfter="NONE"
  say "  node metrics before: ${mBefore}"
  say "  node metrics after:  ${mAfter}"

  local median p90 count late lateShare
  read -r count median p90 late lateShare <<<"$(summarise_times "${OUT_DIR}/times-${round}-${label}.txt")"

  local cpuPerMb
  cpuPerMb="$(awk -v c="${cpuRetrieval}" -v b="${bytes}" 'BEGIN{printf "%.3f", (b>0)?c/(b/1000000):0}')"

  local lagCount maxLag lastLag behind behindShare worstFinal=0
  read -r lagCount maxLag lastLag behind behindShare <<<"$(summarise_lag "${lagFile}")"
  worstFinal="$(sort -n "${finalsFile}" 2>/dev/null | tail -1)"
  [ -n "${worstFinal}" ] || worstFinal=0

  say "  ${count} fetches by ${viewers} viewer(s), $((bytes / 1000000)) MB, $((ended - started))s, median ${median}ms, p90 ${p90}ms"
  say "  ⭐ ${late} of ${count} missed the ${BUDGET_MS}ms budget = ${lateShare}%"
  if [ "${pace}" -gt 0 ]; then
    say "  ⭐ paced at ${pace}ms: ${behind} of ${lagCount} fetches started behind = ${behindShare}%"
    say "  ⭐⭐ deepest lag ${maxLag}ms, worst viewer ended ${worstFinal}ms behind = the buffer this needs"
  fi
  say "  ⭐ gateway CPU ${cpuUsed}s total, ${cpuRetrieval}s above idle = ${cpuPerMb}s per MB retrieved"
  say "  ⭐ host load ${loadBefore} before, peaked ${loadMax} avg, runnable mean ${runMean} peak ${runMax} of $(nproc) cores"
  say "  accounting after:  ${after}"
  # The guard in the arm loop reads the peak this arm actually produced, rather than a between-arm
  # sample that a settle has already quietened.
  LAST_ARM_RUN_MEAN="${runMean}"

  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "${round}" "${label}" "${swap}" "${cache}" "${idle}" "${viewers}" "${pace}" "${spread}" "${jitterMs}" "${count}" "${bytes}" \
    "$((ended - started))" "${median}" "${p90}" "${lateShare}" "${behindShare}" "${maxLag}" \
    "${worstFinal}" "${cpuUsed}" "${cpuIdleRate}" \
    "${cpuRetrieval}" "${cpuPerMb}" "${loadBefore}" "${loadMax}" "${runMean}" "${runMax}" "${before}" "${after}" >>"${STATE}"
  printf '%s\t%s\t%s\tbefore\t%s\n%s\t%s\t%s\tafter\t%s\n' \
    "${round}" "${label}" "${swap}" "${mBefore}" "${round}" "${label}" "${swap}" "${mAfter}" >>"${METRICS_TSV}"
}

say "=== retrieval debt probe: ${ROUNDS} rounds of [${ARM_PLAN}] at ${SEGMENTS} segments ==="
say "gateway found at swap=${BASELINE_SWAP} cache=${BASELINE_CACHE}, which is what it will be left at"
[ -s "${STATE}" ] || printf 'round\tarm\tswap\tcache\tidle\tviewers\tpaceMs\tspread\tjitterMs\tfetches\tbytes\tseconds\tmedianMs\tp90Ms\tlatePct\tbehindPct\tmaxLagMs\tendLagMs\tcpuS\tcpuIdleRate\tcpuRetrievalS\tcpuSPerMb\tloadBefore\tloadMax\trunMean\trunMax\tacctBefore\tacctAfter\n' >"${STATE}"
[ -s "${SERIES}" ] || printf 'round\tarm\tat\telapsed\tpeers\tinDebt\ttotalDebt\tdeepest\tmedianDebt\tp10Debt\tpinned\n' >"${SERIES}"

BASELINE_RUNNABLE="$(baseline_runnable)"
say "ceiling ${LOAD_CEILING} runnable across $(nproc) cores, $(host_load) avg now"
say "the neighbours alone are ${BASELINE_RUNNABLE} runnable, so arms settle to ${LOAD_SETTLE:-$((BASELINE_RUNNABLE + 8))}"

for round in $(seq 1 "${ROUNDS}"); do
  for spec in ${ARM_PLAN}; do
    IFS=':' read -r label swap idle cache viewers pace spread jitterMs <<<"${spec}"
    run_arm "${round}" "${label}" "${swap}" "${idle:-0}" "${cache:-}" "${viewers:-}" "${pace:-}" "${spread:-}" "${jitterMs:-}" ||
      say "round ${round} arm ${label} did not complete"

    # ⛔ On the peak the arm actually produced, not on a sample taken after it. This machine is shared
    # with forty other bee nodes and eight unrelated stacks, and an unattended sweep that keeps climbing
    # would degrade all of them. Order an arm plan by ascending viewer count and this makes the first arm
    # to push the box too far the last one that runs.
    if [ "${LAST_ARM_RUN_MEAN:-0}" -gt "${LOAD_CEILING}" ]; then
      say "⛔ that arm averaged ${LAST_ARM_RUN_MEAN} runnable, over the ${LOAD_CEILING} ceiling: stopping"
      # The EXIT trap restores the gateway on this path as on every other, so no restore here.
      exit 3
    fi

    # Then quieten down before the next one, so an arm is never measured on top of its predecessor.
    settle_host
  done
done

say "=== done ==="
