import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  advertisableRenditions,
  LadderLiveness,
  LadderLivenessBook,
  MAX_RUNGS_DROPPED_AT_ONCE,
  RUNG_DEATH_LAG_SEGMENTS,
  RUNG_READMIT_AFTER_SEGMENTS,
} from '../src/libs/LadderLiveness.js';

/**
 * The rule that stops a master advertising a rung nothing is producing.
 *
 * ⛔⛔⛔ **Every case here is a live failure the CLIENT's version of this rule shipped**, ported with
 * it. They are not hypotheticals and they are not this module's own history: they are what eight
 * attempts in `packages/client/.../feedState.ts` cost, and the reason that rule was copied rather
 * than a second one invented. If one of these starts failing, read that file before changing this
 * one.
 */

const LADDER = ['360p', '480p', '720p', '1080p'];

/** Every rung delivers one segment, which is what a healthy ladder does. */
function everyRungDelivers(liveness: LadderLiveness, rungs: readonly string[] = LADDER): void {
  for (const rung of rungs) {
    liveness.recordDelivered(rung);
  }
}

describe('a healthy ladder', () => {
  it('calls no rung stopped while every one of them is delivering', () => {
    const liveness = new LadderLiveness();

    for (let round = 0; round < 20; round++) {
      everyRungDelivers(liveness);
    }

    for (const rung of LADDER) {
      assert.equal(liveness.hasStopped(rung, LADDER), false, `${rung} was called dead on a healthy ladder`);
    }
  });

  /**
   * ⛔ The regression that disabled the client's failover outright, on 2026-08-31: rungs are separate
   * transcodes writing separate feeds and they do not advance in lockstep, so a rule comparing
   * cumulative totals drifts apart without bound while nothing is wrong.
   */
  it('tolerates rungs drifting apart, because separate transcodes never advance in lockstep', () => {
    const liveness = new LadderLiveness();

    // 1080p delivers half as often as the rest, for fifty rounds. Nothing has failed.
    for (let round = 0; round < 50; round++) {
      everyRungDelivers(liveness, ['360p', '480p', '720p']);
      if (round % 2 === 0) {
        liveness.recordDelivered('1080p');
      }
    }

    assert.equal(liveness.hasStopped('1080p', LADDER), false, 'a slower rung is not a stopped one');
  });

  /** A rung that has not started yet is not a rung that has stopped. */
  it('keeps advertising a rung that has never delivered anything', () => {
    const liveness = new LadderLiveness();

    for (let round = 0; round < 20; round++) {
      everyRungDelivers(liveness, ['360p', '480p', '720p']);
    }

    assert.equal(liveness.hasStopped('1080p', LADDER), false);
  });
});

describe('a rung that stops', () => {
  it('is called stopped once the ladder has delivered four segments it has not', () => {
    const liveness = new LadderLiveness();
    everyRungDelivers(liveness);

    for (let segment = 0; segment < RUNG_DEATH_LAG_SEGMENTS; segment++) {
      everyRungDelivers(liveness, ['360p', '480p', '720p']);
    }

    assert.equal(liveness.lagOf('1080p', LADDER), RUNG_DEATH_LAG_SEGMENTS);
    assert.equal(liveness.hasStopped('1080p', LADDER), true);
  });

  it('is not called stopped one segment early', () => {
    const liveness = new LadderLiveness();
    everyRungDelivers(liveness);

    for (let segment = 0; segment < RUNG_DEATH_LAG_SEGMENTS - 1; segment++) {
      everyRungDelivers(liveness, ['360p', '480p', '720p']);
    }

    assert.equal(liveness.hasStopped('1080p', LADDER), false);
  });

  it('is alive again the moment it delivers, because the lag is measured from its last delivery', () => {
    const liveness = new LadderLiveness();
    everyRungDelivers(liveness);
    for (let segment = 0; segment < RUNG_DEATH_LAG_SEGMENTS; segment++) {
      everyRungDelivers(liveness, ['360p', '480p', '720p']);
    }
    assert.equal(liveness.hasStopped('1080p', LADDER), true);

    liveness.recordDelivered('1080p');

    assert.equal(liveness.hasStopped('1080p', LADDER), false, 'a rung that publishes again is not dead');
  });
});

describe('the reference is a middle rung, never the leader', () => {
  /**
   * ⛔⛔⛔ The live failure this exists for. 2026-08-31: a viewer settled on 1080p and the client had
   * already dropped 720p, 480p and 360p during the settle, leaving one rung, before any fault was
   * injected. A maximum lets ONE rung running ahead condemn every other one at once.
   */
  it('does not let one rung running ahead condemn the whole ladder', () => {
    const liveness = new LadderLiveness();
    everyRungDelivers(liveness);

    // 1080p sprints twenty segments ahead. Every other rung keeps its own steady pace.
    for (let segment = 0; segment < 20; segment++) {
      liveness.recordDelivered('1080p');
    }

    for (const rung of ['360p', '480p', '720p']) {
      assert.equal(liveness.hasStopped(rung, LADDER), false, `${rung} was condemned by a sibling running ahead`);
    }
  });

  /** Upper middle, so two rungs dying together are both still judged against the two that live. */
  it('still catches two rungs dying together', () => {
    const liveness = new LadderLiveness();
    everyRungDelivers(liveness);

    for (let segment = 0; segment < RUNG_DEATH_LAG_SEGMENTS; segment++) {
      everyRungDelivers(liveness, ['360p', '480p']);
    }

    assert.equal(liveness.hasStopped('720p', LADDER), true);
    assert.equal(liveness.hasStopped('1080p', LADDER), true);
  });

  /**
   * ⚠️ The inherited limit, asserted so it is a known property rather than a surprise. Three of four
   * dying puts the middle among the dead. That is a broadcast falling apart, not a rung failing.
   */
  it('cannot see three of four dying, and that is documented rather than fixed', () => {
    const liveness = new LadderLiveness();
    everyRungDelivers(liveness);

    for (let segment = 0; segment < 20; segment++) {
      liveness.recordDelivered('360p');
    }

    assert.equal(liveness.hasStopped('1080p', LADDER), false);
  });
});

describe('the whole broadcast stopping', () => {
  /**
   * ⛔⛔⛔ **THIS ASSERTS A DEFECT, ON PURPOSE, AND THE OWNER HAS NOT YET RULED ON THE FIX.**
   *
   * Observed live 2026-09-01 in V7, the first sitting after the rung failover was armed. The
   * uploader was killed, so every rung stopped. The client dropped **three of the four** — "Rung
   * 360p ... 480p ... 1080p has stopped being produced (4 segments behind the ladder)" — hls.js
   * raised a fatal `levelSwitchError`, and the player destroyed and restarted itself. This case
   * reproduces that rung for rung, 720p surviving included.
   *
   * The class docblock claims a whole broadcast stopping is safe, because it "freezes every rung's
   * count and leaves the comparison where it was". That holds only if they stop at the SAME INSTANT.
   * They do not. Each rung drains whatever it was already holding, the queues differ, and a rung
   * that drains further pushes the middle reference up past rungs that stopped with less in hand.
   *
   * A fix has to decide something this class currently has no opinion on: how much of a ladder may
   * be condemned at once before the right conclusion is "the broadcast ended" rather than "these
   * rungs failed". The docblock already says three of four dying is out of scope, and the code does
   * not enforce that, which is how it enforced the opposite here. ⛔ **That is a product call on the
   * riskiest rule in this client — eight attempts, three shipped regressions — so it is recorded
   * rather than guessed at.** See [[swarm-hls-rung-failover-design]].
   */
  it('condemns nothing when the source goes away, because that is a broadcast ending', () => {
    const liveness = new LadderLiveness();
    for (let round = 0; round < 20; round++) {
      everyRungDelivers(liveness);
    }

    // The tail of a broadcast whose source went away. Every rung drains whatever it was already
    // holding, and they were not holding the same amount: 1080p had four segments queued and 720p
    // had eight. Nothing has failed, the source is simply gone.
    for (let segment = 0; segment < 4; segment++) {
      liveness.recordDelivered('1080p');
    }
    for (let segment = 0; segment < 8; segment++) {
      liveness.recordDelivered('720p');
    }

    assert.deepEqual(
      liveness.liveRungs().sort(),
      [...LADDER].sort(),
      'a broadcast that ended cost the ladder its rungs. Owner ruling 2026-09-01: past ' +
        `${MAX_RUNGS_DROPPED_AT_ONCE} the right conclusion is that the source went away`,
    );
    assert.deepEqual(
      advertisableRenditions(
        LADDER.map((name) => ({ name, height: Number(name.replace('p', '')) })),
        liveness,
      ).map((r) => r.name),
      LADDER,
      'and the master must go on advertising all of them for the same reason',
    );
  });

  /** ⛔ The one rung case must still work, or the ruling has disabled the feature it was about. */
  it('still drops a single rung that stops while the others carry on', () => {
    const liveness = new LadderLiveness();
    everyRungDelivers(liveness);
    for (let segment = 0; segment < RUNG_DEATH_LAG_SEGMENTS; segment++) {
      everyRungDelivers(liveness, ['360p', '480p', '720p']);
    }

    assert.deepEqual(liveness.liveRungs().sort(), ['360p', '480p', '720p']);
  });

  /** Two at once is already past the limit, so it is a broadcast problem and nothing is dropped. */
  it('drops nothing when two rungs stop together', () => {
    const liveness = new LadderLiveness();
    everyRungDelivers(liveness);
    for (let segment = 0; segment < RUNG_DEATH_LAG_SEGMENTS; segment++) {
      everyRungDelivers(liveness, ['360p', '480p']);
    }

    assert.deepEqual(liveness.liveRungs().sort(), [...LADDER].sort());
  });

  /** The floor that stopped it being all four, and the only reason playback had anywhere to go. */
  it('never condemns the last rung standing, which is what kept V7 playable at all', () => {
    const liveness = new LadderLiveness();
    liveness.recordDelivered('720p');
    for (let segment = 0; segment < 50; segment++) {
      liveness.recordDelivered('720p');
    }

    assert.equal(liveness.hasStopped('720p', ['720p']), false);
  });
});

describe('a ladder too small to judge', () => {
  it('calls nothing stopped on a single rendition, which has no middle and nowhere to go', () => {
    const liveness = new LadderLiveness();
    liveness.recordDelivered('720p');

    for (let segment = 0; segment < 50; segment++) {
      liveness.recordDelivered('720p');
    }

    assert.equal(liveness.hasStopped('720p', ['720p']), false);
  });
});

describe('the shape of the ladder, which is what decides whether to rewrite the master', () => {
  it('lists every rung while all of them are producing', () => {
    const liveness = new LadderLiveness();
    everyRungDelivers(liveness);

    assert.deepEqual(liveness.liveRungs().sort(), [...LADDER].sort());
  });

  it('drops a rung that has stopped, which is the change a republish watches for', () => {
    const liveness = new LadderLiveness();
    everyRungDelivers(liveness);
    for (let segment = 0; segment < RUNG_DEATH_LAG_SEGMENTS; segment++) {
      everyRungDelivers(liveness, ['360p', '480p', '720p']);
    }

    assert.deepEqual(liveness.liveRungs().sort(), ['360p', '480p', '720p']);
  });

  it('puts it back when it publishes again, so the master is rewritten a second time', () => {
    const liveness = new LadderLiveness();
    everyRungDelivers(liveness);
    for (let segment = 0; segment < RUNG_DEATH_LAG_SEGMENTS; segment++) {
      everyRungDelivers(liveness, ['360p', '480p', '720p']);
    }
    assert.equal(liveness.liveRungs().includes('1080p'), false);

    liveness.recordDelivered('1080p');

    assert.deepEqual(liveness.liveRungs().sort(), [...LADDER].sort());
  });

  /**
   * ⛔ The shape must not flicker while nothing is wrong, or a healthy broadcast rewrites its master
   * on a loop and every rewrite is a feed write that costs postage.
   */
  it('does not change on a healthy ladder, however long it runs', () => {
    const liveness = new LadderLiveness();
    const shapes = new Set<string>();

    for (let round = 0; round < 60; round++) {
      everyRungDelivers(liveness);
      shapes.add(liveness.liveRungs().sort().join(','));
    }

    assert.equal(shapes.size, 1, `the ladder shape flickered: ${[...shapes].join(' | ')}`);
  });

  it('knows nothing before the first delivery, rather than guessing a ladder', () => {
    assert.deepEqual(new LadderLiveness().liveRungs(), []);
  });
});

describe('what the master is allowed to advertise', () => {
  const rendition = (name: string) => ({ name, height: Number(name.replace('p', '')) });

  it('drops a rung the ladder has left behind', () => {
    const liveness = new LadderLiveness();
    everyRungDelivers(liveness);
    for (let segment = 0; segment < RUNG_DEATH_LAG_SEGMENTS; segment++) {
      everyRungDelivers(liveness, ['360p', '480p', '720p']);
    }

    const advertised = advertisableRenditions(LADDER.map(rendition), liveness);

    assert.deepEqual(
      advertised.map((r) => r.name),
      ['360p', '480p', '720p'],
    );
  });

  it('advertises the whole ladder while every rung is producing', () => {
    const liveness = new LadderLiveness();
    everyRungDelivers(liveness);

    assert.deepEqual(
      advertisableRenditions(LADDER.map(rendition), liveness).map((r) => r.name),
      LADDER,
    );
  });

  /**
   * ⛔ A master naming nothing is not a degraded ladder, it is an unplayable stream. The last rung
   * standing is still the only thing a viewer can be offered.
   */
  it('never advertises nothing, however much of the ladder has died', () => {
    const liveness = new LadderLiveness();
    const single = [rendition('720p')];
    liveness.recordDelivered('720p');
    for (let segment = 0; segment < 50; segment++) {
      liveness.recordDelivered('360p');
    }

    assert.deepEqual(
      advertisableRenditions(single, liveness).map((r) => r.name),
      ['720p'],
    );
  });

  it('hands back an empty list unchanged rather than inventing a rendition', () => {
    assert.deepEqual(advertisableRenditions([], new LadderLiveness()), []);
  });

  /**
   * The reconnect window's own case, and the reason this rule counts segments rather than reading a
   * clock. A whole-encoder disconnect stops SRS's transcoders, so all four rungs go quiet together
   * and stay quiet for as long as the outage lasts — up to a full reap window, and now deliberately
   * so, because the session is being held open for the encoder to come back to.
   *
   * ⛔ A clock would call every rung dead there and the master would be rewritten, or refused, in the
   * middle of an outage a broadcast is about to recover from. The count cannot: nothing advanced, so
   * the reference did not move and no rung is behind it. Property 1 of three, and the one this
   * change leans on hardest.
   */
  it('advertises every rung through an outage in which the whole ladder went quiet', () => {
    const liveness = new LadderLiveness();
    const renditions = LADDER.map(rendition);
    for (let segment = 0; segment < 10; segment++) {
      everyRungDelivers(liveness);
    }

    // The outage. Nothing is recorded for any rung, for however long it lasts.
    assert.deepEqual(
      advertisableRenditions(renditions, liveness).map((r) => r.name),
      LADDER,
      'a ladder that went quiet together lost rungs from its master, so a viewer joining the outage ' +
        'is offered fewer qualities than the broadcast has',
    );
    for (const rung of LADDER) {
      // ⚠️ Not a lag of zero: rungs deliver one at a time, so each of them is up to one segment
      // behind the middle at any instant, which the rule's own tolerance of four is sized for. What
      // an outage must not do is let that lag GROW, and a lag that cannot grow is the whole of the
      // "count segments, never read a clock" property.
      assert.equal(liveness.hasStopped(rung, LADDER), false, `${rung} read as dead on a ladder that did not move`);
      assert.ok(liveness.lagOf(rung, LADDER) < RUNG_DEATH_LAG_SEGMENTS, `${rung} drifted during an outage`);
    }

    // And the return puts every rung back where it was, one at a time as the transcoders restart.
    for (const rung of LADDER) {
      liveness.recordDelivered(rung);
      assert.deepEqual(
        advertisableRenditions(renditions, liveness).map((r) => r.name),
        LADDER,
        `the master stopped offering a rung while ${rung} was coming back`,
      );
    }
  });
});

/**
 * ⛔⛔⛔ The one place this rule is no longer the client's. Measured live 2026-09-23: 1080p's batch was
 * full, most of its uploads were refused and one landed now and then, and each one that landed put the
 * rung back in the master for another four of the ladder's segments. The master was rewritten 793
 * times in four hours. `RefusedRungStaysOut.test.ts` drives that through a real uploader.
 */
describe('a rung whose uploads are being refused', () => {
  const REFUSED = '1080p';
  const THE_REST = ['360p', '480p', '720p'];

  /** The ladder moves on while every upload of the refused rung fails, until it has left it behind. */
  function leftBehindWhileRefused(liveness: LadderLiveness): void {
    everyRungDelivers(liveness);
    for (let segment = 0; segment < RUNG_DEATH_LAG_SEGMENTS; segment += 1) {
      everyRungDelivers(liveness, THE_REST);
      liveness.recordUploadFailed(REFUSED);
    }
  }

  /** One of the refused rung's segments lands, beside one from each of the others. */
  function landsOnce(liveness: LadderLiveness): void {
    everyRungDelivers(liveness, THE_REST);
    liveness.recordDelivered(REFUSED);
  }

  it('is dropped once the ladder leaves it behind, as any stopped rung is', () => {
    const liveness = new LadderLiveness();

    leftBehindWhileRefused(liveness);

    assert.equal(liveness.hasStopped(REFUSED, LADDER), true);
  });

  it('is not put back by one segment that lands', () => {
    const liveness = new LadderLiveness();
    leftBehindWhileRefused(liveness);

    landsOnce(liveness);

    assert.equal(
      liveness.hasStopped(REFUSED, LADDER),
      true,
      'one stray segment through a full batch put the rung back in front of every viewer',
    );
    assert.equal(liveness.liveRungs().includes(REFUSED), false);
  });

  it(`comes back after ${RUNG_READMIT_AFTER_SEGMENTS} segments in a row, and not one sooner`, () => {
    const liveness = new LadderLiveness();
    leftBehindWhileRefused(liveness);

    for (let landed = 1; landed < RUNG_READMIT_AFTER_SEGMENTS; landed += 1) {
      landsOnce(liveness);
      assert.equal(liveness.hasStopped(REFUSED, LADDER), true, `back after only ${landed} segments in a row`);
    }
    landsOnce(liveness);

    assert.equal(liveness.hasStopped(REFUSED, LADDER), false, 'a rung whose uploads work again stayed out');
    assert.deepEqual(liveness.liveRungs().sort(), [...LADDER].sort());
  });

  it('starts the run again from nothing when another upload is refused', () => {
    const liveness = new LadderLiveness();
    leftBehindWhileRefused(liveness);

    for (let landed = 1; landed < RUNG_READMIT_AFTER_SEGMENTS; landed += 1) {
      landsOnce(liveness);
    }
    liveness.recordUploadFailed(REFUSED);
    landsOnce(liveness);

    assert.equal(liveness.hasStopped(REFUSED, LADDER), true, 'a refusal in the middle of the run was forgotten');
  });

  /**
   * ⛔ A refusal alone drops nothing. A rung that has one segment refused and keeps pace otherwise is a
   * working quality, and dropping it would take it away from every viewer for a segment's loss.
   */
  it('is never dropped for a refusal it keeps pace through', () => {
    const liveness = new LadderLiveness();
    everyRungDelivers(liveness);

    everyRungDelivers(liveness, THE_REST);
    liveness.recordUploadFailed(REFUSED);
    for (let segment = 0; segment < 3 * RUNG_READMIT_AFTER_SEGMENTS; segment += 1) {
      landsOnce(liveness);
      assert.equal(liveness.hasStopped(REFUSED, LADDER), false, `dropped ${segment} segments after one refusal`);
    }
  });

  /** A transcoder that stopped and came back refused nothing, so it is offered again as soon as it delivers. */
  it('leaves a rung that fell behind with nothing refused to come back on its first segment', () => {
    const liveness = new LadderLiveness();
    everyRungDelivers(liveness);
    for (let segment = 0; segment < RUNG_DEATH_LAG_SEGMENTS; segment += 1) {
      everyRungDelivers(liveness, THE_REST);
    }

    landsOnce(liveness);

    assert.equal(liveness.hasStopped(REFUSED, LADDER), false);
  });

  /** Property 1 again: every rung refused together advances nothing, so nothing falls behind. */
  it('holds nothing out when every rung′s uploads are refused together', () => {
    const liveness = new LadderLiveness();
    everyRungDelivers(liveness);

    for (let segment = 0; segment < 3 * RUNG_READMIT_AFTER_SEGMENTS; segment += 1) {
      for (const rung of LADDER) {
        liveness.recordUploadFailed(rung);
      }
    }
    everyRungDelivers(liveness);

    assert.deepEqual(
      liveness.liveRungs().sort(),
      [...LADDER].sort(),
      'a node outage for the whole ladder cost it rungs',
    );
  });

  /** Held out is still stopped, so the owner's limit of 2026-09-01 counts it like any other. */
  it('counts toward the limit, so two rungs held out together are both kept', () => {
    const liveness = new LadderLiveness();
    everyRungDelivers(liveness);
    for (let segment = 0; segment < RUNG_DEATH_LAG_SEGMENTS; segment += 1) {
      everyRungDelivers(liveness, ['360p', '480p']);
      liveness.recordUploadFailed('720p');
      liveness.recordUploadFailed(REFUSED);
    }

    assert.deepEqual(liveness.liveRungs().sort(), [...LADDER].sort());
    assert.equal(
      advertisableRenditions(
        LADDER.map((name) => ({ name })),
        liveness,
      ).length,
      LADDER.length,
    );
  });
});

/**
 * The per-ladder book both ladder registries keep. It only routes a segment's outcome to that
 * ladder's own tracker and answers the live set, so these check the routing, and the rule itself is
 * covered above.
 */
describe('the liveness book both ladder registries keep', () => {
  it('keeps one tracker per ladder and hands the same one back', () => {
    const book = new LadderLivenessBook();

    assert.equal(book.of('ladder-a'), book.of('ladder-a'));
    assert.notEqual(book.of('ladder-a'), book.of('ladder-b'));
  });

  it("answers each segment's outcome with the rungs its own ladder now treats as live", () => {
    const book = new LadderLivenessBook();
    for (const rung of LADDER) {
      book.recordDelivered('ladder-a', rung);
    }

    let live: string[] = [];
    for (let segment = 0; segment < RUNG_DEATH_LAG_SEGMENTS; segment += 1) {
      for (const rung of ['360p', '480p', '720p']) {
        book.recordDelivered('ladder-a', rung);
      }
      live = book.recordUploadFailed('ladder-a', '1080p');
    }

    assert.deepEqual(live, ['360p', '480p', '720p'], 'the refused rung was still answered as live');
    assert.deepEqual(book.recordDelivered('ladder-b', '360p'), ['360p'], 'a second ladder saw the first one');
  });
});
