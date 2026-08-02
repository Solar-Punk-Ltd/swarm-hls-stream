import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  IllegalReadinessTransition,
  needsCatalogAnnounce,
  onCatalogAnnounced,
  onFirstSegmentUploaded,
  READINESS_ANNOUNCED,
  READINESS_PENDING,
  READINESS_SEGMENT_READY,
  readinessFromPersisted,
  readinessToPersisted,
} from '../src/libs/AnnounceReadiness.js';

describe('announce readiness transitions (ARCH-3)', () => {
  it('starts pending and reaches segment-ready on the first segment', () => {
    assert.equal(onFirstSegmentUploaded(READINESS_PENDING), READINESS_SEGMENT_READY);
  });

  // Both writers run on every segment rather than only the first, so this has to be idempotent.
  // Modelled as a target state instead of an event, the second segment of every broadcast that had
  // already announced would be a move backwards.
  it('leaves a stream that has announced where it is when more segments arrive', () => {
    assert.equal(onFirstSegmentUploaded(READINESS_ANNOUNCED), READINESS_ANNOUNCED);
  });

  it('leaves segment-ready unchanged on later segments', () => {
    assert.equal(onFirstSegmentUploaded(READINESS_SEGMENT_READY), READINESS_SEGMENT_READY);
  });

  it('reaches announced from segment-ready', () => {
    assert.equal(onCatalogAnnounced(READINESS_SEGMENT_READY), READINESS_ANNOUNCED);
  });

  it('stays announced when a later manifest publish re-asserts it', () => {
    assert.equal(onCatalogAnnounced(READINESS_ANNOUNCED), READINESS_ANNOUNCED);
  });

  // A catalog entry written before any segment points at a feed with nothing in it, so a viewer
  // opens a broadcast that cannot play. Nothing reaches this today because uploadLiveManifest gates
  // on needsCatalogAnnounce, and this asserts that gate rather than assuming it.
  it('refuses to announce a stream that has uploaded no segment', () => {
    assert.throws(() => onCatalogAnnounced(READINESS_PENDING), IllegalReadinessTransition);
  });
});

describe('announce readiness gate (ARCH-3)', () => {
  it('owes the catalog an announce only once a segment is up and before it has announced', () => {
    assert.equal(needsCatalogAnnounce(READINESS_SEGMENT_READY), true);
    assert.equal(needsCatalogAnnounce(READINESS_PENDING), false);
    assert.equal(needsCatalogAnnounce(READINESS_ANNOUNCED), false);
  });
});

describe('announce readiness persistence (ARCH-3)', () => {
  for (const readiness of [READINESS_PENDING, READINESS_SEGMENT_READY, READINESS_ANNOUNCED] as const) {
    it(`round-trips ${readiness} through the persisted shape`, () => {
      const restored = readinessFromPersisted(readinessToPersisted(readiness));

      assert.equal(restored.readiness, readiness);
      assert.equal(restored.repairedFrom, undefined, 'a legal state was reported as needing repair');
    });
  }

  // The persisted shape is deliberately unchanged, so a recovery entry written by an older build
  // still loads. Asserted as literals rather than through the round trip, which would pass just as
  // happily on a format nothing else can read.
  it('writes the two booleans older builds wrote', () => {
    assert.deepEqual(readinessToPersisted(READINESS_PENDING), {
      isFirstSegmentReady: false,
      isFirstManifestReady: false,
    });
    assert.deepEqual(readinessToPersisted(READINESS_SEGMENT_READY), {
      isFirstSegmentReady: true,
      isFirstManifestReady: false,
    });
    assert.deepEqual(readinessToPersisted(READINESS_ANNOUNCED), {
      isFirstSegmentReady: true,
      isFirstManifestReady: true,
    });
  });

  it('reads the three combinations an older build could have written', () => {
    assert.equal(
      readinessFromPersisted({ isFirstSegmentReady: false, isFirstManifestReady: false }).readiness,
      READINESS_PENDING,
    );
    assert.equal(
      readinessFromPersisted({ isFirstSegmentReady: true, isFirstManifestReady: false }).readiness,
      READINESS_SEGMENT_READY,
    );
    assert.equal(
      readinessFromPersisted({ isFirstSegmentReady: true, isFirstManifestReady: true }).readiness,
      READINESS_ANNOUNCED,
    );
  });

  // The whole reason the two booleans became one value. This combination cannot be reached by any
  // live sequence, and a stream restored into it passes every gate silently while never being
  // published: `needsCatalogAnnounce` reads false, so `announceToCatalog` is never called.
  const IMPOSSIBLE = { isFirstSegmentReady: false, isFirstManifestReady: true };

  it('repairs a persisted entry claiming it announced before its first segment', () => {
    const restored = readinessFromPersisted(IMPOSSIBLE);

    assert.equal(restored.readiness, READINESS_SEGMENT_READY);
    assert.equal(needsCatalogAnnounce(restored.readiness), true, 'the repaired stream still owes an announce');
  });

  it('reports what it repaired, so the entry on disk can be identified', () => {
    assert.deepEqual(readinessFromPersisted(IMPOSSIBLE).repairedFrom, IMPOSSIBLE);
  });

  // Refusing the entry was the first version of this and was strictly worse than the bug it was
  // added for: an unregistered stream is never finalized as a VOD at the recovery timeout, so its
  // catalog entry says `live` forever and the file fails identically on every restart.
  it('does not throw, because a refused entry is never cleaned up', () => {
    assert.doesNotThrow(() => readinessFromPersisted(IMPOSSIBLE));
  });
});
