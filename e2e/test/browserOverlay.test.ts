import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { type OverlayRow, parseOverlayNumber, readOverlayMetrics } from '../src/browser/overlay.js';

/** The overlay as it renders once a stream is playing, in the units its own formatters emit. */
const PLAYING: OverlayRow[] = [
  { section: 'Startup', label: 'Startup Time', value: '1843 ms' },
  { section: 'Rebuffering', label: 'Count', value: '0' },
  { section: 'Rebuffering', label: 'Duration', value: '0 ms' },
  { section: 'Quality', label: 'Delivered Resolution', value: '1280×720' },
  { section: 'Quality', label: 'Quality Switches', value: '2' },
  { section: 'Quality', label: 'Dropped Frames', value: '4' },
  { section: 'ABR', label: 'Level Selection', value: 'auto' },
  { section: 'ABR', label: 'Selected Rung', value: '720p' },
  { section: 'ABR', label: 'Bandwidth Estimate', value: '4210 kbps' },
  { section: 'ABR', label: '\u00a0 1080p', value: '5000 kbps' },
  { section: 'ABR', label: '\u25b8 720p', value: '2800 kbps' },
  { section: 'ABR', label: '\u00a0 480p', value: '1200 kbps' },
  { section: 'ABR', label: '\u00a0 360p', value: '700 kbps' },
  { section: 'ABR', label: 'ABR would pick', value: '720p' },
  { section: 'Reliability', label: 'Fatal Errors', value: '0' },
  { section: 'Live', label: 'E2E Live Latency', value: '5.87 s' },
  { section: 'Live', label: 'Latency Target', value: '6.00 s' },
  { section: 'Live', label: 'Buffer Stalls', value: '0' },
];

describe('reading the numbers off the shipped QoE overlay', () => {
  it('reads a playing session', () => {
    assert.deepEqual(readOverlayMetrics(PLAYING), {
      startupMs: 1843,
      rebufferCount: 0,
      rebufferMs: 0,
      resolution: '1280×720',
      qualitySwitches: 2,
      droppedFrames: 4,
      selectedRungHeight: 720,
      abrWouldPickHeight: 720,
      abrEnabled: true,
      bandwidthEstimateKbps: 4210,
      ladderHeights: [1080, 720, 480, 360],
      fatalErrors: 0,
      liveLatencyS: 5.87,
      liveTargetLatencyS: 6,
      bufferStalls: 0,
    });
  });

  /**
   * The row that says whether the latency beside it is comparable with another run's. hls.js raises
   * its own target by up to a target duration after a stall and never lowers it, so a run reading
   * 6.81s against a 7.00s target and one reading 5.89s against 6.00s are the same player behaving the
   * same way, and averaging them is meaningless.
   */
  it('reads the target the player is steering to apart from the latency it reached', () => {
    const stalled = PLAYING.map((row) => (row.label === 'Latency Target' ? { ...row, value: '7.00 s' } : row)).map(
      (row) => (row.label === 'Buffer Stalls' ? { ...row, value: '1' } : row),
    );

    const metrics = readOverlayMetrics(stalled);

    assert.equal(metrics.liveTargetLatencyS, 7);
    assert.equal(metrics.bufferStalls, 1);
    assert.equal(metrics.liveLatencyS, 5.87, 'the latency row is untouched by the target moving');
  });

  /**
   * The join is a label written as prose, so the failure mode is someone rewording the overlay and
   * every reading afterwards coming back empty. An empty latency and a six-second latency are not
   * distinguishable in a summary, so this stops instead.
   */
  it('refuses to read an overlay that no longer has the label it looks under', () => {
    const reworded = PLAYING.map((row) => (row.label === 'E2E Live Latency' ? { ...row, label: 'Live Latency' } : row));

    assert.throws(() => readOverlayMetrics(reworded), /no 'E2E Live Latency' under 'Live'/);
  });

  it('refuses when a label moved to another section', () => {
    const moved = PLAYING.map((row) => (row.section === 'Live' ? { ...row, section: 'Latency' } : row));

    assert.throws(() => readOverlayMetrics(moved), /Update OVERLAY_FIELDS/);
  });

  /** Before hls.js has a latency the overlay shows its placeholder, which is not the same as zero. */
  it('reads a metric with no value yet as absent rather than as zero', () => {
    const early = PLAYING.map((row) => (row.label === 'E2E Live Latency' ? { ...row, value: '—' } : row));

    assert.equal(readOverlayMetrics(early).liveLatencyS, null);
  });

  it('reads a counter with no value yet as none, because a counter has one', () => {
    const early = PLAYING.map((row) => (row.label === 'Dropped Frames' ? { ...row, value: '—' } : row));

    assert.equal(readOverlayMetrics(early).droppedFrames, 0);
  });

  it('reads an unknown resolution as absent rather than as the placeholder text', () => {
    const early = PLAYING.map((row) => (row.label === 'Delivered Resolution' ? { ...row, value: '—' } : row));

    assert.equal(readOverlayMetrics(early).resolution, null);
  });
});

describe('parsing one overlay value', () => {
  it('takes the number and leaves the unit', () => {
    assert.equal(parseOverlayNumber('1843 ms'), 1843);
    assert.equal(parseOverlayNumber('5.87 s'), 5.87);
    assert.equal(parseOverlayNumber('12.3%'), 12.3);
  });

  it('reads the placeholder as absent', () => {
    assert.equal(parseOverlayNumber('—'), null);
  });

  it('reads a value that is not a number at all as absent', () => {
    assert.equal(parseOverlayNumber('in progress'), null);
  });
});

/**
 * ⭐ The readings V2 is built on. A quality switch is a claim about what the PLAYER chose, and the
 * only thing the harness had before this was the resolution the decoder produced. Those are different
 * questions: two rungs can share a height, and a rung chosen but not yet decoded shows in neither.
 */
describe('reading which rung the player chose off the overlay', () => {
  const withRow = (label: string, value: string): OverlayRow[] =>
    PLAYING.map((row) => (row.label === label ? { ...row, value } : row));

  it('reads the selected rung as a height, off a row written for a person', () => {
    assert.equal(readOverlayMetrics(withRow('Selected Rung', '360p')).selectedRungHeight, 360);
  });

  /** Before hls.js has parsed a master there is no rung, and the overlay says so with its placeholder. */
  it('reads a rung not yet picked as absent rather than as zero', () => {
    assert.equal(readOverlayMetrics(withRow('Selected Rung', '\u2014')).selectedRungHeight, null);
  });

  /**
   * \u26d4 The reading that decides whether a run is evidence about ABR at all. A pinned player rides
   * one rung by instruction, so it cannot step down and its not doing so proves nothing.
   */
  it('says ABR is off when something pinned the level', () => {
    assert.equal(readOverlayMetrics(withRow('Level Selection', 'pinned')).abrEnabled, false);
    assert.equal(readOverlayMetrics(PLAYING).abrEnabled, true);
  });

  /**
   * \u2b50 The counter moves on the DECISION. A player that decided to step down and could not get
   * the frames out still counts the switch, and the delivered resolution still reads the old rung.
   */
  it('counts switches the player made, apart from the resolution it managed to deliver', () => {
    const metrics = readOverlayMetrics(withRow('Quality Switches', '5'));

    assert.equal(metrics.qualitySwitches, 5);
    assert.equal(metrics.resolution, '1280\u00d7720', 'the delivered resolution is untouched by the counter');
  });

  it('reads the bandwidth the player believes it has, which is the input to the choice', () => {
    assert.equal(readOverlayMetrics(withRow('Bandwidth Estimate', '820 kbps')).bandwidthEstimateKbps, 820);
    assert.equal(readOverlayMetrics(withRow('Bandwidth Estimate', '\u2014')).bandwidthEstimateKbps, null);
  });

  /**
   * \u26d4 Same rule as every other field here. An ABR section that was renamed or removed must stop
   * the run, because a null selected rung and a player that never switched are indistinguishable in a
   * summary, and V2 would pass by reading nothing.
   */
  it('refuses an overlay that no longer carries the ABR section it reads', () => {
    const gone = PLAYING.filter((row) => row.section !== 'ABR');

    // The field named is whichever the reader reaches first, so the section is what this pins.
    assert.throws(() => readOverlayMetrics(gone), /under 'ABR'/);
  });
});

/**
 * ⭐ The rung list, which is what a VOD run needs and no live run had asked for. A recording whose
 * master resolved but whose rung playlists did not is a player holding fewer levels than the
 * deployment declares, and nothing else in a sample would show it.
 */
describe('reading the whole ladder the player parsed', () => {
  it('reads every rung the overlay lists, in its own order', () => {
    assert.deepEqual(readOverlayMetrics(PLAYING).ladderHeights, [1080, 720, 480, 360]);
  });

  /**
   * ⛔⛔ The marker is `▸` on the current rung and a NON-BREAKING SPACE on every other one. A pattern
   * built with an ordinary space matches only the rung being played, so a four rung ladder reads as
   * ONE, which is exactly the failure this reading exists to catch.
   */
  it('reads the rungs that are not being played, not only the marked one', () => {
    const heights = readOverlayMetrics(PLAYING).ladderHeights;

    assert.ok(heights.includes(1080), 'the 1080p row is prefixed with a non-breaking space, not a marker');
    assert.equal(heights.length, 4);
  });

  /** A single-rendition stream has no ladder rows at all, which is not the same as a missing reading. */
  it('reads no ladder where the player holds none', () => {
    const single = PLAYING.filter((row) => !/\d+p$/.test(row.label));

    assert.deepEqual(readOverlayMetrics(single).ladderHeights, []);
  });

  /**
   * ⛔ The narrowing, which is not free. Every other reading here is pinned to one section AND one
   * label, and this one is pinned only by shape, so without the section it would take a rung from
   * anywhere the overlay ever prints a height.
   */
  it('takes rungs from the ABR section and nowhere else', () => {
    const elsewhere: OverlayRow[] = [...PLAYING, { section: 'Quality', label: '\u00a0 240p', value: '300 kbps' }];

    assert.deepEqual(readOverlayMetrics(elsewhere).ladderHeights, [1080, 720, 480, 360]);
  });

  /**
   * ⛔⛔⛔ The whole reason this field was added, and a fixture where both rows read `720p` cannot
   * catch it. `Selected Rung` is `hls.currentLevel`, which is what DECODED. `ABR would pick` is
   * `hls.nextAutoLevel`, which is what the algorithm chose. A viewer whose buffer has run dry keeps
   * reporting the last rung they managed to play while ABR has already moved, and on 2026-08-30 that
   * gap was read as ABR refusing to adapt.
   */
  it('reads what ABR chose apart from what the decoder is showing', () => {
    const starving: OverlayRow[] = PLAYING.map((row) =>
      row.label === 'ABR would pick' ? { ...row, value: '360p' } : row,
    );

    const metrics = readOverlayMetrics(starving);

    assert.equal(metrics.selectedRungHeight, 720, 'the decoder is still showing the rung it last played');
    assert.equal(metrics.abrWouldPickHeight, 360, 'while ABR has already chosen a lower one');
  });

  /** A single-rendition stream has no ladder to pick from, so the overlay renders no such row. */
  it('reads no ABR choice on a player that has no ladder, rather than refusing the run', () => {
    const singleRendition = PLAYING.filter((row) => row.label !== 'ABR would pick');

    assert.equal(readOverlayMetrics(singleRendition).abrWouldPickHeight, null);
  });

  /**
   * ⛔ Anchored at both ends. A label is prose, and a settings row naming a rung inside a sentence
   * carries the same characters a rung row does without being one.
   */
  it('does not take a rung out of a label that merely contains one', () => {
    const prose: OverlayRow[] = [...PLAYING, { section: 'ABR', label: 'floor is 240p', value: 'on' }];

    assert.deepEqual(readOverlayMetrics(prose).ladderHeights, [1080, 720, 480, 360]);
  });

  /** The named ABR rows are not rungs, however much they look like one. */
  it('does not mistake the selected rung or the prediction for a ladder entry', () => {
    const onlyNamed = PLAYING.filter((row) => row.section !== 'ABR' || !/^[\u25b8\u00a0]/.test(row.label));

    assert.deepEqual(readOverlayMetrics(onlyNamed).ladderHeights, []);
  });
});
