/**
 * How many segments a second the stage asks SRS to announce, and whether any sitting has shown that
 * rate working.
 *
 * ## Why this exists
 *
 * SRS fires the `on_hls` webhook once per closed segment **per rung**, so a ladder asks for
 * `rungs / segmentSeconds` announcements a second. Measured on the deployment host 2026-08-31, SRS
 * sustained about 6.7 a second while its own encoders were producing 8.0, and **nothing errors when
 * it cannot keep up**. Announcements fall behind the media at 0.46s per second of video until the lag
 * passes `hls_window`, after which SRS deletes each segment before announcing it: the uploader is
 * handed a callback naming a file that is already gone. The tallest rung crosses first and is
 * unpublished about two minutes in, having lost 765 of its 955 segments, while the master feed goes
 * on advertising it to viewers.
 *
 * ⛔⛔⛔ **A sitting in that state looks healthy and is not.** Three rungs publish at ~100% of target,
 * the uploader raises no queue warning, `swarm_hls_segments_uploaded_total` keeps climbing, and every
 * suite that does not read the per-rung breakdown passes. That is the failure this refuses.
 *
 * ## Why the bands rather than a ceiling
 *
 * The obvious gate is `rate <= 6.7`. That number is **one measurement, on a host carrying 74
 * containers including 40 co-tenant Bee nodes**, and this repository has a rule about a number nobody
 * replicated deciding whether a paid sitting runs. So the rule here is not a ceiling at all: it is
 * the two rates a sitting has actually resolved, and an explicit gap between them.
 *
 * - **4.0/s worked.** 600s broadcast, four rungs at 1.0s: lag flat at 0.0s across 580 segments, zero
 *   segments lost on any rung, 100% of the media published.
 * - **8.0/s broke.** Four rungs at 0.5s: 765 of 955 segments lost on 1080p, the rung unpublished.
 *
 * Between them nothing has been run. A rate in that gap is refused rather than guessed at, and the
 * refusal says how to widen it, because running a sitting there is precisely how the gap closes.
 */

/** Highest announcement rate a sitting has shown publishing 100% of the media on every rung. */
export const MEASURED_SUSTAINED_PER_S = 4.0;

/** Lowest announcement rate a sitting has shown losing a rung mid-broadcast. */
export const MEASURED_BROKEN_PER_S = 8.0;

/**
 * Set to `true` to run inside the unmeasured gap on purpose.
 *
 * Deliberately does NOT stand down the known-broken band. A rate at or above
 * {@link MEASURED_BROKEN_PER_S} has been watched destroying a rung, and an operator acknowledging
 * that is not new information.
 */
export const ACKNOWLEDGE_UNMEASURED = 'E2E_ACK_UNMEASURED_ANNOUNCEMENT_RATE';

/** `engine <name> {`, which `engines/srs/entrypoint.sh` writes once per `ABR_LADDER` rung. */
const LADDER_ENGINE = /^[ \t]*engine[ \t]+([A-Za-z0-9-]+)[ \t]*\{/gm;

type RateBand = 'sustained' | 'unmeasured' | 'broken';

interface AnnouncementLoad {
  /** Rung names the stage transcodes, or a single synthetic rendition when it transcodes nothing. */
  readonly rungs: readonly string[];
  readonly segmentSeconds: number;
  /** `rungs.length / segmentSeconds`: what SRS is asked to announce every second. */
  readonly perSecond: number;
  readonly band: RateBand;
}

/**
 * Rung names in a running SRS config, in the order the entrypoint wrote them.
 *
 * Deduplicated, because a ladder generates a second vhost and a config that carried the transcode
 * block twice would otherwise double the rung count and refuse a stage that is fine.
 */
export function ladderRungs(srsConf: string): string[] {
  const seen = new Set<string>();
  for (const match of srsConf.matchAll(LADDER_ENGINE)) {
    seen.add(match[1]);
  }
  return [...seen];
}

function bandFor(perSecond: number): RateBand {
  if (perSecond <= MEASURED_SUSTAINED_PER_S) {
    return 'sustained';
  }
  return perSecond >= MEASURED_BROKEN_PER_S ? 'broken' : 'unmeasured';
}

/**
 * What the stage asks of SRS every second.
 *
 * A stage that transcodes nothing still segments the one rendition published into it, so it asks for
 * `1 / segmentSeconds`. Naming that rendition `single` rather than leaving the list empty keeps the
 * refusal readable and stops a caller reading "no rungs" as "no load".
 */
export function announcementLoad(rungs: readonly string[], segmentSeconds: number): AnnouncementLoad {
  if (!Number.isFinite(segmentSeconds) || segmentSeconds <= 0) {
    throw new Error(`A segment length of ${segmentSeconds}s is not a length, so nothing can be asked of it.`);
  }

  const named = rungs.length === 0 ? ['single'] : [...rungs];
  const perSecond = named.length / segmentSeconds;

  return { rungs: named, segmentSeconds, perSecond, band: bandFor(perSecond) };
}

function fitAt(load: AnnouncementLoad, perSecond: number): string {
  const seconds = load.rungs.length / perSecond;
  return `${seconds.toFixed(2)}s segments (${load.rungs.length} rungs / ${perSecond.toFixed(2)} a second)`;
}

/**
 * The sentence to fail a preflight with, or `null` when the rate is one a sitting has sustained.
 *
 * Takes the acknowledgement flag rather than reading `process.env` so the rule stays a pure function
 * and its tests do not have to mutate the environment.
 */
export function announcementRefusal(load: AnnouncementLoad, unmeasuredAcknowledged: boolean): string | null {
  if (load.band === 'sustained') {
    return null;
  }

  const asks =
    `The stage cuts ${load.segmentSeconds}s segments on ${load.rungs.length} rung(s) ` +
    `(${load.rungs.join(', ')}), so it asks SRS for ${load.perSecond.toFixed(2)} announcements a second.`;

  const mechanism =
    'SRS fires on_hls once per closed segment per rung. Past what it can dispatch it does not error: ' +
    'announcements fall behind the media until the lag passes hls_window, and then SRS deletes each ' +
    'segment before announcing it. The tallest rung is unpublished mid-broadcast and the master feed ' +
    'goes on advertising it, so the run looks healthy and silently measures a three-rung ladder.';

  const fix = `Set HLS_FRAGMENT so the ladder fits: ${fitAt(
    load,
    MEASURED_SUSTAINED_PER_S,
  )} is the highest rate a sitting has sustained.`;

  if (load.band === 'broken') {
    return (
      `${asks}\n\n${mechanism}\n\nA sitting at ${MEASURED_BROKEN_PER_S.toFixed(2)}/s lost 765 of 955 ` +
      `segments on the 1080p rung and unpublished it about two minutes in. This rate is at or above ` +
      `that and is refused with no override.\n\n${fix}`
    );
  }

  if (unmeasuredAcknowledged) {
    return null;
  }

  return (
    `${asks}\n\n${mechanism}\n\nThat is above the ${MEASURED_SUSTAINED_PER_S.toFixed(2)}/s a sitting ` +
    `has sustained and below the ${MEASURED_BROKEN_PER_S.toFixed(2)}/s one has been watched breaking ` +
    `at. Nothing has been run in between, so this refuses rather than guessing.\n\n${fix}\n\n` +
    `To run here on purpose, and measure the gap rather than assume it, set ${ACKNOWLEDGE_UNMEASURED}=true. ` +
    `Then read swarm_hls_rung_segments_uploaded_total per rung: one rung at zero while the others hold ` +
    `is this failure, and it is invisible in the unlabelled total.`
  );
}

/** One line for a run log, so a cleared run records the rate it ran at rather than only that it passed. */
export function announcementSummary(load: AnnouncementLoad): string {
  return (
    `${load.rungs.length} rung(s) at ${load.segmentSeconds}s asks ${load.perSecond.toFixed(2)} ` +
    `announcements/s (sustained band is at or below ${MEASURED_SUSTAINED_PER_S.toFixed(2)})`
  );
}
