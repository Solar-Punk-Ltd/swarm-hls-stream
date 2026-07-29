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

At least three reviewers, plus the claims auditor from R3. Each one is a separate agent with a single
assigned lens, spawned fresh.

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

The outcome lands on the pull request as a review through `gh`, listing what was confirmed, what was
refuted and why, and what changed as a result. A review that exists only in a session transcript
provides no auditability, and once the transcript is gone nobody can tell whether the gate ran.

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

## Lens catalogue

Pick by what the diff touches. Three minimum, plus the claims auditor, which is never optional.

| Lens                   | Select when                                              | Hunts                                                                      |
| ---------------------- | -------------------------------------------------------- | -------------------------------------------------------------------------- |
| Claims audit           | **Always**                                               | Assertions in the description that were never checked, or are stale        |
| Correctness            | Any logic change                                         | Wrong output for specific inputs, false green, false red                   |
| Security               | Input handling, auth, filesystem paths, CI, dependencies | A concrete attack path with a named attacker and what they control         |
| Concurrency            | The orchestrator, queues, timers, recovery               | Interleavings that corrupt state, lost updates, races between entry points |
| Behaviour preservation | Refactors, autofixes, anything claimed to be mechanical  | Hunks where behaviour actually differs from the version they replaced      |
| Config consistency     | Config, scripts, CI, packaging, docs describing commands | Two things in the repo that disagree, and what breaks because they do      |
| Silent failure         | Error paths, health and status reporting, retries        | Swallowed errors, fallbacks that mask a fault, a green that means nothing  |
| Test integrity         | New or changed tests                                     | Tests that pass without exercising the behaviour, and coverage that lies   |

Two rules on top of selection. Give each lens a genuinely different question, since three reviewers
asked the same thing produce one finding three times and a false sense of coverage. And after the
verification pass, ask which lens was not run, because the gap is the next round's work.

## Fail closed

If the required lenses did not run, the gate is **not satisfied**, exactly as if the outside reviewer
had never posted. Do not merge, and do not record the sprint exit gate as met. Name the lenses that
ran.

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
