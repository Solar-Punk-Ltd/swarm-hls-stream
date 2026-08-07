/**
 * Reports the picture stopping, which is the only symptom of a gateway that is slow rather than
 * absent.
 *
 * Taken from the media element rather than from hls.js, and deliberately in the same units the bench
 * reports are denominated in: `rebufferCount` there is a `waiting` after the first `playing`,
 * de-duplicated per stall. `PLAYBACK_STALL_BURST` was measured against those reports, so counting it
 * the same way here means the threshold is read in the units it was derived in rather than
 * translated into them.
 *
 * @param onStall Called once per stall. Never during startup, and never after the broadcast ends.
 */
export function attachPlaybackStallReporter(media: HTMLMediaElement, onStall: () => void): () => void {
  let hasPlayed = false;
  let isStalled = false;
  let hasEnded = false;

  const onPlaying = () => {
    hasPlayed = true;
    isStalled = false;
  };

  const onWaiting = () => {
    // Startup is buffering rather than a fault, and it is the one moment `waiting` is guaranteed, so
    // without the first guard the overlay appears on the join of every stream. The second collapses
    // the repeats Chrome emits when a seek or a rate change lands inside a buffer that is already
    // starved, which would otherwise let one stall trip a threshold meant to need four.
    if (!hasPlayed || isStalled || hasEnded) {
      return;
    }
    isStalled = true;
    onStall();
  };

  // A finished broadcast starves its buffer exactly as a failing one does. The feed state has its own
  // terminal message for that, and a stall counted on the way out competes with it for the last thing
  // the viewer is told.
  const onEnded = () => {
    hasEnded = true;
  };

  media.addEventListener('playing', onPlaying);
  media.addEventListener('waiting', onWaiting);
  media.addEventListener('ended', onEnded);

  return () => {
    media.removeEventListener('playing', onPlaying);
    media.removeEventListener('waiting', onWaiting);
    media.removeEventListener('ended', onEnded);
  };
}
