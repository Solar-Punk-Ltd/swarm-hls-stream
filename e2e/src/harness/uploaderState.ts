import { containerName, type E2EConfig } from '../config.js';

import type { Host } from './host.js';
import { shellQuoted } from './shellQuote.js';

/**
 * Reach the uploader's persisted recovery state while the uploader itself is not running.
 *
 * A recovery entry only means anything across a restart, so every scenario that tests one has to read
 * or change it in exactly the window where the process that owns it is stopped. `docker exec` cannot
 * enter a stopped container, so the state volume is mounted into a throwaway container instead.
 *
 * Everything here is scoped to the volume the profile under test declares, discovered from that
 * container rather than constructed from the project name. That is what keeps it off the other
 * compose projects sharing the deployment host, and it is why the mount is looked up by destination:
 * a volume named by convention is a guess, and a guess that happens to match another stack's naming
 * would be a fault injected into somebody else's deployment.
 */

/** Where the throwaway container sees the state volume. Its own private mount point, not the uploader's. */
const HELPER_MOUNT = '/state';

interface StateVolume {
  /** The docker volume backing the uploader's `STATE_DIR`. */
  readonly name: string;
  /**
   * `STATE_DIR` relative to the volume root.
   *
   * Empty whenever the volume is mounted at `STATE_DIR` itself, which is the deployment's own layout.
   * A deployment that mounted a parent directory instead would put the entries in a subdirectory, and
   * a helper that ignored that would report an empty state directory as confidently as a true one.
   */
  readonly prefix: string;
}

async function resolveStateVolume(host: Host, cfg: E2EConfig): Promise<StateVolume> {
  const uploader = containerName(cfg, 'stream-uploader');
  const stateDir = (await host.containerEnv(uploader)).STATE_DIR;
  if (!stateDir) {
    throw new Error(`${uploader} declares no STATE_DIR, so its recovery entries cannot be located`);
  }

  const { stdout } = await host.run(
    `docker inspect -f '{{range .Mounts}}{{.Destination}} {{.Name}}{{println}}{{end}}' ${uploader}`,
  );
  const mounts = stdout
    .split('\n')
    .map((line) => line.trim().split(/\s+/))
    .filter((parts): parts is [string, string] => parts.length === 2 && parts[1].length > 0);

  // Longest destination first, so a volume mounted exactly at STATE_DIR wins over one mounted at a
  // parent of it. Both are correct mounts and only the deeper one gives the shorter prefix.
  const containing = mounts
    .filter(([destination]) => stateDir === destination || stateDir.startsWith(`${destination}/`))
    .sort((a, b) => b[0].length - a[0].length)[0];

  if (!containing) {
    throw new Error(`${uploader} has no volume mounted at or above ${stateDir}, so its state is not durable`);
  }

  const [destination, name] = containing;
  return { name, prefix: stateDir.slice(destination.length).replace(/^\//, '') };
}

/**
 * Run a shell line against the state volume, with the uploader's `STATE_DIR` as the working directory.
 *
 * The uploader's own image is reused rather than a general-purpose one, because pulling an image is a
 * network operation this suite should not need mid-scenario and the deployment host must not acquire
 * anything on our account.
 */
export async function runInStateDir(host: Host, cfg: E2EConfig, script: string): Promise<string> {
  const { name, prefix } = await resolveStateVolume(host, cfg);
  const uploader = containerName(cfg, 'stream-uploader');
  const { stdout } = await host.run(`docker inspect -f '{{.Config.Image}}' ${uploader}`);
  const image = stdout.trim();
  if (!image) {
    throw new Error(`could not read the image behind ${uploader}, so no helper container can mount its state`);
  }

  const workdir = prefix ? `${HELPER_MOUNT}/${prefix}` : HELPER_MOUNT;
  const result = await host.run(
    `docker run --rm -v ${name}:${HELPER_MOUNT} -w ${workdir} ${image} sh -c ${shellQuoted(script)}`,
  );
  return result.stdout;
}

/** Stream ids with a recovery entry on disk, by the `<id>.json` naming `RecoveryStore` uses. */
export async function recoveryEntryIds(host: Host, cfg: E2EConfig): Promise<string[]> {
  // `|| true` so an empty directory is an empty list rather than a failed scenario: `ls` exits
  // non-zero when its glob matches nothing, and "no stream is mid-recovery" is an ordinary state.
  const listing = await runInStateDir(host, cfg, 'ls -1 *.json 2>/dev/null || true');
  return listing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.endsWith('.json'))
    .map((line) => line.replace(/\.json$/, ''));
}

/**
 * File names of the damaged entries the uploader has moved aside, by the `<id>.json.corrupt` naming
 * `RecoveryStore.quarantine` uses.
 *
 * These are what keeps `/health` reporting `unrecoverable_stream`, so a scenario that plants one has
 * to clear it: left behind, it degrades this deployment for every run after it.
 */
export async function quarantinedEntryNames(host: Host, cfg: E2EConfig): Promise<string[]> {
  const listing = await runInStateDir(host, cfg, 'ls -1 *.json.corrupt* 2>/dev/null || true');
  return listing
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** The raw bytes of any file in the state directory, named exactly as it sits there. */
export function readStateFile(host: Host, cfg: E2EConfig, fileName: string): Promise<string> {
  return runInStateDir(host, cfg, `cat ${shellQuoted(fileName)}`);
}

/** Delete any file in the state directory, for a scenario putting back what it planted. */
export async function removeStateFile(host: Host, cfg: E2EConfig, fileName: string): Promise<void> {
  await runInStateDir(host, cfg, `rm -f ${shellQuoted(fileName)}`);
}

/** The raw bytes of one recovery entry, exactly as the uploader will read them back. */
export function readRecoveryEntry(host: Host, cfg: E2EConfig, id: string): Promise<string> {
  return runInStateDir(host, cfg, `cat ${shellQuoted(`${id}.json`)}`);
}

/**
 * Delete one recovery entry.
 *
 * For a scenario putting back what it planted. The deployment is shared, and a state file left behind
 * is read by every boot after this suite finishes.
 */
export async function removeRecoveryEntry(host: Host, cfg: E2EConfig, id: string): Promise<void> {
  await runInStateDir(host, cfg, `rm -f ${shellQuoted(`${id}.json`)}`);
}

/**
 * Overwrite one recovery entry.
 *
 * Written through a temporary file and renamed, which is how `RecoveryStore.save` writes it: a
 * scenario that left a half-written entry would be testing a torn write rather than the content it
 * meant to plant.
 */
export async function writeRecoveryEntry(host: Host, cfg: E2EConfig, id: string, contents: string): Promise<void> {
  const file = `${id}.json`;
  await runInStateDir(
    host,
    cfg,
    `printf %s ${shellQuoted(contents)} > ${shellQuoted(`${file}.tmp`)} && mv ${shellQuoted(
      `${file}.tmp`,
    )} ${shellQuoted(file)}`,
  );
}
