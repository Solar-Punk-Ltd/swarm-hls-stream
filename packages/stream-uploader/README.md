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

### ABR ladder

With `ABR_ENABLED=true` (see [engines/srs](../../engines/srs/)) the engine publishes one stream per
rung, and each gets its own `StreamUploader` and its own manifest feed. Two things then tie them
back together:

- The four rungs fold into a **single catalog entry**, keyed by a shared group id rather than by
  topic. Four uploaders write that entry concurrently, which is safe only because every catalog
  write goes through one serialized queue.
- That same point is where the ladder's **master playlist** is written, to a fifth feed whose topic
  is the group id — it is the only place the whole ladder is known, since each uploader holds just
  its own rung. The catalog entry's `topic` points at the master, so one URL yields every rung.

Each rung's `BANDWIDTH` in the master is measured from real segments rather than copied from the
encoder's target, and is re-announced when it drifts more than 15% (at most every 30s, since the
catalog is one feed shared by every stream). `EXT-X-MEDIA-SEQUENCE` carries the engine's own
sequence number, which is what tells a player that two rungs share a timeline.

## Prerequisites

- Node.js 20+
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
pnpm start:uploader
```

The API server starts on port 3000 (default).

> **Note:** Both packages share a single `.env` file in the **monorepo root**. See [.env.sample](../../.env.sample) for all available variables.

## Environment Variables (in root `.env`)

**Required:**

| Variable            | Description                           |
| ------------------- | ------------------------------------- |
| `BEE_URL`           | Bee node API URL                      |
| `STAMP`             | Postage stamp ID (`pnpm stamp:setup`) |
| `STREAM_KEY`        | Private key (hex) for signing feeds   |
| `STREAM_LIST_TOPIC` | Feed topic for the stream catalog     |

**Optional:**

| Variable              | Default   | Description                                   |
| --------------------- | --------- | --------------------------------------------- |
| `MANIFEST_ACCESS_URL` | _(empty)_ | Base URL for segment refs in manifests        |
| `API_PORT`            | `3000`    | HTTP API port                                 |
| `STATE_DIR`           | `./state` | Directory for crash recovery state            |
| `MAX_QUEUE_SIZE`      | `100`     | Max queued segments per stream                |
| `RECOVERY_TIMEOUT`    | `60000`   | Crash recovery timeout (ms)                   |
| `ENGINE`              | _(empty)_ | Engine plugin to load (`srs`, `ome` or empty) |

Engine-specific variables (e.g. `SRS_MEDIA_PATH` for SRS, `OME_*` for OME) live in `engines/<name>/.env` and are loaded only when that engine is selected via `ENGINE`. Copy the sample next to each engine to get started: [engines/srs/.env.sample](../../engines/srs/.env.sample), [engines/ome/.env.sample](../../engines/ome/.env.sample). Values in the root `.env` (or injected container env) take precedence over the engine file.

## API

### Generic API

Engine-independent HTTP interface for pushing segments directly.

| Endpoint               | Method                               | Description                                    |
| ---------------------- | ------------------------------------ | ---------------------------------------------- |
| `POST /stream/start`   | JSON body: `{ streamId, mediatype }` | Register a new stream                          |
| `POST /stream/segment` | Raw body + headers                   | Push a segment                                 |
| `POST /stream/stop`    | JSON body: `{ streamId }`            | End a stream                                   |
| `GET /health`          | —                                    | Service health, active streams, queue pressure |

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
  -H 'Content-Type: application/json' \
  -d '{"streamId": "test/mystream", "mediatype": "video"}'

# Push a segment
curl -X POST http://localhost:3000/stream/segment \
  -H 'x-stream-id: test/mystream' \
  -H 'x-segment-index: 0' \
  -H 'x-duration: 1.5' \
  --data-binary @segment-0.ts

# Stop the stream
curl -X POST http://localhost:3000/stream/stop \
  -H 'Content-Type: application/json' \
  -d '{"streamId": "test/mystream"}'
```

## Core Components

| Module               | Description                                                                     |
| -------------------- | ------------------------------------------------------------------------------- |
| `StreamOrchestrator` | Central coordinator — manages stream lifecycle, queue, backpressure, recovery   |
| `StreamUploader`     | Per-stream upload session — uploads segments, updates manifests via Swarm feeds |
| `StreamCatalog`      | Maintains the stream directory as a Swarm feed                                  |
| `RecoveryStore`      | Persists stream state to disk for crash recovery                                |
| `ManifestManager`    | Builds and updates HLS manifests                                                |
| `AbrLadder`          | The rung list from `ABR_LADDER`, and what maps a stream name back to its rung    |
| `MasterPlaylist`     | Builds a ladder's multivariant playlist                                          |
| `MasterFeedWriter`   | Publishes that master to a feed per ladder, topic = the ladder's group id        |
| `BitrateMeter`       | Measures each rung's real bitrate, which becomes the master's `BANDWIDTH`        |

## Scripts

| Script           | Description                 |
| ---------------- | --------------------------- |
| `pnpm build`     | Compile TypeScript          |
| `pnpm start`     | Start the server            |
| `pnpm lint`      | Run ESLint                  |
| `pnpm typecheck` | Type check without emitting |
