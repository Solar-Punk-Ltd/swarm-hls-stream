import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { publishingRendition, publishingRenditionPattern } from '../src/uploaderLog.js';

/**
 * The composer and the matcher are one definition read two ways, so these tests are about the join
 * between them rather than about either half. A message the harness cannot match is the failure this
 * module exists to make impossible.
 */
describe('the rendition publish message', () => {
  it('round-trips a rung and a ladder through the pattern derived from it', () => {
    const found = publishingRenditionPattern().exec(publishingRendition('720p', 'group-1'));

    assert.ok(found, 'the pattern does not match the message it was derived from');
    assert.equal(found[1], '720p');
    assert.equal(found[2], 'group-1');
  });

  it('finds every rung of a ladder in one log, in the order they published', () => {
    const log = ['360p', '480p', '720p', '1080p'].map((rung) => publishingRendition(rung, 'g1')).join('\n');

    const rungs = [...log.matchAll(publishingRenditionPattern('g'))].map((match) => match[1]);

    assert.deepEqual(rungs, ['360p', '480p', '720p', '1080p']);
  });

  it('does not match a line that merely mentions a rendition, so a failure is not read as a publish', () => {
    assert.equal(publishingRenditionPattern().test('Failed to publish rendition 720p of ladder g1'), false);
  });

  /**
   * The pattern is assembled from the composer's own output, so the literal half is escaped and the
   * placeholders are the only things that become groups. Written as an assertion because the failure
   * mode is silent: a stray unescaped metacharacter matches nothing and reads as "the uploader never
   * published a rung".
   */
  it('reads the fixed half of the message as literal text', () => {
    const pattern = publishingRenditionPattern();

    assert.ok(pattern.exec(publishingRendition('720p', 'g1')));
    assert.equal(pattern.exec('Publishing rendition X of ladder Y extra')?.[2], 'Y');
    assert.equal(pattern.test('Publishing rendition of ladder g1'), false, 'a missing rung must not match');
  });

  it('captures a name carrying a dot, which a resolution-style rung would', () => {
    const found = publishingRenditionPattern().exec(publishingRendition('720p.hi', 'g.1'));

    assert.equal(found?.[1], '720p.hi');
    assert.equal(found?.[2], 'g.1');
  });
});
