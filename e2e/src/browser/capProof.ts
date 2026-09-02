/**
 * Proving that a cap was applied and that the recorder could see, before any figure taken under
 * either is allowed to mean anything.
 *
 * ## ⛔⛔⛔ Why this exists: a cap that could not prove itself, and a zero that passed as healthy
 *
 * Two readings of 2026-09-02 were void and neither said so at the time.
 *
 * - The arm 3 probe ran under a "2800 kbps cap", which carries 350,000 bytes/s, and pulled a 225 KB
 *   segment in 0.1 s and a 1.2 MB one in 0.3 to 0.4 s. The physical floors are 0.64 s and 3.3 s. The
 *   cap had been applied to the page's debug session and the node lives in a SharedWorker, so it
 *   never reached the transport at all. Nothing in the run noticed.
 * - Every byte column of that same report reads **0** while those retrievals succeeded, because the
 *   recorder was page scoped too. The H0 check then compared the zero against what the cap allows,
 *   found it comfortably under, and printed "✅ H0 holds". **A zero from a blind instrument passed as
 *   a healthy reading.**
 *
 * ⛔ So neither the cap nor the recorder is believed here. Each is proved by effect, on every squeeze
 * run, and a run that cannot prove one refuses rather than publishing under it. `workerTargets.ts`
 * is the fix; this module is what stops the fix being believed rather than shown.
 *
 * ## Two proofs, and the shape each takes on a page we did not write
 *
 * **The cap proof** times one retrieval of a known-size payload through the node and compares it
 * against the physical floor at the cap. That needs a handle to retrieve through, which our own
 * client publishes (`__swarmFetchBackendSwitch.retrieveBytes`) and weeb-3's own page does not. On his
 * page the proof is therefore {@link capExceededRefusal}, which is **one sided**: inbound over the
 * cap refuses, and inbound under it proves nothing, because an idle node also reads under a cap.
 * That limit is stated in the report rather than papered over.
 *
 * **The recorder proof** compares the payload a retrieval returned against what the recorder counted
 * arriving over the same stretch. Those bytes crossed a wire, so a recorder that saw fewer of them
 * than the payload contained did not see the wire they crossed. On weeb-3's page there is no payload
 * figure, so the proof is {@link blindWhileDeliveringRefusal}: a playhead that gained media proves
 * segments were delivered, and zero inbound beside that is a blind instrument.
 */

const MS_PER_SECOND = 1_000;

/**
 * How much of the physical floor a retrieval has to take before the cap counts as having landed.
 *
 * ⛔ Under one rather than at one, and the slack is in the direction that avoids a false refusal. A
 * capped retrieval cannot beat its floor, but the floor is computed from the payload the node
 * returned rather than from what crossed the wire, and a node that had part of the answer cached, or
 * a window clipped by a millisecond at either end, can land just inside it. Four fifths is far
 * enough below to make a false refusal implausible and nowhere near the failure it screens for,
 * which was **six times** faster than the floor.
 */
export const CAP_PROOF_FLOOR_SHARE = 0.8;

/**
 * How far over a cap a stretch's mean inbound may sit before the cap is judged never to have landed.
 *
 * The external shaper's own over-band, reused for its reason: coming in over a cap has no benign
 * explanation, while a burst measured across a window boundary has one.
 */
export const CAP_OVERSHOOT_TOLERANCE = 1.15;

/**
 * Not exported: it is reachable as `CapProof['verdict']`, and every exported name is a promise
 * something may import it.
 */
type CapVerdict = 'reached the node' | 'never reached the node' | 'no reading';

/** What one timed retrieval says about whether the cap was ever applied to the node's transport. */
export interface CapProof {
  /** The payload the node returned, or null where it returned none. */
  byteLength: number | null;
  /** How long it took, as the client's own clock measured it, or null where nothing settled. */
  elapsedMs: number | null;
  /** How long that many bytes take at the cap, which is the physical floor. Null with no reading. */
  minimumMs: number | null;
  /** The floor this run requires, {@link CAP_PROOF_FLOOR_SHARE} of the physical one. */
  requiredMs: number | null;
  capBytesPerSecond: number;
  verdict: CapVerdict;
}

/**
 * Judge one timed retrieval against the cap it was supposed to have run under.
 *
 * A null byte length or elapsed time is `no reading` and never a pass. A cap the run could not prove
 * is the failure this module exists for, so the absence of the proof is treated exactly as harshly
 * as the proof coming back negative.
 */
export function judgeCapProof(
  byteLength: number | null,
  elapsedMs: number | null,
  capBytesPerSecond: number,
): CapProof {
  if (byteLength === null || elapsedMs === null || byteLength <= 0 || capBytesPerSecond <= 0) {
    return {
      byteLength,
      elapsedMs,
      minimumMs: null,
      requiredMs: null,
      capBytesPerSecond,
      verdict: 'no reading',
    };
  }

  const minimumMs = (byteLength / capBytesPerSecond) * MS_PER_SECOND;
  const requiredMs = minimumMs * CAP_PROOF_FLOOR_SHARE;

  return {
    byteLength,
    elapsedMs,
    minimumMs,
    requiredMs,
    capBytesPerSecond,
    verdict: elapsedMs < requiredMs ? 'never reached the node' : 'reached the node',
  };
}

/** Digits grouped without going through a locale, so an artifact reads the same on every machine. */
function grouped(value: number): string {
  return Math.round(value)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function secondsLabel(ms: number): string {
  return `${(ms / MS_PER_SECOND).toFixed(2)} s`;
}

/**
 * Why this run must not publish anything taken under its cap, or null when the cap was proved.
 *
 * @param through What was retrieved through, named so the sentence says which path was timed.
 */
export function capProofRefusal(proof: CapProof, through: string): string | null {
  if (proof.verdict === 'reached the node') {
    return null;
  }

  if (proof.verdict === 'no reading') {
    return (
      `the cap could not prove itself: nothing came back through ${through} to time, so this run has ` +
      'no evidence that the cap reached the transport carrying the bytes. A cap that cannot prove ' +
      'itself is the failure of the arm 3 probe of 2026-09-02, where every capped figure was a ' +
      'reading of an uncapped link. Refusing rather than publishing under it.'
    );
  }

  return (
    `the cap did not reach the node. ${grouped(proof.byteLength ?? 0)} bytes came back through ` +
    `${through} in ${secondsLabel(proof.elapsedMs ?? 0)}, and at ` +
    `${grouped(proof.capBytesPerSecond)} bytes/s that many bytes cannot cross the wire in less than ` +
    `${secondsLabel(proof.minimumMs ?? 0)}. The floor this run requires is ` +
    `${secondsLabel(proof.requiredMs ?? 0)}, which is ${CAP_PROOF_FLOOR_SHARE} of the physical one. ` +
    'The emulation was therefore applied somewhere the bytes do not travel, which since weeb-3 ' +
    '0.0.341001 means it reached the page and not the SharedWorker the node runs in.'
  );
}

/** The cap proof in one line, for the console and for the artifact's own prose. */
export function capProofLine(proof: CapProof): string {
  if (proof.verdict === 'no reading') {
    return '⛔ **the cap proved nothing**, because no retrieval came back to time it with';
  }
  const measured =
    `${grouped(proof.byteLength ?? 0)} bytes in ${secondsLabel(proof.elapsedMs ?? 0)} against a ` +
    `${secondsLabel(proof.minimumMs ?? 0)} floor at ${grouped(proof.capBytesPerSecond)} bytes/s`;
  return proof.verdict === 'reached the node'
    ? `✅ **the cap reached the node**: ${measured}`
    : `⛔ **the cap never reached the node**: ${measured}`;
}

/**
 * Why a stretch's own traffic says the cap was never applied, or null.
 *
 * ⛔⛔ **One sided, and the caller must say so wherever it prints this.** Inbound over the cap has no
 * benign explanation and refuses. Inbound under the cap proves nothing at all, because a node that
 * was idle, or a recorder that was blind, reads exactly the same way. This is the strongest thing
 * available on a page that publishes no retrieval handle, and it is weaker than
 * {@link capProofRefusal}, which is what our own client's page gets.
 */
export function capExceededRefusal(
  inboundBytes: number,
  windowMs: number,
  capBytesPerSecond: number,
  where: string,
): string | null {
  if (windowMs <= 0 || capBytesPerSecond <= 0) {
    return null;
  }
  const meanBytesPerSecond = inboundBytes / (windowMs / MS_PER_SECOND);
  if (meanBytesPerSecond <= capBytesPerSecond * CAP_OVERSHOOT_TOLERANCE) {
    return null;
  }

  return (
    `the cap was never applied to the transport carrying the bytes. Across ${where} the recorder ` +
    `counted ${grouped(inboundBytes)} inbound bytes over ${secondsLabel(windowMs)}, a mean of ` +
    `${grouped(meanBytesPerSecond)} bytes/s, against the ${grouped(capBytesPerSecond)} bytes/s that ` +
    'cap allows. A capped link cannot carry more than its cap, so every figure taken under it here ' +
    'is a reading of an unconstrained link.'
  );
}

/** Not exported, for the reason {@link CapVerdict} is not: `RecorderProof['verdict']` reaches it. */
type RecorderVerdict = 'saw the delivery' | 'blind' | 'no reading';

/**
 * What the recorder counted, against what the node is known to have delivered.
 *
 * `readings` is how many retrievals the comparison is over, and it is the field that keeps a run
 * with nothing to compare from reading as a pass. "I could not look" and "I looked and saw nothing"
 * are the same zero, and this project has already paid for that once (`#41`).
 */
export interface RecorderProof {
  payloadBytes: number;
  inboundBytes: number;
  readings: number;
  verdict: RecorderVerdict;
}

/**
 * Judge the recorder against the payload that is known to have crossed the wire.
 *
 * ⛔ Inbound below the payload is arithmetically impossible on a sighted instrument: the payload
 * arrived from peers over those very sockets, plus protocol overhead, so a smaller total means
 * sockets the recorder never saw. There is no tolerance band, because the direction of the error is
 * one physics does not allow.
 */
export function judgeRecorderProof(payloadBytes: number, inboundBytes: number, readings: number): RecorderProof {
  if (readings <= 0 || payloadBytes <= 0) {
    return { payloadBytes, inboundBytes, readings, verdict: 'no reading' };
  }
  return {
    payloadBytes,
    inboundBytes,
    readings,
    verdict: inboundBytes < payloadBytes ? 'blind' : 'saw the delivery',
  };
}

/**
 * Why no byte figure in this run may be printed, or null when the recorder was proved to see.
 *
 * @param what The instrument being judged, named so the sentence says which recorder went dark.
 */
export function recorderBlindRefusal(proof: RecorderProof, what: string): string | null {
  if (proof.verdict === 'saw the delivery') {
    return null;
  }

  if (proof.verdict === 'no reading') {
    return (
      `${what} cannot be shown to have seen anything: no retrieval in this run returned a payload to ` +
      'compare its byte counts against. Every byte figure here would be an unproved instrument ' +
      'reading, and a zero from a blind instrument is what passed as "H0 holds" on 2026-09-02.'
    );
  }

  return (
    `${what} is blind. The node delivered ${grouped(proof.payloadBytes)} payload bytes across ` +
    `${proof.readings} retrieval(s) and the recorder counted ${grouped(proof.inboundBytes)} inbound ` +
    'bytes arriving over the same stretches. Those payload bytes crossed a wire, so an inbound total ' +
    'below them means the recorder is not attached to the wire they crossed. Since weeb-3 0.0.341001 ' +
    "the node's sockets belong to a SharedWorker target, which a page-scoped recorder cannot see. " +
    'Refusing rather than printing a zero as a reading.'
  );
}

/** The recorder proof in one line, for the console and for the artifact's own prose. */
export function recorderProofLine(proof: RecorderProof): string {
  const counted = `${grouped(proof.inboundBytes)} inbound against ${grouped(proof.payloadBytes)} payload bytes over ${
    proof.readings
  } retrieval(s)`;
  if (proof.verdict === 'no reading') {
    return '⛔ **the recorder proved nothing**, because no retrieval returned a payload to compare against';
  }
  return proof.verdict === 'saw the delivery'
    ? `✅ **the recorder saw the delivery**: ${counted}`
    : `⛔ **the recorder is blind**: ${counted}`;
}

/**
 * Why a stretch that delivered media while the recorder read nothing must not be published, or null.
 *
 * ⛔ The recorder proof for a page that reports no payload size. A playhead that gained media proves
 * segments were fetched and appended, so bytes crossed the wire, so an inbound total of zero beside
 * it is an instrument that was not looking at the wire. Weaker than {@link recorderBlindRefusal},
 * which compares against a known payload, and it is the strongest thing weeb-3's own page allows.
 *
 * @param mediaGainedS Media the playhead gained across the stretch, or null where it cannot be read.
 */
export function blindWhileDeliveringRefusal(
  mediaGainedS: number | null,
  inboundBytes: number,
  where: string,
): string | null {
  if (mediaGainedS === null || mediaGainedS <= 0 || inboundBytes > 0) {
    return null;
  }

  return (
    `the recorder is blind across ${where}. The playhead gained ${mediaGainedS.toFixed(1)} s of media ` +
    'there, so segments were fetched and appended and bytes crossed the wire, and the recorder ' +
    'counted zero inbound bytes over the same stretch. Since weeb-3 0.0.341001 the node runs in a ' +
    'SharedWorker whose sockets a page-scoped recorder cannot see. Refusing rather than printing that ' +
    'zero, which is what the arm 3 probe of 2026-09-02 published as a healthy idle reading.'
  );
}
