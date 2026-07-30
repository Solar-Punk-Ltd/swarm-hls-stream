# Review gate

Standing protocol. Every pull request into `feat/ai-hardening` passes this before it merges.

This replaces the Copilot gate described in
[`2026-07-29-hardening-handoff.md`](./2026-07-29-hardening-handoff.md). The Copilot review quota for
the organization is exhausted for the month, so the automated outside reviewer is unavailable. The
gate it occupied is not optional, so it needs a replacement rather than a gap.

## What the outside reviewer was actually providing

Worth being precise about, because a replacement that misses any of the three is not a replacement.

1. **Independence.** It never saw the author's reasoning. It read the diff and nothing else.
2. **Auditability.** Findings landed in the PR timeline, so "left unaddressed" was a state anyone
   could detect afterwards.
3. **A blocking ritual.** The PR could not be called done until every finding was answered.

The naive substitute, the author re-reading their own diff, loses all three at once. It is not a
weaker version of a review, it is a different activity. Everything below exists to engineer the three
properties back.

## The gate

Five requirements. All five, or the gate is not satisfied.

### R1. Independent lenses, starved of the author's reasoning

Every pull request gets the claims auditor from R3, plus the code lenses the diff in front of you
actually needs. There is no minimum count. [Selecting lenses](#selecting-lenses) is the procedure and it
binds, because a gate that ran the wrong lenses is not rescued by having run several. Each lens is a
separate agent with a single assigned question, spawned fresh.

Each reviewer receives the diff and read access to the repository. Each reviewer is **not** given:

- the pull request description,
- the reasoning behind the commits,
- the author's own account of what the change does or why it is correct,
- the finding in the register that the change is meant to close, or any statement of the expected
  answer.

Withholding the description is the single most important rule here and the easiest one to break by
accident. A PR body in this project is a persuasive document that argues the change is correct. A
reviewer who reads it reviews the argument instead of the code, agrees with it, and reports nothing.
The claims auditor is the sole exception, because for that lens the description is the artifact under
test.

Lens prompts state the failure classes to hunt and require a concrete failure scenario. They must
also say, in as many words, that reporting few or no findings is a good result. Without that, a
reviewer with nothing to report invents something.

### R2. Verification defaults to refuted

No finding is actionable on sight. Every one is checked against the code before anything is fixed,
and the burden of proof sits on the finding.

A finding is CONFIRMED only if it reduces to a specific state or input, then a specific wrong
outcome. If it cannot be reduced to that shape, it is REFUTED. "Fragile", "could be a problem",
"consider adding" and "not best practice" are all REFUTED by definition, whatever their stated
severity.

Verify the stated severity separately from the stated defect. The two fail independently, and in
practice severity fails more often. A real MEDIUM reported as CRITICAL is still a bad finding,
because it reorders the work. Downgrade it, keep it, and say so.

Verify the proposed fix too. A fix can be wrong even when the defect is real, and a plausible wrong
fix is the most expensive thing a review can produce. One round here proposed restoring a quoted
glob that was the exact break CI had just caught.

This is not caution for its own sake. The ten-agent audit that produced the register generated
roughly 120 raw findings, and nine confident, high-severity ones were fabrications. One asserted that
Bee node passwords had been committed, when `.gitignore` covered the path, `git ls-files` returned
nothing for it, and no such commit existed. Another number, "~40 BZZ per segment", was invented
outright. The failure mode of an agent reviewer is not missing defects, it is inventing them
persuasively, and a fabricated CRITICAL costs more than a missed MEDIUM because it gets acted on.

Verification runs commands. Prefer measuring to reasoning. Where a claim concerns past behaviour,
check the base commit with `git show <ref>:<path>` or a throwaway worktree. Where a claim concerns a
tool's default, run the tool.

### R3. Audit the author's claims, not only the diff

A required lens with no equivalent in the tool being replaced, and the reason this gate is better
than that tool in at least one respect.

Every claim in the PR description is extracted and independently verified: exit codes, test counts,
file counts, which scripts exist, what was broken before, tooling version behaviour, and every ticked
box in the test plan. Verdicts are TRUE, FALSE, MISLEADING, STALE or UNVERIFIABLE, each with the
command that was run and its actual output.

The justification is direct evidence from this project. Two real defects in this work were claim
failures rather than code failures. An exit code was reported as zero when it had been read through a
pipe, which reports the last command's status and not the one that mattered. A security pass asserted
"no known vulnerabilities" from reading `package.json`, while sixty dependency advisories were open,
twenty-one of them at runtime scope. A diff reviewer catches neither, because neither is in the diff.
Both are caught by reading the claim and going to check.

Anything FALSE, MISLEADING or STALE gets the description corrected before merge. A PR body is
documentation and it outlives the review.

### R4. The result is posted, not just discussed

The outcome lands on the pull request as a review through `gh`, listing the lenses that ran, the lenses
that were selected against, what was confirmed, what was refuted and why, and what changed as a result.
A review that exists only in a session transcript provides no auditability, and once the transcript is
gone nobody can tell whether the gate ran or which lenses it used.

Findings are answered the same way an outside reviewer's would be. Confirmed ones become fixes, one
fix per commit. Refuted ones get a reply carrying the disproof. Neither blanket acceptance nor
blanket dismissal is a valid outcome.

### R5. Refutations go into the register

Every REFUTED finding is appended to the rejected-findings table in
[`2026-07-29-hardening-audit.md`](./2026-07-29-hardening-audit.md) together with its disproof. Real
findings that fall outside the pull request's scope become new register rows instead of scope creep.

That table already holds nine entries and has already prevented rework. It is the only artifact that
stops a future round from re-raising a claim that has been investigated and killed, and it
appreciates with every round.

## Selecting lenses

Owner rule, 2026-07-30. Decide per pull request, run what you selected, and name what you dropped.

1. **The claims auditor runs on every pull request.** It has no substitute and it is never traded away
   for a slot. Two real defects in this work were claim failures rather than code failures, and a diff
   reviewer catches neither, because neither is in the diff.
2. **Pick the code lenses by the surfaces the diff touches.** Read the "Select when" column below as
   binding rather than advisory.
3. **Do not pad to a number.** A one-surface diff takes the auditor plus one or two lenses.
4. **Give each selected lens a genuinely different question.** Three lenses asked the same thing produce
   one finding three times and a false sense of coverage.
5. **Name the lenses you did not run**, in the posted result required by R4. That list is the next
   round's work.

**The full catalogue runs as a deep run at the end of each sprint**, paired with the sprint-exit
re-audit in the handoff's working protocol. Sprint exit is when a fix in one domain is most likely to
have quietly broken another, so that is where breadth belongs rather than on every pull request.

The earlier floor of three lenses plus the auditor is **withdrawn**, not merely relaxed. It spent the
same fleet on a 13-line config diff as on a four-task logic change, and a floor invites padding to
reach it, which is the failure rule 4 exists to prevent.

### Lens catalogue

| Lens                   | Select when                                                                     | Hunts                                                                                                             |
| ---------------------- | ------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Claims audit           | **Always**                                                                      | Assertions in the description that were never checked, or are stale                                               |
| Correctness            | Any logic change                                                                | Wrong output for specific inputs, false green, false red                                                          |
| Security               | Input handling, auth, filesystem paths, CI, dependencies                        | A concrete attack path with a named attacker and what they control                                                |
| Concurrency            | The orchestrator, queues, timers, recovery                                      | Interleavings that corrupt state, lost updates, races between entry points                                        |
| Behaviour preservation | Refactors, autofixes, anything claimed to be mechanical                         | Hunks where behaviour actually differs from the version they replaced                                             |
| Config consistency     | Config, scripts, CI, packaging, docs describing commands                        | Two things in the repo that disagree, and what breaks because they do                                             |
| Silent failure         | Error paths, health and status reporting, retries                               | Swallowed errors, fallbacks that mask a fault, a green that means nothing                                         |
| Test integrity         | New or changed tests                                                            | Tests that pass without exercising the behaviour, and coverage that lies                                          |
| Protocol correctness   | This gate, the handoff's working protocol, any rule a later session must follow | Obligations removed or weakened, requirements no artifact can prove, and the cheapest review the new text permits |

### What selection has measured

PR #30 bundled four tasks across four surfaces, so six lenses were all justified and the wide run paid
for itself: the CRITICAL came from the one lens whose question was specifically "what can break while
this still reports healthy". The way to need fewer lenses is a tighter pull request, not a shorter list
on a broad one.

PR #31, a dead-code sweep, took three. PR #32, two dependency-injection seams, took four. Both rounds
found real defects, so a reduced set is not a rubber stamp.

## Lens prompt rules

Each of these came out of a round of this gate rather than out of general principle. They live here
because they are part of the protocol rather than part of any one round's notes.

**Read the figures below with their provenance.** This repository holds no measurement artifact: no token
log, no timing log, no recorded mutation set. The #30 mutation counts and the #29 token figures also
appear in the gate results posted on those pull requests, so they can be checked against something other
than this file. The #28 percentages and the #32 mutation count appear only in author-written documents,
and a document asserting its own measurement is not evidence. Treat an unchecked figure as a reason to
re-measure rather than as a settled number. Each rule stands on the finding its round produced, which is
checkable, rather than on the size of the number attached to it.

- **Run the claims auditor first and alone**, before the code lenses. Twice in one session a test count
  went stale mid-review and invalidated the description after the code lenses had already finished.
- **Tell the claims auditor that "the file exists" is not evidence, and that UNVERIFIABLE is the correct
  verdict when the available evidence falls short.** On #27 and #28 it returned TRUE twice on evidence
  that established nothing. With that sentence added, on #29 it correctly refused to verify a
  measurement it could not reproduce. This is the highest value per word of anything found so far.
- **Give the test-integrity lens mutation as its method, not reading.** On #30 it ran 36 mutations and
  named, for each survivor, an assertion that did not assert what its title claimed. On #32 it ran 51
  and found that a test written to document a missing timeout would have stayed green once the timeout
  landed. Reading the files produces neither result.
- **Verify the reviewer's proposed fix, not only its finding.** Already required by R2, and worth
  repeating in the prompt. On #29 the auditor correctly spotted an imprecise sentence, then proposed a
  rewording wrong in the other direction, turning a real event into a hypothetical one.
- **Forbid lenses from reading `docs/reviews/` and the branch's commit messages, and tell them to exclude
  `docs/` from repo-wide greps.** On #30 two lenses disclosed that an early `grep -i health` had printed
  register lines into their transcripts. Both re-derived their findings from source and said so, which is
  the behaviour you want, and the exposure is still avoidable with one sentence. **The files under review
  are excepted.** When the diff is inside `docs/reviews/`, those files are the artifact and R1's grant of
  the diff wins, so the ban narrows to whatever in that directory the diff does not touch, plus the
  commit message bodies. Without that sentence this rule and R1 contradict each other on exactly the pull
  requests that amend this document, which is how it was found.
- **Give every lens the head sha explicitly**, and say that the working directory may have the base
  branch checked out. On #32 one lens spent a pass measuring base content.
- **Give every lens the scratchpad path and forbid worktrees inside the repository.** Lenses have created
  them anyway, one holding the integration branch checked out, which blocked a merge until it was
  detached. Run `git worktree list` before merging rather than after it fails. The author-side half of
  this: stage explicit paths while lenses are running, because a `git add -A` swept one lens's leftover
  probe directory into a commit.
- **Instruct lenses to run `tsc` with `--noEmit` and never to name files on the command line.** Naming
  files silently ignores `tsconfig.json`. One lens emitted 15 `.js` files beside the sources and turned
  `pnpm lint` red while every tracked file was clean.
- **A neutral orientation brief** covering repo layout, test commands and known traps reveals nothing
  about the expected answer, so R1 still holds with it. Not a uniform win: on #28, the round that
  introduced it, it cut the test lens 20% on tokens and 38% on time and cost the security lens 19% more.
  Keep using it and keep watching.
- **The mechanical lenses do not need the top model tier.** Test integrity and claims audit mostly run
  commands and count, where security and correctness genuinely reason. On #29's 13-line config diff,
  three lenses a tier down cost 49k, 34k and 29k tokens against roughly 50k to 70k each at full tier,
  and the cheap ones still produced a byte-level `.gitignore` check and a per-package `outDir`
  comparison. That was a config diff, so do not assume it holds on a logic-heavy one without checking.

## Fail closed

If a lens you selected did not run, the gate is **not satisfied**, exactly as if the outside reviewer
had never posted. Do not merge, and do not record the sprint exit gate as met.

Per-PR selection weakens this clause unless the selection itself is on the record, because a list that
shrinks can always be made to look complete afterwards. "The gate ran" has to name which lenses, or it
asserts nothing.

So the selection gets its own artifact. **Post the selection and its reasoning as a pull request comment
before launching a single lens.** Not in the description: R3 requires the description to be corrected
before merge, so every correction destroys the timestamp evidence that the selection predated the run.
A comment is immune to that, because R3's corrections land on the description. The comment's timestamp
against the posted result's is then something a later reader can check, which is the whole point.

## What this gate does not give you

Stated plainly rather than papered over, because someone will otherwise read a passing gate as more
assurance than it is.

Every lens here is the same model family as the author. A blind spot shared across that family is
invisible to all of them at once, no matter how many lenses run, and no amount of adversarial
prompting fixes it. Three things reduce the exposure without closing it: lenses that ask genuinely
different questions, verification against ground truth by running commands rather than by
deliberating, and the repo owner's review, which remains the real backstop for anything this gate
clears.

So a passed gate does not mean "reviewed and approved". It means the diff survived a named set of
lenses, every surviving finding was answered, and the claims in the description were checked against
reality. Describe it that way, including in the progress log.
