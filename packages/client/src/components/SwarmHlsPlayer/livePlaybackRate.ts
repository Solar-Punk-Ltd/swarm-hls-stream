import type Hls from 'hls.js';

import { MAX_LIVE_SYNC_PLAYBACK_RATE } from './playerConfig';

/** The value hls.js reads as "leave the playback rate alone", which is also its own default. */
const CATCH_UP_OFF = 1;

/**
 * Whether a rate is one the catch-up could have produced.
 *
 * hls.js only ever writes rates between 1 and `maxLiveSyncPlaybackRate` inclusive, so anything
 * outside that came from the viewer. Exactly 1 is the one value both could have written, and it is
 * read as the viewer asking for ordinary speed, which is what catch-up assumes anyway.
 */
function isCatchUpRate(rate: number): boolean {
  return rate >= CATCH_UP_OFF && rate <= MAX_LIVE_SYNC_PLAYBACK_RATE;
}

/**
 * Stops the live catch-up from taking the viewer's playback speed away from them.
 *
 * The catch-up is a branch hls.js runs on every `timeupdate`, and its else half is the problem: any
 * time the drift is not in the range worth nudging, it writes the rate back to 1. So a viewer who
 * picks 1.5x from the native controls, which this player enables, is returned to 1x within a second
 * on every live stream, with nothing said. Enabling catch-up at all means answering that first.
 *
 * A rate the catch-up could not have written is treated as the viewer's, and turns the catch-up off
 * for as long as they keep it. Returning to 1x hands it back, which is unambiguous while it is off,
 * because nothing else is writing the rate then.
 *
 * Turning it off means writing to `hls.config`, which the latency controller reads live on each
 * tick. hls.js offers no setter for a running player, and its own `Hls#config` is the object that
 * controller holds, so this is the supported way to change it after construction.
 */
export function attachLivePlaybackRateGuard(media: HTMLMediaElement, hls: Hls): () => void {
  const onRateChange = () => {
    hls.config.maxLiveSyncPlaybackRate = isCatchUpRate(media.playbackRate) ? MAX_LIVE_SYNC_PLAYBACK_RATE : CATCH_UP_OFF;
  };

  media.addEventListener('ratechange', onRateChange);
  return () => {
    media.removeEventListener('ratechange', onRateChange);
  };
}
