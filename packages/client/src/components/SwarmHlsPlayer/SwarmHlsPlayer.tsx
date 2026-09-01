import React, { useEffect, useRef, useState } from 'react';
import { Topic } from '@ethersphere/bee-js';
import Hls, { ErrorDetails, ErrorTypes, Events } from 'hls.js';

import { MEDIA_TYPE_VIDEO, MediaType, Rendition } from '@/types/stream';

import { FeedStateOverlay } from './overlays/feed/FeedStateOverlay';
import { QoeOverlay } from './overlays/qoe/QoeOverlay';
import { attachQoeTracking, initialMetrics, QoeMetrics } from './overlays/qoe/useHlsQoeMetrics';
import { CustomFragmentLoader, CustomManifestLoader, manifestFetcher } from './CustomManifestLoader';
import { FEED_STATE_LIVE, FeedState } from './feedState';
import { attachLivePlaybackRateGuard } from './livePlaybackRate';
import { ManifestStateManager } from './ManifestManagement';
import { nextMediaErrorAction, NO_MEDIA_ERRORS_YET, recoverFromMediaError } from './mediaErrorRecovery';
import { attachPlaybackStallReporter } from './playbackHealth';
import { buildPlayerConfig, HLS_TUNING } from './playerConfig';
import { exposePlayerForInstrumentation } from './playerTestHandle';
import { buildSwarmUri } from './playlist';
import { attachRungFailover, attachWatchedRungReporter } from './rungHealth';

import './SwarmHlsPlayer.scss';

/** Pins playback to a named rung; `AUTO_LEVEL` hands the choice back to hls.js's ABR. */
export const AUTO_LEVEL = 'auto';

// TODO Consider switching to React.MediaHTMLAttributes<HTMLMediaElement> to support <audio> as well
/**
 * The settings this component lets a caller retune.
 *
 * Deliberately narrower than `Partial<HlsConfig>`: that type also advertises `xhrSetup`, `loader`,
 * `abrController` and friends, none of which survive the serialisation below, so promising them
 * would let a caller write code that compiles and silently never runs.
 */
export interface HlsTuning {
  liveSyncDuration?: number;
  liveMaxLatencyDuration?: number;
  maxLiveSyncPlaybackRate?: number;
  maxBufferLength?: number;
  maxMaxBufferLength?: number;
  maxBufferSize?: number;
  maxBufferHole?: number;
  abrEwmaFastLive?: number;
  abrEwmaSlowLive?: number;
  abrEwmaDefaultEstimate?: number;
  abrBandWidthFactor?: number;
  abrBandWidthUpFactor?: number;
  maxStarvationDelay?: number;
  capLevelToPlayerSize?: boolean;
  testBandwidth?: boolean;
}

/**
 * How this player is tuned for a Swarm-backed live stream.
 *
 * Exported so a caller can start from these numbers and override only what it needs, rather than
 * rediscover them. They are deliberately not hls.js's own defaults.
 *
 * The one worth knowing about is `liveSyncDuration`. It is a latency *target*: hls.js parks the
 * playhead that many seconds behind the live edge (`latency-controller.ts`, `targetLatency` then
 * `liveSyncPosition = liveEdge - targetLatency`), and that distance is the same at any segment
 * length. hls.js's own default is `liveSyncDurationCount: 3`, a count multiplied by the playlist's
 * target duration, which does track segment length. Setting one of these forbids the other:
 * `mergeConfig` throws on a config carrying both.
 *
 * What this has to be checked against is not segment length but the engine's **playlist window**,
 * because `liveSyncPosition` is clamped to `edge - levelDetails.totalduration`. A target as long as
 * the window parks the playhead on the oldest fragment, at the eviction boundary. The two engines
 * express that window differently, so the margin differs: SRS's `hls_window` is a duration and
 * holds regardless of fragment length, while OME's is `SegmentCount x SegmentDuration`, which at
 * its defaults is 5 x 2s = 10s, exactly this value.
 */
export const DEFAULT_HLS_TUNING: Readonly<HlsTuning> = Object.freeze({
  // Spread rather than restated. These are the buffering and latency numbers of
  // {@link HLS_TUNING}, each derived from a measurement recorded beside it, and a second copy here
  // is a second place for them to be wrong: the copy this replaces had drifted back to
  // `liveSyncDuration: 10` and `liveMaxLatencyDuration: 30`, which is the pair `playerConfig.ts`
  // names as leaving a viewer between the end of catch-up and the start of the seek with neither
  // running, and it omitted `maxLiveSyncPlaybackRate` altogether, which is LAT-2.
  ...HLS_TUNING,

  // --- ABR ---
  //
  // hls.js computes throughput as `bytes / (loading.end - loading.first)`. Over a CDN that is a
  // measurement of a pipe. Over Swarm it is not: a 2s 1080p segment is a few hundred chunks fanned
  // out across neighbourhoods, and the elapsed time is dominated by retrieval latency rather than
  // by any rate. Consecutive samples therefore swing hard, and hls.js's default half-lives turn
  // that swing into level flapping — so both are lengthened well past them (3 and 9).
  abrEwmaFastLive: 9,
  abrEwmaSlowLive: 27,

  // A floor only. Once the ladder has been parsed, {@link startAtTopRung} raises the estimate to
  // whatever the top rung needs, because any fixed number here is a guess that the ABR gate then
  // treats as a hard ceiling. This value is what a session runs on for the brief window before the
  // master is read, and for a single-rendition stream, where it changes nothing.
  abrEwmaDefaultEstimate: 2_000_000,

  // hls.js's startup probe fetches the first fragment at a low level to measure throughput. That
  // measurement is retrieval latency here, so it produces a number that is not bandwidth; the
  // seeded estimate is the more honest input.
  testBandwidth: false,

  // Off, and this is load-bearing rather than a preference. `capLevelToPlayerSize` caps ABR at the
  // first rung whose width or height reaches `max(playerWidth, playerHeight) x devicePixelRatio`,
  // and it sets `autoLevelCapping`, which ABR cannot exceed for any bandwidth. In a 420px-wide
  // player at devicePixelRatio 1 that resolves to 640x360 — the bottom rung, pinned there
  // permanently and regardless of how fast Swarm is answering. Sizing the ladder to the box is the
  // right production default; it is the wrong thing to leave on while measuring what the ladder can
  // reach. See the watch page, which is laid out wide for the same reason.
  capLevelToPlayerSize: false,

  // Restated at hls.js's own defaults rather than changed. They are here to be swept from a caller
  // during the POC without editing this file; there is no evidence yet for moving them.
  abrBandWidthFactor: 0.95,
  abrBandWidthUpFactor: 0.7,
  maxStarvationDelay: 4,
});

/**
 * A tuning override, reduced to the values it can actually apply and the ones it can survive.
 *
 * Restricted to the keys above for a reason that is not tidiness: `mergeConfig` refuses a config
 * carrying both `liveSyncDuration` and `liveSyncDurationCount`, and these defaults always supply
 * the first, so letting the second through would throw inside the effect and take the tree down.
 *
 * Non-finite numbers are dropped rather than passed through, because `JSON` turns `NaN` and
 * `Infinity` into `null`, and a `null` here does not fall back to the default, it replaces it.
 * `maxBufferLength: null` reaches hls.js as `Math.max(null, …)`, which is zero, and a player that
 * buffers nothing stalls forever. `Number(searchParams.get('buf'))` on bad input hits exactly this.
 * Booleans have no such hazard and survive the round trip as themselves.
 *
 * Sorted, so a config assembled in a different key order is still the same config and does not
 * tear the player down and rebuild it mid-playback.
 */
function tuningKey(tuning: HlsTuning): string {
  const tunable = new Set(Object.keys(DEFAULT_HLS_TUNING));
  const usable = Object.entries(tuning)
    .filter((entry): entry is [string, number | boolean] => {
      const [key, value] = entry;
      return tunable.has(key) && (typeof value === 'boolean' || Number.isFinite(value));
    })
    .sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify(Object.fromEntries(usable));
}

/**
 * Identity of a ladder, by the only parts of it the player has to be rebuilt for.
 *
 * Deliberately excludes bandwidth. The uploader keeps correcting each rung's measured bandwidth,
 * and rebuilding the player every time it did would restart playback every half minute. A session
 * therefore runs on the bandwidths that had landed by the time hls.js read the master — which for
 * a live stream is once, at the start — and later corrections benefit later sessions.
 */
function ladderKey(renditions: Rendition[] | undefined): string {
  if (!renditions || renditions.length === 0) {
    return '';
  }

  return renditions.map((r) => `${r.name}:${r.topic}`).join('|');
}

/** The rung to aim at: tallest, and among equals the one carrying the most bits. */
function topLevelIndex(levels: readonly { height: number; maxBitrate: number }[]): number {
  return levels.reduce((best, level, index) => {
    const incumbent = levels[best];
    const taller = level.height > incumbent.height;
    const fatter = level.height === incumbent.height && level.maxBitrate > incumbent.maxBitrate;
    return taller || fatter ? index : best;
  }, 0);
}

/**
 * Starts the session on the top rung and lets measurement bring it down, rather than starting at
 * the bottom and waiting for measurement to let it up.
 *
 * The second is what hls.js does by default and it cannot work over Swarm. `findBestLevel` will
 * only move up to a rung when `abrBandWidthUpFactor x bandwidthEstimate >= BANDWIDTH`, and
 * `bandwidthEstimate` moves only on fragments actually fetched — with `testBandwidth` off there is
 * no probe, and a probe would measure retrieval latency rather than a rate anyway. So a viewer
 * fetching 700 kbps segments measures roughly 700 kbps, concludes 700 kbps is all it can afford,
 * and never tries the rung that would have told it otherwise. The floor is self-fulfilling.
 *
 * Seeding the estimate at exactly what the top rung needs under the up-switch factor inverts that:
 * the whole ladder is affordable from cold, and the first real fragments then move the estimate.
 * If Swarm keeps up it stays high; if it does not, the EWMA falls and — faster — the starvation
 * path in `findBestLevel` drops the level as the buffer drains. Falling back on evidence, rather
 * than never climbing for want of it.
 *
 * The cost is an honest one: the first fragment is a top-rung fragment, so a viewer on a slow
 * gateway pays a slower startup before the first down-switch. That is the trade this branch is
 * making, and it is what `abrEwmaFastLive` governs the speed of.
 */
function startAtTopRung(hls: Hls): void {
  const levels = hls.levels;
  if (levels.length < 2) {
    return;
  }

  // Clamped because this is a divisor and the factor is caller-tunable for exactly this kind of
  // sweep. A zero would seed an infinite estimate, which hls.js then multiplies by the same zero
  // and compares as NaN — no rung is ever selectable and playback simply never starts.
  const upFactor = Math.min(Math.max(hls.config.abrBandWidthUpFactor, 0.1), 1);
  const top = topLevelIndex(levels);
  const affordable = levels[top].maxBitrate / upFactor;

  // Never downward: a caller that deliberately seeded higher keeps its number.
  hls.bandwidthEstimate = Math.max(hls.config.abrEwmaDefaultEstimate, Math.round(affordable));

  // `startLevel` picks the first fragment only, and leaves ABR enabled — unlike `currentLevel`,
  // which would pin the session to this rung for good.
  hls.startLevel = top;
}

/**
 * Pins hls.js to one rung. Called only when a rung was asked for; otherwise ABR chooses.
 *
 * Matched by feed URI where the catalog supplied one, because a rung's topic is the one attribute
 * of a level that came from this ladder and cannot collide with another rung's. Falling back to the
 * height in the rung's name covers the session driven purely by a published master, which knows
 * every level's resolution but has no rendition names to match against.
 *
 * Assigning `currentLevel` is also what turns ABR off — a `startLevel` alone only picks where it
 * begins, and it would switch away on the first throughput sample.
 */
function applyLevel(hls: Hls, owner: string, renditions: Rendition[], level: string): void {
  const target = renditions.find((r) => r.name === level);

  const index = target
    ? hls.levels.findIndex((candidate) => candidate.uri === buildSwarmUri(owner, target.topic))
    : levelIndexByName(hls, level);

  if (index < 0) {
    console.warn(`Rendition "${level}" is not among the parsed levels, leaving selection on auto`);
    return;
  }

  hls.currentLevel = index;
}

/** `720p` -> the parsed level 720 rows tall, so a rung can be pinned without a catalog entry. */
function levelIndexByName(hls: Hls, level: string): number {
  const height = Number.parseInt(level, 10);
  if (!Number.isFinite(height)) {
    return -1;
  }

  return hls.levels.findIndex((candidate) => candidate.height === height);
}

interface HlsPlayerProps extends React.VideoHTMLAttributes<HTMLVideoElement> {
  owner: string;
  topicString: string;
  mediaType: MediaType;
  enableQoeOverlay?: boolean;
  /**
   * The stream's ABR ladder. Absent or empty, the player reads `topicString` as a single media
   * playlist exactly as it always has.
   */
  renditions?: Rendition[];
  /**
   * Rung to pin playback to, by name. Omitted, or {@link AUTO_LEVEL}, leaves the choice to ABR,
   * which is the default. Pinning is for isolating one rung — comparing it against the others, or
   * telling a bad rung apart from a bad switch. Ignored without a ladder.
   */
  level?: string;
  /**
   * Overrides merged over {@link DEFAULT_HLS_TUNING}.
   *
   * Compared by value rather than by reference, so passing an object literal is safe: it does not
   * hand the effect a new identity on every render and tear the player down mid-playback. A change
   * in the values themselves does rebuild the player, which loses playback position.
   */
  hlsConfig?: HlsTuning;
}

/** The key both the manifest state and the feed state are held under. Null if the name is unusable. */
function toHexTopic(topicString: string): string | null {
  try {
    return Topic.fromString(topicString).toString();
  } catch (error) {
    console.warn('Not a usable topic name:', topicString, error);
    return null;
  }
}

export const SwarmHlsPlayer: React.FC<HlsPlayerProps> = ({
  owner,
  topicString,
  mediaType,
  autoPlay = true,
  controls = true,
  enableQoeOverlay = false,
  renditions,
  level,
  hlsConfig,
  ...videoProps
}) => {
  const [restartTrigger, setRestartTrigger] = useState(0);
  const [metrics, setMetrics] = useState<QoeMetrics>(initialMetrics);
  const [feedState, setFeedState] = useState<FeedState>(FEED_STATE_LIVE);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsConfigKey = tuningKey(hlsConfig ?? {});
  const renditionKey = ladderKey(renditions);

  // Read through a ref, not a dependency. The catalog is polled every few seconds and hands back
  // a fresh array each time, so depending on it directly would tear the player down and rebuild
  // it on every poll. `renditionKey` is what the effect actually reacts to.
  const renditionsRef = useRef(renditions);
  renditionsRef.current = renditions;

  // Deliberately not part of the effect below, which reruns on every restart. A fatal network error
  // is what causes a restart, so a subscription torn down and rebuilt with the player would be
  // dropped at exactly the moment it has something to say. The tracker replays on subscribe, so a
  // mount that lands in the middle of an outage still hears about it.
  useEffect(() => {
    const hexTopic = toHexTopic(topicString);
    if (!hexTopic) {
      return;
    }
    return manifestFetcher.feedHealth.subscribe(hexTopic, setFeedState);
  }, [topicString]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) {
      return;
    }

    const sourceUrl = buildSwarmUri(owner, topicString);
    const ladder = renditionsRef.current;

    // A ladder the catalog knows about. Only the fallback path needs this — a stream whose feed
    // holds a published master is recognised by the loader from the master itself, catalog or not.
    const isLadder = renditionKey.length > 0 && !!ladder;

    if (isLadder) {
      manifestFetcher.registerLadder(sourceUrl, () => ({
        owner,
        renditions: renditionsRef.current ?? ladder,
      }));
    }

    let hls: Hls | null = null;

    const onHlsPause = () => {
      hls?.stopLoad();
    };
    const onHlsPlay = () => {
      hls?.startLoad();
    };

    if (Hls.isSupported()) {
      hls = new Hls(
        buildPlayerConfig(
          { pLoader: CustomManifestLoader, fLoader: CustomFragmentLoader },
          { ...DEFAULT_HLS_TUNING, ...(JSON.parse(hlsConfigKey) as HlsTuning) },
        ),
      );

      const restartStream = () => {
        console.warn('Restarting stream due to manifest parsing error.');
        hls?.destroy();
        setRestartTrigger((prev) => prev + 1);
      };

      // Held across errors rather than inside the handler, because the escalation is about how many
      // failures arrived in a row and a per-event value cannot remember that.
      let mediaErrors = NO_MEDIA_ERRORS_YET;

      video.addEventListener('pause', onHlsPause);
      video.addEventListener('play', onHlsPlay);

      hls.on(Events.ERROR, (_event, data) => {
        if (data.fatal) {
          console.error('HLS.js fatal error:', data.type, data.details);
        } else {
          console.warn('HLS.js non-fatal error:', data.details, data.error?.message ?? '');
          return;
        }

        if (data.details === ErrorDetails.LEVEL_PARSING_ERROR) {
          console.error('Media sequence mismatch detected, reloading stream.');
          restartStream();
          return;
        }

        switch (data.type) {
          case ErrorTypes.NETWORK_ERROR:
            console.warn('Fatal network error');
            restartStream();
            break;
          case ErrorTypes.MEDIA_ERROR: {
            // ⛔ Recovery re-appends the media that just failed, so calling it on every fatal media
            // error with no window and no ending is an unbounded loop that refetches fragments each
            // turn. A broadcast whose opening media a decoder will not accept used to leave a viewer
            // on a black player pulling media for as long as the tab stayed open.
            const decision = nextMediaErrorAction(mediaErrors, performance.now());
            mediaErrors = decision.state;
            console.warn(`Fatal media error, ${decision.action}`);
            if (decision.action === 'restart') {
              restartStream();
              break;
            }
            // Playhead read before recovery detaches the media. recoverFromMediaError starts loading
            // by hand when it is zero, which is the case autoStartLoad off leaves stopped for good.
            if (hls) {
              recoverFromMediaError(hls, video.currentTime, decision.action === 'swap-codec-and-recover');
            }
            break;
          }
          default:
            console.error('Unrecoverable fatal error. Destroying and restarting.');
            restartStream();
            break;
        }
      });

      hls.attachMedia(video);
      hls.loadSource(sourceUrl);

      hls.on(Events.MANIFEST_PARSED, () => {
        // The ladder is whatever hls.js parsed, not whatever the catalog said: a published master
        // is the authority on which rungs exist, and a deep link may have had no catalog at all.
        const pinned = !!level && level !== AUTO_LEVEL;
        if (pinned) {
          applyLevel(hls!, owner, renditionsRef.current ?? ladder ?? [], level!);
        } else {
          startAtTopRung(hls!);
        }

        hls!.startLoad();

        if (autoPlay) {
          video.play().catch((err) => {
            console.warn('Auto-play failed:', err);
          });
        }
      });
    } else {
      console.error('HLS is not supported in this browser.');
    }

    const detachQoe = enableQoeOverlay ? attachQoeTracking(video, hls, setMetrics) : null;
    const detachRateGuard = hls ? attachLivePlaybackRateGuard(video, hls) : null;
    const detachTestHandle = hls ? exposePlayerForInstrumentation(hls) : null;

    // ⛔ Both halves of what a ladder viewer needs when one rung stops being produced, and neither
    // works alone: the failover moves the picture, the reporter is what lets the overlay say so
    // during the seconds before it does. A single-rendition stream gets neither, because there is
    // no second rung to move to and nothing for a group's health to be folded from.
    //
    // ⛔⛔⛔ **This was OFF from 2026-08-31 to 2026-09-01, and the condition it was waiting on has
    // been met. Read all of this before touching it again.**
    //
    // Seven attempts at the rule, and three of them amputated THREE OF FOUR HEALTHY RUNGS during the
    // settle, before any fault was injected, on three consecutive live runs. That is worse than the
    // defect it exists to fix: the defect freezes one viewer on one dead rung, this destroys the
    // ladder on a broadcast where nothing is wrong. `a7b7220` switched it off.
    //
    // ⭐⭐⭐ **It was switched off "until the stage under it is understood", and the stage is now
    // understood.** That commit's own reasoning is the reason this is back on: fourteen artifacts
    // said a live viewer took 0.76 to 1.49 segments a second against the 2.00 that 0.5s segments
    // need, with no fault injected, so every rung looked sick and a rule that compares rungs was
    // reading the starvation rather than a dead rung.
    //
    // That starvation had a cause and it was not the client. SRS fires `on_hls` once per closed
    // segment per rung, so a four-rung ladder at 0.5s asked for 8.00 announcements a second against
    // the ~6.7 SRS was measured sustaining. It never errored: announcements fell behind the media at
    // 0.46s per second of video until the lag passed `hls_window`, and then SRS deleted each segment
    // before announcing it. Every rung really was intermittently silent, and the 1080p rung really
    // was dying about two minutes in, on every broadcast the rule was ever judged against.
    //
    // The stage moved to 1.0s segments on 2026-09-01 and asks 4.00/s. Verified over 600s: every rung
    // delivered at 1.00/s, announcement lag flat at 0.0s across 580 segments, ZERO segments lost on
    // any rung. `suites/preflight/announcement-rate` refuses a stage that goes back over the line.
    //
    // ⭐ And the rule itself changed before it was switched off, which is why this is not attempt
    // eight of the same thing. `6846309` judges a dead rung by **segments the ladder delivered that
    // this rung did not**, never by a clock. All three amputations were clocks, and a clock runs
    // during intervals in which nothing could have been served, so it measures the outage rather
    // than the rung. A delivered-segment count freezes when the whole stage freezes. See
    // `RUNG_DEATH_LAG_SEGMENTS` in `feedState.ts`.
    //
    // ⚠️ **What is still unproven: this rule has never run live at all.** It was written after the
    // third amputation and switched off before it was ever armed on a stage. The 102 tests in
    // `test/rungHealth.test.ts` and `test/feedState.test.ts` encode seven live faults and are the
    // specification, and they pass, but a green spec is not an arm. The next live ladder run is the
    // first real evidence either way, and the thing to watch for is the old failure: rungs dropped
    // during the settle with no fault injected.
    //
    // The reporter stays on either way. It is measured and it works: a viewer on a dead rung is
    // told the feed has stalled rather than being shown `live`.
    const RUNG_FAILOVER_ENABLED = true;
    const ladderTopic = isLadder ? toHexTopic(topicString) : null;
    const detachRungFailover =
      hls && RUNG_FAILOVER_ENABLED ? attachRungFailover(hls, manifestFetcher.feedHealth) : null;
    const detachWatchedRung =
      hls && ladderTopic ? attachWatchedRungReporter(hls, ladderTopic, manifestFetcher.feedHealth) : null;

    // Attached with the player rather than with the subscription above, because it is the player
    // that stalls: a restart builds a fresh media pipeline and the stalls of the one before it are
    // not the new one's. The burst they feed lives in the tracker, which does outlive the restart.
    const stallTopic = toHexTopic(topicString);
    const detachStallReporter = stallTopic
      ? attachPlaybackStallReporter(video, () => manifestFetcher.feedHealth.recordPlaybackStall(stallTopic))
      : null;

    return () => {
      video.removeEventListener('pause', onHlsPause);
      video.removeEventListener('play', onHlsPlay);
      detachQoe?.();
      detachRateGuard?.();
      detachStallReporter?.();
      detachTestHandle?.();
      detachRungFailover?.();
      detachWatchedRung?.();

      // Stops every rung's walk and discards its accumulated playlist, including rungs discovered
      // from a published master that this component never saw.
      manifestFetcher.unregisterLadder(sourceUrl);

      if (hls) {
        // The source feed, on top of the rungs `unregisterLadder` has already stopped. For a
        // single-rendition stream it is the media playlist and holds the only state there is; for a
        // ladder it is the master, and clearing it is a no-op. Leaving either behind would have the
        // next session resume someone else's playlist.
        //
        // The destroy runs whatever the clear does. Losing it leaks the loaders and the media
        // attachment of every player the page has ever mounted, and a cleanup that throws takes the
        // rest of React's cleanup with it, so this is not a guarantee to drop for tidiness.
        try {
          const hexTopic = toHexTopic(topicString);
          if (hexTopic) {
            ManifestStateManager.getInstance().clear(hexTopic);
          }
        } finally {
          hls.destroy();
          hls = null;
        }
      }
    };
  }, [autoPlay, restartTrigger, enableQoeOverlay, owner, topicString, hlsConfigKey, renditionKey, level]);

  const videoEl =
    mediaType === MEDIA_TYPE_VIDEO ? (
      <video ref={videoRef} controls={controls} autoPlay={autoPlay} muted playsInline {...videoProps} />
    ) : (
      <audio
        className="swarm-hls-player-audio"
        ref={videoRef as React.RefObject<HTMLAudioElement>}
        controls={controls}
        autoPlay={autoPlay}
      />
    );

  return (
    <div className="swarm-hls-player-wrapper">
      {videoEl}
      <FeedStateOverlay state={feedState} />
      {enableQoeOverlay && <QoeOverlay metrics={metrics} />}
    </div>
  );
};
