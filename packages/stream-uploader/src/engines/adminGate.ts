import { AdminApiClient, AdminStreamDraft } from '../libs/AdminApiClient.js';
import { Logger } from '../libs/Logger.js';
import { AdminSession, MediaType } from '../types.js';
import { getErrorMessage } from '../utils/common.js';
import { matchesPublishKey } from '../utils/publishKey.js';

const logger = Logger.getInstance();

/**
 * The publish gate both engines run when admin mode is on. See {@link AdminApiClient}.
 *
 * ## Why this is one function and not two engine-shaped ones
 *
 * The engines disagree about everything around the credential: SRS relays a `param` query string on a
 * webhook, OME signs a body carrying a publish URL, one answers a numeric code and the other an
 * admission verdict. They agree exactly about what a publish has to prove, and the last time that
 * agreement was left implicit — SEC-26's publisher address — both call sites were wrong in the same
 * way for the whole life of the feature, because each looked correct beside the other's absence.
 *
 * ## What it refuses, in order
 *
 * 1. **Unannounced.** No draft for this ingest id. In admin mode there is no such thing as a stream
 *    nobody declared: the topic and the key are both minted by the declaration, so there is nothing
 *    to publish into and nothing to check against.
 * 2. **Unreachable.** The lookup did not complete. Deliberately a refusal and deliberately its own
 *    log line: failing open would admit a publisher with no key check at all, and a broadcast
 *    published to a random topic that the admin never learns about is worse than one that never
 *    started, because it spends postage and reaches nobody.
 * 3. **Bad key.** The presented `key=` is not the draft's, compared constant-time.
 * 4. **Wrong media type.** The engine's `app` says one thing and the declaration says another. Refused
 *    rather than reconciled: `app` decides which media the uploader publishes and the draft decides
 *    what the admin will show, and a stream that is audio to one and video to the other is a player
 *    that builds the wrong codec set from the first fragment.
 */
export const ADMIN_PUBLISH_ALLOWED = 'allowed' as const;
export const ADMIN_PUBLISH_UNANNOUNCED = 'unannounced' as const;
export const ADMIN_PUBLISH_UNREACHABLE = 'unreachable' as const;
export const ADMIN_PUBLISH_BAD_KEY = 'bad-key' as const;
export const ADMIN_PUBLISH_WRONG_MEDIA_TYPE = 'wrong-media-type' as const;

export type AdminPublishRefusal =
  | typeof ADMIN_PUBLISH_UNANNOUNCED
  | typeof ADMIN_PUBLISH_UNREACHABLE
  | typeof ADMIN_PUBLISH_BAD_KEY
  | typeof ADMIN_PUBLISH_WRONG_MEDIA_TYPE;

export type AdminPublishVerdict =
  | { kind: typeof ADMIN_PUBLISH_ALLOWED; session: AdminSession }
  | { kind: AdminPublishRefusal };

/**
 * Whether a refusal is one to count as an authentication rejection, which is what `/health` reports
 * and what OBS-15 exists for.
 *
 * The two credential refusals count. `unreachable` does not: it is this deployment failing, not a
 * caller failing to prove anything, and counting it would make an admin outage read as an attack.
 * `wrong-media-type` does not either: the caller proved the key for the stream it named, so it is a
 * misconfigured publisher rather than an unauthorised one.
 */
export function isAuthRefusal(refusal: AdminPublishRefusal): boolean {
  return refusal === ADMIN_PUBLISH_UNANNOUNCED || refusal === ADMIN_PUBLISH_BAD_KEY;
}

/**
 * @param tag the engine's log prefix, e.g. `[SRS]`, so a refusal reads the way every other line that
 * engine writes does.
 * @param presentedKey the `key=` the announce carried, from the engine's own extraction helper, or
 * null when it carried none.
 */
export async function resolveAdminPublish(
  client: AdminApiClient,
  tag: string,
  streamId: string,
  mediatype: MediaType,
  presentedKey: string | null,
): Promise<AdminPublishVerdict> {
  let draft: AdminStreamDraft | null;
  try {
    draft = await client.lookupByIngestId(streamId);
  } catch (error) {
    // Deliberately not worded "unreachable" even though the verdict is named that. The same branch
    // catches a 401 and a 200 whose body is not a draft, and those share the verdict for a good
    // reason — they are this deployment failing rather than a caller failing to prove anything, so
    // {@link isAuthRefusal} must exclude them — but only the cause says which one happened, and an
    // operator reading the line is the person who has to tell a bad token from a dead admin.
    logger.error(`${tag} refused ${streamId}: the admin API did not resolve it (${getErrorMessage(error)})`);
    return { kind: ADMIN_PUBLISH_UNREACHABLE };
  }

  if (draft === null) {
    logger.warn(`${tag} refused ${streamId}: no announced stream for this ingest id`);
    return { kind: ADMIN_PUBLISH_UNANNOUNCED };
  }

  // Before the media check, because this is the one that decides whether the caller is the
  // broadcaster at all, and the other discloses something about a declaration they have not proved
  // they own. Neither the presented key nor the expected one is ever logged.
  if (!matchesPublishKey(draft.publishKey, presentedKey)) {
    logger.warn(`${tag} refused ${streamId}: missing or invalid publish key for the announced stream`);
    return { kind: ADMIN_PUBLISH_BAD_KEY };
  }

  if (draft.mediaType !== mediatype) {
    logger.error(
      `${tag} refused ${streamId}: the ingest app says ${mediatype} and the announced stream says ${draft.mediaType}`,
    );
    return { kind: ADMIN_PUBLISH_WRONG_MEDIA_TYPE };
  }

  logger.info(`${tag} resolved ${streamId} to announced stream ${draft.id} ("${draft.title}") on topic ${draft.topic}`);
  return { kind: ADMIN_PUBLISH_ALLOWED, session: { id: draft.id, topic: draft.topic } };
}
