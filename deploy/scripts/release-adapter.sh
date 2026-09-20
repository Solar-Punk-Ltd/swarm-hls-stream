#!/bin/bash
set -euo pipefail

refuse() {
  printf 'REFUSED: %s\n' "$1" >&2
  exit 1
}

role="${RELEASE_ADAPTER_ROLE:-uploader}"
case "$role" in
  uploader|viewer) ;;
  *) refuse "stack release adapter role is invalid" ;;
esac

phase="${1:-}"
case "$phase" in
  preflight|build|validate|verify)
    [ "$#" -eq 5 ] && [ "$2" = "--plan" ] && [ "$4" = "--output" ] || refuse "$role release adapter arguments are invalid"
    ;;
  transition)
    [ "$#" -eq 3 ] && [ "$2" = "--plan" ] || refuse "$role release adapter arguments are invalid"
    ;;
  *) refuse "$role release adapter phase is invalid" ;;
esac

plan="$3"
output="${5:-}"
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
candidate_root="$(cd "$script_dir/../.." && pwd -P)"
deploy_dir="$candidate_root/deploy"

command -v jq >/dev/null 2>&1 || refuse "jq is required for a guarded stack release"
[ -f "$plan" ] && [ ! -L "$plan" ] || refuse "$role release plan is invalid"
plan_size="$(wc -c < "$plan" | tr -d '[:space:]')"
[[ "$plan_size" =~ ^[0-9]+$ ]] && [ "$plan_size" -ge 1 ] && [ "$plan_size" -le 65536 ] || refuse "$role release plan is invalid"

if ! jq -e --arg phase "$phase" --arg role "$role" '
  type == "object" and
  (keys | sort) == (["activeArtifactPath", "arguments", "candidateRoot", "images", "phase", "schemaVersion", "slot", "temporaryProject", "treeDigest"] | sort) and
  .schemaVersion == 1 and .phase == $phase and
  (.candidateRoot | type == "string" and startswith("/")) and
  (.treeDigest | type == "string" and test("^[0-9a-f]{64}$")) and
  .temporaryProject == ("release-" + (.treeDigest[0:20])) and
  (.slot | type == "object" and (keys | sort) == ["id", "role"] and .role == $role and (.id | type == "string")) and
  (.arguments | type == "object" and
    (.target | type == "object" and (keys | sort) == ["portSlot", "profile", "services", "target"] and
      (.profile | type == "string") and (.portSlot | type == "number") and .target == "local" and
      (.services | type == "array" and length >= 1 and all(.[]; type == "string"))) and
    (if has("operation") then
      $role == "uploader" and
      (.operation | type == "object" and (keys | sort) == ["kind", "mutatingServices"] and
        (.kind == "prepare" or .kind == "update") and
        (.mutatingServices | type == "array" and length >= 1 and
          all(.[]; type == "string") and . == (sort | unique)))
    else $phase != "validate" end) and
    (if has("fixtureNetwork") then
      (.fixtureNetwork | type == "object" and
        (if $phase == "preflight" then
          (keys | sort) == ["fixtureId", "name"]
        else
          (keys | sort) == ["fixtureId", "name", "networkId"] and
          (.networkId | type == "string" and test("^[0-9a-f]{64}$"))
        end) and
        (.fixtureId | type == "string" and test("^srs-continuation-20260920-[a-z0-9]{8,16}$")) and
        .name == (.fixtureId + "-network")) and
      (if $phase != "preflight" and $role == "uploader" then
        .fixtureVolumeNames == [
          (.target.profile + "_srs-media"),
          (.target.profile + "_uploader-state")
        ]
      else (has("fixtureVolumeNames") | not) end)
    else (has("fixtureVolumeNames") | not) end) and
    ((keys | sort) == ((["target"] +
      (if has("fixtureNetwork") then ["fixtureNetwork"] else [] end) +
      (if has("fixtureVolumeNames") then ["fixtureVolumeNames"] else [] end) +
      (if has("operation") then ["operation"] else [] end)) | sort))) and
  (.images | type == "array") and
  (if ($phase == "transition" or $phase == "validate" or $phase == "verify") then
    .activeArtifactPath == null and
    (if .arguments.operation.kind == "prepare" then
      $phase != "validate" and ((.images | length) == (.arguments.operation.mutatingServices | length))
    else ((.images | length) == (.arguments.target.services | length)) end) and
    all(.images[]; type == "object" and (keys | sort) == ["imageId", "service"] and
      (.service | type == "string") and (.imageId | type == "string" and test("^sha256:[0-9a-f]{64}$")))
  else .activeArtifactPath == null and (.images | length == 0) end)
' "$plan" >/dev/null 2>&1; then
  refuse "$role release plan is invalid"
fi

plan_root="$(jq -r '.candidateRoot' "$plan")"
[ "$plan_root" = "$candidate_root" ] || refuse "$role release candidate root does not match its plan"
profile="$(jq -r '.arguments.target.profile' "$plan")"
port_slot="$(jq -r '.arguments.target.portSlot' "$plan")"
target="$(jq -r '.arguments.target.target' "$plan")"
slot_id="$(jq -r '.slot.id' "$plan")"
temporary_project="$(jq -r '.temporaryProject' "$plan")"
tree_digest="$(jq -r '.treeDigest' "$plan")"
fixture_id="$(jq -r '.arguments.fixtureNetwork.fixtureId // empty' "$plan")"
fixture_network_name="$(jq -r '.arguments.fixtureNetwork.name // empty' "$plan")"
fixture_network_id="$(jq -r '.arguments.fixtureNetwork.networkId // empty' "$plan")"
operation_kind="$(jq -r '.arguments.operation.kind // empty' "$plan")"
[[ "$profile" =~ ^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$ ]] || refuse "$role release profile is invalid"
[[ "$port_slot" =~ ^[0-9]+$ ]] && [ "$port_slot" -ge 1 ] && [ "$port_slot" -le 99 ] || refuse "$role release port slot is invalid"
[ "$target" = "local" ] || refuse "$role release target must be local"
[[ "$temporary_project" =~ ^release-[0-9a-f]{20}$ ]] || refuse "$role release temporary project is invalid"
[[ "$tree_digest" =~ ^[0-9a-f]{64}$ ]] || refuse "$role release tree digest is invalid"
if [ -n "$fixture_id" ]; then
  [[ "$fixture_id" =~ ^srs-continuation-20260920-[a-z0-9]{8,16}$ ]] || refuse "$role release fixture network is invalid"
  [ "$fixture_network_name" = "${fixture_id}-network" ] || refuse "$role release fixture network is invalid"
  [[ "$profile" =~ ^[a-z0-9][a-z0-9-]{0,30}$ ]] || refuse "$role release fixture profile is invalid"
  if [ "$phase" != "preflight" ]; then
    [[ "$fixture_network_id" =~ ^[0-9a-f]{64}$ ]] || refuse "$role release fixture network is invalid"
  fi
fi

services=()
while IFS= read -r service; do
  services+=("$service")
done < <(jq -r '.arguments.target.services[]' "$plan")

seen=" "
for service in "${services[@]}"; do
  [[ "$service" =~ ^[a-z0-9][a-z0-9_-]{0,63}$ ]] || refuse "$role release service is invalid"
  case "$seen" in
    *" $service "*) refuse "$role release services contain a duplicate" ;;
  esac
  seen="${seen}${service} "
done

has_service() {
  local wanted="$1" service
  for service in "${services[@]}"; do
    [ "$service" = "$wanted" ] && return 0
  done
  return 1
}

mutating_services=()
while IFS= read -r service; do
  mutating_services+=("$service")
done < <(jq -r '.arguments.operation.mutatingServices[]?' "$plan")
if [ -n "$operation_kind" ]; then
  for service in "${mutating_services[@]}"; do
    has_service "$service" || refuse "uploader release mutation service is outside its installed target"
  done
  if [ "$operation_kind" = "prepare" ]; then
    for service in "${mutating_services[@]}"; do
      [ "$service" != "stream-uploader" ] || refuse "uploader preparation cannot move stream-uploader"
    done
  else
    mutates_uploader=false
    for service in "${mutating_services[@]}"; do
      [ "$service" != "stream-uploader" ] || mutates_uploader=true
    done
    [ "$mutates_uploader" = true ] || refuse "uploader update must move stream-uploader"
  fi
fi

if [ "$role" = "uploader" ]; then
  [[ "$slot_id" =~ ^[A-Za-z0-9_.:-]{1,200}$ ]] || refuse "uploader release slot id is invalid"
  if ! has_service srs || ! has_service stream-uploader; then
    refuse "uploader release requires srs and stream-uploader"
  fi
  for service in "${services[@]}"; do
    case "$service" in
      srs|stream-uploader|bee-uploader|bee-gateway|bee-uploader-480p|bee-uploader-720p|bee-uploader-1080p|client) ;;
      *) refuse "uploader release service set is unsupported" ;;
    esac
  done
else
  [ "$slot_id" = "default" ] || refuse "viewer release slot id must be default"
  if [ "${#services[@]}" -eq 1 ]; then
    [ "${services[0]}" = "client" ] || refuse "viewer release service set is unsupported"
  elif [ "${#services[@]}" -eq 2 ]; then
    [ "${services[0]}" = "bee-gateway" ] && [ "${services[1]}" = "client" ] || refuse "viewer release service set is unsupported"
  else
    refuse "viewer release service set is unsupported"
  fi
fi
if [ -n "$fixture_id" ]; then
  if [ "$role" = "uploader" ]; then
    [ "${services[*]}" = "srs stream-uploader" ] || refuse "uploader fixture release service set is unsupported"
  else
    [ "${services[*]}" = "client" ] || refuse "viewer fixture release service set is unsupported"
  fi
fi

inspect_fixture_network() {
  local details actual_id expected_id="${1:-}"
  if ! details="$(docker network inspect "$fixture_network_name")"; then
    refuse "$role release fixture network is unavailable"
  fi
  [ "${#details}" -le 65536 ] || refuse "$role release fixture network is invalid"
  if ! jq -e --arg fixture "$fixture_id" '
    type == "array" and length == 1 and
    (.[0] | type == "object" and
      (.Id | type == "string" and test("^[0-9a-f]{64}$")) and
      .Internal == true and
      (.Labels | type == "object") and
      .Labels["org.solarpunk.srs-continuation.fixture"] == $fixture and
      .Labels["org.solarpunk.srs-continuation.managed"] == "true")
  ' <<< "$details" >/dev/null 2>&1; then
    refuse "$role release fixture network is invalid"
  fi
  actual_id="$(jq -r '.[0].Id' <<< "$details")"
  if [ -n "$expected_id" ] && [ "$actual_id" != "$expected_id" ]; then
    refuse "$role release fixture network identity changed"
  fi
  fixture_network_id="$actual_id"
}

inspect_fixture_volume() {
  local volume_name="$1" details
  if ! details="$(docker volume inspect "$volume_name")"; then
    refuse "$role release fixture volume is unavailable"
  fi
  [ "${#details}" -le 65536 ] || refuse "$role release fixture volume is invalid"
  if ! jq -e --arg name "$volume_name" --arg fixture "$fixture_id" '
    type == "array" and length == 1 and
    (.[0] | type == "object" and .Name == $name and
      (.Labels | type == "object") and
      .Labels["org.solarpunk.srs-continuation.fixture"] == $fixture and
      .Labels["org.solarpunk.srs-continuation.managed"] == "true")
  ' <<< "$details" >/dev/null 2>&1; then
    refuse "$role release fixture volume is invalid"
  fi
}

verify_fixture_container() {
  local service="$1" container="$2" labels ports mounts
  labels="$(docker inspect --format '{{json .Config.Labels}}' "$container")"
  if ! jq -e --arg fixture "$fixture_id" '
    type == "object" and
    .["org.solarpunk.srs-continuation.fixture"] == $fixture and
    .["org.solarpunk.srs-continuation.managed"] == "true"
  ' <<< "$labels" >/dev/null 2>&1; then
    refuse "$role release service fixture labels are invalid"
  fi
  if [ "$(docker inspect --format '{{.HostConfig.NanoCpus}}' "$container")" != 1000000000 ] ||
      [ "$(docker inspect --format '{{.HostConfig.Memory}}' "$container")" != 1073741824 ] ||
      [ "$(docker inspect --format '{{.HostConfig.PidsLimit}}' "$container")" != 256 ]; then
    refuse "$role release service fixture resource limits are invalid"
  fi
  ports="$(docker inspect --format '{{json .NetworkSettings.Ports}}' "$container")"
  [ "${#ports}" -le 65536 ] || refuse "$role release service published ports are invalid"
  if [ "$role" = "viewer" ]; then
    if ! jq -e --arg port "$CLIENT_PORT" '
      type == "object" and has("80/tcp") and
      all(to_entries[];
        if .key == "80/tcp" then
          .value == [{"HostIp":"127.0.0.1","HostPort":$port}]
        else .value == null or .value == [] end)
    ' <<< "$ports" >/dev/null 2>&1; then
      refuse "$role release service published ports are invalid"
    fi
  elif ! jq -e '. == null or (type == "object" and all(.[]; . == null or . == []))' <<< "$ports" >/dev/null 2>&1; then
    refuse "$role release service published ports are invalid"
  fi
  mounts="$(docker inspect --format '{{json .Mounts}}' "$container")"
  [ "${#mounts}" -le 65536 ] || refuse "$role release service fixture mounts are invalid"
  case "$service" in
    srs)
      jq -e --arg media "${profile}_srs-media" '
        [.[] | select(.Type == "volume") | {Name, Destination}] | sort_by(.Name) ==
        [{"Name":$media,"Destination":"/usr/local/srs/objs/nginx/html"}]
      ' <<< "$mounts" >/dev/null 2>&1 || refuse "$role release service fixture mounts are invalid"
      ;;
    stream-uploader)
      jq -e --arg media "${profile}_srs-media" --arg state "${profile}_uploader-state" '
        [.[] | select(.Type == "volume") | {Name, Destination}] | sort_by(.Name) ==
        ([
          {"Name":$media,"Destination":"/media"},
          {"Name":$state,"Destination":"/app/state"}
        ] | sort_by(.Name))
      ' <<< "$mounts" >/dev/null 2>&1 || refuse "$role release service fixture mounts are invalid"
      ;;
  esac
}

sorted_services=()
while IFS= read -r service; do
  sorted_services+=("$service")
done < <(printf '%s\n' "${services[@]}" | LC_ALL=C sort)

sorted_mutating_services=()
if [ -n "$operation_kind" ]; then
  while IFS= read -r service; do
    sorted_mutating_services+=("$service")
  done < <(printf '%s\n' "${mutating_services[@]}" | LC_ALL=C sort)
fi

action_services=("${sorted_services[@]}")
[ -z "$operation_kind" ] || action_services=("${sorted_mutating_services[@]}")
verification_services=("${sorted_services[@]}")
[ "$operation_kind" != "prepare" ] || verification_services=("${sorted_mutating_services[@]}")
untouched_services=()
if [ "$operation_kind" = "update" ]; then
  for service in "${sorted_services[@]}"; do
    is_mutating=false
    for mutating_service in "${sorted_mutating_services[@]}"; do
      [ "$service" != "$mutating_service" ] || is_mutating=true
    done
    [ "$is_mutating" = true ] || untouched_services+=("$service")
  done
fi

if [ "$phase" = "transition" ] || [ "$phase" = "validate" ] || [ "$phase" = "verify" ]; then
  expected_image_services=("${sorted_services[@]}")
  [ "$operation_kind" != "prepare" ] || expected_image_services=("${sorted_mutating_services[@]}")
  index=0
  while IFS=$'\t' read -r service image_id; do
    [ "$index" -lt "${#expected_image_services[@]}" ] || refuse "$role release image set is invalid"
    [ "$service" = "${expected_image_services[$index]}" ] || refuse "$role release image set does not match its services"
    [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || refuse "$role release image id is invalid"
    index=$((index + 1))
  done < <(jq -r '.images[] | [.service, .imageId] | @tsv' "$plan")
  [ "$index" -eq "${#expected_image_services[@]}" ] || refuse "$role release image set is incomplete"
fi

if [ -n "$output" ]; then
  case "$output" in
    "$(dirname "$plan")"/*) ;;
    *) refuse "$role release output must stay in its guard work directory" ;;
  esac
fi

# shellcheck source=_lib.sh
source "$script_dir/_lib.sh"
require_config
PROFILE="$profile"
PORT_SLOT="$port_slot"
ENV_FILE="$candidate_root/.env.$profile"
REMOTE_BASE="~/swarm-hls-stream-$profile"
[ -f "$ENV_FILE" ] && [ ! -L "$ENV_FILE" ] || refuse "$role release profile environment is missing or invalid"
load_env

for service in "${services[@]}"; do
  [ "$(get_target "$service")" = "localhost" ] || refuse "$role release service is not bound to the local target"
done

if has_service srs; then
  srs_env="$(engine_env_file srs)"
  [ -f "$srs_env" ] && [ ! -L "$srs_env" ] || refuse "uploader release SRS environment is missing or invalid"
  load_env_file "$srs_env"
fi
apply_port_slot

if [ -n "${SRS_CONF_FILE:-}" ]; then
  [ -f "$SRS_CONF_FILE" ] && [ ! -L "$SRS_CONF_FILE" ] || refuse "uploader release SRS configuration is missing or invalid"
  if [ -n "$operation_kind" ]; then
    srs_conf_parent="$(cd "$(dirname "$SRS_CONF_FILE")" && pwd -P)"
    srs_conf_path="${srs_conf_parent}/$(basename "$SRS_CONF_FILE")"
    case "$srs_conf_path" in
      "$candidate_root"/*) ;;
      *) refuse "guarded uploader operation requires SRS_CONF_FILE inside its immutable candidate" ;;
    esac
  fi
fi

case "${COMPOSE_NETWORK:-}" in
  ''|bridge|host) ;;
  *) refuse "$role release compose network is invalid" ;;
esac
if [ -n "$fixture_id" ] && [ "${COMPOSE_NETWORK:-bridge}" = "host" ]; then
  refuse "$role release fixture network requires bridge networking"
fi

if has_service bee-uploader; then
  [ "${LOCAL_BEE_UPLOADER:-}" = "true" ] || refuse "local bee-uploader service requires LOCAL_BEE_UPLOADER=true"
  if [ "${COMPOSE_NETWORK:-}" = "host" ]; then
    export BEE_URL="http://localhost:${BEE_UPLOADER_API_PORT:-1633}"
  else
    export BEE_URL="http://bee-uploader:${BEE_UPLOADER_API_PORT:-1633}"
  fi
elif [ "$role" = "uploader" ]; then
  [ "${LOCAL_BEE_UPLOADER:-}" = "false" ] || refuse "external uploader Bee requires LOCAL_BEE_UPLOADER=false"
  [ -n "${BEE_URL:-}" ] || refuse "external uploader Bee URL is not configured"
fi

if has_service srs; then
  if [ "${COMPOSE_NETWORK:-}" = "host" ]; then
    export SRS_ADAPTER_HOST=localhost
  else
    export SRS_ADAPTER_HOST=stream-uploader
  fi
  export SRS_ADAPTER_PORT="${API_PORT:-3000}"
fi

if has_service client; then
  export VITE_READER_BEE_URL=/bee
  if has_service bee-gateway; then
    if [ "${COMPOSE_NETWORK:-}" = "host" ]; then
      export CLIENT_BEE_GATEWAY_HOST=localhost
      export CLIENT_BEE_GATEWAY_PORT="${BEE_GATEWAY_API_PORT:-1733}"
    else
      export CLIENT_BEE_GATEWAY_HOST=bee-gateway
      export CLIENT_BEE_GATEWAY_PORT="${BEE_GATEWAY_API_PORT:-1733}"
    fi
  else
    [ -n "${CLIENT_BEE_GATEWAY_HOST:-}" ] && [ "${CLIENT_BEE_GATEWAY_HOST}" != "bee-gateway" ] || refuse "external viewer gateway is not configured"
    [[ "${CLIENT_BEE_GATEWAY_PORT:-}" =~ ^[0-9]+$ ]] && [ "${CLIENT_BEE_GATEWAY_PORT}" -ge 1 ] && [ "${CLIENT_BEE_GATEWAY_PORT}" -le 65535 ] || refuse "external viewer gateway port is invalid"
  fi
fi

if [ "$role" = "uploader" ]; then
  [ "${ENGINE:-srs}" = "srs" ] || refuse "managed uploader release requires ENGINE=srs"
  if [ "$operation_kind" = "prepare" ]; then
    [ -z "${SRS_LIFECYCLE_VERSION:-}" ] || refuse "uploader preparation requires SRS_LIFECYCLE_VERSION to be disabled"
  else
    [ "${SRS_LIFECYCLE_VERSION:-}" = "1" ] || refuse "effective uploader configuration is incompatible: SRS_LIFECYCLE_VERSION"
    [ "${SRS_UPLOADER_ID:-}" = "$slot_id" ] || refuse "effective uploader configuration is incompatible: SRS_UPLOADER_ID"
    [ -n "${ADMIN_API_URL:-}" ] || refuse "effective uploader configuration is incompatible: ADMIN_API_URL"
    admin_api_token="${ADMIN_API_TOKEN:-}"
    [ "${#admin_api_token}" -ge 32 ] || refuse "effective uploader configuration is incompatible: ADMIN_API_TOKEN"
    [ -n "${STAMP:-}" ] || [ -n "${BEE_PUBLISHERS:-}" ] || refuse "managed uploader has no configured postage batch"
  fi
fi

if [ -n "$fixture_id" ]; then
  case "$phase" in
    preflight) inspect_fixture_network ;;
    transition|verify) inspect_fixture_network "$fixture_network_id" ;;
  esac
fi

compose_files=(-f "$deploy_dir/docker-compose.yml")
[ "${COMPOSE_NETWORK:-}" = "host" ] && compose_files+=(-f "$deploy_dir/docker-compose.host.yml")
if [ -n "${BEE_UPLOADER_NAT_ADDR:-}" ] || [ -n "${BEE_GATEWAY_NAT_ADDR:-}" ]; then
  compose_files+=(-f "$deploy_dir/docker-compose.nat.yml")
fi
[ -n "${SRS_CONF_FILE:-}" ] && compose_files+=(-f "$deploy_dir/docker-compose.srs-conf.yml")
compose_profiles=()
for service in "${services[@]}"; do
  compose_profiles+=(--profile "$service")
done

compose_for() {
  local project="$1"
  shift
  docker compose --project-name "$project" --project-directory "$deploy_dir" "${compose_files[@]}" --env-file "$ENV_FILE" "${compose_profiles[@]}" "$@"
}

srs_effective_config_digest() {
  local resolved size digest
  if ! resolved="$(compose_for "$profile" config --format json srs)"; then
    refuse "uploader release could not resolve the SRS effective configuration"
  fi
  size="${#resolved}"
  [ "$size" -ge 1 ] && [ "$size" -le 1048576 ] || refuse "uploader release SRS effective configuration is invalid"
  if ! digest="$(printf '%s' "$resolved" | node "$script_dir/release-effective-config.mjs" srs "$fixture_network_id" 2>/dev/null)"; then
    refuse "uploader release SRS effective configuration is invalid"
  fi
  [[ "$digest" =~ ^[0-9a-f]{64}$ ]] || refuse "uploader release SRS effective configuration is invalid"
  printf '%s' "$digest"
}

verify_srs_runtime_config() {
  local container="$1" resolved candidate_environment actual_environment actual_entrypoint actual_mounts base_image_environment total_size image_id
  if ! resolved="$(compose_for "$profile" config --format json srs 2>/dev/null)"; then
    refuse "uploader release could not resolve the SRS effective configuration"
  fi
  if ! candidate_environment="$(jq -c '.services.srs' <<< "$resolved" 2>/dev/null)"; then
    refuse "uploader release SRS effective configuration is invalid"
  fi
  if ! actual_environment="$(docker inspect --format '{{json .Config.Env}}' "$container" 2>/dev/null)" ||
      ! actual_entrypoint="$(docker inspect --format '{{json .Config.Entrypoint}}' "$container" 2>/dev/null)" ||
      ! actual_mounts="$(docker inspect --format '{{json .Mounts}}' "$container" 2>/dev/null)"; then
    refuse "uploader release could not inspect the running SRS configuration"
  fi
  image_id="$(image_from_plan srs)"
  if ! base_image_environment="$(docker image inspect --format '{{json .Config.Env}}' "$image_id" 2>/dev/null)"; then
    refuse "uploader release could not inspect the SRS image configuration"
  fi
  total_size=$((${#candidate_environment} + ${#actual_environment} + ${#actual_entrypoint} + ${#actual_mounts} + ${#base_image_environment}))
  [ "$total_size" -ge 5 ] && [ "$total_size" -le 1048576 ] || refuse "uploader release SRS effective configuration is invalid"
  if ! printf '%s\n%s\n%s\n%s\n%s\n' "$candidate_environment" "$actual_environment" "$actual_entrypoint" "$actual_mounts" "$base_image_environment" |
      jq -sc '{candidate:.[0],actualEnvironment:.[1],actualEntrypoint:.[2],actualMounts:.[3],baseImageEnvironment:.[4]}' 2>/dev/null |
      node "$script_dir/release-effective-config.mjs" srs-runtime >/dev/null 2>&1; then
    refuse "uploader release running SRS effective configuration does not match"
  fi
}

bee_effective_config_hash() {
  local service="$1" override temporary image_id hash_line
  override="$(dirname "$plan")/release-validation-image-override.yml"
  temporary="${override}.tmp.$$"
  image_id="$(image_from_plan "$service")"
  umask 077
  printf 'services:\n  %s:\n    image: %s\n    pull_policy: never\n' "$service" "$image_id" > "$temporary"
  mv "$temporary" "$override"
  if ! hash_line="$(compose_for "$profile" -f "$override" config --hash "$service")"; then
    refuse "uploader release could not resolve an untouched Bee configuration"
  fi
  printf '%s' "$hash_line"
}

verify_untouched_effective_config() {
  local service="$1" container="$2" project_label service_label actual_hash candidate_hash_line candidate_service candidate_hash extra expected_network_mode
  project_label="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.project"}}' "$container")"
  service_label="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.service"}}' "$container")"
  [ "$project_label" = "$profile" ] && [ "$service_label" = "$service" ] || refuse "uploader release untouched service identity does not match"
  case "$service" in
    srs)
      candidate_hash="$(srs_effective_config_digest)"
      actual_hash="$(docker inspect --format '{{index .Config.Labels "org.solarpunk.srs-continuation.srs-config"}}' "$container")"
      ;;
    bee-uploader|bee-gateway|bee-uploader-480p|bee-uploader-720p|bee-uploader-1080p)
      candidate_hash_line="$(bee_effective_config_hash "$service")"
      [ "${#candidate_hash_line}" -le 256 ] || refuse "uploader release untouched Bee configuration is invalid"
      read -r candidate_service candidate_hash extra <<< "$candidate_hash_line"
      [ "$candidate_service" = "$service" ] && [ -z "${extra:-}" ] && [[ "$candidate_hash" =~ ^[0-9a-f]{64}$ ]] || refuse "uploader release untouched Bee configuration is invalid"
      actual_hash="$(docker inspect --format '{{index .Config.Labels "com.docker.compose.config-hash"}}' "$container")"
      ;;
    *) refuse "uploader release cannot prove an untouched service configuration" ;;
  esac
  [ "$actual_hash" = "$candidate_hash" ] || refuse "uploader release untouched service effective configuration does not match"
  [ "$service" != srs ] || verify_srs_runtime_config "$container"

  if [ -n "$fixture_id" ]; then
    expected_network_mode="$fixture_network_name"
  elif [ "${COMPOSE_NETWORK:-}" = "host" ]; then
    expected_network_mode=host
  else
    expected_network_mode="${profile}_default"
  fi
  [ "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$container")" = "$expected_network_mode" ] || refuse "uploader release untouched service network identity does not match"
}

write_preflight() {
  local temporary="${output}.tmp.$$"
  umask 077
  if [ "$role" = "uploader" ]; then
    if [ "$operation_kind" = "prepare" ] && [ -n "$fixture_id" ]; then
      printf '{"schemaVersion":1,"preparationReady":true,"fixtureNetworkId":"%s","fixtureVolumeNames":["%s_srs-media","%s_uploader-state"]}\n' "$fixture_network_id" "$profile" "$profile" > "$temporary"
    elif [ "$operation_kind" = "prepare" ]; then
      printf '%s\n' '{"schemaVersion":1,"preparationReady":true}' > "$temporary"
    elif [ -n "$fixture_id" ]; then
      printf '{"schemaVersion":1,"lifecycleVersion":1,"uploaderId":"%s","adminApiConfigured":true,"fixtureNetworkId":"%s","fixtureVolumeNames":["%s_srs-media","%s_uploader-state"]}\n' "$slot_id" "$fixture_network_id" "$profile" "$profile" > "$temporary"
    else
      printf '{"schemaVersion":1,"lifecycleVersion":1,"uploaderId":"%s","adminApiConfigured":true}\n' "$slot_id" > "$temporary"
    fi
  else
    if [ -n "$fixture_id" ]; then
      printf '{"schemaVersion":1,"fixtureNetworkId":"%s"}\n' "$fixture_network_id" > "$temporary"
    else
      printf '%s\n' '{"schemaVersion":1}' > "$temporary"
    fi
  fi
  mv "$temporary" "$output"
}

write_images() {
  local temporary="${output}.tmp.$$" index service image_id
  umask 077
  printf '{"schemaVersion":1,"images":[' > "$temporary"
  for ((index = 0; index < ${#result_services[@]}; index++)); do
    service="${result_services[$index]}"
    image_id="${result_images[$index]}"
    [ "$index" -eq 0 ] || printf ',' >> "$temporary"
    printf '{"service":"%s","imageId":"%s"}' "$service" "$image_id" >> "$temporary"
  done
  printf ']}\n' >> "$temporary"
  mv "$temporary" "$output"
}

image_from_plan() {
  jq -r --arg service "$1" '.images[] | select(.service == $service) | .imageId' "$plan"
}

case "$phase" in
  preflight)
    write_preflight
    ;;
  build)
    build_services=("${sorted_services[@]}")
    [ "$operation_kind" != "prepare" ] || build_services=("${sorted_mutating_services[@]}")
    built=()
    external=()
    for service in "${build_services[@]}"; do
      case "$service" in
        stream-uploader|client) built+=("$service") ;;
        *) external+=("$service") ;;
      esac
    done
    [ "${#built[@]}" -eq 0 ] || compose_for "$temporary_project" build "${built[@]}"
    [ "${#external[@]}" -eq 0 ] || compose_for "$temporary_project" pull "${external[@]}"
    result_services=()
    result_images=()
    for service in "${build_services[@]}"; do
      if [ "$service" = "stream-uploader" ] || [ "$service" = "client" ]; then
        image_id="$(docker image inspect --format '{{.Id}}' "${temporary_project}-${service}")"
      else
        image_reference="$(compose_for "$temporary_project" config --images "$service")"
        if [ "${#image_reference}" -gt 512 ] || ! [[ "$image_reference" =~ ^[A-Za-z0-9][A-Za-z0-9._/:@-]*$ ]]; then
          refuse "$role release external image reference is invalid"
        fi
        image_id="$(docker image inspect --format '{{.Id}}' "$image_reference")"
      fi
      [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || refuse "$role release built image id is invalid"
      result_services+=("$service")
      result_images+=("$image_id")
    done
    write_images
    ;;
  validate)
    result_services=()
    result_images=()
    for service in "${untouched_services[@]}"; do
      container="$(compose_for "$profile" ps -q "$service")"
      [[ "$container" =~ ^[A-Za-z0-9_.:-]+$ ]] || refuse "$role release could not identify one container per service"
      [ "$(docker inspect --format '{{.State.Status}}' "$container")" = "running" ] || refuse "$role release service is not running"
      verify_untouched_effective_config "$service" "$container"
      image_id="$(docker inspect --format '{{.Image}}' "$container")"
      [[ "$image_id" =~ ^sha256:[0-9a-f]{64}$ ]] || refuse "$role release running image id is invalid"
      result_services+=("$service")
      result_images+=("$image_id")
    done
    write_images
    ;;
  transition)
    override="$(dirname "$plan")/release-image-override.yml"
    reset_override="$(dirname "$plan")/release-fixture-port-reset.yml"
    temporary="${override}.tmp.$$"
    srs_config_digest=""
    for service in "${action_services[@]}"; do
      [ "$service" != srs ] || srs_config_digest="$(srs_effective_config_digest)"
    done
    umask 077
    printf 'services:\n' > "$temporary"
    for service in "${action_services[@]}"; do
      image_id="$(image_from_plan "$service")"
      printf '  %s:\n    image: %s\n    pull_policy: never\n' "$service" "$image_id" >> "$temporary"
      if [ -n "$fixture_id" ] || [ "$service" = srs ]; then
        printf '    labels:\n' >> "$temporary"
        if [ -n "$fixture_id" ]; then
          printf '      org.solarpunk.srs-continuation.fixture: "%s"\n      org.solarpunk.srs-continuation.managed: "true"\n' "$fixture_id" >> "$temporary"
        fi
        if [ "$service" = srs ]; then
          printf '      org.solarpunk.srs-continuation.srs-config: "%s"\n' "$srs_config_digest" >> "$temporary"
        fi
      fi
      if [ -n "$fixture_id" ]; then
        printf '    networks:\n      - default\n' >> "$temporary"
        printf '    cpus: 1\n    mem_limit: 1073741824\n    pids_limit: 256\n' >> "$temporary"
        if [ "$role" = "viewer" ] && [ "$service" = "client" ]; then
          printf '    ports:\n      - "127.0.0.1:%s:80"\n' "$CLIENT_PORT" >> "$temporary"
        fi
      fi
    done
    if [ -n "$fixture_id" ]; then
      printf 'networks:\n  default:\n    external: true\n    name: %s\n' "$fixture_network_name" >> "$temporary"
      if [ "$role" = "uploader" ]; then
        printf 'volumes:\n' >> "$temporary"
        for volume in srs-media uploader-state; do
          printf '  %s:\n    labels:\n      org.solarpunk.srs-continuation.fixture: "%s"\n      org.solarpunk.srs-continuation.managed: "true"\n' "$volume" "$fixture_id" >> "$temporary"
        done
      fi
    fi
    mv "$temporary" "$override"
    if [ -n "$fixture_id" ]; then
      temporary="${reset_override}.tmp.$$"
      printf 'services:\n' > "$temporary"
      for service in "${action_services[@]}"; do
        printf '  %s:\n    ports: !reset []\n' "$service" >> "$temporary"
      done
      mv "$temporary" "$reset_override"
      if [ -n "$operation_kind" ]; then
        compose_for "$profile" -f "$reset_override" -f "$override" up -d --no-deps --no-build --pull never "${action_services[@]}"
      else
        compose_for "$profile" -f "$reset_override" -f "$override" up -d --no-build --pull never "${action_services[@]}"
      fi
    else
      if [ -n "$operation_kind" ]; then
        compose_for "$profile" -f "$override" up -d --no-deps --no-build --pull never "${action_services[@]}"
      else
        compose_for "$profile" -f "$override" up -d --no-build --pull never "${action_services[@]}"
      fi
    fi
    "$script_dir/assert-started.sh" "$profile" "${action_services[@]}"
    ;;
  verify)
    override="$(dirname "$plan")/release-image-override.yml"
    [ -f "$override" ] && [ ! -L "$override" ] || refuse "$role release image override is missing"
    reset_override="$(dirname "$plan")/release-fixture-port-reset.yml"
    if [ -n "$fixture_id" ]; then
      [ -f "$reset_override" ] && [ ! -L "$reset_override" ] || refuse "$role release fixture port reset is missing"
    fi
    result_services=()
    result_images=()
    for service in "${verification_services[@]}"; do
      if [ -n "$fixture_id" ]; then
        container="$(compose_for "$profile" -f "$reset_override" -f "$override" ps -q "$service")"
      else
        container="$(compose_for "$profile" -f "$override" ps -q "$service")"
      fi
      [[ "$container" =~ ^[A-Za-z0-9_.:-]+$ ]] || refuse "$role release could not identify one container per service"
      [ "$(docker inspect --format '{{.State.Status}}' "$container")" = "running" ] || refuse "$role release service is not running"
      health="$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container")"
      [ -z "$health" ] || [ "$health" = "healthy" ] || refuse "$role release service is not healthy"
      image_id="$(docker inspect --format '{{.Image}}' "$container")"
      [ "$image_id" = "$(image_from_plan "$service")" ] || refuse "$role release running image does not match the guarded build"
      if [ -n "$fixture_id" ]; then
        container_network_id="$(docker inspect --format "{{with index .NetworkSettings.Networks \"$fixture_network_name\"}}{{.NetworkID}}{{end}}" "$container")"
        [ "$container_network_id" = "$fixture_network_id" ] || refuse "$role release service is not on the bound fixture network"
        verify_fixture_container "$service" "$container"
      fi
      result_services+=("$service")
      result_images+=("$image_id")
    done
    if [ -n "$fixture_id" ] && [ "$role" = "uploader" ]; then
      needs_media_volume=false
      needs_uploader_state=false
      for service in "${verification_services[@]}"; do
        case "$service" in
          srs) needs_media_volume=true ;;
          stream-uploader)
            needs_media_volume=true
            needs_uploader_state=true
            ;;
        esac
      done
      [ "$needs_media_volume" != true ] || inspect_fixture_volume "${profile}_srs-media"
      [ "$needs_uploader_state" != true ] || inspect_fixture_volume "${profile}_uploader-state"
    fi
    write_images
    ;;
esac
