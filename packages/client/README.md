# Client

React application for browsing and playing HLS streams delivered via the Swarm decentralized network. Part of the [swarm-hls-stream](../../) monorepo.

## Prerequisites

- Node.js 22+
- pnpm
- A running Swarm Bee node (for reading streams)
- A running [stream-uploader](../stream-uploader/) (for producing streams)

## Getting Started

From the monorepo root:

```bash
# Install dependencies
pnpm install

# Create .env from sample (if not done yet)
cp .env.sample .env
# Edit .env — fill in VITE_APP_OWNER, VITE_READER_BEE_URL, etc.

# Start the dev server
pnpm client:start
```

Opens at `http://localhost:5173`.

> **Note:** Both packages share a single `.env` file in the **monorepo root**. See [.env.sample](../../.env.sample) for all available variables.

## Vite Dev Proxy

When `VITE_READER_BEE_URL` points to `localhost` or `127.0.0.1`, the dev server automatically proxies `/bee/*` requests to the Bee node. This avoids CORS issues during local development — no Bee configuration needed.

In production builds or when pointing to a remote gateway, requests go directly to the configured URL. The gateway URL can also be changed at runtime via the UI (DomainSelector in the header).

## Environment Variables (in root `.env`)

| Variable              | Required | Description                                                        |
| --------------------- | -------- | ------------------------------------------------------------------ |
| `VITE_READER_BEE_URL` | Yes      | Bee node URL for fetching streams                                  |
| `VITE_APP_OWNER`      | Yes      | Feed owner address (hex, no 0x prefix)                             |
| `VITE_APP_RAW_TOPIC`  | Yes      | Feed topic for the stream catalog — must match `STREAM_LIST_TOPIC` |

## Features

- **Stream Browser** — Fetches the stream catalog from Swarm feeds, displays up to 10 streams sorted by state (live first) and timestamp
- **Stream Preview** — Thumbnail generation from the first segment, live/VOD badges, duration display
- **HLS Playback** — Video and audio stream playback via custom hls.js loaders
- **Gateway Selector** — Runtime Bee node URL switching via UI modal, persisted to localStorage

## QoE Overlay

Append `?qoe=1` to a stream watcher URL to enable a draggable overlay with playback quality metrics (startup time, rebuffering, bitrate, dropped frames, live latency, etc.). Press `Q` to toggle visibility.

## ABR ladder

A stream published with the SRS ABR ladder is **five feeds**: one media playlist per rung, plus a multivariant playlist — the master — on a feed of its own whose topic is the ladder's group id. The catalog entry's `topic` points at the master, so one URL yields the whole ladder and any Swarm-aware HLS client can consume it, not just this player. The entry also keeps a `renditions` array (one per rung, with its measured bandwidth), which is what lets the UI describe a ladder without fetching anything.

The loader decides what a stream is from what its feed actually answers with, not from a flag: a body containing `#EXT-X-STREAM-INF` is a master, and the rungs it names start being walked before hls.js has parsed it. An entry whose `topic` still points at the lowest rung — written before masters were published — falls back to a master built locally from `renditions`.

Feed URIs use a `swarm://<owner>/<topic>` scheme. That is not cosmetic: hls.js resolves every playlist URI through url-toolkit against the playlist's own URL, and a URI with a scheme is the one case it returns untouched — a bare `owner/topic` comes back as `owner/owner/topic`.

Append `?level=<rung>` to a stream watcher URL to pin playback to one rung (`?level=720p`), which is how you tell a bad rung apart from a bad switch. Without it, hls.js's ABR chooses. A stream with no ladder ignores the parameter and plays its single rendition as before.

### Rungs share a timeline through EXT-X-MEDIA-SEQUENCE

These playlists carry no `EXT-X-PROGRAM-DATE-TIME`, so the sequence number is the only thing telling hls.js that two levels cover the same media. Every rung is transcoded from one source with keyframes forced to the same timestamps, so segment N means the same interval on all of them — and both the uploader and `ManifestStateManager` therefore preserve the _engine's_ sequence number rather than renumbering from zero. Renumbering is right for one playlist read alone and wrong across a ladder: four rungs all claiming to start at 0 while their first segments cover different instants is a switch that lands in a gap.

### Tuning

`DEFAULT_HLS_TUNING` carries the ABR settings, and the ones that differ from hls.js's own defaults do so for one reason: hls.js measures throughput as `bytes / (loading.end - loading.first)`, which over a CDN is a pipe and over Swarm is mostly retrieval latency. So the EWMA half-lives are lengthened well past the defaults to stop that noise becoming level flapping, and the startup bandwidth probe is off because what it measures here is not bandwidth. `abrBandWidthFactor`, `abrBandWidthUpFactor` and `maxStarvationDelay` are exposed at hls.js's defaults so they can be swept without editing the component.

Two settings are load-bearing rather than preferences, because without them the ladder cannot leave its bottom rung at all:

- **`capLevelToPlayerSize: false`.** hls.js caps ABR at the first rung reaching `max(playerWidth, playerHeight) × devicePixelRatio` and enforces it through `autoLevelCapping`, which ABR cannot exceed for any bandwidth. In a 420px-wide player at `devicePixelRatio` 1 that resolves to 640×360 — pinned to 360p permanently, however fast Swarm is answering. The watch page is also laid out full-viewport-width for the same reason: so the top rungs are worth reaching, not merely reachable.
- **Start at the top rung, fall back on evidence.** `findBestLevel` only moves _up_ to a rung when `abrBandWidthUpFactor × bandwidthEstimate ≥ BANDWIDTH`, and the estimate moves only on fragments actually fetched. A viewer pulling 700 kbps segments measures roughly 700 kbps, concludes that is all it can afford, and never tries the rung that would have told it otherwise — the floor is self-fulfilling. So on `MANIFEST_PARSED` the player seeds the estimate at exactly what the top rung needs under the up-switch factor and sets `startLevel` to that rung. The whole ladder is then affordable from cold, and real fragments move the estimate from there: if Swarm keeps up it stays high, and if it does not the EWMA falls while the starvation path drops the level as the buffer drains. The cost is honest — the first fragment is a top-rung fragment, so a slow gateway pays a slower startup before the first down-switch.

### A rung that stops being produced

When one quality stops publishing and the others carry on, the player drops that rung rather than waiting on it. Measured live on 2026-09-01: a viewer watching a dead 1080p rung was on a live one **7.1 seconds later with no freeze at all**, against 87 and 103 seconds of frozen picture before it, and no healthy rung was dropped.

The rule is in `rungHealth.ts` and `feedState.ts`, and three of its properties are each a fix for a live regression rather than a preference. It took eight attempts and the earlier ones amputated healthy rungs.

- **Count delivered segments, never read a clock.** Four attempts judged a rung by how long it had been quiet and three of those shipped a fault, because a clock runs during intervals in which nothing could have been produced: it measures the outage rather than the rung. A whole broadcast stopping freezes every rung's count and leaves the comparison exactly where it was.
- **Compare against a middle rung, never the leader.** A maximum lets one rung running ahead condemn every other one at once, which is how a viewer settled on 1080p ended up with the other three deleted before any fault was injected. The upper middle, so two rungs dying together are still judged against the two that live.
- **Measure each rung's lag from where the ladder stood at its own last delivery**, not between cumulative totals. Rungs are separate transcodes writing separate feeds at slightly different speeds, so cumulative counts drift apart without bound for reasons that are nobody's fault.

`RUNG_DEATH_LAG_SEGMENTS` is 4, twice the widest healthy gap, and `MIN_LEVELS_TO_DROP_ONE` is 2 because the last rung standing is still the only thing a viewer can be offered. The uploader keeps its own copy of this rule in `LadderLiveness`, deliberately a port rather than a second invention, so the master stops advertising the same rung the player stops using. **If one constant moves the other must move with it.**

⛔ It is not reversible. hls.js's `removeLevel` deletes the rung for the session, so a viewer who lives through an outage stays capped until they reload. One attempt to use `autoLevelCapping` instead froze the viewer for 83 seconds and never recovered, and was reverted. The cause is not understood, so reproduce that freeze before trying again.

Fragment loading is started by hand from `MANIFEST_PARSED` (`autoStartLoad: false`) so that seeding happens before the first level is chosen, rather than depending on which of two hls.js controllers registered for `MANIFEST_LOADED` first.

Combine with `?qoe=1` to watch what those settings do: the overlay's ABR section shows the selected rung, hls.js's live bandwidth estimate, and **switch latency** — the time from hls.js committing to a rung until the first fragment of it is buffered. That last number is the one this POC exists to produce.

## Custom hls.js Loaders

Standard hls.js expects static manifest URLs. On Swarm, every manifest update produces a new content hash. The client solves this with custom loaders:

1. **CustomManifestLoader** — Instead of fetching a static URL, performs a Swarm Feed lookup to get the latest manifest. Proactively fetches the next feed index for caching.
2. **CustomFragmentLoader** — Resolves segment references from the manifest (which contain Swarm hashes) into fetchable blob URLs via the configured Bee node.
3. **ManifestStateManager** — Merges incoming live manifests into a growing EVENT-type playlist so segments remain available longer than the sliding window. Tracks feed indices, handles deduplication, and caches serialized output.
4. **LadderFeedPoller** — For ABR streams, owns the feed walk for _every_ rung rather than letting hls.js drive it. A feed is walked one SOC at a time, and hls.js only refreshes the playlist of the level it is playing, so a rung switched away from stops advancing; two minutes later it is ~120 indices behind at the 1.0s segment a four-rung ladder runs (and was ~240 at the 0.5s the ladder used before 2026-09-01) and catches up at one per refresh. The poller keeps all four at the live edge on its own clock, which is what makes a switch cost nothing. Costs four small SOC lookups per segment interval instead of one.

5. **`fragmentRequested` and `fragmentSettled` are a parsed contract, not debug output.** The loaders write those two console lines, `packages/shared/src/clientLog.ts` composes them and owns their wording, and `e2e/src/browser/fragmentRequests.ts` reads them back. They are the only thing that lets a sitting say whether a down-switch the player asked for actually completed or starved. Rewording either one throws nothing and fails nothing: the e2e quality arm's reading simply comes back empty, and the run reports on a viewer it could not see.

## weeb-3 runs in a SharedWorker

Built with `VITE_BROWSER_FETCH_BACKEND=weeb3`, the client fetches segment bytes from a Swarm node
running in the viewer's own tab instead of from a Bee gateway. That node is **not in the page**. From
`@lat-murmeldjur/weeb_3` 0.0.341001 the `Weeb3No103` class is a facade with no node behind it, and
every call it makes, `retrieveBytes` included, is passed to a SharedWorker. **There is no in-page mode
to fall back to**, so if the worker cannot start, a viewer on this backend gets no Swarm at all and the
only symptom is `the in-tab node did not reach the network: SharedWorker request timed out`.

A SharedWorker script has to come from the page's own origin, so the client serves the package's
runtime itself. Four things go into one directory, because they resolve relative to each other:

| Served as                | What it is                                                        |
| ------------------------ | ----------------------------------------------------------------- |
| `/weeb-3/worker.js`      | The worker script. `Weeb3FetchBackend` passes this URL explicitly |
| `/weeb-3/weeb_3.js`      | The wasm-bindgen glue, which `worker.js` imports                  |
| `/weeb-3/weeb_3_bg.wasm` | 3.9 MB of node, which the glue fetches beside itself              |
| `/weeb-3/snippets/**`    | Two files the glue imports by relative path                       |

`scripts/copy-weeb3-runtime.mjs` copies them out of `node_modules` into `public/weeb-3/`, which Vite
copies verbatim into `dist/`. It runs from `prebuild` and `predev`, so a plain `pnpm build` or
`pnpm dev` is enough. The directory is generated and gitignored: the lockfile is the only thing that
says which version a deployment serves, and the copy refuses rather than serving a partial runtime if
a release stops shipping one of the four.

In production `deploy/client-nginx.conf.template` answers `/weeb-3/` off the filesystem with
`try_files $uri =404`. That block is load-bearing. Without it the prefix inherits the SPA fallback,
`worker.js` comes back as the app's own HTML at 200, and the failure surfaces as the timeout above
rather than as a missing file. The nginx image already maps `application/wasm`, which the glue needs
for `WebAssembly.instantiateStreaming`.

The worker URL is origin-absolute, so a deployment under a sub-path has to serve `/weeb-3/` at the
domain root as well.

`/weeb-3/service.js` is deliberately **not** served. It exists for weeb-3's own player via
`attachStream`, which would measure weeb-3's hls.js rather than this client's.

## Project Structure

```
src/
  components/
    Button/               # Reusable button (primary/secondary variants)
    DomainSelector/       # Gateway URL modal
    Icons/                # SVG icon components
    StreamList/           # Stream list display (max 10, sorted)
    StreamPreview/        # Preview card with thumbnail
    SwarmHlsPlayer/       # Core player + custom loaders + manifest state
  layouts/
    Main/                 # Header + content wrapper
  pages/
    StreamBrowser/        # Home — fetches stream catalog, renders list
    StreamWatcher/        # Watch — plays a single stream
  providers/
    App.tsx               # Global state (stream list, gateway URL)
  types/
    stream.ts             # MediaType, StreamState, Stream interface
  utils/
    catalogFeed.ts        # Follows the stream catalog feed by walking slots
    config.ts             # Environment config with auto proxy detection
    fetchWithTimeout.ts   # fetch() with a timeout, returning a timed response
    format.ts             # formatDuration (mm:ss)
    requestJitter.ts      # Gateway request jitter, to desynchronise pollers
    thumbnailManifest.ts  # Preview segment URL for stream thumbnails
```
