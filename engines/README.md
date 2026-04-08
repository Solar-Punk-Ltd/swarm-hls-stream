# Engines

Transcoding engines that produce HLS segments for the [stream-uploader](../packages/stream-uploader/).

Each engine has two parts:

1. **Server config** — lives here under `engines/<name>/` (docker-compose, config files)
2. **Plugin** — lives in the stream-uploader at `packages/stream-uploader/src/engines/<name>.ts`

The plugin registers engine-specific HTTP routes on the uploader's server. No separate process needed — the engine's webhooks call the uploader directly.

## Available Engines

| Engine | Plugin | Description |
|--------|--------|-------------|
| [srs](./srs/) | `ENGINE=srs` | SRT/RTMP ingest via [SRS](https://github.com/ossrs/srs) |

## How It Works

1. The transcoding server (e.g., SRS) receives a stream and produces HLS segments on disk
2. The server sends webhooks to the stream-uploader at `/engines/<name>/` routes
3. The engine plugin reads segments from disk and passes them to the upload pipeline
4. The uploader handles everything else (Swarm upload, manifests, feed management)

## Generic API

The stream-uploader also exposes a generic API that works without any engine plugin:

```
POST /stream/start    { "streamId": "<id>", "mediatype": "video" | "audio" }
POST /stream/segment  Headers: x-stream-id, x-segment-index, x-duration  Body: raw binary
POST /stream/stop     { "streamId": "<id>" }
```

This can be used by any custom integration that sends segment data directly over HTTP.

## Adding a New Engine

1. Add server config: `engines/<engine-name>/` with docker-compose and config files
2. Add a plugin: `packages/stream-uploader/src/engines/<engine-name>.ts`
   - Implement the `EnginePlugin` interface from `engines/types.ts`
   - Register webhook routes that the engine server will call
3. Register it in `packages/stream-uploader/src/index.ts` `loadEngines()`
4. Add the engine's docker service to `deploy/docker-compose.yml`

## Structure

```
engines/
  <engine-name>/
    docker-compose.yml        # Standalone engine server (for dev/testing)
    <config files>            # Engine-specific configuration

packages/stream-uploader/src/engines/
  types.ts                    # EnginePlugin interface
  <engine-name>.ts            # Engine plugin implementation
```
