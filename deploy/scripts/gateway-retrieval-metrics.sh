#!/bin/bash
# The counters that separate "a peer refused us" from "the network was slow", as one line of
# name=value pairs. Reduced on the host: /metrics is 1068 lines and only a dozen answer anything.
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
  END{printf "\n"}'
