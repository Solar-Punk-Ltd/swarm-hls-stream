import { catalogStateLost, manifestUploaded, rungBatchRefused, segmentUploaded } from '@swarm-hls-stream/shared';
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  deployedLogShapeRefusal,
  deployedLogShapeSummary,
  deployedMessage,
  messageLiterals,
} from '../src/deployedLogShape.js';

/**
 * ⛔ Every case here is the 2026-09-01 sitting. The manifest log line gained a stream id, the
 * harness was synced to the host, the uploader was not, and two scenarios reported "manifest
 * publishes never resumed" against a deployment that was publishing manifests throughout. The gate
 * exists so that costs a refusal before the first frame rather than a paid sitting.
 */

const MANIFEST = deployedMessage(
  'manifest publishes',
  (stream, index) => manifestUploaded(stream, index),
  'service/happy-path and the freeze guard in bee-outage-long',
);
const SEGMENT = deployedMessage(
  'per-segment uploads',
  (stream, index) => segmentUploaded(stream, index, 'ref'),
  'every scenario that counts segments',
);

/** The uploader as it stood before the manifest line named its rung. */
const STALE_DIST = 'log(`Manifest uploaded at SOC index ${nextIndex}`)';

/**
 * The shortest prefix of the stand-in that `deployedLogShape.ts` can still recognise.
 *
 * ⛔ The guards below look for THIS rather than for the whole stand-in. The split recognises every
 * prefix from ten characters down to four, so a composer that cuts its argument to five leaves
 * `SHAPE` behind and one that cuts to four leaves `SHAP`, and a guard written against `SHAPE` misses
 * the second of those. Every longer prefix begins with this one, so one check covers the whole range
 * the code handles.
 *
 * ⚠️ Mirrors `SAMPLE_TEXT` and `MIN_USEFUL_FRAGMENT` in `src/deployedLogShape.ts`, the same way the
 * whole stand-in is already written out below.
 */
const SHORTEST_STAND_IN_PREFIX = 'SHAP';

describe('splitting a composed message into the parts a deployment must contain', () => {
  it('keeps the fixed halves and drops the values', () => {
    const literals = messageLiterals(MANIFEST.composed);

    assert.ok(
      literals.some((l) => l.includes('uploaded at SOC index')),
      `the distinctive half was lost: ${literals.join(' | ')}`,
    );
    assert.equal(
      literals.some((l) => l.includes(SHORTEST_STAND_IN_PREFIX) || l.includes('909090909090')),
      false,
      'a placeholder leaked into what the deployment is checked for',
    );
  });

  /**
   * ⛔ Without this the gate passes against anything. `segmentUploaded` composes to
   * `Segment N of <stream> uploaded: <ref>`, whose middle fragment cuts down to "of" — two
   * characters that occur in every log ever written.
   */
  it('drops fragments too short to distinguish one deployment from another', () => {
    for (const literal of messageLiterals(SEGMENT.composed)) {
      assert.ok(literal.length >= 4, `"${literal}" would match any deployment at all`);
    }
  });

  /**
   * ⛔⛔ **A composer that SHORTENS one of its arguments, which this gate could not see.**
   * `rungBatchRefused` cuts the batch id to its first eight characters, because a whole id is what
   * authorises spending on a rung and a refusal outlives the run in a scrollback. Run on a ten
   * character stand-in that leaves eight of it behind, so the split found no placeholder there and
   * kept `Postage batch SHAPEPRO of` as a literal the deployment is required to contain.
   *
   * ⛔ The direction of the failure is what makes it worth a case of its own. It does not weaken the
   * gate, it breaks it shut: no uploader ever built contains that text, so the refusal would fire on
   * every deployment for ever and tell an operator to redeploy something that was never stale.
   */
  it('keeps up with a composer that shortens its own placeholder', () => {
    const refused = deployedMessage(
      'batch refusals',
      (text, index) => rungBatchRefused(text, text, index, text),
      'the batch-drain suites',
    );
    const literals = messageLiterals(refused.composed);

    assert.ok(
      literals.some((literal) => literal.includes('Postage batch')),
      `the distinctive half was lost: ${literals.join(' | ')}`,
    );
    for (const literal of literals) {
      assert.doesNotMatch(
        literal,
        new RegExp(SHORTEST_STAND_IN_PREFIX),
        `"${literal}" carries a placeholder, so the gate would demand it of every deployment`,
      );
    }
  });

  /**
   * ⛔⛔ The boundary of what the split can recognise, which is where a guard against the WHOLE
   * stand-in stops working. `rungBatchRefused` cuts its batch id to eight characters and is the
   * shortest cut the contract has today, so nothing in it distinguishes a split that recognises
   * prefixes down to four from one that stops at five. A composer that cut to four would leave
   * `SHAP` as a literal every deployment is required to contain, and break the gate shut the way
   * `SHAPEPRO` did.
   *
   * ⚠️ The composer is a stand-in for one this contract does not have yet. That is the point: the
   * guard has to be at least as wide as the code, rather than as wide as today's shortest cut.
   */
  it('leaves nothing behind for a composer that cuts its argument to the shortest prefix', () => {
    const cutToFour = deployedMessage(
      'a composer that truncates hard',
      (text, index) => `Postage batch ${text.slice(0, SHORTEST_STAND_IN_PREFIX.length)} of ${index}`,
      'nothing yet, this is the boundary case',
    );

    for (const literal of messageLiterals(cutToFour.composed)) {
      assert.doesNotMatch(
        literal,
        new RegExp(SHORTEST_STAND_IN_PREFIX),
        `"${literal}" carries a placeholder, so the gate would demand it of every deployment`,
      );
    }
  });
});

describe('refusing a stage whose uploader predates the harness', () => {
  it('refuses when the deployed code cannot write the line', () => {
    const refusal = deployedLogShapeRefusal([MANIFEST], STALE_DIST);

    assert.ok(refusal, 'a stale uploader must not be measured against');
    assert.match(refusal, /manifest publishes/);
    assert.match(refusal, /Redeploy the stream-uploader/);
  });

  /** ⛔ The refusal has to name the wrong fix as wrong, because it is the tempting one. */
  it('tells the reader not to reword the pattern back', () => {
    assert.match(String(deployedLogShapeRefusal([MANIFEST], STALE_DIST)), /Do NOT reword the patterns/);
  });

  it('says which scenarios stop, so a reader knows what the refusal bought them', () => {
    assert.match(String(deployedLogShapeRefusal([MANIFEST], STALE_DIST)), /bee-outage-long/);
  });

  it('passes a deployment built from this same checkout', () => {
    const current = `${MANIFEST.composed} ${SEGMENT.composed}`;

    assert.equal(deployedLogShapeRefusal([MANIFEST, SEGMENT], current), null);
  });

  it('counts every stale line rather than stopping at the first', () => {
    const refusal = String(deployedLogShapeRefusal([MANIFEST, SEGMENT], STALE_DIST));

    assert.match(refusal, /does not write 2 of the log lines/);
  });

  it('passes vacuously on an empty list rather than throwing', () => {
    assert.equal(deployedLogShapeRefusal([], ''), null);
  });

  it('says what a green check proved, so a pass is not silence', () => {
    assert.match(deployedLogShapeSummary([MANIFEST, SEGMENT]), /2 parsed log line/);
  });
});

/**
 * ⛔ The rule the whole gate rests on, written down because a message added on 2026-09-01 walked
 * into it. A composed message survives bundling as literals only where the composer holds it as one,
 * and `tsc` keeps a `+` between two strings exactly as it was written. So the fragment spanning that
 * join is in no built file, and the gate refuses a deployment that writes the line perfectly well.
 *
 * Right for a stale deployment and wrong for ever, so the fix belongs on the composer's side:
 * `catalogStateLost` is one template literal and has to stay one, whatever it costs in line width.
 */
describe('a message the deployment assembles from more than one literal', () => {
  const CATALOG_LOST = deployedMessage(
    'the catalog giving up on its own previous state',
    (stream, index) => catalogStateLost(stream, index),
    "finalize-crash's discriminator",
  );

  /** The catalog line the way `StreamCatalog` wrote it before the composer existed. */
  const SPLIT_LITERAL_DIST =
    'error(`[StreamCatalog] State at index ${index} failed to read ${reads} times; ` + ' +
    "'continuing with an empty catalog — earlier entries are lost')";

  it('refuses it, which is why the composer holds the message as a single template literal', () => {
    assert.match(String(deployedLogShapeRefusal([CATALOG_LOST], SPLIT_LITERAL_DIST)), /empty catalog/);
  });

  it('passes the same message where the deployment holds it whole', () => {
    assert.equal(deployedLogShapeRefusal([CATALOG_LOST], CATALOG_LOST.composed), null);
  });
});
