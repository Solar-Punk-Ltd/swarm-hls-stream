/**
 * Whether the uploader a stage is actually running writes the log lines this harness parses.
 *
 * ⛔⛔⛔ The gap this closes, walked into on 2026-09-01. `logLevel.ts` already guards one silent
 * precondition of the whole suite, that the deployment's `LOG_LEVEL` admits the lines. It guards the
 * LEVEL and says nothing about the SHAPE. So a message reworded in this repo and not yet deployed
 * leaves every pattern that reads it matching nothing, the counters stay at zero, and the scenarios
 * fail with labels that blame the product.
 *
 * That is not hypothetical either. `Manifest uploaded at SOC index N` gained a stream id that day.
 * The harness was synced to the host and the uploader was not, so a paid sitting reported
 * `bee-outage-long` and `service/happy-path` red, both for "manifest publishes never resumed", on a
 * deployment that was publishing manifests the whole time.
 *
 * ## Why it reads the built code rather than a log
 *
 * A preflight runs before anything publishes, so the lines are not in any recent log window to
 * sample. What is always there is the JavaScript the container is running: the uploader deploy syncs
 * a prebuilt `dist/`, and a composed message's fixed halves survive bundling as literals. Grepping
 * for those needs no broadcast, costs nothing and cannot be confused by an idle stage.
 *
 * ⚠️ It proves the deployed code CAN write the line, not that it did. That is the right question
 * here: a scenario that waits for a line already knows how to fail when it never comes, and what it
 * cannot survive is a line that arrives in a shape nothing reads.
 */

/** Stand-ins the composers are run with, so the fixed halves of a message can be split back out. */
const SAMPLE_TEXT = 'SHAPEPROBE';
const SAMPLE_NUMBER = 909090909090;

/**
 * The fixed fragments of a composed message, in order, with the substituted values removed.
 *
 * Fragments shorter than this are dropped, because a one or two character joiner (`" of "` cut down
 * to `" "`) appears in every line ever written and would pass against any deployment at all.
 */
const MIN_USEFUL_FRAGMENT = 4;

/**
 * Every stand-in a composed message can carry, longest first.
 *
 * ⛔⛔ **The prefixes are here for a composer that SHORTENS one of its arguments**, which this gate
 * could not see until 2026-09-04. `rungBatchRefused` cuts the batch id to its first eight characters,
 * deliberately, because a whole id is what authorises spending on a rung and a refusal outlives the
 * run in a scrollback. Run on the ten character {@link SAMPLE_TEXT} it leaves eight of it behind, the
 * split found no stand-in there, and `Postage batch SHAPEPRO of` became a literal every deployment
 * was required to contain.
 *
 * ⛔ Which breaks the gate SHUT rather than weakening it. No uploader ever built contains that text,
 * so the refusal would fire on every deployment for ever and tell an operator to redeploy something
 * that was never stale. Alternation is ordered, so the longest match wins and a whole stand-in is
 * never split as a shorter one.
 *
 * Safe because {@link SAMPLE_TEXT} is a distinctive invented word: no fixed half of any message in
 * the contract begins with any of its prefixes, so a prefix can only be a stand-in that was cut short.
 */
function standInPattern(): RegExp {
  const prefixes: string[] = [];
  for (let length = SAMPLE_TEXT.length; length >= MIN_USEFUL_FRAGMENT; length--) {
    prefixes.push(SAMPLE_TEXT.slice(0, length));
  }
  return new RegExp([...prefixes, String(SAMPLE_NUMBER)].join('|'));
}

export function messageLiterals(composed: string): string[] {
  return composed
    .split(standInPattern())
    .map((fragment) => fragment.trim())
    .filter((fragment) => fragment.length >= MIN_USEFUL_FRAGMENT);
}

/** One message the harness parses, named the way an operator reading a refusal would name it. */
export interface DeployedMessage {
  /** What the line tells the harness. */
  readonly what: string;
  /** The message as this repo composes it, run through the placeholders above. */
  readonly composed: string;
  /** What stops working when the deployment cannot write it. */
  readonly neededBy: string;
}

/** Built here rather than imported as constants, so the composer stays the single definition. */
export function deployedMessage(
  what: string,
  compose: (text: string, index: number) => string,
  neededBy: string,
): DeployedMessage {
  return { what, composed: compose(SAMPLE_TEXT, SAMPLE_NUMBER), neededBy };
}

/**
 * Why a stage cannot be measured, or null.
 *
 * `deployedCode` is whatever the container holds: the whole of `dist` concatenated is fine, since
 * this only ever asks whether a literal occurs in it.
 */
export function deployedLogShapeRefusal(messages: readonly DeployedMessage[], deployedCode: string): string | null {
  const missing = messages.filter((message) =>
    messageLiterals(message.composed).some((literal) => !deployedCode.includes(literal)),
  );
  if (missing.length === 0) {
    return null;
  }

  const detail = missing
    .map((message) => {
      const absent = messageLiterals(message.composed).filter((literal) => !deployedCode.includes(literal));
      return (
        `  - ${message.what}: the deployed uploader has no "${absent[0]}". ` +
        `Without it ${message.neededBy} reads nothing and fails as though the uploader never acted.`
      );
    })
    .join('\n');

  return (
    `The uploader running on this stage does not write ${missing.length} of the log lines this ` +
    `harness parses:\n${detail}\n` +
    'This is a stale deployment rather than a broken product: the messages are a contract in ' +
    '`packages/shared/src/uploaderLog.ts` and this checkout has moved past what is deployed. ' +
    'Redeploy the stream-uploader (deploy/scripts/deploy.sh) and run again. ⛔ Do NOT reword the ' +
    'patterns to match the old deployment, which buys a green run against code nobody is shipping.'
  );
}

/** What a passing check is worth saying, so a green preflight still reports what it proved. */
export function deployedLogShapeSummary(messages: readonly DeployedMessage[]): string {
  return `${messages.length} parsed log line(s) confirmed present in the deployed uploader's own code`;
}
