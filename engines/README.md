# Engines

Transcoding engines that produce HLS segments for the [stream-uploader](../packages/stream-uploader/).

Each engine has two parts:

1. **Server config** — lives here under `engines/<name>/` (docker-compose, config files)
2. **Plugin** — lives in the stream-uploader at `packages/stream-uploader/src/engines/<name>.ts`

The plugin registers engine-specific HTTP routes on the uploader's server. No separate process needed — the engine's webhooks call the uploader directly.

## Available Engines

| Engine        | Plugin       | Description                                                                                                  |
| ------------- | ------------ | ------------------------------------------------------------------------------------------------------------ |
| [srs](./srs/) | `ENGINE=srs` | SRT/RTMP ingest via [SRS](https://github.com/ossrs/srs)                                                      |
| [ome](./ome/) | `ENGINE=ome` | SRT ingest via [OvenMediaEngine](https://github.com/AirenSoft/OvenMediaEngine); uploader pulls HLS over HTTP |

## How It Works

1. The transcoding server (e.g., SRS) receives a stream and produces HLS segments on disk
2. The server sends webhooks to the stream-uploader under `/engines/<name>/`, at paths the engine chooses: `/engines/srs/streams` and `/engines/srs/hls` for SRS, `/engines/ome/admission` for OME. Only the prefix is generic
3. The engine plugin reads segments from disk and passes them to the upload pipeline
4. The uploader handles everything else (Swarm upload, manifests, feed management)

## ABR ladder (SRS only)

Set `ABR_ENABLED=true` in the root `.env` and SRS produces four renditions instead of one. The
uploader and SRS both read this knob, and for a Docker deployment only the root `.env` reaches
both, because compose interpolates each service's copy from it. Setting it in `engines/srs/.env`
turns the ladder on for SRS while the uploader keeps it off and publishes four unrelated streams.
Each rung is a stream in its own right, so the flow above is unchanged, it just happens four times,
and the uploader gets four feeds it groups back into one ladder.

The uploader then writes a fifth feed: the ladder's **master playlist**, a multivariant playlist
naming the four rung feeds, on a topic that _is_ the ladder's group id. The catalog entry points at
that, so one URL yields the whole ladder. It is rewritten whenever a rung's measured bandwidth
drifts, and always before the catalog entry referring to it — the other order would publish an
entry whose topic resolves to nothing.

```
                     transcode (4x ffmpeg)         republish, RTMP 127.0.0.1
SRT ingest ──▶ __defaultVhost__ ──────────────▶ vhost abr ──▶ HLS + webhooks ──▶ uploader
               hls: off                         no transcode
```

Two things about this shape are load-bearing:

**The second vhost is what stops a transcode loop.** Transcode scope is matched at vhost, app and
stream level and the matches are cumulative (`parse_scope_engines` in SRS's `srs_app_encoder.cpp`).
A rung republished into the vhost that transcodes matches the same rule and gets transcoded again,
and so does _its_ output. A vhost with no transcode block terminates that. If `?vhost=` ever fails
to match, SRS silently falls back to `__defaultVhost__` and the loop starts — which is why the
ingest vhost keeps its webhooks even though it segments nothing, so the uploader can see a
rendition arrive on the wrong vhost and say so.

**Every rung must cut segments at the same media timestamps.** `ABR_FPS x HLS_FRAGMENT` is the GOP
and has to be a whole number of frames; the entrypoint refuses to start rather than round it,
because a fractional GOP drifts the rungs apart and every switch then lands mid-GOP.

Verify a running ladder with `curl http://localhost:1985/api/v1/streams`. That is the SRS stats
API on `SRS_HTTP_API_PORT`, which defaults to 1985 and shifts with `--portSlot`, and the deploy
compose now publishes it. Expect five streams (one source, four rungs) and the count _stable_. A
count that keeps climbing is the loop.

Audio is muxed into each rung rather than split into an `EXT-X-MEDIA` rendition group. With
`ABR_ACODEC=copy` the four copies are bit-identical and cost no CPU. Splitting it is the right
production answer and is left as a TODO.

## Generic API

The stream-uploader also exposes a generic API that works without any engine plugin:

```
POST /stream/start    { "streamId": "<id>", "mediatype": "video" | "audio" }
POST /stream/segment  Headers: x-stream-id, x-segment-index, x-duration  Body: raw binary
POST /stream/stop     { "streamId": "<id>" }  Answered 202, drains in the background
GET  /stream/status   ?streamId=<id>              live | draining | finalized | failed

All four require `Authorization: Bearer $API_AUTH_TOKEN`. There is no unauthenticated mode:
every accepted segment spends postage stamp money, so an open write endpoint drains the batch.
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
