import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  feedTopicHexOf,
  makeRefPool,
  manifestRefusal,
  MIN_SEGMENT_REFS,
  parseRungManifest,
  spacedRefs,
} from '../src/browser/rungManifest.js';

/**
 * Reading a rung's recording out of the m3u8 the gateway serves, and handing its references out once.
 *
 * ⛔⛔ The repeat rule is the one that would quietly produce a miracle. A reference asked for twice
 * in one tab is answered out of the node's own cache in single digit milliseconds, so a run that
 * reused one would publish a retrieval time that is a measurement of a cache hit, sitting in a table
 * of network retrievals and indistinguishable from a very fast one.
 */

const REF_A = 'a'.repeat(64);
const REF_B = 'b'.repeat(64);
const REF_C = 'c'.repeat(64);

function manifestText(refs: readonly string[]): string {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    '#EXT-X-TARGETDURATION:3',
    '#EXT-X-MEDIA-SEQUENCE:580',
    ...refs.flatMap((ref) => ['#EXTINF:2.068, no desc', ref]),
    '#EXT-X-ENDLIST',
    '',
  ].join('\n');
}

describe('what a rung manifest says', () => {
  it('takes the segment references and leaves the tags behind', () => {
    const parsed = parseRungManifest('360p', '906fe47f', manifestText([REF_A, REF_B, REF_C]));

    assert.deepEqual(parsed.refs, [REF_A, REF_B, REF_C]);
    assert.equal(parsed.manifest.segmentCount, 3);
    assert.equal(parsed.manifest.rung, '360p');
    assert.equal(parsed.manifest.topicHex, '906fe47f');
  });

  it('reads the target duration and the typical segment length', () => {
    const parsed = parseRungManifest('1080p', 'fbb12dbb', manifestText([REF_A, REF_B]));

    assert.equal(parsed.manifest.targetDurationS, 3);
    assert.equal(parsed.manifest.medianSegmentSeconds, 2.068);
  });

  /**
   * ⭐ The stage this project runs on changed segment length on 2026-09-01, and every figure measured
   * before that was measured on a different stage. A recording's own declared segment length is what
   * says which one a result belongs to, so it is read rather than assumed.
   */
  it('takes the median segment length rather than the first one', () => {
    const text = ['#EXTM3U', '#EXTINF:1.000,', REF_A, '#EXTINF:2.000,', REF_B, '#EXTINF:9.000,', REF_C].join('\n');

    assert.equal(parseRungManifest('360p', 'topic', text).manifest.medianSegmentSeconds, 2);
  });

  it('says nothing rather than guessing when the manifest carries no durations', () => {
    const parsed = parseRungManifest('360p', 'topic', ['#EXTM3U', REF_A].join('\n'));

    assert.equal(parsed.manifest.targetDurationS, null);
    assert.equal(parsed.manifest.medianSegmentSeconds, null);
  });

  /** A playlist served over http arrives with the line endings the writer used, not the reader's. */
  it('reads a manifest with carriage returns in it', () => {
    const parsed = parseRungManifest('360p', 'topic', `#EXTM3U\r\n#EXT-X-TARGETDURATION:3\r\n${REF_A}\r\n`);

    assert.deepEqual(parsed.refs, [REF_A]);
    assert.equal(parsed.manifest.targetDurationS, 3);
  });

  /** A 64-character line that is not lowercase hex is not a reference, and must not become one. */
  it('takes only the lines that are a reference', () => {
    const text = ['#EXTM3U', 'A'.repeat(64), 'z'.repeat(64), 'a'.repeat(63), REF_A].join('\n');

    assert.deepEqual(parseRungManifest('360p', 'topic', text).refs, [REF_A]);
  });
});

describe('whether a recording can carry this run', () => {
  const enough = parseRungManifest(
    '360p',
    'topic',
    manifestText(Array.from({ length: 40 }, (_u, i) => `${i}`.padStart(64, '0'))),
  );
  const thin = parseRungManifest('360p', 'topic', manifestText([REF_A, REF_B]));

  it('lets a recording with room through', () => {
    assert.equal(manifestRefusal(enough, 13), null);
  });

  it('refuses a recording too short to be the one this probe was written against', () => {
    const refusal = manifestRefusal(thin, 1);

    assert.match(String(refusal), new RegExp(String(MIN_SEGMENT_REFS)));
    assert.match(String(refusal), /360p/);
  });

  /**
   * ⛔ Refused before the browser opens rather than part way through. A run that ran out of fresh
   * references mid-sitting would either repeat one, which is a cache hit dressed as a retrieval, or
   * abandon the arms it had not reached yet.
   */
  it('refuses a recording that cannot supply every reference this run will ask for', () => {
    assert.match(String(manifestRefusal(enough, 100)), /100/);
  });
});

describe('references spread through a recording', () => {
  const refs = Array.from({ length: 100 }, (_unused, index) => `${index}`.padStart(64, '0'));

  it('hands back as many as were asked for', () => {
    assert.equal(spacedRefs(refs, 13).length, 13);
  });

  /** Spread rather than the first n, so a run does not measure only the opening of the recording. */
  it('spreads them across the whole recording rather than taking a run of them', () => {
    const picked = spacedRefs(refs, 4);

    assert.deepEqual(picked, [refs[0], refs[25], refs[50], refs[75]]);
  });

  it('never hands back the same reference twice', () => {
    const picked = spacedRefs(refs, 40);

    assert.equal(new Set(picked).size, picked.length);
  });

  it('hands back everything it has when asked for more than the recording holds', () => {
    const picked = spacedRefs([REF_A, REF_B], 10);

    assert.deepEqual(picked, [REF_A, REF_B]);
  });
});

describe('the pool a run takes its references from', () => {
  it('hands out each reference once, in order', () => {
    const pool = makeRefPool([REF_A, REF_B], '360p');

    assert.equal(pool.take(), REF_A);
    assert.equal(pool.take(), REF_B);
  });

  it('says how many are left', () => {
    const pool = makeRefPool([REF_A, REF_B], '360p');
    pool.take();

    assert.equal(pool.remaining(), 1);
  });

  /**
   * ⛔⛔ Throws rather than wrapping round. Handing the first reference out again would answer from
   * the node's own cache in single digit milliseconds and score as a miracle in a table of network
   * retrievals.
   */
  it('refuses to hand out a reference it has already given away', () => {
    const pool = makeRefPool([REF_A], '1080p');
    pool.take();

    assert.throws(() => pool.take(), /1080p/);
    assert.throws(() => pool.take(), /cache/);
  });
});

/**
 * The topic a master names a rung feed by is the raw string, and the gateway wants its hash.
 *
 * The vector is the 360p ladder group of the 2026-09-02 V4 broadcast: the raw UUID the master carried,
 * and the hex the gateway answered the recording's playlist for.
 */
describe('the feed topic a manifest names', () => {
  it('hashes a raw topic string to the 32-byte topic the gateway serves', () => {
    assert.equal(
      feedTopicHexOf('85c23b10-b224-4ee7-93e6-90cf82c69d0d'),
      '0fd0326b6bac931c4fe1a73dac31d66212a1465b35300471a7c3167ae6872941',
    );
  });

  it('passes a topic already in hex form through, lowercased', () => {
    const hex = '0FD0326B6BAC931C4FE1A73DAC31D66212A1465B35300471A7C3167AE6872941';
    assert.equal(feedTopicHexOf(hex), hex.toLowerCase());
  });
});
