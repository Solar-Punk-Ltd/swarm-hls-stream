import { StartGateWarning } from '../types.js';

import { SINGLE_PUBLISHER } from './BeePublisherPool.js';

/**
 * What the uploader does about a startup gate it cannot clear.
 *
 * ## The failure this exists for
 *
 * `ChequebookGate` and `PostageGate` each read one thing before the uploader touches anything paid
 * or stateful, and each refused the start on any answer it could not read. On 2026-09-16 an ABR
 * uploader on the live host was configured with a pool address that had no node behind it. The
 * chequebook read timed out, the gate refused with "chequebook is absent or unreadable: timeout of
 * 4000ms exceeded", docker restarted the container into the same refusal, and the deploy was refused
 * on the loop. Nothing was wrong with any chequebook. The gate reported honestly and the conclusion
 * it forced was still the wrong one, because a refusal is the loudest thing in a log and it was
 * standing in front of the address that was actually wrong.
 *
 * ## What the owner ruled, 2026-09-17
 *
 * "The uploader and engine should be able to start no matter what the status of the chequebook is."
 * So the readings stay, on every boot, and by default a gate that cannot clear its node writes its
 * whole refusal as a warning and the service starts. `UPLOADER_START_GATES=refuse` is how a
 * deployment asks for the old behaviour, unchanged: same gates, same order, same messages.
 *
 * ## Why the mode lives here rather than inside each gate
 *
 * A gate's job is to establish one fact and say what it found. Whether the service survives that
 * finding is a deployment decision, and putting it in both gates would be one decision written
 * twice, free to drift. This runs them instead, and a third gate joins by appearing in the list.
 */

/**
 * The variable a deployment sets, spelled here so the messages can name it.
 *
 * `utils/config.ts` writes the same name out again at the read rather than importing this, and that
 * is deliberate: `deploy/test/uploaderEnv.test.js` finds the service's knobs by scraping the literal
 * out of each `optional(...)` call, so a name read through a constant is a knob it cannot check.
 */
const START_GATE_MODE_ENV = 'UPLOADER_START_GATES';

/** Read every gate, log what refuses, and start anyway. The shipped mode since 2026-09-17. */
export const START_GATE_WARN = 'warn';

/** Stop the start on the first gate that refuses, which is what every boot did before that date. */
export const START_GATE_REFUSE = 'refuse';

/** The second argument of {@link runStartGates}, and what `parseStartGateMode` below answers with. */
export type StartGateMode = typeof START_GATE_WARN | typeof START_GATE_REFUSE;

/**
 * One node a gate could not clear, as the gate hands it over when it is collecting rather than
 * refusing.
 *
 * `url` and `message` are for the log and nothing else. `/health` is unauthenticated and published on
 * every interface this deployment binds, and a gate's message carries node URLs and batch ids, so
 * what is latched there is {@link StartGateWarning}: the gate's name and the rung, and no more.
 *
 * Both arrive with any credential already stripped, through the same helper `BeePublisherPool.routing`
 * answers with, because a URL that has travelled this far is one nobody remembers to strip later.
 */
export interface GateRefusal {
  /** The ABR rung, where the gate's nodes carry one. A single-node deployment has none to name. */
  readonly rung?: string;
  readonly url: string;
  /** What the gate would have thrown, whole. */
  readonly message: string;
}

/** Where a gate puts a refusal instead of throwing it. Absent, the gate throws at the first one. */
export type GateCollector = (refusal: GateRefusal) => void;

/** One startup check, as {@link runStartGates} needs it: a name for the log, and the reading itself. */
export interface StartGate {
  /** How a warning names this gate to an operator. The class name is what both callers pass. */
  readonly name: string;
  /**
   * Read, and either throw at the first refusal or hand every one of them to `collect`.
   *
   * The mode decides which, and the gate is told by being given a collector or not, rather than by
   * being told the mode. A gate has no business knowing what a deployment does about what it found.
   */
  run(collect?: GateCollector): Promise<void>;
}

/** Where a downgraded refusal goes. Matches `Logger`, narrowed to the one method used here. */
interface StartGateLogger {
  warn(message: string): void;
}

/** Where a whole pass of warnings goes, so `/health` can report what warned instead of refusing. */
type StartGateWarningSink = (warnings: readonly StartGateWarning[]) => void;

/**
 * The mode a deployment asked for, or a refusal naming both of them.
 *
 * A value that is neither is refused rather than read as the default. Starting anyway is the owner's
 * ruling, and a deployment that asked for `refuse` and mistyped it would otherwise be handed that
 * ruling silently, running the opposite of what its own env file says.
 */
export function parseStartGateMode(written: string): StartGateMode {
  const mode = written.trim().toLowerCase();
  if (mode === START_GATE_WARN || mode === START_GATE_REFUSE) {
    return mode;
  }

  throw new Error(
    `Env var ${START_GATE_MODE_ENV} is neither "${START_GATE_WARN}" nor "${START_GATE_REFUSE}": "${written}"`,
  );
}

/**
 * Run every gate in order, and do with a refusal whatever the mode says.
 *
 * Under `warn` every gate is read even after an earlier one refused, because the chequebook and the
 * postage batch are separate questions with separate fixes. An operator who has to restart once per
 * finding learns them one boot at a time. Under `refuse` the first failure is rethrown untouched, so
 * the caller's crash report carries the gate's own message rather than a wrapper around it.
 */
export async function runStartGates(
  gates: readonly StartGate[],
  mode: StartGateMode,
  logger: StartGateLogger,
  /** Called once with everything this pass warned about, so `/health` can report it. See D16's review. */
  onWarnings: StartGateWarningSink = () => {},
): Promise<void> {
  const warnings: StartGateWarning[] = [];

  for (const gate of gates) {
    const collect =
      mode === START_GATE_REFUSE
        ? undefined
        : (refusal: GateRefusal) => {
            const rung = namedRung(refusal.rung);
            warnings.push({ gate: gate.name, rung });
            logger.warn(warningLine(gate.name, rung, refusal.message));
          };

    try {
      await gate.run(collect);
    } catch (error) {
      if (mode === START_GATE_REFUSE) {
        throw error;
      }

      // A gate that threw under warn rather than collecting: an empty node set, or something no node
      // reading produced. Neither may pass silently, so it is warned about and latched like the rest.
      warnings.push({ gate: gate.name });
      logger.warn(warningLine(gate.name, undefined, describeFailure(error)));
    }
  }

  // Always, including with nothing to report, because the pass that clears is what replaces the last
  // pass that did not. The gates are re-read on every attempt of a node wait, and only the last of
  // those describes the service that is now running.
  onWarnings(warnings);
}

/**
 * The rung worth naming, or nothing.
 *
 * A single-node deployment routes everything through one publisher whose rung is the placeholder
 * `all`, which nobody configured and which reads as broken English in a sentence: "ChequebookGate on
 * all did not clear". {@link StartGateWarning} already documents the rung as absent there, so this is
 * the code agreeing with its own contract.
 */
function namedRung(rung: string | undefined): string | undefined {
  return rung === SINGLE_PUBLISHER ? undefined : rung;
}

function warningLine(gate: string, rung: string | undefined, message: string): string {
  const subject = rung === undefined ? gate : `${gate} on ${rung}`;
  return (
    `[startGates] ${subject} did not clear and the uploader is starting anyway: ${message} ` +
    `Set ${START_GATE_MODE_ENV}=${START_GATE_REFUSE} to make this stop the start again.`
  );
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
