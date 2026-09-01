import { containerName, type E2EConfig } from '../config.js';
import { parseStageSegmenting, type StageSegmenting } from '../segmentLength.js';

import type { Host } from './host.js';
import { PUBLISHER_GOP_SECONDS } from './publisher.js';

/**
 * What the deployed stage cuts a segment at, read off the running SRS container.
 *
 * ## Why the container and not the env files this suite already resolved
 *
 * `loadConfig` layers the deployment's env files and could hand back `HLS_FRAGMENT` for free. It
 * would be the wrong number often enough to matter. An env file edited after the last deploy states
 * an intention, a bare `docker compose up` loses env `deploy.sh` would have supplied, and this bench
 * host is shared: on 2026-08-17 a co-tenant session changed `hls_fragment` to 2.0 on its own SRS
 * stack, and the only reason anybody knew is that somebody ran `docker exec` by hand. The config
 * inside the container is the one `entrypoint.sh` generated at start and SRS was exec'd on, so it is
 * what the process is running. `Host.containerEnv` already carries this rule for `LOG_LEVEL`.
 *
 * ## ⛔ What this is NOT, and which gate covers the rest
 *
 * It is a prediction from the running config, not an observation of published media. It cannot see
 * an encoder failing to deliver the cadence its own config asks for, because that shows up only in
 * the raw `#EXTINF` of a live playlist and reading one needs a broadcast, which is real money on
 * every second. `deploy/scripts/stage-fingerprint.sh` is that gate and runs during a sitting, where
 * the broadcast is already paid for. This one sits earlier and costs one `docker exec` of a text
 * file: no publish, no stamp, no BZZ, nothing on the deployment changed.
 *
 * The fault it does catch is the one that is otherwise never caught, because it looks exactly like a
 * healthy run: a stage configured for the other viewer type.
 */

/** Where `entrypoint.sh` writes the config SRS is started on: `exec ./objs/srs -c conf/srs.conf`. */
const SRS_CONF_PATH = '/usr/local/srs/conf/srs.conf';

/**
 * Read the running SRS container's own config into what it will cut at.
 *
 * Throws on every way of learning nothing, and the throw is the point: a container that is not
 * there, a config that is not readable and a config that says nothing are all refusals, because "I
 * could not find out" and "nothing is wrong" are the same return value to a caller that only looks
 * for a mismatch.
 */
export async function readStageSegmenting(host: Host, cfg: E2EConfig): Promise<StageSegmenting> {
  return parseStageSegmenting(await readStageConf(host, cfg), PUBLISHER_GOP_SECONDS);
}

/**
 * The same config as text, for callers that need what {@link parseStageSegmenting} does not carry.
 *
 * `announcement-rate` needs the ladder's rung count, which is one `engine <name> {` block per rung
 * and is not part of a segmenting reading. Reading the file twice would be two `docker exec` calls
 * that could disagree if a co-tenant redeployed between them, so both preflights take one read.
 */
export async function readStageConf(host: Host, cfg: E2EConfig): Promise<string> {
  const container = containerName(cfg, 'srs');
  const { stdout } = await host.run(`docker exec ${container} cat ${SRS_CONF_PATH}`);

  return stdout;
}
