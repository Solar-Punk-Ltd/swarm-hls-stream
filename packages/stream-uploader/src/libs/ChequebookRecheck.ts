import { StartGateWarning } from '../types.js';

import { Clock, systemClock, Timer } from './Clock.js';
import { latchedWarning, StartGate } from './StartGates.js';

/**
 * Where the boot's gate warnings are held for `/health`, which `StreamOrchestrator` is.
 *
 * Replaced whole on every record, so what this reads back is exactly what `/health` reports.
 */
export interface StartGateWarningStore {
  getStartGateWarnings(): readonly StartGateWarning[];
  recordStartGateWarnings(warnings: readonly StartGateWarning[]): void;
}

/** Where the reads are reported. Matches `Logger`, narrowed to the three methods used here. */
interface RecheckLogger {
  info(message: string): void;
  warn(message: string): void;
  debug(message: string): void;
}

interface ChequebookRecheckOptions {
  /** The chequebook gate, built the way the boot's pass ran it. */
  readonly gate: StartGate;
  /** How long after one read has answered the next one starts. `CHEQUEBOOK_RECHECK_MS`. */
  readonly intervalMs: number;
  readonly store: StartGateWarningStore;
  readonly logger: RecheckLogger;
  /** Injected so a test can step time rather than wait a minute per read. */
  readonly clock?: Clock;
}

const MS_PER_SECOND = 1_000;

/**
 * Reads the chequebook again while the boot's chequebook warning stands, and takes that warning off
 * `/health` as soon as every node holds its floor.
 *
 * ## The failure this exists for
 *
 * Under the shipped `chequebook-warn` a chequebook under its floor does not stop the boot. The gate
 * warns, the service starts, and the finding is latched onto `/health` as `start_gate_warned`, which
 * answers 503. Nothing read the chequebook again after that, so funding the node changed nothing
 * anybody could see: the container stayed unhealthy for the life of the process and only a restart
 * cleared it. A colleague testing the manager reported the uploader as stuck on 2026-09-25 for exactly
 * that reason.
 *
 * ## What it reads, and what it leaves alone
 *
 * The same gate the boot ran, over the same nodes, `intervalMs` after the previous read has answered.
 * Reads never overlap, because a chequebook read is answered off the chain and can take the whole gate
 * timeout, and an older answer landing after a newer one would put back a warning the newer one had
 * cleared. Each pass replaces the chequebook's warnings with what it found and keeps every other
 * gate's: a postage warning from the boot is about a batch, and the chequebook says nothing about
 * it. The pass that finds every node funded is the last one.
 *
 * Every node rather than only the ones that warned, because a rung funded at boot may have drained
 * since, and while the warning stands that is worth naming too. Once it clears nothing reads again, so
 * a node that drains after that is still the question `ChequebookGate` says it does not answer.
 *
 * Under `UPLOADER_START_GATES=refuse` a chequebook the gate will not accept ends the boot, so nothing is
 * ever latched and this never starts.
 */
export class ChequebookRecheck {
  private readonly clock: Clock;
  private timer: Timer | null = null;
  private isStarted = false;
  private isStopped = false;

  constructor(private readonly options: ChequebookRecheckOptions) {
    this.clock = options.clock ?? systemClock;
  }

  /** Start reading again if the boot left a chequebook warning, and do nothing otherwise. */
  public start(): void {
    const held = this.heldWarnings();
    if (this.isStarted || this.isStopped || held.length === 0) {
      return;
    }

    this.isStarted = true;
    const { gate, intervalMs, logger } = this.options;
    logger.info(
      `[ChequebookRecheck] ${gate.name} warned at boot on ${describeRungs(held)}. Reading it again every ` +
        `${seconds(intervalMs)} until it clears, and no restart is needed once the chequebook is funded`,
    );
    this.scheduleNextRead();
  }

  /** Stop reading. A read already in flight finishes and changes nothing. */
  public stop(): void {
    this.isStopped = true;
    this.timer?.cancel();
    this.timer = null;
  }

  private scheduleNextRead(): void {
    // Unref'd, because a pending re-read is no reason to keep alive a process that is otherwise ending.
    this.timer = this.clock.setTimer(() => this.readAgainOrSayWhy(), this.options.intervalMs, { unref: true });
  }

  private readAgainOrSayWhy(): void {
    this.timer = null;
    this.readAgain().catch((error: unknown) => {
      // Nothing inside a pass is expected to throw, since the gate's own failures are collected. Kept
      // reading anyway, because a loop that died here would leave the warning up for good.
      this.options.logger.warn(`[ChequebookRecheck] a read failed and is tried again: ${describeFailure(error)}`);
      if (!this.isStopped) {
        this.scheduleNextRead();
      }
    });
  }

  /**
   * One read, and what it leaves on /health: this gate's warnings are replaced by what the read found and
   * every other gate's are kept. The read that finds nothing is the last one.
   */
  private async readAgain(): Promise<void> {
    const { gate, intervalMs, store, logger } = this.options;
    const found = await this.readOnce(this.heldWarnings());
    if (this.isStopped) {
      return;
    }

    const otherGates = store.getStartGateWarnings().filter((warning) => warning.gate !== gate.name);
    store.recordStartGateWarnings([...otherGates, ...found]);

    if (found.length === 0) {
      logger.info(`[ChequebookRecheck] every chequebook now holds its floor, so ${gate.name} is off /health`);
      return;
    }

    const nextRead = seconds(intervalMs);
    logger.debug(
      `[ChequebookRecheck] ${gate.name} still warns on ${describeRungs(found)}, reading again in ${nextRead}`,
    );
    this.scheduleNextRead();
  }

  /**
   * One pass of the gate, as the warnings it leaves.
   *
   * A rung that was already warned about goes to debug, because the boot wrote the whole refusal to the
   * log and a minute later it is not news. A rung that was not is a warning, with the gate's message.
   */
  private async readOnce(held: readonly StartGateWarning[]): Promise<StartGateWarning[]> {
    const { gate, logger } = this.options;
    const found: StartGateWarning[] = [];
    const isHeld = (rung: string | undefined) => held.some((warning) => warning.rung === rung);
    const report = (rung: string | undefined, line: string) => (isHeld(rung) ? logger.debug(line) : logger.warn(line));

    try {
      await gate.run((refusal) => {
        const warning = latchedWarning(gate.name, refusal);
        found.push(warning);
        report(warning.rung, `[ChequebookRecheck] ${refusal.message}`);
      });
    } catch (error) {
      // Filed as `runStartGates` files a gate that threw rather than collecting: no rung, and the reason
      // in the log. An empty node set does that, and it does not clear by waiting.
      found.push({ gate: gate.name });
      report(undefined, `[ChequebookRecheck] ${gate.name} could not be read again: ${describeFailure(error)}`);
    }

    return found;
  }

  private heldWarnings(): StartGateWarning[] {
    const { gate, store } = this.options;
    return store.getStartGateWarnings().filter((warning) => warning.gate === gate.name);
  }
}

/** The rungs a set of warnings names, for a log line. A single-node deployment's warning names none. */
function describeRungs(warnings: readonly StartGateWarning[]): string {
  return warnings.map((warning) => warning.rung ?? 'its node').join(', ');
}

function seconds(ms: number): string {
  return `${ms / MS_PER_SECOND} s`;
}

function describeFailure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
