# How the bench reads the feed decides what it reports (LAT-10)

**2026-08-04. Four ten-minute broadcasts, back to back, same stack, same settings, 720p 2500kbps at a
2.0s GOP. The only thing varied is how the bench follows the feed.**

`walk` is what the player does: one head lookup on mount, then explicit slot addresses.
`head` is what this bench did on every poll for the whole of LAT-10's history.

|                                     | walk (the player) | walk  | walk  | **head (the old bench)** |
| ----------------------------------- | ----------------: | ----: | ----: | -----------------------: |
| longest stall                       |             4.59s | 4.76s | 4.79s |               **37.22s** |
| polls that saw that stall           |                 2 |     2 |     2 |                        8 |
| feed index jump when it moved       |                 1 |     1 |     1 |                   **19** |
| segments delivered                  |               280 |   289 |   257 |                   **91** |
| feed polls completed                |               423 |   435 |   413 |                      133 |
| capture to fetchable, median        |             4.84s | 4.95s | 4.85s |                    5.41s |
| p95                                 |             6.11s | 6.16s | 6.05s |                    7.20s |
| worst                               |             8.31s | 7.16s | 6.99s |                    8.19s |
| smallest buffer that would not stall |             6.31s | 5.20s | 5.05s |                    6.19s |

Reports: `longrun-2026-08-04T14-41-36-698Z`, `T14-52-08-953Z`, `T15-02-42-839Z`, and the head run
`T15-13-18-780Z`.

## What it says

**The 30 to 48 second freeze was the instrument.** Reading the same broadcast the way the player
reads it, the worst a viewer waited was **4.8 seconds**, and it took two polls at a two second
cadence to see it. That is about one segment, and all three runs agree to within 0.2s.

**The index jump is the cleanest tell.** A reader keeping up moves one slot at a time. The walking
reader jumped **1** in all three runs. The head reader jumped **19**, meaning nineteen updates were
already written and waiting while it was told the feed had not moved.

**A third of the broadcast never arrived.** 10.1 minutes at a 2.0s GOP is about 303 segments. The
walking reader carried 257 to 289 of them, 85 to 95%. The head reader carried **91**, 30%. It also
managed only 133 polls where the walking readers managed 413 to 435, because each head lookup took
about 4.5 seconds.

## What is still real

The remaining 4.8s stall is not nothing, but it is one segment rather than a freeze, and a player
holding 9 to 10s plays straight through it. Every walk run says so.

The three walk runs are tight: median 4.84 / 4.95 / 4.85s, p95 6.05 to 6.16s. That is the first time
this project has had a repeatable latency figure, because it is the first time the instrument has not
been the dominant term.

## What it costs the record

**Every latency and stability figure published before this was measured through the head lookup**,
including all of `profiles.md`. They are not simply inflated by a constant: the head reader also
delivers a third of the segments, so anything derived from sample counts, stall lengths, buffer
recommendations or "frozen share" describes the reader rather than the deployment.

The concurrency result (LAT-11) survives in direction, since both arms used the same reader, but its
absolute numbers need redoing too.
