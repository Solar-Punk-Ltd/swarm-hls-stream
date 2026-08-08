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

Append `?level=<rung>` to a stream watcher URL to pin playback to one rung (`?level=720p`), or `?level=auto` to hand the choice to hls.js's ABR. A stream with no ladder ignores the parameter and plays its single rendition as before.

## Custom hls.js Loaders

Standard hls.js expects static manifest URLs. On Swarm, every manifest update produces a new content hash. The client solves this with custom loaders:

1. **CustomManifestLoader** — Instead of fetching a static URL, performs a Swarm Feed lookup to get the latest manifest. Proactively fetches the next feed index for caching.
2. **CustomFragmentLoader** — Resolves segment references from the manifest (which contain Swarm hashes) into fetchable blob URLs via the configured Bee node.
3. **ManifestStateManager** — Merges incoming live manifests into a growing EVENT-type playlist so segments remain available longer than the sliding window. Tracks feed indices, handles deduplication, and caches serialized output.

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
