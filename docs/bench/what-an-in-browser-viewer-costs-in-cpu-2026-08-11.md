# What an in-browser viewer costs in CPU, n=3, and its one thread is the ceiling

**2026-08-11.** Three headless runs against `abel-1` on a 12-core Apple Silicon Mac, driven by
`run-sustain-headless.mjs`. **Cost: nothing.** No gateway, no broadcast, no encoder, no postage, and
an unfunded in-browser node that cannot spend. `abel-1` is VOD, so this is repeatable on demand.

Every CPU figure this project held was a **bee** figure, read off one PID by
`retrieval-debt-probe.sh`. The in-browser mode had none at all, and the browser was outside every
number in [what a viewer node costs](what-a-viewer-node-costs-in-cpu-2026-08-08.md) as well. This
closes the first of those two gaps.

## ⭐ The answer: about nine tenths of a core, and it is spent on one thread

| run | minutes | **steady cores** | **main thread** | delivered | ratio | stalls |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| validation | 3 | **1.046** | **0.672** | 997 KB/s | 0.9796 | 2 |
| run 1 | 12 | **0.973** | **0.752** | 1003 KB/s | 0.9851 | 2 |
| run 2 | 12 | **0.785** | **0.543** | 1014 KB/s | 0.9960 | 0 |

⭐ **0.79 to 1.05 cores of total Chrome CPU at 8.34 Mbps, n=3.** Quote the range. The three runs
delivered within 1.7% of the same bytes and their CPU spread is 33%, so a single figure from one
sitting would have been up to 13% off in either direction.

⭐⭐ **The main thread is at 0.54 to 0.75 while that happens, and that is the ceiling, not the core
count.** The machine is under 9% of twelve cores and weeb-3 is already using half to three quarters
of the only thread it has. Spare cores on the host buy a viewer nothing. weeb-3's concurrency ceiling
was known to be emergent rather than configured, with no cap on the retrieval path, and this is the
first direct measurement of what produces it: **at 8.34 Mbps a browser node is within about 1.4x of
saturating its own thread**, so the headroom above the shipping profile is real but not large.

⚠️ The service worker is a separate CDP target and is **not** in the main-thread column. It **is** in
the core count, which is measured off the process tree. weeb-3 serves HLS through that worker, so the
two columns must be read together and the thread figure is a floor.

## ⭐⭐ Startup is cheap here, and that is the opposite of the gateway

| window | run 1 | run 2 |
| --- | ---: | ---: |
| idle, `about:blank` | 0.153 | 0.127 |
| **startup, to first frame** | **0.256** | **0.311** |
| steady, playing | 0.973 | 0.785 |

⭐ **Dialing 160 bootnodes to a full 200-peer table costs about a quarter of a core for twenty
seconds.** A [cold bee gateway](a-cold-gateway-is-idle-long-before-it-is-cheap-2026-08-09.md) burned
**14x** its settled rate over the same window. The browser node's expensive phase is retrieval and
decode, not joining, and a deployment does not need to warm one.

⚠️ An empty headless Chrome already costs 0.13 to 0.16 cores. Net of that floor the page itself is
**0.63 to 0.89 cores**, and which of the two numbers is right depends on whether the viewer would
have had a browser open anyway.

## ⚠️ A question this raises and cannot answer: the cheapest run played the best

Run 2 used **19% less CPU than run 1** and **43% less main thread**, delivered **1% more bytes**, and
was the only run with **zero stalls**. More CPU bought worse playback, twice.

That is the shape the unfunded gateway made, where CPU went on peer selection that never produced a
byte, and it is consistent with a browser node paying for retries rather than for delivery. **It is
not a mechanism, it is three points with a consistent direction**, and n=3 does not get a mechanism.
What would settle it is the per-peer retry counters weeb-3 already keeps, read at the same cadence.

## The instrument

⭐⭐ **The process tree is the measurement, not the PID.** Chrome runs a browser process, a GPU
process, one renderer per site and utilities. Sampling the PID we spawn would report the cost of
supervising the work. `chrome-cpu.mjs` descends from that PID instead, which also means the
operator's own Chrome cannot be charged to the run, as a match on the executable name would have
done silently.

⭐ **Two readings because there are two ceilings.** The tree says how many cores a viewer eats.
`Performance.getMetrics` says whether the one thread is out of headroom. A run can be comfortable on
the first and finished on the second.

⭐ **The idle window is the null control**, taken on `about:blank` after Chrome is up and before
anything is navigated to. It is the only moment a caller cannot reach, so `withPage` takes it.

## ⛔ What this does not say

⛔⛔ **These are Apple Silicon cores. Every bee CPU figure this project holds is from the 48-core
Linux host.** A core is not a core across those two, and the browser figure includes video decode and
the player while the bee figures are pure retrieval. Per MB the browser lands at **0.77 to 1.05
CPU-s/MB** against a light gateway's 1.26 to 1.31 and an ultra-light's 3.32 to 3.75, which is
suggestive and **must not be put in a shared table** until one machine has run both.

⚠️ **One stream, one shape.** 4.14 MB segments at 8.34 Mbps. The shipping 1.0s profile at 6000 kbps
is a different segment size and is still unmeasured for CPU, as it is for everything else.

⚠️ **VOD, not the live edge**, and one machine. Nothing here says what a second concurrent browser
node would cost, and it cannot: two weeb-3 nodes starve each other's peer table.

⚠️ **The printed verdict reads DOES NOT SUSTAIN on all three.** The bar is 0.999 and it charges
startup against the stream. See
[the sustain result](abel-sustain-result-2026-08-11.md) for why that threshold, not the stream, is
what fails.
