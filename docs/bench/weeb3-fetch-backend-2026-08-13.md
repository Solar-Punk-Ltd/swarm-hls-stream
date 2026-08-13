# A segment fetched by a Swarm node in the viewer's own tab

**2026-08-13. Phase A of task #92, plus the free real-browser check that phase A2 was going to be.**
Cost nothing: no broadcast, no postage, no BZZ.

## What shipped

`VITE_BROWSER_FETCH_BACKEND` selects where the player gets **segment bytes**: `gateway`, which ships
and stays the default, or `weeb3`, a Swarm node running inside the viewer's tab. The catalog, the feed
and every manifest still travel through the viewer's gateway on both paths, so an arm differs from the
gateway arm in one thing rather than two.

⛔ Deliberately **not** `attachStream`. weeb-3 ships a complete HLS path of its own, and using it would
measure weeb-3's player instead of ours, which is what made #44's headline unusable.

## ⛔⛔⛔ The finding: weeb-3 returns the Swarm span and a gateway does not

`retrieveBytes` hands back the payload with its **8-byte little-endian length prefix still attached**.
A gateway's `/bytes/<ref>` does not. Handing those bytes to hls.js unchanged puts eight bytes of
length header in front of the transport stream, and the demuxer never finds a valid first packet.

Measured in Chrome against four references from the decay cohort that the gateway had served the same
day, at three different sizes:

| reference | gateway | `retrieveBytes` | delta | uint64 LE at offset 0 |
| --- | ---: | ---: | ---: | ---: |
| `7773f81c` | 818,740 | 818,748 | +8 | **818,740** |
| `45b83ac1` | 819,116 | 819,124 | +8 | **819,116** |
| `9fdd4c63` | 844,872 | 844,880 | +8 | **844,872** |
| `9b6a51b8` | 820,808 | 820,816 | +8 | **820,808** |

The prefix decodes to the gateway's own byte count every time. The MPEG-TS sync byte `0x47` sits at
offset 8 rather than 0, and the 188-byte packet alignment holds from 8 and not from 0.

⭐ **The fix reads the prefix rather than dropping eight bytes.** The span is self-describing, so it is
stripped only when it accounts for exactly what follows. Dropping eight bytes unconditionally would
corrupt every segment just as badly the day a weeb-3 release stops framing its answer.

### Proven byte for byte, not by length

The same reference, fetched both ways:

| | bytes | first byte | SHA-256 |
| --- | ---: | --- | --- |
| weeb-3 in Chrome, span stripped | 818,740 | `0x47` | `103f1331…c07471ef` |
| gateway `10077` over curl | 818,740 | `0x47` | `103f1331…c07471ef` |

⭐⭐⭐ **This is what a free real-browser run buys.** Twelve stubbed unit tests passed while the backend
was going to feed hls.js a corrupt stream, because a stub returns whatever the stub says. The same
lesson as the nine passing tests over a completely broken gateway script, one week earlier.

## The service worker requirement does not bind this path

The package's README says the embedding page "must be below the `/weeb-3/` scope and serve the
packaged worker at `/weeb-3/service.js`", and the wasm hardcodes both strings. That worker exists to
intercept `/bzz/` **fetches** and answer them from the node, which is how `attachStream` and
`renderInterface` work.

`retrieveBytes` is a direct call that returns bytes, so it should need none of it. Confirmed rather
than assumed: served from `http://127.0.0.1:8901/`, a path nowhere near `/weeb-3/`, the node reached
the network in **5,034ms** and retrieved every reference asked of it. No service worker error appeared.

## ⚠️ Timing: an observation, not a result

Sequential single retrievals, one laptop, node warm about four minutes:

| | ~800 KB segment |
| --- | ---: |
| weeb-3, cold, first retrieval after `ready(1)` | 9,423-10,466 ms |
| weeb-3, warm, uncached, n=4 | **3,185-4,003 ms** (201-251 KB/s) |
| the gateway on the same segments, same day | 1,791-2,343 ms |

⛔⛔ **This does not say weeb-3 is twice as slow for a viewer, and must not be quoted that way.**
It is concurrency 1, and hls.js fetches at 4. This project has already measured a 3.29x advantage at
c1 collapse to 1.26x at c4, on its own content. Whether an in-tab node sustains playback is exactly
what A2 measures and this does not.

⚠️ A repeat of an already-fetched reference returned in **2 ms**, which is weeb-3's own cache and not a
retrieval. Every figure above is a reference the node had never seen.

## ⛔ `networkState()` does not report a peer count

The phase B plan assumed it does. It returns `status`, `mode`, `networkId`, `swarmNetworkId`,
`walletChainId`, `baseSymbol`, `bzzSymbol`, and three bootnode arrays (`bootnodes` 319,
`browserBootnodes` 319, `skippedBootnodes` 0). **No live connection count.**

So phase B's refusal gate cannot report "connected to N peers" from this call. `ready(n, timeoutMs)`
is a usable probe for a threshold, since it answers whether `n` was reached, but it is a predicate
rather than a reading. The 319 matches the entry-point count measured on 2026-08-11, which is the
bootnode list rather than anything this node achieved.

## What the bundle costs

weeb-3 is reached through an `import()` inside a lazily called method, so the bundler splits it out and
a gateway build never fetches it.

| | before | after |
| --- | ---: | ---: |
| entry chunk | 1,000.54 kB | **1,003.28 kB** |
| weeb-3 chunks, fetched only by a weeb3 build | 0 | **4,532.92 kB** (41.37 glue + 4,491.55 wasm) |

`bundle.test.ts` asserts both directions: the entry carries no wasm glue, and some chunk still does.
Without the second case it would pass just as well on a build where weeb-3 was dropped altogether.

## What is still open

- **A2 proper**: our player, end to end, through this backend on recorded content. Needs a client
  redeploy. Everything above is one retrieval at a time, never a playing video.
- **Sustained rate at hls.js's own concurrency**, which is the only question that decides whether this
  is viable.
- **Phase B**, the refusal gate, now needing a peer source that is not `networkState()`.
