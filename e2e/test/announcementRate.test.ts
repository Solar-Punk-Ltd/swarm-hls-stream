import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ACKNOWLEDGE_UNMEASURED,
  announcementLoad,
  announcementRefusal,
  announcementSummary,
  ladderRungs,
  MEASURED_BROKEN_PER_S,
  MEASURED_SUSTAINED_PER_S,
} from '../src/announcementRate.js';

/**
 * The rule behind `suites/preflight/announcement-rate`, which refuses a sitting whose ladder asks
 * SRS for more announcements a second than any sitting has shown it sustaining.
 *
 * The two configurations at the bottom are the anchors: they are the stages that actually ran, and
 * the verdicts here are what those runs produced.
 */

/** As `engines/srs/entrypoint.sh` writes it, one block per `ABR_LADDER` rung. */
function confWithRungs(names: readonly string[]): string {
  const engines = names
    .map(
      (name) =>
        `        engine ${name} {\n            enabled         on;\n            vcodec          libx264;\n        }`,
    )
    .join('\n');
  return `vhost abr {\n    transcode {\n        enabled     on;\n${engines}\n    }\n}\n`;
}

describe('ladderRungs', () => {
  it('names every rung the stage transcodes', () => {
    assert.deepEqual(ladderRungs(confWithRungs(['1080p', '720p', '480p', '360p'])), ['1080p', '720p', '480p', '360p']);
  });

  it('finds no rungs in a config that transcodes nothing', () => {
    assert.deepEqual(ladderRungs('vhost __defaultVhost__ {\n    hls {\n        enabled on;\n    }\n}\n'), []);
  });

  /**
   * A ladder generates a second vhost and a config carrying the transcode block twice would double
   * the count, refusing a stage that is fine. The rung is the unit of announcement, not the block.
   */
  it('counts a rung once however many vhosts carry it', () => {
    const doubled = `${confWithRungs(['1080p', '720p'])}\n${confWithRungs(['1080p', '720p'])}`;
    assert.deepEqual(ladderRungs(doubled), ['1080p', '720p']);
  });

  it('does not mistake a word ending in engine for an engine block', () => {
    assert.deepEqual(ladderRungs('        # the transcode engine writes\n        reengine 720p {\n'), []);
  });
});

describe('announcementLoad', () => {
  it('is one announcement per rung per segment', () => {
    const load = announcementLoad(['1080p', '720p', '480p', '360p'], 1.0);
    assert.equal(load.perSecond, 4);
    assert.equal(load.band, 'sustained');
  });

  /**
   * A stage that transcodes nothing still segments the rendition published into it, so it has a rate
   * rather than no load. Naming it keeps the refusal readable.
   */
  it('treats a stage with no ladder as one rendition rather than none', () => {
    const load = announcementLoad([], 0.5);
    assert.deepEqual([...load.rungs], ['single']);
    assert.equal(load.perSecond, 2);
    assert.equal(load.band, 'sustained');
  });

  it('refuses a segment length that is not a length, rather than dividing by it', () => {
    assert.throws(() => announcementLoad(['720p'], 0), /not a length/);
    assert.throws(() => announcementLoad(['720p'], Number.NaN), /not a length/);
  });
});

describe('the bands', () => {
  it('clears a rate a sitting has sustained', () => {
    const load = announcementLoad(['a', 'b', 'c', 'd'], 1.0);
    assert.equal(load.perSecond, MEASURED_SUSTAINED_PER_S);
    assert.equal(announcementRefusal(load, false), null);
  });

  it('refuses the gap nothing has been run in', () => {
    const load = announcementLoad(['a', 'b', 'c'], 0.5);
    assert.equal(load.perSecond, 6);
    assert.equal(load.band, 'unmeasured');
    assert.match(String(announcementRefusal(load, false)), /Nothing has been run in between/);
  });

  it('lets an operator into the gap on purpose, because running there is how it gets measured', () => {
    const load = announcementLoad(['a', 'b', 'c'], 0.5);
    assert.equal(announcementRefusal(load, true), null);
  });

  /**
   * The acknowledgement is for the unknown, never for the known-bad. An operator confirming they
   * accept a rate that was watched destroying a rung is not new information.
   */
  it('refuses a rate measured breaking even when the operator acknowledges the gap', () => {
    const load = announcementLoad(['a', 'b', 'c', 'd'], 0.5);
    assert.equal(load.perSecond, MEASURED_BROKEN_PER_S);
    assert.equal(load.band, 'broken');
    assert.match(String(announcementRefusal(load, true)), /refused with no override/);
  });
});

describe('the refusal', () => {
  const load = announcementLoad(['1080p', '720p', '480p', '360p'], 0.5);

  it('names the failure as silent, because a run in this state passes every other suite', () => {
    const refusal = String(announcementRefusal(load, false));
    assert.match(refusal, /does not error/);
    assert.match(refusal, /looks healthy/);
  });

  it('names the segment length that would fit rather than only the rate that does not', () => {
    assert.match(String(announcementRefusal(load, false)), /1\.00s segments/);
  });

  it('names the acknowledgement variable only where it applies', () => {
    assert.doesNotMatch(String(announcementRefusal(load, false)), new RegExp(ACKNOWLEDGE_UNMEASURED));
    const gap = announcementLoad(['a', 'b', 'c'], 0.5);
    assert.match(String(announcementRefusal(gap, false)), new RegExp(ACKNOWLEDGE_UNMEASURED));
  });
});

describe('the two stages that actually ran', () => {
  const LADDER = ['1080p', '720p', '480p', '360p'];

  /** 2026-08-31: 765 of 955 segments lost on 1080p, the rung unpublished about two minutes in. */
  it('refuses the four-rung 0.5s stage that lost a rung every broadcast', () => {
    const load = announcementLoad(ladderRungs(confWithRungs(LADDER)), 0.5);
    assert.equal(load.band, 'broken');
    assert.notEqual(announcementRefusal(load, false), null);
  });

  /** 2026-09-01: 600s, lag flat at 0.0s over 580 segments, zero segments lost on any rung. */
  it('clears the four-rung 1.0s stage that published all of it', () => {
    const load = announcementLoad(ladderRungs(confWithRungs(LADDER)), 1.0);
    assert.equal(load.band, 'sustained');
    assert.equal(announcementRefusal(load, false), null);
    assert.match(announcementSummary(load), /4 rung\(s\) at 1s asks 4\.00/);
  });

  it('clears the in-browser 2.0s stage, which was never exposed to this', () => {
    const load = announcementLoad(ladderRungs(confWithRungs(LADDER)), 2.0);
    assert.equal(load.perSecond, 2);
    assert.equal(announcementRefusal(load, false), null);
  });
});
