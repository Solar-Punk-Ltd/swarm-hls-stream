/**
 * The recording a probe reads references out of, and the rule that each is used once.
 *
 * A rung's playlist is fetched from the gateway exactly as the client fetches it, so what this parses
 * is the product's own manifest rather than a file the harness wrote. `GET /feeds/{owner}/{topic}`
 * answers with the m3u8 text itself, not a JSON envelope.
 *
 * ## ⛔⛔ Why a reference is never handed out twice
 *
 * A reference asked for a second time in the same tab is answered from the node's own cache in single
 * digit milliseconds. That number would sit in a table of network retrievals looking like a very fast
 * one, and it is the single easiest way for this probe to publish a miracle. {@link makeRefPool}
 * throws rather than wrapping round, and {@link manifestRefusal} refuses before the browser opens
 * rather than letting a run discover mid-sitting that it is out of fresh references.
 */

/** The two rungs of the recording. */
export type RungName = '360p' | '1080p';

/** What one rung's manifest declared, read through the gateway the way the client reads it. */
export interface RungManifest {
  rung: RungName;
  topicHex: string;
  segmentCount: number;
  /** The `#EXT-X-TARGETDURATION` ceiling, or null when the manifest carried none. */
  targetDurationS: number | null;
  /**
   * The typical `#EXTINF`, which is the only size a manifest declares.
   *
   * ⭐ Read rather than assumed. This stage moved from 2.0s segments to 1.0s on 2026-09-01, and a
   * recording's own declared segment length is what says which stage a result belongs to.
   */
  medianSegmentSeconds: number | null;
}

export interface ParsedRungManifest {
  manifest: RungManifest;
  refs: string[];
}

export interface RefPool {
  /** The next unused reference, or a throw. Never a repeat. */
  take: () => string;
  remaining: () => number;
}

/**
 * The fewest references a recording needs before it is the one this probe was written against.
 *
 * Sitting five's recording holds 127 per rung. A playlist far below this is a different recording,
 * probably a live head still filling, and reading a result off it would describe that instead.
 */
export const MIN_SEGMENT_REFS = 24;

/** A Swarm reference as a playlist line: 32 bytes, lowercase hex, alone on the line. */
const SEGMENT_REF = /^[0-9a-f]{64}$/;

const TARGET_DURATION_TAG = '#EXT-X-TARGETDURATION:';
const SEGMENT_DURATION_TAG = '#EXTINF:';

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

/** A tag's numeric value, or null where the tag is absent or carries something that is not a number. */
function taggedNumber(lines: readonly string[], tag: string): number | null {
  const line = lines.find((candidate) => candidate.startsWith(tag));
  if (line === undefined) {
    return null;
  }
  // `#EXTINF` carries a trailing `, no desc`, which the comma strips. A bare tag has no comma.
  const value = Number(line.slice(tag.length).split(',')[0]);
  return Number.isFinite(value) ? value : null;
}

/**
 * Every bare segment reference an m3u8 names, in playlist order.
 *
 * Its own function because a caller can hold a playlist without knowing which rung of a ladder it
 * belongs to: `browser:vod` reads one off the address the player's own fragment log names, and a
 * rung name it invented would put a label nobody chose on a reference.
 */
export function segmentRefsOf(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => SEGMENT_REF.test(line));
}

export function parseRungManifest(rung: RungName, topicHex: string, text: string): ParsedRungManifest {
  const lines = text.split('\n').map((line) => line.trim());
  const refs = segmentRefsOf(text);
  const durations = lines
    .filter((line) => line.startsWith(SEGMENT_DURATION_TAG))
    .map((line) => taggedNumber([line], SEGMENT_DURATION_TAG))
    .filter((duration): duration is number => duration !== null);

  return {
    manifest: {
      rung,
      topicHex,
      segmentCount: refs.length,
      targetDurationS: taggedNumber(lines, TARGET_DURATION_TAG),
      medianSegmentSeconds: durations.length === 0 ? null : median(durations),
    },
    refs,
  };
}

/**
 * Why this recording cannot carry the run that is about to start, or null.
 *
 * ⛔ Both reasons are checked before the browser opens. A run that ran out of fresh references part
 * way through would either repeat one, which is a cache hit dressed as a retrieval, or abandon the
 * arms it had not reached.
 *
 * @param needed How many distinct references this run's plan will ask this rung for.
 */
export function manifestRefusal(parsed: ParsedRungManifest, needed: number): string | null {
  const { rung } = parsed.manifest;
  const held = parsed.refs.length;

  if (held < MIN_SEGMENT_REFS) {
    return (
      `the ${rung} manifest names ${held} segments, under the ${MIN_SEGMENT_REFS} this probe expects. ` +
      'That is a different recording from the one it was written against, probably a live head still ' +
      'filling, and a result read off it would describe that recording rather than this question'
    );
  }
  if (held < needed) {
    return (
      `this run asks the ${rung} rung for ${needed} distinct references and its manifest names ${held}. ` +
      "A reference used twice in one tab is answered from the node's own cache in single digit " +
      'milliseconds, so the run is refused rather than allowed to repeat one'
    );
  }
  return null;
}

/**
 * As many references as were asked for, spread evenly across the whole recording.
 *
 * Spread rather than the first n, so a run does not measure only the opening of a recording. Content
 * decay is real here and it is not uniform in time, so taking a contiguous run would confound the
 * question with where in the recording the references came from.
 *
 * Hands back everything it has when asked for more than the recording holds. {@link manifestRefusal}
 * is what refuses that case, before this is ever reached.
 */
export function spacedRefs(refs: readonly string[], wanted: number): string[] {
  const take = Math.min(wanted, refs.length);
  return Array.from({ length: take }, (_unused, index) => refs[Math.floor((index * refs.length) / take)]);
}

/** A rung's references, handed out one at a time and never twice. */
export function makeRefPool(refs: readonly string[], label: string): RefPool {
  const queue = [...refs];
  return {
    take: (): string => {
      const ref = queue.shift();
      if (ref === undefined) {
        throw new Error(
          `the ${label} reference pool is empty and a run asked it for another. Handing an already ` +
            "used reference out would be answered from the node's own cache in single digit " +
            'milliseconds and would score as a miracle in a table of network retrievals.',
        );
      }
      return ref;
    },
    remaining: (): number => queue.length,
  };
}
