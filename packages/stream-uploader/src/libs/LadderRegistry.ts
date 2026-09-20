import { MediaType, Rendition } from '../types.js';

import { ManagedExpectedRendition } from './ManagedCheckpointStore.js';

export interface ManagedLadderRun {
  readonly runNumber: number;
  readonly uploaderId: string;
  readonly claimId: string;
  readonly expectedRenditions: readonly ManagedExpectedRendition[];
}

/**
 * Everything about a ladder that is the same for all of its rungs.
 *
 * Declared here rather than beside the catalog that used to be the only thing holding it, because
 * both implementations of {@link LadderRegistry} are handed one and only one of them is a catalog.
 */
export interface LadderIdentity {
  title: string;
  owner: string;
  /**
   * What ties the rungs together: the catalog entry's key, the master feed's topic, and the name every
   * rung's own feed topic is derived from. See `rungTopicFor`.
   */
  group: string;
  mediatype: MediaType;
  /**
   * The admin's own id for this broadcast, in admin mode, which every report to it names.
   *
   * A property of the ladder rather than of the rung, in the same way the group is: one declared
   * stream is one ladder, and all four rungs report their records against it. Absent standalone,
   * where nothing is reported to anybody — {@link StreamCatalog} never reads it.
   */
  adminStreamId?: string;
  /** Immutable lifecycle-v1 authority for this ladder announce. */
  managedRun?: ManagedLadderRun;
}

/**
 * What one rung's announce achieved for the whole ladder, which is more than that rung can see.
 *
 * ⛔ A rung announcing itself again without an `index` is a rung that is LIVE again, on the feed it
 * was already on: its topic is derived from the group and its rung name, so it is the same string it
 * announced last time. Whatever finished record it replaces stays addressable until that rung's next
 * finalize arrives with an index of its own — see `StreamCatalog.keepingWhatFinished`.
 *
 * ⛔ Returned rather than inferred by the caller, and that is the same rule
 * `StreamCatalog.addStream` already follows for a single-rendition stream: a rung announces its own
 * record and the *ladder* is what flips, so the only thing that can say whether this announce is the
 * moment the broadcast became a recording is whatever holds the other three rungs. A session
 * announcing a flip off its own intent reports one broadcast ending twice, which is what a resumed
 * finalize does.
 */
export interface RenditionAnnouncement {
  /**
   * Where the ladder's master playlist landed in the group's feed, or null when no master was
   * written — which is a standalone deployment with no master writer, or a ladder with nothing left
   * to name.
   */
  masterIndex: number | null;
  /** Exact immutable Swarm reference written at masterIndex, or null when no master landed. */
  masterReference?: string | null;
  /** Whether this announce is the moment every rung of the ladder had finalized, and none before it. */
  flippedToFinished: boolean;
  /** Playing time of the finished recording in seconds, when the ladder flipped. */
  duration: number | null;
}

/**
 * Where a rung's rendition record goes, and where a delivery is counted.
 *
 * Two implementations, one per deployment, and the split is the whole of ABR in admin mode.
 * {@link StreamCatalog} merges the four rungs into one catalog entry on Swarm and writes the master
 * from it. `AdminLadderRegistry` posts each record to the admin, which holds the merge state and writes
 * its own catalog entry, and writes the master from the ladder that comes back. Neither knows about
 * the other, and the uploader knows about neither.
 */
export interface LadderRegistry {
  /**
   * Merge one rung into its ladder, publish the ladder's master playlist, and say what that achieved.
   */
  upsertRendition(identity: LadderIdentity, rendition: Rendition): Promise<RenditionAnnouncement>;

  /**
   * One segment of this rung reached Swarm.
   *
   * Called from the uploader's segment path beside the per-rung metric, because that is the one place
   * a delivery is known to have actually landed rather than been attempted. It is also the only path
   * that can notice a rung *stopping*, which no announce ever reports. See `LadderLiveness`.
   */
  recordRungDelivered(group: string, rung: string, managedRun?: ManagedLadderRun): void;
}
