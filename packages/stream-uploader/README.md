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

| Variable            | Description                                                                            |
| ------------------- | -------------------------------------------------------------------------------------- |
| `BEE_URL`           | Bee node API URL                                                                       |
| `STAMP`             | Postage stamp ID (`pnpm stamp:setup`)                                                  |
| `STREAM_KEY`        | Private key (hex) for signing feeds                                                    |
| `STREAM_LIST_TOPIC` | Feed topic for the stream catalog                                                      |
| `API_AUTH_TOKEN`    | Bearer token for the `/stream/*` routes, minimum 32 characters. `openssl rand -hex 32` |

**Optional:**

| Variable               | Default   | Description                                                         |
| ---------------------- | --------- | ------------------------------------------------------------------- |
| `MANIFEST_ACCESS_URL`  | _(empty)_ | Base URL for segment refs in manifests                              |
| `API_PORT`             | `3000`    | HTTP API port                                                       |
| `STATE_DIR`            | `./state` | Directory for crash recovery state                                  |
| `MAX_QUEUE_SIZE`       | `100`     | Max queued segments per stream                                      |
| `RECOVERY_TIMEOUT`     | `60000`   | Crash recovery timeout (ms)                                         |
| `SEGMENT_STALL_MS`     | `30000`   | Silence after which `/health` reads degraded                        |
| `SEGMENT_DEDUP_WINDOW` | `10000`   | Segment indexes remembered per stream, twice this many held at most |
| `ENGINE`               | _(empty)_ | Engine plugin to load (`srs`, `ome` or empty)                       |

Engine-specific variables (e.g. `SRS_MEDIA_PATH` for SRS, `OME_*` for OME) live in `engines/<name>/.env` and are loaded only when that engine is selected via `ENGINE`. Copy the sample next to each engine to get started: [engines/srs/.env.sample](../../engines/srs/.env.sample), [engines/ome/.env.sample](../../engines/ome/.env.sample). Values in the root `.env` (or injected container env) take precedence over the engine file.

## API

### Generic API

Engine-independent HTTP interface for pushing segments directly.

| Endpoint               | Method                               | Description                                |
| ---------------------- | ------------------------------------ | ------------------------------------------ |
| `POST /stream/start`   | JSON body: `{ streamId, mediatype }` | Register a new stream                      |
| `POST /stream/segment` | Raw body + headers                   | Push a segment                             |
| `POST /stream/stop`    | JSON body: `{ streamId }`            | End a stream, answered `202`               |
| `GET /stream/status`   | Query: `?streamId=<id>`              | What became of a stream                    |
| `GET /metrics`         | —                                    | Prometheus exposition                      |
| `GET /health`          | —                                    | Service health, `200` ok or `503` degraded |

All four `/stream/*` routes and `GET /metrics` require `Authorization: Bearer $API_AUTH_TOKEN`, checked in constant time before the body is parsed, so an unauthenticated request neither reaches the orchestrator nor costs the process a buffered body. `GET /health` is deliberately outside the gate: it is a liveness endpoint that `deploy/scripts/health.sh` reads, it accepts no input and it spends nothing. No compose healthcheck consumes it today.

The `/engines/*` webhook routes are **not** behind this gate. OME admission carries its own HMAC signature. The two SRS routes carry no credential at all, and `POST /engines/srs/hls` reaches the same stamp-spending path `/stream/segment` does, so on a default `ENGINE=srs` deployment an anonymous caller can still cause an upload. That is the open half of SEC-1, tracked as S1.2.

**Metrics.** `GET /metrics` serves Prometheus text exposition. These are process-lifetime totals and
they deliberately outlive the streams they count, which is the one thing `/health` structurally cannot
do: `/health` describes the streams registered right now, so at the moment a live session is wrongly
killed it answers `ok` with `activeStreams: 0`.

| Metric                                      | Type    | Meaning                                                   |
| ------------------------------------------- | ------- | --------------------------------------------------------- |
| `swarm_hls_segments_uploaded_total`         | counter | Segments whose payload reached Swarm                      |
| `swarm_hls_segments_dropped_total`          | counter | Segments whose upload retry window was spent, data gone   |
| `swarm_hls_segments_lost_total`             | counter | Segments the engine could never obtain from its origin    |
| `swarm_hls_manifest_publish_failures_total` | counter | Live manifest publishes that failed                       |
| `swarm_hls_streams_finalized_total`         | counter | Stops that published a VOD                                |
| `swarm_hls_streams_failed_total`            | counter | Stops that did not. Those broadcasts have no recording    |
| `swarm_hls_last_segment_timestamp_seconds`  | gauge   | Unix time of the newest segment that landed, 0 while none |
| `swarm_hls_active_streams`                  | gauge   | Streams registered and expected to be producing           |
| `swarm_hls_queue_depth`                     | gauge   | Segments waiting to upload across every stream            |
| `swarm_hls_queue_backlog_seconds`           | gauge   | Playing time still queued for the worst stream            |

Unlike `/health`, `/metrics` is behind the bearer gate: it names when the last segment landed and how
many broadcasts have run, which is more than a liveness probe should give away. Point a scraper at it
with an `authorization` credential:

```yaml
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
`msSinceSegmentLoss`, `msSinceCatalogAnnounceFailed`, `msSinceStatePersistFailed` and `engines`.

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

Currently supported: **SRS** (SRT/RTMP to HLS) and **OME** (OvenMediaEngine, LLHLS).

## Supported Transcoding Engines

### OME Engine - OvenMediaEngine :

When `ENGINE=ome`, webhook endpoints are mounted:

| Endpoint             | Description                  |
| -------------------- | ---------------------------- |
| `POST /engines/ome/` | Handles `admission` webhooks |

1. **Ingest** — broadcaster pushes SRT into OvenMediaEngine, which transcodes and publishes LLHLS.
2. **Admission** — OME calls the `/engines/ome/admission` webhook on publish start/stop; the uploader verifies the HMAC signature and starts/stops the stream.
3. **Pull** — an `HlsPuller` polls OME's HLS playlist and fetches new segments over HTTP (one puller per stream).
4. **Upload** — the orchestrator uploads segments to Swarm, updates the live manifest feed (SOC), and finalizes a VOD manifest + catalog entry on stop.

### SRS Engine

When `ENGINE=srs`, SRS webhook endpoints are mounted:

| Endpoint                    | Description                                    |
| --------------------------- | ---------------------------------------------- |
| `POST /engines/srs/streams` | Handles `on_publish` / `on_unpublish` webhooks |
| `POST /engines/srs/hls`     | Handles `on_hls` webhook (new segment ready)   |

SRS writes segments to the shared media volume. The uploader reads segments from disk, uploads to Swarm, and deletes the file after upload.

## Testing with FFmpeg

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
