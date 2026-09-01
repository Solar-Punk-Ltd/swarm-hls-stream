import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { advertisableRenditions, LadderLiveness, RUNG_DEATH_LAG_SEGMENTS } from '../src/libs/LadderLiveness.js';

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
  it('condemns three rungs of four when the source goes away, which is the open defect', () => {
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
      LADDER.filter((rung) => liveness.hasStopped(rung, LADDER)),
      ['360p', '480p', '1080p'],
      'the cascade changed shape. Read the docblock: this pins a known defect, so a change here is ' +
        'either the fix (make it [] and say so) or a new way of getting it wrong',
    );
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
});
