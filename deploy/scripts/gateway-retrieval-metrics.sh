#!/bin/bash
# The counters that separate "a peer refused us" from "the network was slow", as one line of
# name=value pairs. Reduced on the host: /metrics is 1068 lines and only a dozen answer anything.
#
# ⛔ `peerReq` and `attemptSum` count peer-selection LOOP ITERATIONS, not requests on the wire. Bee
# increments both before the `prepareCredit` call that decides whether to contact the peer at all, so
# every accounting skip lands in them and is never sent. **Requests that actually left the node are
# `attemptSum - blocks`**, which on 2026-08-08 was 1.28-1.30 per chunk unfunded against 1.14 funded.
# Reading the raw column as network load overstates it by about 34x.
#
# `durLe1` is the node's own view of the failure that matters: `durCount - durLe1` is the number of
# retrievals that took a second or more, which is the retry timer firing, and it is the statistic a
# median cannot see. `attLe1` is how many chunks were served on the first candidate peer.
curl -s -m 10 "http://localhost:$1/metrics" 2>/dev/null | awk '
  $1=="bee_accounting_accounting_blocks_count"        {printf "blocks=%d ", $2}
  $1=="bee_accounting_disconnects_overdraw_count"     {printf "dropOverdraw=%d ", $2}
  $1=="bee_accounting_disconnects_ghost_overdraw_count"{printf "dropGhost=%d ", $2}
  $1=="bee_accounting_disconnects_enforce_refresh_count"{printf "dropRefresh=%d ", $2}
  $1=="bee_pseudosettle_sent_pseudosettlements"       {printf "settleSent=%d ", $2}
  $1=="bee_pseudosettle_received_pseudosettlements"   {printf "settleRecv=%d ", $2}
  $1=="bee_retrieval_request_count"                   {printf "req=%d ", $2}
  $1=="bee_retrieval_request_failure_count"           {printf "reqFail=%d ", $2}
  $1=="bee_retrieval_total_errors"                    {printf "errors=%d ", $2}
  $1=="bee_retrieval_peer_request_count"              {printf "peerReq=%d ", $2}
  $1=="bee_retrieval_request_attempts_sum"            {printf "attemptSum=%d ", $2}
  $1=="bee_retrieval_request_attempts_count"          {printf "attemptCount=%d ", $2}
  $1=="bee_retrieval_request_attempts_bucket{le=\"1\"}"  {printf "attLe1=%d ", $2}
  $1=="bee_retrieval_request_attempts_bucket{le=\"10\"}" {printf "attLe10=%d ", $2}
  $1=="bee_retrieval_request_duration_time_sum"       {printf "durSum=%.3f ", $2}
  $1=="bee_retrieval_request_duration_time_count"     {printf "durCount=%d ", $2}
  $1=="bee_retrieval_request_duration_time_bucket{le=\"0.25\"}" {printf "durLe0p25=%d ", $2}
  $1=="bee_retrieval_request_duration_time_bucket{le=\"1\"}"    {printf "durLe1=%d ", $2}
  END{printf "\n"}'
