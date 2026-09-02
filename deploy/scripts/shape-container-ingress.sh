#!/usr/bin/env bash
#
# Cap this container's DOWNLOAD with a real shaped link, and refuse the run unless it can prove the
# rate it installed.
#
# ## Why a real shaper exists at all
#
# Every "slow connection" this project has measured was Chrome's `Network.emulateNetworkConditions`
# applied over CDP, which is one aggregate budget the browser schedules across every transport
# itself. An in-tab Swarm node holds about two hundred WebSocket connections, and how Chromium
# divides an emulated budget across two hundred sockets is not a fact about a 2.8 Mbps link. The
# probe of 2026-09-02 found the in-tab node behaving badly under that emulation, and the owner ruled
# the emulation a prime suspect rather than the node. This is the arm that repeats the probe with the
# emulation removed and a shaped link in its place.
#
# ## ⛔ It runs INSIDE the container, and only ever a container of its own
#
# `bench-on-host.sh` runs with `--network host`, so the container shares one network namespace with
# all four bee nodes, the uploader, the gateway and every co-tenant on the machine. A policer
# installed there throttles all of them. `--shape-kbps` therefore implies `--own-network`, and the
# first thing below is a positive test of that: if the deployment's own client answers on THIS
# container's loopback, the namespace is shared and nothing is installed.
#
# ## ⛔ A shaper that cannot prove its own rate must not run a measurement
#
# `tc` reports what it configured, never what the link then did. So the rate is measured, against a
# real download from the host's own client, and a reading outside the band refuses the whole run
# before the browser opens. Every earlier version of "the link was slow" in this repository was an
# instrument nobody had read back.
#
# ## What it shapes, and what it leaves alone
#
# Download only, which is the same shape `squeezeDownload` has: a viewer sends nothing worth capping,
# and capping upload would add a second way for the run to differ from what it says it did. Ingress
# policing is the only direction a qdisc can do without a mirror device, which is why it is a policer
# with `conform-exceed drop` rather than a queue.
#
# Usage, from inside the container, with the cap and the client already in the environment:
#   SHAPE_KBPS=2800 BROWSER_CLIENT_URL=http://host.docker.internal:10004 \
#     deploy/scripts/shape-container-ingress.sh
#
# On success it writes `export PROBE_EXTERNAL_CAP_MEASURED_BPS=<bytes per second>` to
# `$SHAPE_ENV_FILE`, which the caller sources so the driver can label its rows with a proved rate
# rather than with the number that was asked for.
set -euo pipefail

# tc spells kilobits `kbit`, and its `kbps` means kiloBYTES, which is the trap in every recipe for
# this. One kbit/s is 1000 bits/s, so a kbps cap is this many bytes per second.
BYTES_PER_KBIT_SECOND=125

# The token bucket's depth, as a fraction of one second's worth of bytes. A policer with too small a
# burst drops the head of every TCP window and delivers far under its rate; too large a one lets the
# first moments run free. 200ms is the usual middle, and over a transfer of several seconds it moves
# the average by about a percent.
BURST_DIVISOR=5
MIN_BURST_BYTES=10000

# Packets larger than the policer's mtu count as exceeding it whatever the rate says, and GRO hands
# a container's interface aggregated segments far larger than an ethernet frame. Left at the default
# the policer drops nearly everything, which the rate gate below would catch as a refusal rather
# than as a measurement, but it would catch it after the operator had waited for a timeout.
POLICE_MTU="64kb"

# The band a measured rate has to land in, as percentages of the cap. Asymmetric on purpose: an
# ingress policer drops rather than queues, and TCP answers a drop by backing off, so a shaped link
# genuinely delivers somewhat under its configured rate. Coming in OVER the cap has no benign
# explanation at all, so that side is tighter.
TOLERANCE_UNDER_PCT="${SHAPE_TOLERANCE_UNDER_PCT:-25}"
TOLERANCE_OVER_PCT="${SHAPE_TOLERANCE_OVER_PCT:-15}"

# Big enough that the burst and TCP slow start are a small share of the average. At a 2800 kbit cap
# 2 MB takes about six seconds.
PROBE_MIN_BYTES="${SHAPE_PROBE_MIN_BYTES:-2000000}"

# Generous. What this guards against is a policer so wrong that the download never ends, and the
# refusal for that has to arrive rather than the run hanging.
PROBE_TIMEOUT_S="${SHAPE_PROBE_TIMEOUT_S:-180}"

# How far the asset crawl goes, and how much it will read on the way. The wasm this looks for is
# referenced from a chunk that is itself dynamically imported, so it sits two hops from the page.
# Bounded so a malformed build cannot turn discovery into a crawl of the whole site, and because the
# widened reference pattern below deliberately admits some strings that are not assets at all: those
# cost a HEAD each and are then skipped.
CRAWL_PASSES=3
CRAWL_TEXT_BUDGET=12
CRAWL_HEAD_BUDGET=300

SHAPE_ENV_FILE="${SHAPE_ENV_FILE:-/tmp/swarm-shape-cap.env}"

REACHABILITY_TIMEOUT_S=8
NAMESPACE_PROBE_TIMEOUT_S=3

die() {
  echo "shape-container-ingress: $1" >&2
  exit 1
}

# `%d` rather than a shell arithmetic expansion, because curl writes `%{speed_download}` as a float
# and bash refuses a decimal point outright.
as_integer() {
  awk '{ printf "%d", $1 + 0 }'
}

require_positive_integer() {
  case "$2" in
    '' | *[!0-9]*) die "$1 must be a positive whole number and is '$2'" ;;
    0) die "$1 must be a positive whole number and is '$2'" ;;
  esac
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "$2"
}

SHAPE_KBPS="${SHAPE_KBPS:-}"
require_positive_integer SHAPE_KBPS "${SHAPE_KBPS}"
require_positive_integer SHAPE_TOLERANCE_UNDER_PCT "${TOLERANCE_UNDER_PCT}"
require_positive_integer SHAPE_TOLERANCE_OVER_PCT "${TOLERANCE_OVER_PCT}"

CLIENT_URL="${BROWSER_CLIENT_URL:-}"
[ -n "${CLIENT_URL}" ] || die \
  "BROWSER_CLIENT_URL is required. It is both what proves this container has a network namespace of
  its own and where the download that proves the rate comes from. browser-on-host.sh sets it."

CLIENT_ORIGIN="$(printf '%s' "${CLIENT_URL}" | sed -E 's#^(https?://[^/]+).*$#\1#')"
CLIENT_AUTHORITY="${CLIENT_ORIGIN#*://}"
CLIENT_PORT="${CLIENT_AUTHORITY##*:}"
[ "${CLIENT_PORT}" != "${CLIENT_AUTHORITY}" ] || die \
  "BROWSER_CLIENT_URL '${CLIENT_URL}' names no port, so the loopback check below could not tell
  whether this container shares the host's network namespace."
require_positive_integer "the port in BROWSER_CLIENT_URL" "${CLIENT_PORT}"

require_command tc \
  "tc is not installed in this image, so no shaper can be installed and every figure a shaped run
  produced would be a figure about an unshaped link. Add iproute2 to the Dockerfile."
require_command ip \
  "ip is not installed in this image, so the interface to shape cannot be resolved. Add iproute2 to
  the Dockerfile."
require_command curl "curl is not installed in this image, so no rate can be proved."

CAP_BYTES_PER_SECOND=$((SHAPE_KBPS * BYTES_PER_KBIT_SECOND))
BURST_BYTES=$((CAP_BYTES_PER_SECOND / BURST_DIVISOR))
[ "${BURST_BYTES}" -ge "${MIN_BURST_BYTES}" ] || BURST_BYTES="${MIN_BURST_BYTES}"
FLOOR_BYTES_PER_SECOND=$((CAP_BYTES_PER_SECOND * (100 - TOLERANCE_UNDER_PCT) / 100))
CEILING_BYTES_PER_SECOND=$((CAP_BYTES_PER_SECOND * (100 + TOLERANCE_OVER_PCT) / 100))

# ⛔⛔⛔ The one check that stands between a shaped arm and throttling the whole machine. In a
# namespace of its own this container has nothing on its loopback, so the deployment's client
# answering there means `--network host` is still in force and the policer would be installed on the
# interface all four bee nodes, the uploader and every co-tenant are using.
require_own_namespace() {
  if curl -fsS -o /dev/null -m "${NAMESPACE_PROBE_TIMEOUT_S}" "http://127.0.0.1:${CLIENT_PORT}/" 2>/dev/null; then
    die "the deployment's client answers on 127.0.0.1:${CLIENT_PORT} from inside this container, so
  this container is SHARING THE HOST'S NETWORK NAMESPACE. A shaper installed here would throttle
  every bee node, the uploader, the gateway and every co-tenant on the machine. Nothing was
  installed. Pass --own-network (--shape-kbps implies it) and run again."
  fi
}

# Before the qdisc, so a route that was never there is reported as itself rather than as a shaper
# that under-delivered.
require_client_reachable() {
  curl -fsS -o /dev/null -m "${REACHABILITY_TIMEOUT_S}" "${CLIENT_ORIGIN}/" 2>/dev/null || die \
    "the client at ${CLIENT_ORIGIN} could not be reached from inside this container, unshaped.
  Either the --add-host=host.docker.internal:host-gateway mapping is not resolving on this docker
  version, or the client's published port is bound to the host's loopback only and so is not
  reachable across the docker bridge. Nothing was installed."
}

RESOLVED_IFACE=""
resolve_iface() {
  if [ -n "${SHAPE_IFACE:-}" ]; then
    RESOLVED_IFACE="${SHAPE_IFACE}"
  else
    RESOLVED_IFACE="$(ip -4 route show default | awk '{ for (i = 1; i < NF; i++) if ($i == "dev") { print $(i + 1); exit } }')"
  fi
  [ -n "${RESOLVED_IFACE}" ] || die \
    "no default route, so there is no interface to shape. Set SHAPE_IFACE if this container reaches
  the host some other way."
  ip link show "${RESOLVED_IFACE}" >/dev/null 2>&1 || die \
    "there is no interface called '${RESOLVED_IFACE}' in this container."
}

# Every asset a text body names, resolved against the directory that body came from.
#
# ⛔ Two forms, because Vite writes both, and knowing one is knowing neither. The page names its
# entry chunk with the base prefix (`/assets/index-HASH.js`) and so does the wasm URL, while a chunk
# names the siblings it dynamically imports RELATIVELY (`./weeb_3-HASH.js`), because they sit in the
# same directory it does. A crawl that read only the prefixed form would stop one hop short of the
# 4.5 MB wasm, which is the only thing on this client big enough to measure a rate over.
#
# ⛔ `|| true` on each grep. A body that mentions no asset is ordinary, grep says so with exit 1, and
# under `pipefail` that would abort the crawl at the first stylesheet.
asset_refs_in() {
  local dir="$1" body="$2"
  {
    printf '%s' "${body}" | { grep -o 'assets/[A-Za-z0-9._@-]\{1,\}' || true; } | sed 's#^#/#'
    printf '%s' "${body}" | { grep -oE '[A-Za-z0-9._@-]+\.(js|mjs|css|wasm)' || true; } | sed "s#^#${dir}/#"
  } | sort -u
}

fetch_text() {
  curl -fsS -m "${REACHABILITY_TIMEOUT_S}" "${CLIENT_ORIGIN}$1" 2>/dev/null || true
}

# Never fails, so a reference the crawl guessed wrong costs one 404 rather than the whole discovery.
content_length_of() {
  curl -fsSI -m "${REACHABILITY_TIMEOUT_S}" "${CLIENT_ORIGIN}$1" 2>/dev/null |
    tr -d '\r' |
    awk 'tolower($1) == "content-length:" { print $2; exit }' || true
}

# Breadth first from the page, reading only what can name another asset. The largest thing found is
# what the rate is measured over, which on this client is weeb-3's 4.5 MB wasm.
PROBE_PATH=""
PROBE_BYTES=0
LARGEST_SEEN=""
discover_probe_asset() {
  local seen_text=" " known="" frontier="/" pass=0 text_reads=0 heads=0
  local body new path length

  while [ "${pass}" -lt "${CRAWL_PASSES}" ] && [ -n "${frontier}" ]; do
    new=""
    # Splitting on whitespace on purpose, and safely: `asset_refs_in` admits no character a shell
    # would split or glob on beyond the spaces these lists are joined with.
    for path in ${frontier}; do
      case "${path}" in
        *.js | *.mjs | *.css | /) ;;
        *) continue ;;
      esac
      case "${seen_text}" in
        *" ${path} "*) continue ;;
      esac
      [ "${text_reads}" -lt "${CRAWL_TEXT_BUDGET}" ] || break
      seen_text="${seen_text}${path} "
      text_reads=$((text_reads + 1))
      body="$(fetch_text "${path}")"
      new="${new} $(asset_refs_in "${path%/*}" "${body}" | tr '\n' ' ')"
    done

    known="${known}${new} "
    frontier="${new}"
    pass=$((pass + 1))
  done

  for path in $(printf '%s' "${known}" | tr ' ' '\n' | sort -u); do
    [ "${heads}" -lt "${CRAWL_HEAD_BUDGET}" ] || break
    heads=$((heads + 1))
    length="$(content_length_of "${path}")"
    case "${length}" in
      '' | *[!0-9]*) continue ;;
    esac
    if [ "${length}" -gt "${PROBE_BYTES}" ]; then
      PROBE_BYTES="${length}"
      PROBE_PATH="${path}"
      LARGEST_SEEN="${PROBE_PATH} at ${PROBE_BYTES} bytes"
    fi
  done
}

# Refuses rather than measuring over something too small to average out the burst and slow start.
require_probe_asset() {
  if [ -n "${SHAPE_PROBE_URL:-}" ]; then
    PROBE_URL="${SHAPE_PROBE_URL}"
    echo "shape-container-ingress: measuring the rate over ${PROBE_URL}, as SHAPE_PROBE_URL asked"
    return
  fi

  discover_probe_asset
  [ "${PROBE_BYTES}" -ge "${PROBE_MIN_BYTES}" ] || die \
    "no asset of at least ${PROBE_MIN_BYTES} bytes was found under ${CLIENT_ORIGIN}/assets/, and the
  largest was ${LARGEST_SEEN:-nothing at all}. A rate measured over a smaller download is mostly the
  policer's burst and TCP slow start. Point SHAPE_PROBE_URL at something larger on this host and run
  again."
  PROBE_URL="${CLIENT_ORIGIN}${PROBE_PATH}"
  echo "shape-container-ingress: measuring the rate over ${PROBE_PATH}, ${PROBE_BYTES} bytes"
}

install_policer() {
  # An earlier qdisc on this interface would silently keep its own rate, so it goes first. Absent is
  # the ordinary case and is not an error.
  tc qdisc del dev "${RESOLVED_IFACE}" ingress 2>/dev/null || true

  tc qdisc add dev "${RESOLVED_IFACE}" handle ffff: ingress || die \
    "the ingress qdisc could not be installed on ${RESOLVED_IFACE}. That is CAP_NET_ADMIN missing:
  --shape-kbps passes --cap-add=NET_ADMIN, and a capability added to a container is not necessarily
  effective for a non-root user, which is what this container runs as. Nothing is shaped, so nothing
  below would have been a reading of a shaped link."

  # `protocol all` and a mask of zero, so every packet arriving on this interface is policed rather
  # than one address family of them. A default docker bridge is IPv4 only, so there is nothing else
  # here to reach, and a filter that quietly covered one family would leave the node's peer traffic
  # unshaped while the report claimed otherwise.
  tc filter add dev "${RESOLVED_IFACE}" parent ffff: protocol all prio 1 u32 \
    match u32 0 0 \
    police rate "${SHAPE_KBPS}kbit" burst "${BURST_BYTES}" mtu "${POLICE_MTU}" conform-exceed drop || die \
    "the policer could not be attached to the ingress qdisc on ${RESOLVED_IFACE}. Nothing is shaped."

  tc -s filter show dev "${RESOLVED_IFACE}" parent ffff: | grep -q 'police' || die \
    "tc accepted the filter and then shows no police action on ${RESOLVED_IFACE}, so what is
  installed is not what was asked for."
}

MEASURED_BYTES_PER_SECOND=0
measure_rate() {
  local speed
  speed="$(curl -sS -o /dev/null -m "${PROBE_TIMEOUT_S}" -w '%{speed_download}' "${PROBE_URL}")" || die \
    "the download that proves the rate did not complete within ${PROBE_TIMEOUT_S}s under the
  ${SHAPE_KBPS} kbit/s cap. A policer this far off its configured rate cannot carry a measurement."
  MEASURED_BYTES_PER_SECOND="$(printf '%s' "${speed}" | as_integer)"
}

require_rate_in_band() {
  if [ "${MEASURED_BYTES_PER_SECOND}" -lt "${FLOOR_BYTES_PER_SECOND}" ]; then
    die "the shaped link delivered ${MEASURED_BYTES_PER_SECOND} bytes/s against the
  ${CAP_BYTES_PER_SECOND} bytes/s the ${SHAPE_KBPS} kbit/s cap allows, which is more than
  ${TOLERANCE_UNDER_PCT}% under it. The policer is dropping more than it is shaping, so a run here
  would measure the shaper. Nothing was measured."
  fi
  if [ "${MEASURED_BYTES_PER_SECOND}" -gt "${CEILING_BYTES_PER_SECOND}" ]; then
    die "the shaped link delivered ${MEASURED_BYTES_PER_SECOND} bytes/s against the
  ${CAP_BYTES_PER_SECOND} bytes/s the ${SHAPE_KBPS} kbit/s cap allows, which is more than
  ${TOLERANCE_OVER_PCT}% over it. The cap is not reaching this traffic, so nothing below would be a
  reading of a capped link. Nothing was measured."
  fi
}

require_own_namespace
require_client_reachable
resolve_iface
echo "shape-container-ingress: shaping ${RESOLVED_IFACE} inbound at ${SHAPE_KBPS} kbit/s" \
  "(${CAP_BYTES_PER_SECOND} bytes/s, burst ${BURST_BYTES} bytes)"
require_probe_asset
install_policer
measure_rate
require_rate_in_band

printf 'export PROBE_EXTERNAL_CAP_MEASURED_BPS=%s\n' "${MEASURED_BYTES_PER_SECOND}" > "${SHAPE_ENV_FILE}"

echo "shape-container-ingress: proved ${MEASURED_BYTES_PER_SECOND} bytes/s against the" \
  "${CAP_BYTES_PER_SECOND} bytes/s the cap allows, inside the" \
  "${FLOOR_BYTES_PER_SECOND}-${CEILING_BYTES_PER_SECOND} band"
echo "shape-container-ingress: wrote ${SHAPE_ENV_FILE}"
