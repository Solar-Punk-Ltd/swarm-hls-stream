# Client

React application for browsing and playing HLS streams delivered via the Swarm decentralized network. Part of the [swarm-hls-stream](../../) monorepo.

## Prerequisites

- Node.js 20+
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
pnpm dev
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

A stream published with the SRS ABR ladder carries a `renditions` array in the catalog: one entry per rung, each with its own feed topic and its measured bandwidth. The player turns that into a multivariant playlist locally — the master is four URIs that never change, so it is built rather than fetched, and no fifth feed exists for it.

Feed URIs use a `swarm://<owner>/<topic>` scheme. That is not cosmetic: hls.js resolves every playlist URI through url-toolkit against the playlist's own URL, and a URI with a scheme is the one case it returns untouched — a bare `owner/topic` comes back as `owner/owner/topic`.

Append `?level=<rung>` to a stream watcher URL to pin playback to one rung (`?level=720p`), which is how you tell a bad rung apart from a bad switch. Without it, hls.js's ABR chooses. A stream with no ladder ignores the parameter and plays its single rendition as before.

### Tuning

`DEFAULT_HLS_TUNING` carries the ABR settings, and the ones that differ from hls.js's own defaults do so for one reason: hls.js measures throughput as `bytes / (loading.end - loading.first)`, which over a CDN is a pipe and over Swarm is mostly retrieval latency. So the EWMA half-lives are lengthened well past the defaults to stop that noise becoming level flapping, the startup bandwidth probe is off because what it measures here is not bandwidth, and the cold-start estimate is seeded mid-ladder rather than at hls.js's 500 kbps. `abrBandWidthFactor`, `abrBandWidthUpFactor` and `maxStarvationDelay` are exposed at hls.js's defaults so they can be swept without editing the component.

Combine with `?qoe=1` to watch what those settings do: the overlay's ABR section shows the selected rung, hls.js's live bandwidth estimate, and **switch latency** — the time from hls.js committing to a rung until the first fragment of it is buffered. That last number is the one this POC exists to produce.

## Custom hls.js Loaders

Standard hls.js expects static manifest URLs. On Swarm, every manifest update produces a new content hash. The client solves this with custom loaders:

1. **CustomManifestLoader** — Instead of fetching a static URL, performs a Swarm Feed lookup to get the latest manifest. Proactively fetches the next feed index for caching.
2. **CustomFragmentLoader** — Resolves segment references from the manifest (which contain Swarm hashes) into fetchable blob URLs via the configured Bee node.
3. **ManifestStateManager** — Merges incoming live manifests into a growing EVENT-type playlist so segments remain available longer than the sliding window. Tracks feed indices, handles deduplication, and caches serialized output.
4. **LadderFeedPoller** — For ABR streams, owns the feed walk for *every* rung rather than letting hls.js drive it. A feed is walked one SOC at a time, and hls.js only refreshes the playlist of the level it is playing, so a rung switched away from stops advancing; two minutes later it is ~80 indices behind and catches up at one per refresh. The poller keeps all four at the live edge on its own clock, which is what makes a switch cost nothing. Costs four small SOC lookups per segment interval instead of one.

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
    bee.ts                # makeFeedIdentifier (keccak256)
    config.ts             # Environment config with auto proxy detection
    fetch.ts              # retryAwaitableAsync utility
    format.ts             # formatDuration (mm:ss)
```
