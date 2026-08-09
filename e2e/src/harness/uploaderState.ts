import { containerName, type E2EConfig } from '../config.js';

import type { Host } from './host.js';

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

/**
 * Wrap a value so one shell parse yields it back unchanged.
 *
 * The command reaches the deployment host as a single ssh argument and is parsed once there, so one
 * level of quoting is the whole requirement. A single quote inside is closed, escaped and reopened,
 * which is the only sequence a single-quoted shell string has no escape for.
 */
function singleQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

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
  const { stdout } = await host.run(
    `docker inspect -f '{{.Config.Image}}' ${uploader}`,
  );
  const image = stdout.trim();
  if (!image) {
    throw new Error(`could not read the image behind ${uploader}, so no helper container can mount its state`);
  }

  const workdir = prefix ? `${HELPER_MOUNT}/${prefix}` : HELPER_MOUNT;
  const result = await host.run(
    `docker run --rm -v ${name}:${HELPER_MOUNT} -w ${workdir} ${image} sh -c ${singleQuote(script)}`,
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

/** The raw bytes of one recovery entry, exactly as the uploader will read them back. */
export function readRecoveryEntry(host: Host, cfg: E2EConfig, id: string): Promise<string> {
  return runInStateDir(host, cfg, `cat ${singleQuote(`${id}.json`)}`);
}

/**
 * Delete one recovery entry.
 *
 * For a scenario putting back what it planted. The deployment is shared, and a state file left behind
 * is read by every boot after this suite finishes.
 */
export async function removeRecoveryEntry(host: Host, cfg: E2EConfig, id: string): Promise<void> {
  await runInStateDir(host, cfg, `rm -f ${singleQuote(`${id}.json`)}`);
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
    `printf %s ${singleQuote(contents)} > ${singleQuote(`${file}.tmp`)} && mv ${singleQuote(`${file}.tmp`)} ${singleQuote(file)}`,
  );
}
