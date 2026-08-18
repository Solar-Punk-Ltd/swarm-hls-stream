# Splitting `docs/bench`: the plan, and why it is not a file move

**Written 2026-08-17. Not executed.** This is the migration a housekeeping pass found necessary and
declined to perform in the same breath, because the naive version breaks a running harness.

## The shape today

| | |
| --- | ---: |
| files in `docs/bench` | **889** |
| on disk | **242 MB** |
| curated findings (hand-written `.md`) | 130 |
| per-run artefacts (timestamped `.json` / `.md` / `.tsv`) | **669** |
| artefacts referenced by any doc, script or memory | **25** |

So 75% of the directory is machine output that nothing links to, sitting beside the 130 documents
people actually read. Finding a document by name works. Browsing the directory does not.

## ⛔ Why the obvious move breaks things

`git mv docs/bench/longrun-* docs/bench/runs/` looks safe and is not.

1. **`deploy/scripts/sweep-interleaved.sh:256` globs the flat path.**
   ```sh
   for candidate in "${REPO_DIR}"/docs/bench/longrun-*.json; do
   ```
   After a move this glob matches nothing. A glob that matches nothing does not fail loudly, it
   iterates zero times, so the sweep would run to completion having silently skipped its inputs.

2. **Three scripts write into the flat directory**: `bench-profiles.sh:106`, `bench-on-host.sh:115`
   and `bench-sweep.sh:70` each `mkdir -p "${REPO_ROOT}/docs/bench"`, and `bench-on-host.sh:116`
   rsyncs the remote directory straight into it. Moving the existing files does not move where the
   next sitting puts its output, so the directory would refill flat and the split would rot within a
   week.

3. **25 artefacts are cited by name** from curated documents and from memory. Those citations are how
   a published number gets re-checked against its evidence, which this project has needed repeatedly.

## ⛔⛔ Deleting them is worse than leaving them

The 644 unreferenced artefacts are not clutter to be swept. They are the raw evidence that published
findings get audited against, and several headline claims in this repo were corrected by re-reading
exactly these files rather than the write-ups. `gateway-less-live-2026-08-16.md` records one: the
numbers that refuted its first conclusion were in the same JSON the original figures came from.

**An artefact is cheap to keep and impossible to recreate**, because the sitting that produced it
cost real BZZ and ran against a network state that no longer exists.

## The migration, in the order that keeps the tree working

Each step leaves the repo green on its own, so the sequence can stop anywhere.

1. **Give the writers one name for the destination.** Add `BENCH_RUNS_DIR` to `burn-rates.sh` (or a
   new `bench-paths.sh`), defaulting to `docs/bench/runs`. Change the three writers and the rsync to
   use it. Nothing moves yet, so nothing breaks.
2. **Make the reader path-independent before the files move.** Replace the `sweep-interleaved.sh`
   glob with one that searches both locations, and **assert it found something**. A zero-match glob
   must exit non-zero, which is the defect that makes step 4 dangerous.
3. **Add a test that fails if a writer regresses to the flat path.** Grep the scripts for
   `docs/bench/` written as a literal. Without this the split rots as soon as the next driver is
   copy-pasted from an old one, which is exactly how the duplication in these scripts accumulated.
4. **Move the 669 artefacts** with `git mv`, in one commit that changes nothing else, so the rename
   is reviewable and revertible on its own.
5. **Rewrite the 25 citations** in the curated documents and in memory. They are enumerable, so this
   is mechanical, and step 2 means a missed one degrades to a slow search rather than a wrong answer.
6. **Re-point `INDEX.md`** only if any indexed document moved. It indexes findings, not artefacts, so
   this step is probably empty.

## What it is worth

A browsable directory of 130 documents instead of 889 mixed files, and a place for run output that a
future driver falls into by default rather than by discipline.

⚠️ **It is not worth doing carelessly.** The failure mode of step 4 without steps 1 to 3 is a bench
harness that runs, exits zero, and quietly measures nothing, which is the most expensive shape of bug
this project has.
