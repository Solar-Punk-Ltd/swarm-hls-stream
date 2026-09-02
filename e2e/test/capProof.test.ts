import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  blindWhileDeliveringRefusal,
  CAP_OVERSHOOT_TOLERANCE,
  CAP_PROOF_FLOOR_SHARE,
  capExceededRefusal,
  type CapProof,
  capProofLine,
  capProofRefusal,
  judgeCapProof,
  judgeRecorderProof,
  recorderBlindRefusal,
  type RecorderProof,
  recorderProofLine,
} from '../src/browser/capProof.js';

/**
 * The two proofs a squeeze run has to pass before any figure taken under its cap means anything.
 *
 * ⛔ The numbers below are the arm 3 probe of 2026-09-02, which is the run these refusals exist to
 * have refused. A 2800 kbps cap allows 350,000 bytes/s, and that run pulled 225 KB in 0.1 s and
 * 1.2 MB in 0.3 s against physical floors of 0.64 s and 3.3 s, with every byte column reading zero.
 * Both refusals are exercised on those readings, so a regression that let either pass would have to
 * pass the run it was written for.
 */

const CAP_BYTES_PER_SECOND = 350_000;
const SEGMENT_360_BYTES = 224_848;
const SEGMENT_1080_BYTES = 1_163_720;

/** What the arm 3 probe actually measured for each, which is the failure being screened for. */
const ARM_3_360_MS = 100;
const ARM_3_1080_MS = 300;

describe('judgeCapProof', () => {
  it('refuses the arm 3 360p row, which beat its floor six times over', () => {
    const proof: CapProof = judgeCapProof(SEGMENT_360_BYTES, ARM_3_360_MS, CAP_BYTES_PER_SECOND);

    assert.equal(proof.verdict, 'never reached the node');
    // 224,848 / 350,000 is 0.642 s. The row took 0.1.
    assert.ok(proof.minimumMs !== null && Math.round(proof.minimumMs) === 642);
    assert.ok(proof.requiredMs !== null && proof.requiredMs === proof.minimumMs * CAP_PROOF_FLOOR_SHARE);
  });

  it('refuses the arm 3 1080p row, whose floor was 3.3 s and which took 0.3', () => {
    const proof = judgeCapProof(SEGMENT_1080_BYTES, ARM_3_1080_MS, CAP_BYTES_PER_SECOND);

    assert.equal(proof.verdict, 'never reached the node');
    assert.ok(proof.minimumMs !== null && Math.round(proof.minimumMs) === 3325);
  });

  it('passes a retrieval that took at least the floor, which is a cap that landed', () => {
    const proof = judgeCapProof(SEGMENT_360_BYTES, 3_400, CAP_BYTES_PER_SECOND);

    assert.equal(proof.verdict, 'reached the node');
    assert.equal(capProofRefusal(proof, 'the in-tab node'), null);
  });

  it('passes a retrieval exactly on the required floor, so the boundary is not a refusal', () => {
    const floorMs = (SEGMENT_360_BYTES / CAP_BYTES_PER_SECOND) * 1_000 * CAP_PROOF_FLOOR_SHARE;

    assert.equal(judgeCapProof(SEGMENT_360_BYTES, floorMs, CAP_BYTES_PER_SECOND).verdict, 'reached the node');
    assert.equal(judgeCapProof(SEGMENT_360_BYTES, floorMs - 1, CAP_BYTES_PER_SECOND).verdict, 'never reached the node');
  });

  it('reads a retrieval that returned nothing as no reading, which is never a pass', () => {
    // ⛔ The absence of the proof is treated as harshly as the proof coming back negative. A cap that
    // cannot prove itself is the whole failure, so a run with nothing to time must not publish.
    assert.equal(judgeCapProof(null, null, CAP_BYTES_PER_SECOND).verdict, 'no reading');
    assert.equal(judgeCapProof(SEGMENT_360_BYTES, null, CAP_BYTES_PER_SECOND).verdict, 'no reading');
    assert.equal(judgeCapProof(null, 5_000, CAP_BYTES_PER_SECOND).verdict, 'no reading');
    assert.equal(judgeCapProof(0, 5_000, CAP_BYTES_PER_SECOND).verdict, 'no reading');
  });

  it('reads a run with no cap at all as no reading rather than dividing by zero', () => {
    const proof = judgeCapProof(SEGMENT_360_BYTES, 100, 0);

    assert.equal(proof.verdict, 'no reading');
    assert.equal(proof.minimumMs, null);
  });
});

describe('capProofRefusal', () => {
  it('says the cap did not reach the node, and names the path that was timed', () => {
    const refusal = capProofRefusal(
      judgeCapProof(SEGMENT_1080_BYTES, ARM_3_1080_MS, CAP_BYTES_PER_SECOND),
      'the in-tab node',
    );

    assert.ok(refusal !== null);
    assert.match(refusal, /the cap did not reach the node/);
    assert.match(refusal, /the in-tab node/);
    assert.match(refusal, /SharedWorker/);
  });

  it('says a missing reading proved nothing rather than implying a pass', () => {
    const refusal = capProofRefusal(judgeCapProof(null, null, CAP_BYTES_PER_SECOND), 'a plain fetch');

    assert.ok(refusal !== null);
    assert.match(refusal, /could not prove itself/);
    assert.match(refusal, /a plain fetch/);
  });
});

describe('capProofLine', () => {
  it('can come out all three ways, so the verdict prose in a report can flip', () => {
    assert.match(capProofLine(judgeCapProof(SEGMENT_360_BYTES, 3_400, CAP_BYTES_PER_SECOND)), /reached the node/);
    assert.match(
      capProofLine(judgeCapProof(SEGMENT_360_BYTES, ARM_3_360_MS, CAP_BYTES_PER_SECOND)),
      /never reached the node/,
    );
    assert.match(capProofLine(judgeCapProof(null, null, CAP_BYTES_PER_SECOND)), /proved nothing/);
  });
});

describe('capExceededRefusal', () => {
  it('refuses a stretch whose mean inbound sat over the cap', () => {
    // Twice the cap across ten seconds. A capped link cannot carry more than its cap.
    const refusal = capExceededRefusal(CAP_BYTES_PER_SECOND * 20, 10_000, CAP_BYTES_PER_SECOND, 'the capped phase');

    assert.ok(refusal !== null);
    assert.match(refusal, /never applied to the transport/);
    assert.match(refusal, /the capped phase/);
  });

  it('allows a stretch inside the overshoot band, which a boundary burst can produce', () => {
    const justInside = CAP_BYTES_PER_SECOND * CAP_OVERSHOOT_TOLERANCE * 10;

    assert.equal(capExceededRefusal(justInside, 10_000, CAP_BYTES_PER_SECOND, 'the capped phase'), null);
  });

  it('is one sided: a quiet stretch proves nothing and is not refused', () => {
    // ⛔ The limit this carries. An idle node and a blind recorder both read under a cap, so passing
    // here is not evidence the cap landed. It is the strongest thing a page with no retrieval handle
    // allows, and it is weaker than the timed proof.
    assert.equal(capExceededRefusal(0, 60_000, CAP_BYTES_PER_SECOND, 'the capped phase'), null);
  });

  it('says nothing about a stretch of no length, rather than dividing by zero', () => {
    assert.equal(capExceededRefusal(1_000, 0, CAP_BYTES_PER_SECOND, 'the capped phase'), null);
  });
});

describe('judgeRecorderProof', () => {
  it('calls the arm 3 recorder blind: 1.2 MB delivered and zero counted', () => {
    const proof: RecorderProof = judgeRecorderProof(SEGMENT_1080_BYTES, 0, 1);

    assert.equal(proof.verdict, 'blind');
  });

  it('accepts a recorder that counted at least the payload, plus overhead', () => {
    // The arm 1 probe of the same day: 224,848 payload bytes against 250,192 inbound.
    assert.equal(judgeRecorderProof(SEGMENT_360_BYTES, 250_192, 1).verdict, 'saw the delivery');
  });

  it('refuses an inbound total below the payload, with no tolerance band at all', () => {
    // ⛔ Physics does not allow the error in this direction: the payload arrived over those sockets,
    // so a smaller total means sockets the recorder never saw.
    assert.equal(judgeRecorderProof(SEGMENT_360_BYTES, SEGMENT_360_BYTES - 1, 1).verdict, 'blind');
    assert.equal(judgeRecorderProof(SEGMENT_360_BYTES, SEGMENT_360_BYTES, 1).verdict, 'saw the delivery');
  });

  it('reads a run with nothing to compare as no reading rather than as a pass', () => {
    // "I could not look" and "I looked and saw nothing" are the same zero, and #41 already cost this
    // project that confusion once.
    assert.equal(judgeRecorderProof(0, 0, 0).verdict, 'no reading');
    assert.equal(judgeRecorderProof(0, 500_000, 3).verdict, 'no reading');
    assert.equal(judgeRecorderProof(SEGMENT_360_BYTES, 0, 0).verdict, 'no reading');
  });
});

describe('recorderBlindRefusal', () => {
  it('says the recorder is blind and names both totals', () => {
    const refusal = recorderBlindRefusal(judgeRecorderProof(SEGMENT_1080_BYTES, 0, 3), "the probe's frame recorder");

    assert.ok(refusal !== null);
    assert.match(refusal, /is blind/);
    assert.match(refusal, /1,163,720 payload bytes/);
    assert.match(refusal, /3 retrieval/);
    assert.match(refusal, /SharedWorker/);
  });

  it('says nothing was proved where no retrieval returned a payload', () => {
    const refusal = recorderBlindRefusal(judgeRecorderProof(0, 0, 0), "the probe's frame recorder");

    assert.ok(refusal !== null);
    assert.match(refusal, /cannot be shown to have seen anything/);
  });

  it('is silent on a recorder that saw the delivery', () => {
    assert.equal(recorderBlindRefusal(judgeRecorderProof(SEGMENT_360_BYTES, 250_192, 1), 'the recorder'), null);
  });
});

describe('recorderProofLine', () => {
  it('can come out all three ways', () => {
    assert.match(recorderProofLine(judgeRecorderProof(SEGMENT_360_BYTES, 250_192, 1)), /saw the delivery/);
    assert.match(recorderProofLine(judgeRecorderProof(SEGMENT_360_BYTES, 0, 1)), /is blind/);
    assert.match(recorderProofLine(judgeRecorderProof(0, 0, 0)), /proved nothing/);
  });
});

describe('blindWhileDeliveringRefusal', () => {
  it('refuses a phase that gained media while the recorder counted nothing', () => {
    const refusal = blindWhileDeliveringRefusal(59.8, 0, 'the capped phase');

    assert.ok(refusal !== null);
    assert.match(refusal, /is blind across the capped phase/);
    assert.match(refusal, /59\.8 s of media/);
  });

  it('is silent where the recorder counted anything at all', () => {
    assert.equal(blindWhileDeliveringRefusal(59.8, 1, 'the capped phase'), null);
  });

  it('is silent on a phase that gained no media, because a stalled picture fetches nothing', () => {
    // ⛔ Zero media and zero bytes is a starved viewer, which is a result. Only media WITHOUT bytes
    // is arithmetically impossible and therefore an instrument fault.
    assert.equal(blindWhileDeliveringRefusal(0, 0, 'the capped phase'), null);
  });

  it('is silent on a phase nobody could measure, rather than reading null as zero', () => {
    assert.equal(blindWhileDeliveringRefusal(null, 0, 'the capped phase'), null);
  });
});
