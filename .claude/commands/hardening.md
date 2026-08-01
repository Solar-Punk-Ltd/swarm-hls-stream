---
description: Resume the swarm-hls-stream hardening work from the current register state
---

Resume the hardening work on this repository. Do the reading before touching anything.

## Read first, in full, before any code

1. `docs/reviews/2026-08-01-session-handover.md` — where things stand, what is next, and the traps
   and lessons that will otherwise be relearned.
2. `docs/reviews/2026-07-29-hardening-audit.md` — the findings register and every acceptance
   criterion.
3. `docs/reviews/2026-07-29-hardening-handoff.md` — priorities, protocol, environment traps, and the
   progress log.
4. `docs/reviews/review-gate.md` — the review every pull request passes.

The audit is finished. **Do not re-audit and do not re-derive findings.** If a row looks wrong, say
so and amend it explicitly rather than quietly working to a different target.

## How a row gets closed

**A task is done when its acceptance criterion passes as a test, not when the code looks right.**

- **Verify the row against source before implementing it.** Three criteria have already been found
  defective this way. Two were satisfiable without doing any work at all. When one is wrong, record
  the amendment in the audit beside the original, with the original struck through, and say so in the
  commit and the pull request.
- **Prove every fix by reverting it.** Break the fix, watch the specific tests fail, restore it, and
  put the counts in the commit message. A test that passes against the unfixed code is the failure
  mode this repository keeps hitting, most recently twice in one session, on tests that read
  convincingly.
- **Distrust the test that demonstrates the consequence** rather than the mechanism. Those are the
  ones that assert nothing.

## Working rules

- Conventional commit subjects. **One fix per commit.** No `Co-Authored-By` footers, no AI attribution
  anywhere, including pull request bodies and comments.
- **No em-dashes and no semicolons in prose.** Code is exempt.
- `pnpm verify` must be green before you push. Typecheck the uploader with `tsconfig.test.json`, since
  `tsconfig.json` does not cover `test/`.
- Any dependency change gets the full four-part provenance check on every version it introduces,
  including transitive ones: publish age, signature and SLSA provenance queried **one field at a
  time**, `npm audit signatures`, and malware advisories. Report the results next to the advisory
  numbers and name whatever lacks provenance.
- Request a Copilot review on each pull request:
  `gh api repos/Solar-Punk-Ltd/swarm-hls-stream/pulls/N/requested_reviewers -X POST -f "reviewers[]=copilot-pull-request-reviewer[bot]"`

## Ask before

- Pushing to a shared branch, and before merging anything. **Name the exact pull requests and the
  target branch, then wait.**
- Running the deploy or clean scripts. `clean.sh` destroys the containers and data of a live stack.

## Never

- Buy, extend or top up a postage stamp. On-chain actions are the owner's, testnet included.

## Then

Report where you are starting, what the first row's criterion actually says, and whether it survives
being checked against source. Then begin.

$ARGUMENTS
