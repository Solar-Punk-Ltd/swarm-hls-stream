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

/**
 * Not exported, and `deploy/scripts/unused-exports.mjs` is why: no caller names this type. Both of
 * them reach it through `parseStartGateMode` below, and an exported name nothing imports is a
 * promise this repository counts.
 */
type StartGateMode = typeof START_GATE_WARN | typeof START_GATE_REFUSE;

/** One startup check, as {@link runStartGates} needs it: a name for the log, and the reading itself. */
export interface StartGate {
  /** How a warning names this gate to an operator. The class name is what both callers pass. */
  readonly name: string;
  run(): Promise<void>;
}

/** Where a downgraded refusal goes. Matches `Logger`, narrowed to the one method used here. */
interface StartGateLogger {
  warn(message: string): void;
}

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
): Promise<void> {
  for (const gate of gates) {
    try {
      await gate.run();
    } catch (error) {
      if (mode === START_GATE_REFUSE) {
        throw error;
      }

      logger.warn(
        `[startGates] ${gate.name} did not clear and the uploader is starting anyway: ${describeFailure(error)} ` +
          `Set ${START_GATE_MODE_ENV}=${START_GATE_REFUSE} to make this stop the start again.`,
      );
    }
  }
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
