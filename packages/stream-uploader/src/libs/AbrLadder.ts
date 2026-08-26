import { LadderRung } from '../types.js';

/**
 * Must stay in step with ABR_LADDER's default in `engines/srs/.env.sample`. The engine and the
 * uploader read the same variable, so they only diverge when one of them is left unset — and the
 * uploader's copy is what supplies width, height and the starting bandwidth for the master
 * playlist, none of which SRS puts in its webhooks.
 */
export const DEFAULT_LADDER_SPEC = '1080p:1920:1080:5000 720p:1280:720:2800 480p:854:480:1200 360p:640:360:700';

const RUNG_NAME = /^[a-zA-Z0-9._-]+$/;

export interface RungMatch {
  /** The stream id with the rung suffix removed — the ladder all four rungs belong to. */
  baseStreamId: string;
  rung: LadderRung;
}

/**
 * The rung list the engine was configured with, in the uploader's hands.
 *
 * The engine names its renditions by appending the rung name to the stream (`live` becomes
 * `live_720p`), which is the only thing the webhooks carry — the geometry and the encoder's
 * target bitrate are not in them. Parsing the same ABR_LADDER string the engine was given is how
 * those get back, and it is also how an unexpected suffix stays distinguishable from a rung.
 */
export class AbrLadder {
  private readonly byName: Map<string, LadderRung>;

  private constructor(rungs: LadderRung[]) {
    this.byName = new Map(rungs.map((rung) => [rung.name, rung]));
  }

  public static parse(spec: string): AbrLadder {
    // ⚠️ `filter(Boolean)` is doing the work here, and it makes two mutations of this line
    // equivalent: dropping `.trim()` and narrowing `\s+` to `\s` both only add empty strings, which
    // the filter then removes. Both survive `pnpm mutate` and neither is a coverage gap, so do not
    // write a test for them.
    const entries = spec.trim().split(/\s+/).filter(Boolean);
    if (entries.length === 0) {
      throw new Error('ABR_LADDER is empty; expected entries of the form name:width:height:kbps');
    }

    const rungs = entries.map((entry) => parseRung(entry));

    const names = new Set<string>();
    for (const rung of rungs) {
      if (names.has(rung.name)) {
        throw new Error(`ABR_LADDER has two rungs named "${rung.name}"`);
      }
      names.add(rung.name);
    }

    return new AbrLadder(rungs);
  }

  /** Ascending by height: the first entry is the rung a ladder-unaware client should land on. */
  public rungs(): LadderRung[] {
    return [...this.byName.values()].sort((a, b) => a.height - b.height);
  }

  public has(name: string): boolean {
    return this.byName.has(name);
  }

  /**
   * Splits `video/live_720p` into the ladder it belongs to and the rung it is.
   *
   * Matches only against configured rung names rather than any `_<something>` suffix, so a stream
   * key that happens to end in an underscore is not mistaken for a rendition.
   */
  public match(streamId: string): RungMatch | null {
    const separator = streamId.lastIndexOf('_');
    if (separator <= 0) {
      return null;
    }

    const rung = this.byName.get(streamId.slice(separator + 1));
    if (!rung) {
      return null;
    }

    return { baseStreamId: streamId.slice(0, separator), rung };
  }
}

function parseRung(entry: string): LadderRung {
  const parts = entry.split(':');
  if (parts.length !== 4) {
    throw new Error(`ABR_LADDER entry "${entry}" must be name:width:height:kbps`);
  }

  const [name, width, height, kbps] = parts;
  if (!RUNG_NAME.test(name)) {
    throw new Error(`ABR_LADDER rung name "${name}" must match ${RUNG_NAME}`);
  }

  return {
    name,
    width: parsePositiveInt(width, `width of "${name}"`),
    height: parsePositiveInt(height, `height of "${name}"`),
    configuredKbps: parsePositiveInt(kbps, `bitrate of "${name}"`),
  };
}

function parsePositiveInt(value: string, what: string): number {
  if (!/^\d+$/.test(value)) {
    throw new Error(`ABR_LADDER ${what} must be a positive integer, got "${value}"`);
  }

  const parsed = Number.parseInt(value, 10);
  if (parsed <= 0) {
    throw new Error(`ABR_LADDER ${what} must be a positive integer, got "${value}"`);
  }

  return parsed;
}
