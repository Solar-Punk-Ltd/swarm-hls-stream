import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { AbrLadder, DEFAULT_LADDER_SPEC } from '../src/libs/AbrLadder.js';
import { buildLadderEntry, LadderIdentity, StreamEntry } from '../src/libs/StreamCatalog.js';
import { MEDIA_TYPE_VIDEO, Rendition } from '../src/types.js';

describe('AbrLadder.parse', () => {
  it('parses the default ladder into four rungs, lowest first', () => {
    const ladder = AbrLadder.parse(DEFAULT_LADDER_SPEC);

    assert.deepEqual(
      ladder.rungs().map((r) => r.name),
      ['360p', '480p', '720p', '1080p'],
    );
    assert.deepEqual(ladder.rungs()[3], {
      name: '1080p',
      width: 1920,
      height: 1080,
      configuredKbps: 5000,
    });
  });

  it('tolerates arbitrary whitespace between entries', () => {
    const ladder = AbrLadder.parse('  360p:640:360:700\n  720p:1280:720:2800  ');

    assert.deepEqual(
      ladder.rungs().map((r) => r.name),
      ['360p', '720p'],
    );
  });

  it('rejects an empty spec', () => {
    assert.throws(() => AbrLadder.parse('   '), /ABR_LADDER is empty/);
  });

  it('rejects entries that are not name:width:height:kbps', () => {
    assert.throws(() => AbrLadder.parse('720p:1280:720'), /must be name:width:height:kbps/);
    assert.throws(() => AbrLadder.parse('720p:1280:720:2800:extra'), /must be name:width:height:kbps/);
  });

  it('rejects non-numeric and non-positive dimensions', () => {
    assert.throws(() => AbrLadder.parse('720p:1280:720:abc'), /bitrate of "720p" must be a positive integer/);
    assert.throws(() => AbrLadder.parse('720p:1280:0:2800'), /height of "720p" must be a positive integer/);
    assert.throws(() => AbrLadder.parse('720p:-1280:720:2800'), /width of "720p" must be a positive integer/);
  });

  it('rejects a rung name that could not survive being spliced into a config', () => {
    assert.throws(() => AbrLadder.parse('720p;evil:1280:720:2800'), /may contain only letters/);
  });

  it('rejects a rung name containing an underscore, which match() could never resolve', () => {
    // match() splits the stream id on its last underscore, so `live_720p_hq` would look up rung `hq`
    // and find nothing. The name has to be refused at parse rather than accepted and never matched.
    assert.throws(() => AbrLadder.parse('720p_hq:1280:720:2800'), /may contain only letters/);
  });

  it('rejects duplicate rung names', () => {
    assert.throws(() => AbrLadder.parse('720p:1280:720:2800 720p:640:360:700'), /two rungs named "720p"/);
  });

  /**
   * Anchored at both ends, and neither anchor is spare. Without the leading one `a12` passes the
   * guard and `parseInt` answers NaN, which is not `<= 0` so the second check waves it through and
   * the rung reaches the master playlist with a BANDWIDTH of `NaN`. Without the trailing one `12a`
   * silently becomes 12, so a rung advertises a bitrate the encoder was never given.
   */
  it('rejects a bitrate that is only partly numeric, at either end', () => {
    assert.throws(() => AbrLadder.parse('720p:1280:720:a12'), /bitrate of "720p" must be a positive integer/);
    assert.throws(() => AbrLadder.parse('720p:1280:720:12a'), /bitrate of "720p" must be a positive integer/);
  });

  it('answers `has` for a configured rung and not for one the engine was never given', () => {
    const ladder = AbrLadder.parse(DEFAULT_LADDER_SPEC);

    assert.equal(ladder.has('720p'), true);
    assert.equal(ladder.has('1440p'), false);
  });
});

describe('AbrLadder.match', () => {
  const ladder = AbrLadder.parse(DEFAULT_LADDER_SPEC);

  it('splits a rendition stream id into its ladder and its rung', () => {
    const match = ladder.match('video/livestream_720p');

    assert.equal(match?.baseStreamId, 'video/livestream');
    assert.equal(match?.rung.name, '720p');
  });

  it('matches only configured rung names, not any underscore suffix', () => {
    assert.equal(ladder.match('video/livestream_1440p'), null);
    assert.equal(ladder.match('video/livestream_backup'), null);
  });

  it('does not match the untranscoded source', () => {
    assert.equal(ladder.match('video/livestream'), null);
  });

  it('splits on the last underscore, so a stream key may contain them', () => {
    const match = ladder.match('video/my_live_stream_480p');

    assert.equal(match?.baseStreamId, 'video/my_live_stream');
    assert.equal(match?.rung.name, '480p');
  });

  it('does not treat a bare rung name as a rendition of an empty stream', () => {
    assert.equal(ladder.match('_720p'), null);
  });
});

describe('buildLadderEntry', () => {
  const identity: LadderIdentity = {
    title: '08/08/2026',
    owner: 'abcd',
    group: 'group-1',
    mediatype: MEDIA_TYPE_VIDEO,
  };

  const rendition = (name: string, height: number, extra: Partial<Rendition> = {}): Rendition => ({
    name,
    width: (height * 16) / 9,
    height,
    topic: `group-1-${name}`,
    bandwidth: height * 5000,
    avgBandwidth: height * 4000,
    ...extra,
  });

  it('creates the entry from the first rung to come up', () => {
    const entry = buildLadderEntry(identity, [], rendition('720p', 720));

    assert.equal(entry.group, 'group-1');
    assert.equal(entry.state, 'live');
    assert.equal(entry.topic, 'group-1-720p');
    assert.deepEqual(
      entry.renditions?.map((r) => r.name),
      ['720p'],
    );
  });

  it('folds later rungs into the same entry, lowest rung first', () => {
    let previous: StreamEntry[] = [];
    for (const [name, height] of [
      ['720p', 720],
      ['360p', 360],
      ['1080p', 1080],
    ] as const) {
      previous = [buildLadderEntry(identity, previous, rendition(name, height))];
    }

    assert.equal(previous.length, 1);
    assert.deepEqual(
      previous[0].renditions?.map((r) => r.name),
      ['360p', '720p', '1080p'],
    );
  });

  it('points `topic` at the lowest rung so a ladder-unaware client still plays something', () => {
    const first = buildLadderEntry(identity, [], rendition('1080p', 1080));
    const second = buildLadderEntry(identity, [first], rendition('360p', 360));

    assert.equal(first.topic, 'group-1-1080p');
    assert.equal(second.topic, 'group-1-360p');
  });

  it('replaces a rung rather than duplicating it when its bandwidth is corrected', () => {
    const first = buildLadderEntry(identity, [], rendition('720p', 720, { bandwidth: 1 }));
    const second = buildLadderEntry(identity, [first], rendition('720p', 720, { bandwidth: 2_800_000 }));

    assert.equal(second.renditions?.length, 1);
    assert.equal(second.renditions?.[0].bandwidth, 2_800_000);
  });

  it('stays live until every announced rung has finalized', () => {
    const live = buildLadderEntry(identity, [], rendition('360p', 360));
    const halfDone = buildLadderEntry(identity, [live], rendition('720p', 720, { index: 40, duration: 60 }));

    assert.equal(halfDone.state, 'live');
    assert.equal(halfDone.index, undefined);

    const done = buildLadderEntry(identity, [halfDone], rendition('360p', 360, { index: 42, duration: 61 }));

    assert.equal(done.state, 'vod');
    assert.equal(done.index, 42, 'index tracks the primary (lowest) rung');
    assert.equal(done.duration, 61, 'duration is the longest rung');
  });

  it('ignores entries belonging to another ladder or another owner', () => {
    const other: StreamEntry[] = [
      { ...buildLadderEntry(identity, [], rendition('1080p', 1080)), group: 'group-2' },
      { ...buildLadderEntry(identity, [], rendition('1080p', 1080)), owner: 'ffff' },
    ];

    const entry = buildLadderEntry(identity, other, rendition('360p', 360));

    assert.deepEqual(
      entry.renditions?.map((r) => r.name),
      ['360p'],
    );
  });
});
