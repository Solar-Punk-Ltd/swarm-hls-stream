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

| Variable            | Description                         |
| ------------------- | ----------------------------------- |
| `BEE_URL`           | Bee node API URL                    |
| `STAMP`             | Postage stamp ID (`pnpm stamp:setup`) |
| `STREAM_KEY`        | Private key (hex) for signing feeds |
| `STREAM_LIST_TOPIC` | Feed topic for the stream catalog   |

**Optional:**

| Variable              | Default   | Description                               |
| --------------------- | --------- | ----------------------------------------- |
| `MANIFEST_ACCESS_URL` | _(empty)_ | Base URL for segment refs in manifests    |
| `API_PORT`            | `3000`    | HTTP API port                             |
| `STATE_DIR`           | `./state` | Directory for crash recovery state        |
| `MAX_QUEUE_SIZE`      | `100`     | Max queued segments per stream            |
| `RECOVERY_TIMEOUT`    | `60000`   | Crash recovery timeout (ms)               |
| `ENGINE`              | _(empty)_ | Engine plugin to load (`srs` or empty)    |
| `MEDIA_PATH`          | `./media` | Path where the engine writes HLS segments |

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

### SRS Engine

When `ENGINE=srs`, SRS webhook endpoints are mounted:

| Endpoint                    | Description                                    |
| --------------------------- | ---------------------------------------------- |
| `POST /engines/srs/streams` | Handles `on_publish` / `on_unpublish` webhooks |
| `POST /engines/srs/hls`     | Handles `on_hls` webhook (new segment ready)   |

SRS writes segments to the shared media volume. The uploader reads segments from disk, uploads to Swarm, and deletes the file after upload.

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

Currently supported: **SRS** (SRT/RTMP to HLS).

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

## Project Structure

```
src/
  api/
    server.ts              # Express app setup, middleware, engine + route mounting
    routes/
      health.ts            # GET /health
      stream.ts            # POST /stream/{start,segment,stop}
    middleware/
      asyncHandler.ts      # Async error wrapper for Express
      errorHandler.ts      # Structured error responses (ApiError)
      requestLogger.ts     # HTTP request logging
      notFound.ts          # 404 handler
  engines/
    types.ts               # EnginePlugin interface
    srs.ts                 # SRS webhook handlers
  libs/
    StreamOrchestrator.ts  # Stream lifecycle + queue + recovery
    StreamUploader.ts      # Per-stream Swarm upload session
    StreamCatalog.ts       # Stream directory feed
    RecoveryStore.ts       # State persistence
    ManifestManager.ts     # HLS manifest builder
    Logger.ts              # Logging
    ErrorHandler.ts        # Error handling
  types.ts                 # Shared types and constants
  utils/
    config.ts              # Environment config
    common.ts              # Utility functions
  index.ts                 # Entry point
```

## Scripts

| Script           | Description                 |
| ---------------- | --------------------------- |
| `pnpm build`     | Compile TypeScript          |
| `pnpm start`     | Start the server            |
| `pnpm lint`      | Run ESLint                  |
| `pnpm typecheck` | Type check without emitting |
