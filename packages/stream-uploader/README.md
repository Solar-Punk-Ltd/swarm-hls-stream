# Stream Uploader

Node.js service that receives HLS segments and uploads them to the Swarm decentralized network. Part of the [swarm-hls-stream](../../) monorepo.

## How It Works

The uploader receives HLS segments from a media server (e.g. SRS) or directly via HTTP, uploads each segment to Swarm, and maintains a live HLS manifest as a Swarm Feed. When a stream ends, the manifest is finalized as VOD and the stream is registered in the stream catalog feed.

```
Segments in ──▶ StreamOrchestrator ──▶ StreamUploader ──▶ Swarm
                      │                      │
                      │                      ├─ Upload segment data
                      │                      ├─ Update manifest feed (SOC)
                      │                      └─ Update stream catalog feed
                      │
                      ├─ Backpressure (bounded queue, 429 on overflow)
                      ├─ Deduplication (reject duplicate segments)
                      └─ Crash recovery (persisted state + recovery timeout)
```

## Prerequisites

- Node.js 22+
- pnpm
- A running Swarm Bee node with a valid postage stamp (see `pnpm stamp:setup`)

## Getting Started

From the monorepo root:

```bash
# Install and build
pnpm install
pnpm build

# Create .env from sample (if not done yet)
cp .env.sample .env
# Edit .env — fill in STREAM_KEY, run `pnpm stamp:setup` for STAMP

# Start the uploader
pnpm uploader:start
```

The API server starts on port 3000 (default).

> **Note:** Both packages share a single `.env` file in the **monorepo root**. See [.env.sample](../../.env.sample) for all available variables.

## Environment Variables (in root `.env`)

**Required:**

| Variable            | Description                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------- |
| `BEE_URL`           | Bee node API URL                                                                               |
| `STAMP`             | Postage stamp ID (`pnpm stamp:setup`)                                                          |
| `STREAM_KEY`        | Private key (hex) for signing feeds                                                            |
| `STREAM_LIST_TOPIC` | Feed topic for the stream catalog                                                              |
| `API_AUTH_TOKEN`    | Bearer token for `/stream/*` and `GET /metrics`, minimum 32 characters. `openssl rand -hex 32` |

**Optional:**

| Variable               | Default   | Description                                                                                                          |
| ---------------------- | --------- | -------------------------------------------------------------------------------------------------------------------- |
| `PUBLISH_KEY_SECRET`   | _(empty)_ | Master secret for per-stream publish keys, minimum 32 characters. Empty leaves publishers unauthenticated. See below |
| `MANIFEST_ACCESS_URL`  | _(empty)_ | Base URL for segment refs in manifests                                                                               |
| `API_PORT`             | `3000`    | HTTP API port                                                                                                        |
| `STATE_DIR`            | `./state` | Directory for crash recovery state                                                                                   |
| `MAX_QUEUE_SIZE`       | `100`     | Max queued segments per stream                                                                                       |
| `RECOVERY_TIMEOUT`     | `60000`   | Crash recovery timeout (ms)                                                                                          |
| `SEGMENT_STALL_MS`     | `30000`   | Silence after which `/health` reads degraded                                                                         |
| `SEGMENT_DEDUP_WINDOW` | `10000`   | Segment indexes remembered per stream, twice this many held at most                                                  |
| `ENGINE`               | _(empty)_ | Engine plugin to load (`srs`, `ome` or empty)                                                                        |
| `LOG_LEVEL`            | `debug`   | `debug`, `log`, `info`, `warn`, `error` or `silent`. `log` is per segment, `info` is per lifecycle event             |
| `LOG_FORMAT`           | _(empty)_ | `json` for one `{ts, level, msg}` object per line. Anything else keeps the readable format                           |

Engine-specific variables (e.g. `SRS_MEDIA_PATH` for SRS, `OME_*` for OME) live in `engines/<name>/.env` and are loaded only when that engine is selected via `ENGINE`. Copy the sample next to each engine to get started: [engines/srs/.env.sample](../../engines/srs/.env.sample), [engines/ome/.env.sample](../../engines/ome/.env.sample). Values in the root `.env` (or injected container env) take precedence over the engine file.

## API

### Generic API

Engine-independent HTTP interface for pushing segments directly.

| Endpoint               | Method                               | Description                                       |
| ---------------------- | ------------------------------------ | ------------------------------------------------- |
| `POST /stream/start`   | JSON body: `{ streamId, mediatype }` | Register a new stream                             |
| `POST /stream/segment` | Raw body + headers                   | Push a segment. `400` on an unusable `x-duration` |
| `POST /stream/stop`    | JSON body: `{ streamId }`            | End a stream, answered `202`                      |
| `GET /stream/status`   | Query: `?streamId=<id>`              | What became of a stream                           |
| `GET /metrics`         | —                                    | Prometheus exposition                             |
| `GET /health`          | —                                    | Service health, `200` ok or `503` degraded        |

All four `/stream/*` routes and `GET /metrics` require `Authorization: Bearer $API_AUTH_TOKEN`, checked in constant time before the body is parsed, so an unauthenticated request neither reaches the orchestrator nor costs the process a buffered body. `GET /health` is deliberately outside the gate: it is a liveness endpoint that accepts no input and spends nothing, and both the `stream-uploader` compose healthcheck and `deploy/scripts/health.sh` read it unauthenticated.

The `/engines/*` webhook routes are **not** behind this gate, because each carries its own. OME admission is verified by HMAC signature, and the two SRS routes by `SRS_WEBHOOK_TOKEN` in the hook URL, which is the only channel SRS 6 offers. Both fail closed on an empty secret rather than disabling the check. This paragraph described `POST /engines/srs/hls` as reachable by an anonymous caller until S1.2 closed it, and the gate on this pull request measured every shape of both routes answering 401 with the orchestrator untouched.

**Something reads `/health`.** The `stream-uploader` service declares a compose healthcheck that polls
it every 30 seconds and treats the `503` of a degraded service as a failure, so `docker ps` shows
`(unhealthy)` after three consecutive ones. Before that, every `503` this endpoint could raise was a
value in a response body nobody requested.

It reports and does not act, on purpose. Compose does not restart a container for failing its
healthcheck, and nothing declares `depends_on: condition: service_healthy`. Restarting on degraded
would be the wrong response anyway: most reasons describe media already lost or state already
unwritten, and a restart drops every live broadcast to re-run a recovery that changes none of it.

**Metrics.** `GET /metrics` serves Prometheus text exposition. These are process-lifetime totals and
they deliberately outlive the streams they count, which is the one thing `/health` structurally cannot
do: `/health` describes the streams registered right now, so at the moment a live session is wrongly
killed it answers `ok` with `activeStreams: 0`.

| Metric                                      | Type    | Meaning                                                     |
| ------------------------------------------- | ------- | ----------------------------------------------------------- |
| `swarm_hls_segments_uploaded_total`         | counter | Segments whose payload reached Swarm                        |
| `swarm_hls_segments_dropped_total`          | counter | Segments whose upload retry window was spent, data gone     |
| `swarm_hls_segments_lost_total`             | counter | Segments the engine could never obtain from its origin      |
| `swarm_hls_segments_skipped_total`          | counter | Segments discarded on purpose at a puller handover          |
| `swarm_hls_segments_never_named_total`      | counter | Segments in Swarm that no published manifest named          |
| `swarm_hls_auth_rejections_total`           | counter | Requests refused by a credential gate                       |
| `swarm_hls_takeovers_refused_total`         | counter | Announces refused because a live session still holds the id |
| `swarm_hls_manifest_publish_failures_total` | counter | Live manifest publishes that failed                         |
| `swarm_hls_streams_finalized_total`         | counter | Stops that published a VOD                                  |
| `swarm_hls_streams_failed_total`            | counter | Stops that did not. Those broadcasts have no recording      |
| `swarm_hls_streams_reaped_total`            | counter | Broadcasts finalized because their engine went silent       |
| `swarm_hls_segment_durations_unread_total`  | counter | Segments published on the engine's word, unreadable here    |
| `swarm_hls_last_segment_timestamp_seconds`  | gauge   | Unix time of the newest segment that landed, 0 while none   |
| `swarm_hls_active_streams`                  | gauge   | Streams registered and expected to be producing             |
| `swarm_hls_queue_depth`                     | gauge   | Segments waiting to upload across every stream              |
| `swarm_hls_queue_backlog_seconds`           | gauge   | Playing time still queued for the worst stream              |

**Who may take a stream id that is already live.** An announce for an id a live session holds is
refused when both publisher addresses are known and different and something is still publishing into
it. Everything else is allowed, because not every engine reports a publisher address and a missing
field must not take a broadcaster off the air. A stream nothing has published into for
`SEGMENT_STALL_MS` can be claimed by anyone, which is what stops a refusal being permanent.

Two consequences worth knowing before you deploy it.

The guard is symmetric, so **it protects whoever got there first**. Someone who claims a stream id
before your broadcaster does, and keeps feeding it, holds it: your broadcaster is refused for as long
as that continues. `POST /stream/stop` on the id is the operator override, and it is authenticated.
The complete answer is a publish credential the broadcaster presents to the engine, which neither
engine is configured for here.

An attacker who publishes from the same address as your broadcaster is not distinguished from them.
The same host, the same NAT and one shared VPN egress all produce that.

`swarm_hls_takeovers_refused_total` counts every refusal, and it **cannot tell those cases apart**:
an attack and a locked-out broadcaster produce the identical count. Read it as a reason to check who
holds the stream, not as a verdict.

Unlike `/health`, `/metrics` is behind the bearer gate, and the honest reason is narrower than it first
looks: `/health` already discloses `activeStreams`, `queuePressure` and `msSinceStreamActivity` to anyone
who asks, so the gate is really protecting the nine process-lifetime counters, which say how many
broadcasts have run, how many were lost, and how many requests this deployment turned away. Point a scraper at it
with an `authorization` credential:

```yaml
# `stream-uploader:3000` is the default only. `API_PORT` sets both sides of the compose port map,
# and `deploy.sh --portSlot` shifts it, so a second instance listens on 10010 rather than 3000.
scrape_configs:
  - job_name: swarm-hls-stream
    authorization:
      credentials: <API_AUTH_TOKEN>
    static_configs:
      - targets: ['stream-uploader:3000']
```

**Stop is asynchronous.** `POST /stream/stop` answers `202` with `{ ok, accepted, streamId, statusUrl }`
and drains in the background, because a drain has five minutes to publish its VOD and no media server
will hold a webhook open that long. The outcome is read from `GET /stream/status?streamId=<id>`, which
answers one of:

| `state`     | Meaning                                                                                    |
| ----------- | ------------------------------------------------------------------------------------------ |
| `live`      | Registered and accepting segments                                                          |
| `draining`  | Stopping, the VOD has not settled yet                                                      |
| `finalized` | The VOD manifest was committed and the catalog entry published                             |
| `failed`    | The finalize did not complete, with a `reason`. There is no VOD, and no retry is scheduled |

A stream the service has never seen, or one whose stop settled more than fifteen minutes ago, answers
`404` rather than a state, so a caller polling a mistyped id is not told its broadcast is fine.

**Health status:** `GET /health` answers `200` with `status: "ok"`, or `503` with `status: "degraded"` and a
`reasons` array:

| Reason                   | Meaning                                                                                                                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `segment_upload_failure` | A segment reached the uploader but its upload retry window was spent, so that data is gone                                                                                                                                           |
| `segment_loss`           | The engine could not obtain a segment from its origin at all, so it never reached the uploader. Stays reported for `SEGMENT_STALL_MS` after the loss, because a loss is permanent and the stream usually keeps flowing around it     |
| `stale_manifest`         | Three consecutive live-manifest publish failures, so the live playlist is not moving                                                                                                                                                 |
| `queue_pressure`         | Either a segment queue above 80% of `MAX_QUEUE_SIZE`, where the next segments start being refused, or a backlog holding more than `SEGMENT_STALL_MS` of playing time, which is how far behind live a viewer is                       |
| `segment_stall`          | A stream that should be producing has sent nothing for `SEGMENT_STALL_MS`                                                                                                                                                            |
| `unlisted_stream`        | A live stream is absent from the catalog, so no viewer can find it. Reported from the first failed announce, with no threshold, because `StreamCatalog` has already spent its own 10 second retry window by then                     |
| `state_not_persisted`    | A write into `STATE_DIR` is failing, so the next restart resumes a stream from stale segments or the catalog feed from an index readers have already passed. Nothing is wrong with the running process, which is why it needs saying |

`segment_stall` is measured per stream and reported for the worst one, so a busy stream does not mask a dead
one. A draining stream and a stream awaiting a post-crash reconnect are both excluded, because neither is
expected to be sending. The body also carries `activeStreams`, `staleManifestStreams`,
`maxConsecutiveManifestFailures`, `maxConsecutiveSegmentFailures`, `queuePressure`, `msSinceStreamActivity`,
`msSinceSegmentLoss`, `msSinceCatalogAnnounceFailed`, `msSinceStatePersistFailed`, `queueBacklogSeconds`
and `engines`. `queueBacklogSeconds` is the only field that says which of `queue_pressure`'s two triggers
fired.

**Segment headers:**

- `x-stream-id` — Stream identifier
- `x-segment-index` — Segment sequence number
- `x-duration` — Segment duration in seconds

**Error responses:**

- `429` — Queue full (retry after `Retry-After` header)
- `404` — Unknown stream
- `400` — Missing required fields

## Engine Plugin Architecture

The uploader supports pluggable media server engines. Each engine implements the `EnginePlugin` interface:

```typescript
interface EnginePlugin {
  name: string;
  prefix: string;
  createRouter(streamOrchestrator: StreamOrchestrator): Router;
}
```

Engines are thin adapters that translate media server events into `StreamOrchestrator` calls. The generic API and engine routes coexist — both feed into the same orchestrator.

Each engine owns its configuration: a `create<Name>EngineFromEnv()` factory reads the engine's env vars, and `src/engines/registry.ts` maps the `ENGINE` value to that factory. To add an engine, create its module under `src/engines/`, register it in the registry, and add an `engines/<name>/.env.sample` with its variables — the uploader loads `engines/<name>/.env` automatically when the engine is selected.

Currently supported: **SRS** (SRT/RTMP to HLS) and **OME** (OvenMediaEngine, MPEG-TS HLS).

## Supported Engines

Neither engine transcodes as this repository configures them. OME's output profile sets
`<Bypass>true</Bypass>` on both the video and the audio encode, and the SRS config carries no
`transcode` section at all, so both engines remux the broadcaster's own elementary streams into HLS
and the picture a viewer gets is the picture that was published. Changing the resolution or the
bitrate is therefore the broadcaster's to do, not the deployment's, which is the same fact
`docs/bench/profiles.md` records from the other direction.

### OME Engine - OvenMediaEngine :

When `ENGINE=ome`, webhook endpoints are mounted:

| Endpoint                      | Description                           |
| ----------------------------- | ------------------------------------- |
| `POST /engines/ome/admission` | Publish start and stop, HMAC-verified |

1. **Ingest** — broadcaster pushes SRT into OvenMediaEngine, which remuxes it into MPEG-TS HLS.
2. **Admission** — OME calls the `/engines/ome/admission` webhook on publish start/stop; the uploader verifies the HMAC signature and starts/stops the stream.
3. **Pull** — an `HlsPuller` polls `{app}/{stream}/ts:playlist.m3u8` and fetches new segments over HTTP (one
   puller per stream). That is OME's **MPEG-TS** playlist, not its fMP4 one, so the segments are
   `.ts` and nothing downstream ever sees LL-HLS.
4. **Upload** — the orchestrator uploads segments to Swarm, updates the live manifest feed (SOC), and finalizes a VOD manifest + catalog entry on stop.

### SRS Engine

When `ENGINE=srs`, SRS webhook endpoints are mounted:

| Endpoint                    | Description                                    |
| --------------------------- | ---------------------------------------------- |
| `POST /engines/srs/streams` | Handles `on_publish` / `on_unpublish` webhooks |
| `POST /engines/srs/hls`     | Handles `on_hls` webhook (new segment ready)   |

SRS writes segments to the shared media volume. The uploader reads segments from disk, uploads to Swarm, and deletes the file after upload.

## Publisher Authentication

Without `PUBLISH_KEY_SECRET`, anyone who can reach the engine can publish under any stream name, and
the name is public because it is in every HLS URL. Ownership of a live stream id is then decided only
by the address the engine reports, which cannot separate two publishers behind one egress address and
wrongly separates one publisher whose address moved.

Setting `PUBLISH_KEY_SECRET` turns on a per-stream publish key. It is derived from the secret and the
stream id, so a broadcaster's key authorises their stream and no other, and a leaked key is one
compromised broadcast rather than the run of the deployment.

```bash
# Generate the secret once, put it in the root .env, and redeploy the stream-uploader.
openssl rand -hex 32

# Then issue a key per stream. It prints the publish URL for both engines.
./deploy/scripts/publish-key.sh video/demo
```

**Turning it on refuses every publisher that does not present a key**, so issue the keys before
setting the secret. With it set, an announce carrying a valid key takes its stream id back
immediately from any address, and an announce without one can never take a stream whose owner proved
the key, however long that stream has been quiet.

The key travels as a `key` query parameter, which was measured on `ossrs/srs:6` and
`airensoft/ovenmediaengine:latest` rather than read off their documentation:

| Publish path | Where the key goes                                                          |
| ------------ | --------------------------------------------------------------------------- |
| SRS, RTMP    | `rtmp://<host>:<SRS_RTMP_PORT>/video/demo?key=<key>`                        |
| SRS, SRT     | `srt://<host>:<SRS_SRT_PORT>?streamid=#!::r=video/demo?key=<key>,m=publish` |
| OME, SRT     | `srt://<host>:<OME_SRT_PORT>?streamid=<percent-encoded publish url>`        |

**Take the ports from `publish-key.sh` rather than from here.** This repo's own defaults are not 1935
and 10080: `apply_port_slot` resolves slot 0 to `SRS_RTMP_PORT=10002`, and `engines/ome/.env.sample`
sets `OME_SRT_PORT=10081`. The script resolves them the same way the deploy does, so what it prints is
what the deployment is actually listening on.

OME's streamid has to be percent-encoded, because the key sits inside a value that is itself inside a
query and the publisher's own URL parser otherwise splits on the inner `?`. `publish-key.sh` prints
the encoded form.

Rotating `PUBLISH_KEY_SECRET` invalidates every key at once. There is no per-stream revocation, which
is the price of deriving keys instead of storing them.

## Testing with FFmpeg

> **With `PUBLISH_KEY_SECRET` set these commands are refused**, because publisher authentication
> applies to them like any other publish. Append the stream's key inside the `r=` value:
> `streamid=#!::r=video/test?key=<key>,m=publish`, taking the key from
> `./deploy/scripts/publish-key.sh video/test`. The ports below are the upstream defaults rather than
> this repo's, for the same reason as the table above.

Video + audio test pattern (requires SRS running with `ENGINE=srs`):

```bash
ffmpeg -re -f lavfi -i testsrc=size=1280x720:rate=30 \
  -f lavfi -i sine=frequency=1000 \
  -c:v libx264 -preset veryfast -g 45 -c:a aac -b:a 128k \
  -f mpegts "srt://localhost:10080?streamid=#!::r=video/test,m=publish"
```

Audio only:

```bash
ffmpeg -f avfoundation -i ":0" -ac 1 -c:a aac -b:a 128k \
  -f mpegts "srt://localhost:10080?streamid=#!::r=audio/test,m=publish"
```

Or push segments directly via the generic API (no engine needed):

```bash
# Start a stream
curl -X POST http://localhost:3000/stream/start \
  -H "Authorization: Bearer $API_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"streamId": "test/mystream", "mediatype": "video"}'

# Push a segment
curl -X POST http://localhost:3000/stream/segment \
  -H "Authorization: Bearer $API_AUTH_TOKEN" \
  -H 'x-stream-id: test/mystream' \
  -H 'x-segment-index: 0' \
  -H 'x-duration: 1.5' \
  --data-binary @segment-0.ts

# Stop the stream
curl -X POST http://localhost:3000/stream/stop \
  -H "Authorization: Bearer $API_AUTH_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"streamId": "test/mystream"}'

# The stop is accepted, not completed. Poll for what became of it.
curl -G http://localhost:3000/stream/status \
  -H "Authorization: Bearer $API_AUTH_TOKEN" \
  --data-urlencode 'streamId=test/mystream'
```

## Core Components

| Module               | Description                                                                     |
| -------------------- | ------------------------------------------------------------------------------- |
| `StreamOrchestrator` | Central coordinator — manages stream lifecycle, queue, backpressure, recovery   |
| `StreamUploader`     | Per-stream upload session — uploads segments, updates manifests via Swarm feeds |
| `StreamCatalog`      | Maintains the stream directory as a Swarm feed                                  |
| `RecoveryStore`      | Persists stream state to disk for crash recovery                                |
| `ManifestManager`    | Builds and updates HLS manifests                                                |

## Scripts

| Script           | Description                 |
| ---------------- | --------------------------- |
| `pnpm build`     | Compile TypeScript          |
| `pnpm start`     | Start the server            |
| `pnpm lint`      | Run ESLint                  |
| `pnpm typecheck` | Type check without emitting |
