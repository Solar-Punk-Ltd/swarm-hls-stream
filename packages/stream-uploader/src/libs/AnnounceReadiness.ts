/**
 * How far a stream has got towards being discoverable, as one value rather than two booleans.
 *
 * `isFirstSegmentReady` and `isFirstManifestReady` held three legal states between them, which left
 * a fourth representable: announced without a segment. Nothing produced it during a live broadcast,
 * because the only writer of the second is the announce itself and the announce is gated on the
 * first. `restoreState` produced it directly, by assigning both straight from a persisted entry.
 *
 * The cost of that state is silent. `uploadLiveManifest` announces on `SEGMENT_READY` and nothing
 * else, so a stream restored as `ANNOUNCED` having never announced is never published, and no
 * viewer can find a broadcast that is otherwise running correctly.
 */
export const READINESS_PENDING = 'pending' as const;
export const READINESS_SEGMENT_READY = 'segment-ready' as const;
export const READINESS_ANNOUNCED = 'announced' as const;

export type AnnounceReadiness = typeof READINESS_PENDING | typeof READINESS_SEGMENT_READY | typeof READINESS_ANNOUNCED;

/** The persisted shape, unchanged, so a recovery entry written by an older build still loads. */
export interface PersistedReadiness {
  isFirstSegmentReady: boolean;
  isFirstManifestReady: boolean;
}

export class IllegalReadinessTransition extends Error {
  constructor(from: AnnounceReadiness, event: string) {
    super(`Illegal announce readiness transition: ${event} while ${from}`);
    this.name = 'IllegalReadinessTransition';
  }
}

/** What a restore produced, and whether the persisted pair had to be repaired to get there. */
export interface RestoredReadiness {
  readiness: AnnounceReadiness;
  /** The unreachable pair that was read, when one was. Absent on a normal restore. */
  repairedFrom?: PersistedReadiness;
}

/**
 * The state after a segment upload succeeds.
 *
 * Both call sites run on every segment rather than only the first, so this is idempotent by design:
 * a stream that has already announced stays announced. Expressed as the event rather than as a
 * target state for exactly that reason, since "set it to segment-ready" would be a move backwards
 * on the second segment of every broadcast that ever announced.
 */
export function onFirstSegmentUploaded(from: AnnounceReadiness): AnnounceReadiness {
  return from === READINESS_PENDING ? READINESS_SEGMENT_READY : from;
}

/**
 * The state after the catalog announce succeeds, or a throw when no segment has been uploaded.
 *
 * Throwing rather than clamping is the point of the type: announcing without a segment publishes a
 * catalog entry pointing at a feed with nothing in it, so a viewer opens a broadcast that cannot
 * play. Nothing reaches this from `PENDING` today, because `uploadLiveManifest` gates on
 * `needsCatalogAnnounce`, and that gate is what this asserts rather than assumes.
 */
export function onCatalogAnnounced(from: AnnounceReadiness): AnnounceReadiness {
  if (from === READINESS_PENDING) {
    throw new IllegalReadinessTransition(from, 'catalog announce');
  }
  return READINESS_ANNOUNCED;
}

/**
 * Read a persisted entry, repairing the combination that cannot have been reached legally.
 *
 * **Repairs rather than throws, and the first version of this got that wrong.** Refusing the entry
 * looked like the strict, safe answer and was strictly worse than the bug it was added for: the
 * broadcast was no longer registered, so nothing finalized it as a VOD at the recovery timeout, its
 * catalog entry went on saying `live` forever, and the file stayed on disk failing identically on
 * every restart. The old code, for all that it never announced, did at least reach that cleanup.
 *
 * `SEGMENT_READY` is the repair because it is the assumption whose two failure modes are not
 * comparable. Assuming the announce happened when it did not leaves the broadcast undiscoverable for
 * its whole duration. Assuming it did not when it did costs one extra `addStream`, which overwrites
 * an entry with the same content.
 */
export function readinessFromPersisted(persisted: PersistedReadiness): RestoredReadiness {
  if (persisted.isFirstManifestReady && !persisted.isFirstSegmentReady) {
    return { readiness: READINESS_SEGMENT_READY, repairedFrom: persisted };
  }
  if (persisted.isFirstManifestReady) {
    return { readiness: READINESS_ANNOUNCED };
  }
  return { readiness: persisted.isFirstSegmentReady ? READINESS_SEGMENT_READY : READINESS_PENDING };
}

/** The persisted shape for a state, so the recovery file keeps the format older builds wrote. */
export function readinessToPersisted(readiness: AnnounceReadiness): PersistedReadiness {
  return {
    isFirstSegmentReady: readiness !== READINESS_PENDING,
    isFirstManifestReady: readiness === READINESS_ANNOUNCED,
  };
}

/** Whether this stream still owes the catalog an announce. The gate `uploadLiveManifest` reads. */
export function needsCatalogAnnounce(readiness: AnnounceReadiness): boolean {
  return readiness === READINESS_SEGMENT_READY;
}
