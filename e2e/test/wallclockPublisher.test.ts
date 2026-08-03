import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { DEFAULT_KNOBS, type PublishKnobs, wallclockPublishArgs } from '../src/bench/wallclockPublisher.js';

/**
 * The publish recipe is the foundation of the whole measurement, and every flag below is one whose
 * removal produces a run that still succeeds and reports something wrong. That is what makes them
 * worth pinning: nothing downstream would go red.
 *
 * Each expectation here was measured against ffmpeg 7.1.1 on 2026-08-02, publishing this exact
 * argument list into a local HLS muxer and reading the timestamps back out. The numbers those runs
 * produced are quoted where they justify a choice.
 */

const ARGS = wallclockPublishArgs('srt://host:1935?streamid=live/stream', DEFAULT_KNOBS);

/** How many times `flag` appears, since two of these are per-input and appear more than once. */
function count(args: readonly string[], flag: string): number {
  return args.filter((arg) => arg === flag).length;
}

/** The value following `flag`, or undefined if it is absent. */
function valueAfter(args: readonly string[], flag: string): string | undefined {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
}

describe('the flags that make the stream measurable', () => {
  /**
   * Stamped on both inputs, not just the video. Measured: stamping the video alone produced **one**
   * segment in eight seconds where stamping both produced five, because the muxer is handed an audio
   * timeline starting at zero and a video timeline at the epoch and cannot interleave them.
   */
  it('stamps every input with the wall clock', () => {
    assert.equal(count(ARGS, '-use_wallclock_as_timestamps'), count(ARGS, '-i'));
    assert.equal(count(ARGS, '-i'), 2);
  });

  /**
   * Without `-copyts`, ffmpeg rebases the output to start at zero and the stamps are subtracted away.
   * The result is indistinguishable from a stream that never carried a clock, which is exactly the
   * case `wallclock.ts` has to reject, so a run would fail with a message blaming the media engine.
   */
  it('keeps the stamps instead of rebasing the output to zero', () => {
    assert.ok(ARGS.includes('-copyts'));
  });

  /**
   * Unpaced, the encoder pushes media faster than real time and every latency figure is meaningless,
   * so both streams have to be paced. The filters do it rather than `-re`, and this asserts the pair:
   * pacing present, `-re` absent.
   *
   * `-re` is not merely redundant here, it is incompatible with the stamping above. It sizes each
   * sleep by comparing the packet's timestamp against its own elapsed run time, and
   * `-use_wallclock_as_timestamps` gives it an absolute epoch value, so it can conclude it is decades
   * ahead and sleep effectively forever. The failure costs nothing to miss in review, because a
   * stalled publish writes nothing to stderr, stays alive, and sits at 0.0% CPU.
   *
   * The rate is load-sensitive and therefore lives in `pnpm bench:recipe` rather than here: a test
   * that tried to assert it would be measuring the machine it runs on. This asserts only the rule.
   */
  it('paces both streams without -re, which the wall-clock stamps make unusable', () => {
    assert.equal(count(ARGS, '-re'), 0);
    assert.equal(valueAfter(ARGS, '-vf'), 'realtime');
    assert.equal(valueAfter(ARGS, '-af'), 'arealtime');
  });

  /**
   * x264 inserts a keyframe on a scene change unless told not to, which makes the GOP knob an upper
   * bound rather than a cadence and lets segment boundaries wander with the content. A latency run
   * that varies the GOP has to actually vary it.
   */
  it('leaves keyframe placement to the GOP setting alone', () => {
    assert.equal(valueAfter(ARGS, '-sc_threshold'), '0');
  });
});

describe('the knobs a run varies', () => {
  it('turns a GOP in seconds into the frame count ffmpeg takes', () => {
    const knobs: PublishKnobs = { ...DEFAULT_KNOBS, fps: 25, gopSeconds: 4 };

    assert.equal(valueAfter(wallclockPublishArgs('srt://h', knobs), '-g'), '100');
  });

  it('rounds a GOP that does not land on a whole frame, rather than passing a fraction', () => {
    const knobs: PublishKnobs = { ...DEFAULT_KNOBS, fps: 30, gopSeconds: 1.5 };

    assert.equal(valueAfter(wallclockPublishArgs('srt://h', knobs), '-g'), '45');
  });

  it('carries the frame size and rate into the source', () => {
    const knobs: PublishKnobs = { ...DEFAULT_KNOBS, size: '854x480', fps: 24 };

    assert.ok(wallclockPublishArgs('srt://h', knobs).includes('testsrc2=size=854x480:rate=24'));
  });

  it('carries the video bitrate', () => {
    const knobs: PublishKnobs = { ...DEFAULT_KNOBS, videoBitrateKbps: 4_000 };

    assert.equal(valueAfter(wallclockPublishArgs('srt://h', knobs), '-b:v'), '4000k');
  });

  it('publishes to the url it was given, as the last argument', () => {
    assert.equal(ARGS.at(-1), 'srt://host:1935?streamid=live/stream');
    assert.deepEqual(ARGS.slice(-3, -1), ['-f', 'mpegts']);
  });
});
