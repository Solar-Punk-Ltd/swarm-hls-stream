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

⛔⛔⛔ **`HLS_FRAGMENT` also sets how fast SRS has to announce, and that has a ceiling.** SRS fires
`on_hls` once per closed segment per rung, so a ladder asks for `rungs / HLS_FRAGMENT` announcements
a second. Measured on the deployment host 2026-08-31, SRS sustains about **6.7 a second** while its
own encoders were producing 8.0, and nothing errors when it cannot keep up. Announcements fall behind
the media at 0.46s per second of video until the lag passes `HLS_WINDOW`, after which SRS deletes
each segment before announcing it: the uploader gets a callback naming a file that is already gone,
the tallest rung is unpublished about two minutes in, and the master feed goes on advertising it.

A four-rung ladder therefore runs at `HLS_FRAGMENT=1.0` (4.0/s, verified over 600s with lag flat and
zero segments lost) and **not** the 0.5s that measures best on latency, which asks 8.0/s. A single
rendition at 0.5s asks 2.0/s and is unaffected. ⚠️ The 6.7/s is one measurement on a co-tenanted host,
nothing refuses a ladder that exceeds it, and what SRS spends the time on is not known: the uploader
answers each callback in 1ms.

Verify a running ladder with `curl http://localhost:1985/api/v1/streams`. That is the SRS stats
API on `SRS_HTTP_API_PORT`, which defaults to 1985 and shifts with `--portSlot`, and the deploy
compose now publishes it. Expect five streams (one source, four rungs) and the count _stable_. A
count that keeps climbing is the loop.

Audio is muxed into each rung rather than split into an `EXT-X-MEDIA` rendition group. With
`ABR_ACODEC=copy` the four copies are bit-identical and cost no CPU. Splitting it is the right
production answer and is left as a TODO.

## Your own config file

Everything an engine can do beyond the knobs above is a matter of editing its config file, and both
engines are configured by file alone. SRS reads `srs.conf`, and
[full.conf](https://github.com/ossrs/srs/blob/develop/trunk/conf/full.conf) is the annotated
reference for every directive. OvenMediaEngine reads `Server.xml`, documented in its
[configuration guide](https://airensoft.gitbook.io/ovenmediaengine/configuration). Neither engine has
a configuration web page, and neither API writes configuration.

Set `SRS_CONF_FILE` or `OME_CONF_FILE` in `.env` (or `.env.<profile>`) to the path of a file on the
machine that runs compose, and the deploy mounts it read-only where the engine's entrypoint looks
(`deploy/docker-compose.srs-conf.yml`, `deploy/docker-compose.ome-conf.yml`). The entrypoint then
runs on your file exactly what it runs on the template:

- every `*_PLACEHOLDER` token you keep is filled from the environment, so the passphrase, the ports,
  the webhook token, `HLS_FRAGMENT`, `HLS_WINDOW` and the rest still come from the env knobs and
  never have to be written into the file
- a token you drop is gone, and the env knob behind it stops applying to that deployment
- with the ABR ladder on, `TRANSCODE_PLACEHOLDER` and `ABR_VHOST_PLACEHOLDER` mark where the
  generated transcode block and the rung vhost go. Drop them and the entrypoint warns and inserts
  nothing, which is right only if you wrote the ladder into the file yourself

Start from a copy of the template and edit from there. A file that does not parse takes the engine
down on its next start, so check it first. SRS has a test mode that names the offending line. It
checks values as well as syntax, so a file that still carries the tokens is refused at the first of
them, which on a copy of the template is the bare `TRANSCODE_PLACEHOLDER` at line 57, and a mistake
of yours further down is never reached. Fill the tokens with a stand-in and drop the two bare lines
first:

```bash
sed -E '/^(TRANSCODE|ABR_VHOST)_PLACEHOLDER$/d; s/[A-Z_]+_PLACEHOLDER/1/g' my-srs.conf > my-srs.check.conf
docker run --rm -v "$PWD/my-srs.check.conf:/check/srs.conf:ro" ossrs/srs:6 ./objs/srs -t -c /check/srs.conf
```

The copy that passes is not the file you deploy. The deploy mounts `my-srs.conf` itself, and the
entrypoint fills its tokens from the environment. Measured 2026-09-07 on `ossrs/srs:6` at 6.0.184: a
copy of the template is refused at line 57, the filled copy passes, and a misspelt `hls_window` in
the filled copy is named.

OvenMediaEngine has no test mode. Its log names the element it refused.

The file is read when the container starts, so a change needs the engine recreated
(`deploy.sh --profile <p> srs`), and a template change upstream does not reach a deployment that
runs on a file of its own.

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
   - Implement the `EnginePlugin` interface from `packages/stream-uploader/src/engines/types.ts`
   - Register webhook routes that the engine server will call
3. Register it in `packages/stream-uploader/src/engines/registry.ts` (`engineRegistry`), which is what `loadEngines()` reads
4. Add the engine's docker service to `deploy/docker-compose.yml`

## Structure

```
engines/
  <engine-name>/
    docker-compose.yml        # Standalone engine server (for dev/testing)
    <config files>            # Engine-specific configuration

packages/stream-uploader/src/engines/
  types.ts                    # EnginePlugin interface
  registry.ts                 # engineRegistry — maps an engine name to its plugin factory
  load.ts                     # loadEngines() — builds the configured engine's plugins
  <engine-name>.ts            # Engine plugin implementation
```
