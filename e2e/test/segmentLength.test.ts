import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  parseStageSegmenting,
  readSegmentExpectation,
  segmentLengthRefusal,
  stageSegmentSeconds,
  unreadableEngineRefusal,
} from '../src/segmentLength.js';

/**
 * The two viewer types this project ships want OPPOSITE segment lengths, so a run has to say which.
 *
 * ⭐⭐⭐ Measured 2026-08-16 by the sibling repo `swarm-stream-loadlab`, in
 * `docs/measurements/2026-08-16-a-stock-tab-holds-realtime-on-two-second-segments.md`. A stock
 * weeb-3 tab holds **1.000x of realtime on 2s segments** with about 90s of buffer ahead of the
 * playhead, and **0.426x on 0.5s** with 0.5 to 3.5s of buffer, which is a viewer falling behind for
 * as long as it is open. The mechanism is arithmetic rather than tuning: weeb-3 admits roughly one
 * segment per second whatever its peer count, so a 0.5s profile needs two admissions a second
 * against a ceiling near one and can never catch up.
 *
 * The gateway path measures the opposite optimum over 21 funded arms, 0.5s beating 2s on
 * capture-to-fetchable latency at 1.55s against 3.88s. So there is no single right number, and a run
 * that does not name one is a run whose report cannot be read.
 *
 * The parser is here rather than in the preflight because nothing under `suites/` runs in CI.
 */
describe('reading the segment length a run says it needs', () => {
  it('treats an unset variable as undeclared rather than guessing either way', () => {
    assert.equal(readSegmentExpectation(''), 'undeclared');
  });

  it('reads a whole number of seconds, which is what the in-browser profile needs', () => {
    assert.equal(readSegmentExpectation('2'), 2);
  });

  it('reads a fractional second, which is what the gateway control needs', () => {
    assert.equal(readSegmentExpectation('0.5'), 0.5);
  });

  it('ignores surrounding whitespace, which an env file makes easy to leave behind', () => {
    assert.equal(readSegmentExpectation('  2  '), 2);
  });

  /**
   * The one spelling that waives the check, and it has to be a word rather than an absence. A run
   * against a stage this cannot read is legitimate, and it declares itself once the way
   * `E2E_EXPECT_ABR=false` does.
   */
  it('reads the word that declares a run does not pin a segment length', () => {
    assert.equal(readSegmentExpectation('any'), 'any');
  });

  it('refuses a value no arithmetic can use rather than falling back to undeclared', () => {
    assert.throws(() => readSegmentExpectation('two'), /E2E_EXPECT_SEGMENT_S/);
  });

  /**
   * `parseFloat` stops at the first character it cannot use, so `2s` would read as 2 and `0x2` as 0.
   * The second is the one that matters: a zero-length segment and an unparseable one would become
   * the same declaration, and every later division by it is an infinity.
   */
  it('refuses a number with a unit stuck to it rather than parsing the prefix', () => {
    assert.throws(() => readSegmentExpectation('2s'), /E2E_EXPECT_SEGMENT_S/);
  });

  it('refuses zero and negatives, which no segment can be', () => {
    assert.throws(() => readSegmentExpectation('0'), /E2E_EXPECT_SEGMENT_S/);
    assert.throws(() => readSegmentExpectation('-2'), /E2E_EXPECT_SEGMENT_S/);
  });
});

interface ConfShape {
  fragment?: string;
  aofRatio?: string;
  /** The rung keyframe cadence, which `entrypoint.sh` derives from the fragment and so matches it. */
  cadence?: string;
  rungs?: number;
}

/** A ladder config as `engines/srs/entrypoint.sh` generates it: two vhosts, one engine block per rung. */
function ladderConf({ fragment = '0.5', aofRatio = '5.0', cadence = fragment, rungs = 4 }: ConfShape = {}): string {
  const engines = Array.from(
    { length: rungs },
    (_, i) => `
        engine rung${i} {
            vfps            30;
            vparams {
                g                   15;
                keyint_min          15;
                force_key_frames    expr:gte(t,n_forced*${cadence});
            }
        }`,
  ).join('\n');

  return [
    'vhost __defaultVhost__ {',
    '    hls {',
    '        enabled         off;',
    `        hls_fragment    ${fragment};`,
    `        hls_aof_ratio   ${aofRatio};`,
    '    }',
    '    transcode {',
    engines,
    '    }',
    '}',
    'vhost abr {',
    '    hls {',
    '        enabled         on;',
    `        hls_fragment    ${fragment};`,
    `        hls_aof_ratio   ${aofRatio};`,
    '    }',
    '}',
  ].join('\n');
}

/** The single-rendition config: one vhost, no transcode block, so the cadence is whatever publishes. */
function singleConf({ fragment = '0.5', aofRatio = '5.0' } = {}): string {
  return [
    'vhost __defaultVhost__ {',
    '    hls {',
    '        enabled         on;',
    `        hls_fragment    ${fragment};`,
    `        hls_aof_ratio   ${aofRatio};`,
    '    }',
    '}',
  ].join('\n');
}

/** `startPublisher` runs `-g fps*2`, so a stage with no transcode block is cut on a 2s cadence. */
const PUBLISHER_GOP = 2;

/**
 * Reading what a running stage cuts at out of the config it was actually started with.
 *
 * ⛔⛔ Not out of an env file. An env file edited after the last deploy describes an intention, and a
 * co-tenant one wrong compose file away from ours describes somebody else's. On 2026-08-17 a
 * neighbouring session changed `hls_fragment` to 2.0 on its own SRS stack on this host, and the only
 * reason anyone knew is that somebody ran `docker exec` by hand. `Host.containerEnv` already carries
 * the same rule for `LOG_LEVEL`, and this is that rule applied to the segmenter.
 */
describe('reading what a running SRS stage cuts a segment at', () => {
  /**
   * ⭐⭐⭐ With the ladder on the fragment IS the segment, and that is not a coincidence to lean on
   * loosely. `entrypoint.sh` derives every rung's GOP as `ABR_FPS * HLS_FRAGMENT` frames at
   * `ABR_FPS`, which is `HLS_FRAGMENT` seconds, so `ceil(fragment/GOP)*GOP` rounds up by exactly one.
   * Confirmed live on 2026-08-28: four rungs at `HLS_FRAGMENT=0.5` all measured a 0.500s median.
   */
  it('reads a ladder stage, where the fragment and the cadence are the same number', () => {
    const stage = parseStageSegmenting(ladderConf(), PUBLISHER_GOP);

    assert.deepEqual(stage, { fragment: 0.5, aofRatio: 5, gopSeconds: 0.5, transcodes: true });
    assert.equal(stageSegmentSeconds(stage), 0.5);
  });

  it('reads a two-second ladder stage, which is what an in-tab viewer needs', () => {
    assert.equal(stageSegmentSeconds(parseStageSegmenting(ladderConf({ fragment: '2.0' }), PUBLISHER_GOP)), 2);
  });

  /**
   * With no transcode block SRS segments whatever arrives, so the cadence is the publisher's and not
   * the deployment's. `HLS_FRAGMENT` is then only a floor, which is the trap that made this repo
   * blame the fragment for a 1.917s segment twice.
   */
  it('falls back to the publisher cadence where the stage transcodes nothing', () => {
    const stage = parseStageSegmenting(singleConf(), PUBLISHER_GOP);

    assert.deepEqual(stage, { fragment: 0.5, aofRatio: 5, gopSeconds: 2, transcodes: false });
    assert.equal(stageSegmentSeconds(stage), 2);
  });

  it('rounds a fragment up to the next whole cadence, which is what SRS does', () => {
    const stage = parseStageSegmenting(singleConf({ fragment: '2.5', aofRatio: '5.0' }), PUBLISHER_GOP);

    assert.equal(stageSegmentSeconds(stage), 4);
  });

  /**
   * ⛔ Every way of learning nothing is a refusal. "I could not read the stage" and "the stage is
   * fine" are the same return value to anything that only looks for a mismatch.
   */
  it('refuses an empty config rather than reading it as a stage with no opinion', () => {
    assert.throws(() => parseStageSegmenting('   \n', PUBLISHER_GOP), /empty/);
  });

  it('refuses a config missing either half of the pair the prediction needs', () => {
    assert.throws(() => parseStageSegmenting('vhost x {\n    hls {\n    }\n}\n', PUBLISHER_GOP), /hls_fragment/);
    assert.throws(() => parseStageSegmenting('hls_fragment 0.5;\n', PUBLISHER_GOP), /hls_aof_ratio/);
  });

  /**
   * A ladder generates a second vhost and both interpolate the same `${HLS_FRAGMENT}`, so identical
   * values are the normal case and a disagreement means the config was not generated by our
   * entrypoint. Picking a winner would be a guess, and a gate that guesses is the failure mode.
   */
  it('refuses two vhosts that disagree rather than taking whichever comes first', () => {
    const conf = `${singleConf({ fragment: '0.5' })}\n${singleConf({ fragment: '2.0' })}`;

    assert.throws(() => parseStageSegmenting(conf, PUBLISHER_GOP), /hls_fragment/);
  });

  it('refuses rungs whose keyframe cadences disagree, which is a switch landing mid-GOP', () => {
    const conf = ladderConf().replace('n_forced*0.5)', 'n_forced*2.0)');

    assert.throws(() => parseStageSegmenting(conf, PUBLISHER_GOP), /force_key_frames/);
  });

  it('refuses a fragment of zero, which no arithmetic downstream survives', () => {
    assert.throws(() => parseStageSegmenting(singleConf({ fragment: '0' }), PUBLISHER_GOP), /hls_fragment/);
  });
});

/**
 * The parser against the real generator, because a fixture written beside a parser agrees with it.
 *
 * ⛔ Both files above are this test's idea of what `engines/srs` produces. If the template gains an
 * indent, or the entrypoint stops writing `force_key_frames`, every case above still passes and the
 * gate reads a live stage as unreadable, or worse as single-rendition on a stage that transcodes.
 * These two read the shipped files and substitute what the entrypoint substitutes, so a drift in the
 * generator fails here rather than during a sitting.
 */
describe('the parser reads the files engines/srs actually ships', () => {
  const SRS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'engines', 'srs');
  const read = (name: string) => readFileSync(join(SRS_DIR, name), 'utf8');

  it('finds the pair in srs.conf.template once its placeholders are filled', () => {
    const conf = read('srs.conf.template')
      .replace('HLS_FRAGMENT_PLACEHOLDER', '2.0')
      .replace('HLS_AOF_RATIO_PLACEHOLDER', '5.0');

    const stage = parseStageSegmenting(conf, PUBLISHER_GOP);

    assert.deepEqual(stage, { fragment: 2, aofRatio: 5, gopSeconds: PUBLISHER_GOP, transcodes: false });
  });

  /**
   * The cadence line is generated rather than templated, so it is lifted out of the `echo` that
   * writes it. `HLS_FRAGMENT` is what the entrypoint interpolates there, which is also the reason a
   * ladder's segment equals its fragment.
   */
  it('finds the cadence in the force_key_frames line entrypoint.sh writes', () => {
    const emitted = read('entrypoint.sh').match(/echo "(\s*force_key_frames\s+expr:[^"]+)"/)?.[1];
    assert.ok(emitted, 'entrypoint.sh no longer writes a force_key_frames line this parser can read');

    const conf = `${singleConf({ fragment: '2.0' })}\n${emitted.replace('${HLS_FRAGMENT}', '2.0')}`;
    const stage = parseStageSegmenting(conf, PUBLISHER_GOP);

    assert.deepEqual(stage, { fragment: 2, aofRatio: 5, gopSeconds: 2, transcodes: true });
  });
});

/**
 * Refusing a run whose stack cuts at the length the OTHER viewer type wants.
 *
 * ⛔⛔⛔ This is a wrong number rather than a missing one, which is why it is a gate and not a column.
 * An in-tab arm run against a 0.5s stage produces a real, plausible, fully instrumented reading of a
 * viewer that could never have kept up, and nothing in the artefact says so.
 */
describe('refusing a stack that cuts at the wrong length for this run', () => {
  const ladder = (fragment: string) => parseStageSegmenting(ladderConf({ fragment }), PUBLISHER_GOP);

  it('passes an in-browser run against a two-second ladder', () => {
    assert.equal(segmentLengthRefusal({ profile: 'in-browser', needed: 2, stage: ladder('2.0') }), null);
  });

  it('passes a light-client run against a half-second ladder', () => {
    assert.equal(segmentLengthRefusal({ profile: 'light-client', needed: 0.5, stage: ladder('0.5') }), null);
  });

  /** The pairing that was actually running, and the one this whole gate exists for. */
  it('refuses an in-browser run against the half-second stage latbench ships', () => {
    const refusal = String(segmentLengthRefusal({ profile: 'in-browser', needed: 2, stage: ladder('0.5') }));

    assert.match(refusal, /in-browser/);
    assert.match(refusal, /needs 2s/);
    assert.match(refusal, /0\.500s/);
    assert.match(refusal, /HLS_FRAGMENT=2/);
  });

  it('refuses the mirror mistake, a gateway control against a two-second stage', () => {
    const refusal = String(segmentLengthRefusal({ profile: 'light-client', needed: 0.5, stage: ladder('2.0') }));

    assert.match(refusal, /HLS_FRAGMENT=0\.5/);
  });

  /**
   * ⛔ On a single-rendition stage `HLS_FRAGMENT` is a floor and the publisher owns the cadence, so
   * the remedy above is wrong there and saying it anyway would send an operator to a knob that
   * cannot move the number. Only multiples of the publisher's GOP are reachable at all.
   */
  it('names the publisher rather than HLS_FRAGMENT where the stage transcodes nothing', () => {
    const stage = parseStageSegmenting(singleConf(), PUBLISHER_GOP);
    const refusal = String(segmentLengthRefusal({ profile: 'light-client', needed: 0.5, stage }));

    assert.match(refusal, /publisher/);
    assert.doesNotMatch(refusal, /HLS_FRAGMENT=/);
  });

  /**
   * ⛔⛔ Checked before the length comparison, because past the ceiling the arithmetic above stops
   * describing the stage at all. SRS force-closes at `hls_fragment * hls_aof_ratio` whether a
   * keyframe arrived or not: measured 2026-08-05, a 0.25 fragment against a 2s GOP produced 0.53s
   * segments cut mid-GOP, and 281 of them carried no keyframe and could not be read.
   */
  it('refuses a cadence past the force-close ceiling before it compares any length', () => {
    const stage = parseStageSegmenting(singleConf({ fragment: '0.25', aofRatio: '2.1' }), PUBLISHER_GOP);
    const refusal = String(segmentLengthRefusal({ profile: 'light-client', needed: 2, stage }));

    assert.match(refusal, /HLS_AOF_RATIO/);
    assert.match(refusal, /force-close/);
  });

  /** A stage sitting exactly on its own ceiling is inside the range, so it is not a refusal. */
  it('passes a cadence that lands exactly on the ceiling', () => {
    const stage = parseStageSegmenting(singleConf({ fragment: '1.0', aofRatio: '2.0' }), PUBLISHER_GOP);

    assert.equal(segmentLengthRefusal({ profile: 'light-client', needed: 2, stage }), null);
  });
});

/**
 * A run that named a length against a stage this cannot read.
 *
 * The reader knows SRS's generated config and nothing else. Passing an OME run would be the gate
 * reporting a check it never made, so it refuses and names the one-word declaration that says the
 * run does not pin a length.
 */
describe('refusing to pretend a stage it cannot read was checked', () => {
  it('names the engine, the length that went unchecked, and the way to declare it unpinned', () => {
    const refusal = unreadableEngineRefusal('ome', 2);

    assert.match(refusal, /ome/);
    assert.match(refusal, /2s/);
    assert.match(refusal, /E2E_EXPECT_SEGMENT_S=any/);
  });
});
