# What a full disk costs a broadcast

**2026-08-09.** Phase 2.6, the last of the missing crash scenarios, driven end to end against a real
`ENOSPC` for the first time. **Cost: nothing.** No postage, no BZZ, no broadcast minutes.

## The premise was stale, and the answer is the opposite of the worry

The roadmap ranked this as *"`ENOSPC` appears in uploader unit tests. `persistState` swallows it, which
is the quietest way to lose a broadcast."*

✅ **It is no longer quiet.** A failed write sets `statePersistFailedAt`, which reaches
`getHealthSignals()` and raises `HEALTH_REASON_STATE_NOT_PERSISTED` **with no threshold**, so `/health`
degrades on the very first failure. What had never been shown is that this fires under a **real**
filesystem `ENOSPC` rather than the injected error the unit tests use.

## Measured

Two arms against the same process, differing only in free space:

| | **arm A**, space available | **arm B**, 0 bytes free |
| --- | --- | --- |
| recovery entry written | ✅ yes | ⛔ **no** |
| `msSinceStatePersistFailed` | `null` | **3150** |
| `/health` reasons | `segment_upload_failure` | `segment_upload_failure`, **`state_not_persisted`** |
| in the log | — | `Failed to persist state for live/armB: Error: ENOSPC: no space left on device, write` |

⭐ **`segment_upload_failure` appears in both arms**, because the probe deliberately runs against an
unusable stamp so no upload can succeed and nothing can be spent. That is what makes the reading
attributable: the only reason that moves between the arms is the one being tested.

## ⛔ The product consequence, which is what a scale reader needs

**The broadcast keeps running.** It ingests, it tries to upload, and it does all of that with **no
recovery entry on disk**. So `state_not_persisted` does not mean "something failed a moment ago", it
means **a crash from this point loses this broadcast entirely** — there is nothing to recover it from.

Treat it as a page, not a warning. It is one of the few signals whose damage is entirely in the future
and arrives whole.

## How it was run without touching anything

⛔ **The obvious approaches are all unsafe here.** The uploader runs as **root**, so permissions cannot
make its state directory unwritable. `STATE_DIR` is a **volume mount point**, so it cannot be swapped
for a file. And filling that volume would fill the **host disk**, on a machine carrying forty other bee
nodes and five other compose projects.

⛔ Pointing the deployed uploader at an empty state directory is also out: the same directory holds the
catalog feed index, and `CatalogIndexStore`'s own comment says losing it is exactly the fork that class
exists to prevent.

⭐ **So the probe is a throwaway container, not the deployment.** The uploader's own image, run with:

- a **1 MB tmpfs** at `/app/state`, so "full" is bounded by a megabyte of RAM and the host disk is never
  involved
- a **freshly generated signer key** and its own list topic, so it cannot reach the real catalog feed
  even if everything else went wrong
- an **unusable stamp**, so no upload can succeed and nothing can be spent
- `BEE_URL` pointed at the gateway, whose only job here is the one feed read at startup, which is a
  not-found and therefore free

`persistState` runs on the segment **failure** path as well as the success path, so a broadcast that
cannot upload anything still exercises it. That is what makes the whole scenario free.

## ⭐ Two ways this nearly read as a pass

**The first arm wrote no entry and I nearly filled the disk anyway.** `on_publish` alone does not
persist; only handling a segment does. Without arm A there would have been no entry in either arm, no
`state_not_persisted`, and the conclusion would have been "the signal does not fire" — the exact
opposite of the truth.

**And the first fill was not full.** `df` reported 100% and 0 available while **3.7 KB** remained, which
is plenty for a 311-byte recovery entry, so the write succeeded and the arm looked clean. Filling until
`dd` itself fails is what produced a genuine `ENOSPC`. ⛔ **A percentage is not a measurement of free
space. Read the bytes.**
