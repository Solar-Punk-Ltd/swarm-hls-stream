# The crash scenarios nobody had run

**2026-08-09.** Phase 2.3 through 2.7, the five recovery faults this project has listed as missing
since the roadmap was written and never built a harness for. Four are now scenarios in
`e2e/suites/scenarios/`. The fifth is not, deliberately, and the reason is below.

**⭐ Three of the five premises were wrong, and checking them is what made the work affordable.** The
roadmap priced this phase at 60 broadcast-minutes as five browser runs. Four of the five questions are
uploader-side, answerable from the uploader's own log on a stream a few segments long, so the harness
is a suite scenario rather than a watched viewer and the whole phase costs single-digit minutes.

## ⭐⭐ The phase priced at 60 broadcast-minutes costs about two

Measured on the uploader's own chequebook across one full pass of all four scenarios, six publish
sessions, 385 seconds wall clock:

| | |
| --- | ---: |
| uploader `availableBalance` before | 23,238,377,999,972,800 PLUR |
| after | 23,064,490,999,972,700 PLUR |
| **spent** | **173,887,000,000,100 PLUR = 0.0174 BZZ** |
| postage buckets | **151 → 151, no movement at all** |

**Two passes in total**, because the first found four defects in the scenarios themselves. End to end
23,238,377,999,972,800 → **22,881,633,999,971,500**, so **0.0357 BZZ for the whole phase including a
wasted pass**, and postage never moved off 151 of 256.

At the 720p 1.0s rate of 0.0127 BZZ/min that is **1.37 minutes of publishing**, which matches six short
sessions. ⭐ **The estimate was 60 broadcast-minutes, roughly 1.0 BZZ. The real figure is about 60x
smaller**, because the estimate assumed five browser runs at 45s settle plus fault plus 60s recovery
each, and four of the five questions are uploader-side and need only enough segments to have a stream.

⚠️ **The lesson is not "estimates are pessimistic".** It is that **the cost of a measurement is set by
the instrument it needs, not by the question it asks**, and the instrument was chosen by whichever one
happened to be in front of me when the phase was written. Asking "does this need a viewer?" before
pricing is what moved this by two orders of magnitude. Related: `docs/bench/` on the archived-request
corpus, which is the same move applied to retrieval.

## What the premises actually were

| # | the roadmap's premise | what the code says |
| --- | --- | --- |
| **2.3** | "the one window where the entry is gone and the VOD is not published" | ⛔ **Backwards.** `finalize` deletes the entry **last**, after the catalog write. The window is a recording **bought twice**. |
| **2.5** | "`readinessFromPersisted` has a documented repair path" | ⛔ **The repair is the safe path.** An **unparseable** entry is deleted on the next boot, and that is the loss. |
| **2.6** | "`persistState` swallows it, the quietest way to lose a broadcast" | ⛔ **Stale.** It raises `HEALTH_REASON_STATE_NOT_PERSISTED` with **no threshold**, so `/health` degrades on the first failed write. |
| 2.4 | "nothing tests all of them together" | ✅ True, and sharper than stated: see below. |
| 2.7 | "exactly the shape unit tests model badly" | ✅ True. |

### 2.3, read out of `StreamUploader.finalize` rather than out of the plan

The order is: closing live manifest, VOD manifest, catalog entry, `recordStreamFinalized`,
`clearRecoveryEntry`. **The entry goes last.** So a crash cannot leave the entry gone with nothing
published, which is what the roadmap ranked it for.

What it can leave is the reverse, and that is worse than the description it replaces:

- **killed after the VOD manifest commits, before the catalog names it** — the recording is uploaded
  and **paid for**, the catalog still says `live`, and the entry is still on disk. The next boot
  recovers a finished broadcast and finalizes it again, buying a **second** VOD manifest at a higher
  feed index. The catalog names the newer one and the first sits in the feed, bought and unreachable.
- **killed after the catalog says `vod`, before the entry is cleared** — the entry outlives the
  broadcast it describes.

Both end at one question, which is what scenario H asserts: **after the restart, is there exactly one
recording, and does the catalog point at it?**

### 2.4 is a race, not a restart

Every fault this suite injects takes one service away while everything else stays healthy, and the
recovery path quietly depends on that. A reboot holding a recovery entry restores the stream and arms a
**60 second timer**, and finalizing means **uploading a VOD manifest through bee-uploader**.

In every existing scenario bee-uploader has been up for days by then. In a host reboot it is starting
cold at the same moment, and a bee node needs tens of seconds before it accepts an upload. ⭐ **The
recovery deadline and the storage dependency race, and nothing had ever run them against each other.**
The failure that produces is the expensive kind: the broadcast is over, the recording is all that is
left of it, and it is lost at the moment the operator believes the restart worked.

### 2.5's dangerous door is the one nobody checked

`recoverStreams` sorts a bad entry three ways and they do not share a path:

| on disk | what happens | what it costs |
| --- | --- | --- |
| **unparseable** | `RecoveryStore.load` returns null, entry **deleted** | ⛔ the recording, silently |
| parseable, no `streamId` | skipped, **never deleted** | nothing, correctly |
| announce-before-segment | **repaired** to `SEGMENT_READY`, loudly | one extra `addStream` |

⛔ **A broadcast whose entry cannot be parsed is not recovered and not left for a human to look at.**
It is removed on the next boot, so the recording is gone and the catalog goes on saying `live` forever.
**That is the same end state the repair path was written to avoid**, reached through the door nobody
checked.

Scenario J reports this rather than asserting it. A test that asserted the recording is lost would
freeze a defect into the suite as though it were a requirement.

## What the runs found

| scenario | | result |
| --- | --- | --- |
| **H** (2.3) | killed inside `finalize` | ✅ **one recording.** 1 catalog write before the reboot, 1 in total, no entry left, catalog names it |
| **I** (2.4) | whole-stack restart | ✅ **the recording survives.** Finalized through a bee node that restarted with the uploader |
| **J** (2.5) | corrupt or hand-edited entry | ✅ **repaired, and the loss confirmed.** See below |
| **K** (2.7) | reconnect during drain | ✅ **two recordings, two topics**, and the live session keeps its own recovery entry |

### ⛔⛔ J confirmed the loss, live

    J: truncated entry live_stream — removed on boot: true, broadcast finalized: false

**An unparseable recovery entry is deleted on the next boot and the broadcast is never finalized.** The
recording is gone, and the catalog entry it left behind goes on saying `live` forever. Predicted by
reading `recoverStreams`, then demonstrated end to end against the real deployment.

The other two shapes behave correctly and are now asserted rather than assumed: the illegal
announce-before-segment pair is repaired loudly and the stream still finalizes, and a parseable
non-stream file planted in the same directory is skipped and **not** deleted.

⚠️ **This is reported, not asserted as a requirement.** A test that asserted the recording is lost
would freeze the defect into the suite. What the scenario asserts is that the failure is at least
logged, since nothing else notices it.

### ⚠️ H caught the clean ordering, not the narrow window, and it says so

The run reported `finalize completed before the kill landed`. The trigger is a log line read over ssh,
and the two steps after that line finish inside one round trip.

⭐ **That is itself the useful number: the dangerous window is narrower than a network round trip.** It
bounds the exposure to a few milliseconds rather than leaving it unquantified. Hitting it reliably
needs a fault injected **inside** the process, not from outside the container, so it is a unit-level
question wearing an end-to-end costume.

⭐ **The scenario reporting which case it caught is what makes this readable.** A version that asserted
the same things without saying which window it landed in would have passed identically and been quoted
as "the mid-finalize crash is covered".

## ⏸ 2.6 is the one not built, and it is not a scheduling decision

Its premise is stale, above. Beyond that, **the faithful injection is the expensive kind**: the
uploader runs as **root**, so permissions cannot make its state directory unwritable, and `STATE_DIR`
is a volume mount point, so it cannot be replaced with a file. A genuine `ENOSPC` needs the container
recreated with a bounded tmpfs, which mutates a deployment shared with the rest of this measurement
programme.

⛔ **Filling the volume is not an option.** It is backed by the host disk, and the host carries forty
other bee nodes and five other compose projects.

What is left unproven is a **confirmation rather than a discovery**: that the health reason fires under
a real `ENOSPC` rather than the injected error the unit test already uses. Worth doing on a disposable
deployment, not on this one.

## ⛔ Four defects in these scenarios, found by running them, and three are one shape

The first pass failed two of four, and none of the failures was in the product.

| | what was wrong |
| --- | --- |
| **H** | waited for `activeStreams === 0` after the reboot, **which is already true in the first poll**, before `recoverStreams` had registered anything. Every assertion after it read the state *before* recovery |
| **J** | left the publisher running across the restart. Segments resume, `handleSegment` cancels the recovery timer, the stream correctly stays live, and the finalize it waited for **could never happen** |
| **J** | stamped its log window **after** `docker start` returned, so the boot lines it asserts on were already written when the window opened |
| harness | `discoverCatalogFeed` read the last 1000 log lines. Inside a full suite that always works because each scenario publishes just before the next one looks. **On its own against an idle deployment it failed in `before()`** without reaching anything under test |

⭐⭐ **Three of the four are one shape: a check whose answer sits at the value it starts from.** An idle
count that begins at zero, a log window that begins empty, a wait that begins satisfied. Each would have
passed on a broken product, and two of them did pass locally in the sense that nothing complained until
the scenario met a real deployment.

⭐ **The harness defect had been there the whole time and no run could have exposed it**, because
nothing had ever run one scenario on its own. A suite whose members quietly prepare each other's
preconditions is a suite that only works as a whole, and nothing says so until you take one out.

## The harness

`e2e/src/harness/uploaderState.ts`. A recovery entry only means anything across a restart, so every
scenario that tests one has to read or change it in exactly the window where the process that owns it
is stopped. `docker exec` cannot enter a stopped container, so the state volume is mounted into a
throwaway container running the uploader's own image, which pulls nothing.

⭐ **The volume is discovered by looking up which mount contains the container's own `STATE_DIR`**,
rather than constructed from the project name. On a host shared with five other compose projects a
volume named by convention is a guess, and a guess that matched another stack's naming would be a fault
injected into somebody else's deployment.
