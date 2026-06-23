# Segment sizing & PAC alignment

HLS segments are uploaded to Swarm one `.ts` file at a time
([`StreamUploader.handleSegment`](../packages/stream-uploader/src/libs/StreamUploader.ts)).
The size of each segment determines how efficiently and reliably Swarm's
erasure coding protects it. The target is **one full PAC: 476 KiB**.

## Why 476 KiB

Swarm stores data in 4096-byte chunks. A **Packed Address Chunk (PAC)** is one
chunk holding up to 128 child references (`4096 / 32 = 128`), so it covers up to
128 data chunks. Under **MEDIUM** erasure coding (`redundancyLevel: 1`,
unencrypted) a full group is split **119 data + 9 parity = 128**:

```
119 data chunks × 4096 bytes = 487,424 bytes = 476 KiB
```

A segment that fits in **exactly one PAC** is optimal in two independent ways:

1. **Lowest overhead.** Parity count steps with the data size; a full group
   (95–119 data chunks) sits at the minimum **7.6%** overhead. Smaller groups
   pay proportionally more parity.
2. **Undiluted reliability.** The six-nines (10⁻⁶) retrieval guarantee is a
   budget **per PAC**. A segment spanning `s` PACs degrades to `P_fail ≈ s · 10⁻⁶`.

So one PAC is simultaneously the cheapest per byte and the largest unit that
still carries the full guarantee. **Crossing it is penalized twice** — more
overhead *and* worse reliability — which is why 476 KiB is a ceiling we approach
from below, never exceed.

## How we hit it

Media engines (SRS, OME) segment HLS by **time**, not by byte size — segment
size is just `bitrate × duration`. We get to one PAC with two levers:

### 1. Encoder side — keep raw segments under 476 KiB

Choose a CBR bitrate and segment duration whose product stays below 476 KiB:

```
bitrate_bps × duration_s = 487,424 × 8 ≈ 3.9 Mbit
  duration 2 s → ~1.9 Mbps CBR
  duration 4 s → ~0.95 Mbps CBR
```

OME can enforce this with its transcoder (`OutputProfile` + `SegmentDuration`).
SRS in the default config is pass-through, so the publisher's bitrate must
already satisfy the budget. Account for audio + TS container overhead and leave
headroom.

### 2. Upload side — pad the remainder to a full PAC

Raw segments rarely land exactly on 476 KiB, so before upload we pad each
MPEG-TS segment up to one full PAC with **MPEG-TS null packets** (PID `0x1FFF`),
which every player discards
([`segmentPadding.ts`](../packages/stream-uploader/src/utils/segmentPadding.ts)).

- Pad target is `487,296` bytes — the largest whole number of 188-byte TS
  packets that still fits in 119 chunks (476 KiB is not a multiple of 188).
- A segment **already larger than one PAC cannot be padded**; it is uploaded
  as-is and logged as a warning (fix it at the encoder).
- Controlled by `PAD_SEGMENTS_TO_PAC` (default `true`).

Padding is for *alignment of the last partial chunk*, not a substitute for
encoder tuning — padding a genuinely small segment up to 476 KiB just wastes
postage. Both levers are needed: tune the encoder so segments land just under
one PAC, then pad the remainder.

## Coupling note

`PAC_DATA_CHUNKS = 119` in `segmentPadding.ts` is tied to MEDIUM erasure coding
(`redundancyLevel: 1` in `StreamUploader.uploadDataToBee`). If the redundancy
level changes, the data-chunk count per PAC changes too (e.g. STRONG ≈ 107
chunks ≈ 428 KiB) — update both together.
