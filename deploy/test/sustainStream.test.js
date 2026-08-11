import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

/**
 * ⭐ The probe used to hardcode one owner and topic, and every in-browser sitting before 2026-08-11
 * ran against it without anyone ever choosing it. That stream is the latency bench profile,
 * `HLS_FRAGMENT=0.25`, which is not what we ship, and the results were written up as being about our
 * product. So the selector is not a convenience, it is the guard against repeating that, and an
 * unset stream has to throw rather than fall back to anything at all.
 *
 * The probe is a self-executing browser script by design, pasted or fetched into a console, so there
 * is nothing to import. It is evaluated here with the three globals it touches before it would reach
 * the network.
 */

const SOURCE = readFileSync(
  fileURLToPath(new URL('../scripts/in-browser-sustain.js', import.meta.url)),
  'utf-8',
);

const STREAM_NAMES = ['latbench', 'abel-1', 'abel-2'];

const BYTES_PER_KB = 1024;
const BITS_PER_BYTE = 8;
/** Bitrates are decimal megabits by convention, while the KB beside them is binary. Mixing the two
 * moves a figure by 4.9%, which is small enough to look like a rounding difference and be kept. */
const BITS_PER_MEGABIT = 1e6;

/**
 * Runs the probe against stub globals and returns what the console would have seen.
 *
 * `querySelectorAll` returning nothing is deliberate: with peers already full the script goes
 * straight on to attach a stream, finds no navigation input, and records the failure on `__sustain`
 * instead of opening a socket. Every assertion here is about what happened before that point.
 */
function arm(window, { visible = true } = {}) {
  const document = {
    visibilityState: visible ? 'visible' : 'hidden',
    body: { innerText: 'Connected: 200 Connecting: 0' },
    querySelectorAll: () => [],
  };
  const console = { log: () => {}, error: () => {} };
  // Bound to a name rather than returned directly: the probe opens with a comment block, and
  // `return` followed by a line terminator is `return;`, so the script would never run at all.
  const body = `const armed = ${SOURCE}\nreturn armed;`;
  const value = new Function('window', 'document', 'console', body)(window, document, console);
  return { value, sustain: window.__sustain };
}

describe('in-browser sustain probe, choosing a stream', () => {
  it('refuses to run when no stream is chosen', () => {
    assert.throws(() => arm({}), /Refusing to run: set window\.__sustainStream/);
  });

  it('names every stream it knows in the refusal, so the fix is in the error', () => {
    assert.throws(() => arm({}), /latbench.*abel-1.*abel-2/);
  });

  it('refuses an unknown stream rather than falling back to a default', () => {
    assert.throws(() => arm({ __sustainStream: 'ours' }), /Refusing to run/);
  });

  it('still refuses a hidden document once a stream is chosen', () => {
    assert.throws(
      () => arm({ __sustainStream: 'abel-1' }, { visible: false }),
      /document is not visible/,
    );
  });

  it('reports which stream it armed on, so a pasted result carries its scope', () => {
    const { value } = arm({ __sustainStream: 'abel-1' });

    assert.match(value, /armed on 'abel-1'/);
    assert.match(value, /8\.34 Mbps/);
  });

  it('records the stream on the object the raw samples are saved from', () => {
    const { sustain } = arm({ __sustainStream: 'abel-2' });

    assert.equal(sustain.stream.name, 'abel-2');
    assert.equal(sustain.stream.owner, '47535bf0835ff9cb1c7c7cb4f44fa514f58e703d');
    assert.equal(sustain.stream.segmentSeconds, 4.166667);
  });

  it('marks the replicate whose segment shape was assumed rather than read', () => {
    const { sustain } = arm({ __sustainStream: 'abel-2' });

    assert.match(sustain.stream.what, /ASSUMED/);
  });

  it('keeps the bench profile reachable, so the sittings that used it can be reproduced', () => {
    const { sustain } = arm({ __sustainStream: 'latbench' });

    assert.equal(sustain.stream.segmentSeconds, 0.266);
    assert.match(sustain.stream.what, /do not ship/);
  });
});

/** A sample in the shape the probe records, one per wall second. */
const at = (t, ct, extra = {}) => ({ t, ct, rs: 4, paused: false, buffEnd: ct + 10, ...extra });

/** Drives the summary over a prepared set of samples, as a finished run would. */
function summarise(samples, { firstAdvanceAt = 0, stream = 'abel-1' } = {}) {
  const { sustain } = arm({ __sustainStream: stream });
  sustain.samples = samples;
  sustain.firstAdvanceAt = firstAdvanceAt;
  return sustain.summarise();
}

describe('in-browser sustain probe, scoring a run', () => {
  it('does not charge time before the first frame against the stream', () => {
    // Five seconds of startup, then a playhead that keeps perfect time.
    const samples = [
      at(0, 0, { rs: 0 }),
      at(5000, 0, { rs: 0 }),
      at(6000, 1),
      at(105000, 100),
    ];

    const summary = summarise(samples, { firstAdvanceAt: 6000 });

    assert.equal(summary.realtimeRatio, 1);
    assert.ok(summary.realtimeRatioWithStartup < 1, 'the unadjusted figure still carries startup');
  });

  it('counts seconds lost to a playhead that advances slowly but never quite stops', () => {
    // 0.9s of playhead per wall second: no sample ever repeats, so nothing reads as a stall.
    const samples = Array.from({ length: 101 }, (_, i) => at(i * 1000, i * 0.9));

    const summary = summarise(samples, { firstAdvanceAt: 0 });

    assert.equal(summary.stallCount, 0);
    assert.equal(summary.realtimeRatio, 0.9);
    assert.equal(summary.lostS, 10);
  });

  it('reports the stream and its demand beside the ratio', () => {
    const summary = summarise([at(0, 0), at(100000, 100)], { firstAdvanceAt: 0 });

    assert.equal(summary.stream, 'abel-1');
    assert.equal(summary.demandedKBps, 1018);
    assert.equal(summary.derivedDeliveredKBps, 1018);
  });
});

describe('in-browser sustain probe, the stream table', () => {
  /**
   * The bitrate in each description is what a reader quotes, and the two numbers beside it are what
   * the summary divides to state the demand. A table whose prose and arithmetic disagree would put a
   * wrong bitrate into a write-up while every computed figure stayed right, which is the harder
   * version of the mistake to catch.
   */
  for (const name of STREAM_NAMES) {
    it(`states a bitrate for ${name} that its own segment figures produce`, () => {
      const { stream } = arm({ __sustainStream: name }).sustain;
      const claimed = Number(stream.what.match(/([\d.]+) Mbps/)[1]);

      const derived =
        (stream.segmentKB * BYTES_PER_KB * BITS_PER_BYTE) /
        BITS_PER_MEGABIT /
        stream.segmentSeconds;

      assert.ok(
        Math.abs(derived - claimed) / claimed < 0.02,
        `${name}: description says ${claimed} Mbps, segments give ${derived.toFixed(2)}`,
      );
    });
  }
});
