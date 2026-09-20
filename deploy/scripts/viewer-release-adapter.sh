#!/bin/bash
set -euo pipefail

export RELEASE_ADAPTER_ROLE=viewer
exec /bin/bash "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)/release-adapter.sh" "$@"
