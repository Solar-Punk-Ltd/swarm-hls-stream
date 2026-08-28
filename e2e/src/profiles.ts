/**
 * Named, saved run profiles: the handful of env values that decide what a sitting IS, under a name.
 *
 * A run profile answers "which run is this", never "where does the stack live". The byte source and
 * the coverage a run declares belong to the question being asked and travel with the name. The host,
 * the ports, the ssh target and the compose profile belong to a machine, stay in the environment and
 * in the deployment's own env files, and are refused here.
 *
 * ## Why a file rather than a remembered command line
 *
 * A sitting is reproducible only if the next one can be asked for by name. Recipes carried in shell
 * history and in a driver's docblock are how `crash.ts` and `buffer-sweep.ts` came to ignore
 * `BROWSER_FETCH_BACKEND` entirely and file gateway readings under the in-tab node's name. A named
 * file that the suite reads is one place to look, one place to correct, and one thing to cite.
 *
 * ## ⛔ A profile never overrules the operator
 *
 * Precedence is explicit, then profile, then unset. An operator who exported a value is steering one
 * run deliberately, and a file that won that argument would hand back a run that is not the one they
 * asked for under a report naming the profile they thought they had overridden. Presence decides it,
 * not truthiness: a deliberately blanked value is a decision and the profile stands down on it.
 */

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { byteSourceFromEnv } from './browser/fetchBackendSweep.js';
import { readAbrExpectation } from './abrCoverage.js';
import { type EnvBag, readEnvFile } from './envFile.js';

/** `<root>/e2e`, two levels up from `<root>/e2e/src/profiles.ts`. */
const E2E_DIR = dirname(dirname(fileURLToPath(import.meta.url)));

export const PROFILE_DIR = join(E2E_DIR, 'profiles');

export const RUN_PROFILE_VAR = 'E2E_RUN_PROFILE';

/** The in-tab node is the subject this project measures, so an unqualified run is that run. */
export const DEFAULT_RUN_PROFILE = 'in-browser';

const PROFILE_SUFFIX = '.env';

/**
 * Keys that choose which file is read or which deployment is hit, and so cannot come from a file.
 *
 * `E2E_RUN_PROFILE` is circular. `E2E_PROFILE` and `E2E_PORT_SLOT` name a deployment rather than a
 * run, and `config.ts` already refuses them in a deployment's own env file for the same reason: a
 * profile that moved them would aim a sitting at another operator's stack while the report went on
 * naming the profile that was asked for.
 */
const KEYS_A_PROFILE_CANNOT_HOLD = [RUN_PROFILE_VAR, 'E2E_PROFILE', 'E2E_PORT_SLOT'] as const;

export interface RunProfile {
  name: string;
  /** The file that was read, so a report can say where a value came from. */
  path: string;
  /** What the profile decided, which is every key the operator had not already set. */
  applied: EnvBag;
  /** Keys the profile held and stood down on, because the operator had set them. Worth logging. */
  skipped: readonly string[];
}

export interface RunProfileOptions {
  /** Stands in for the process environment, both as the source of precedence and as the target. */
  env?: NodeJS.ProcessEnv;
  /** Profile directory to read. Overridden by tests so fixtures replace the shipped files. */
  dir?: string;
}

/** Profile names on disk, sorted. A missing directory reads as no profiles rather than throwing. */
export function availableRunProfiles(dir: string = PROFILE_DIR): readonly string[] {
  let entries: readonly string[];
  try {
    entries = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.endsWith(PROFILE_SUFFIX))
    .map((entry) => entry.slice(0, -PROFILE_SUFFIX.length))
    .filter((name) => name.length > 0)
    .sort();
}

/**
 * What the named profile would decide, without touching anything.
 *
 * The name is checked against the listing before any file is opened, so a name shaped like a path
 * never reaches one. It is refused as an unknown profile, which is what it is.
 */
export function resolveRunProfile({ env = process.env, dir = PROFILE_DIR }: RunProfileOptions = {}): RunProfile {
  const requested = env[RUN_PROFILE_VAR];
  const name = requested === undefined || requested === '' ? DEFAULT_RUN_PROFILE : requested;
  const available = availableRunProfiles(dir);

  if (!available.includes(name)) {
    throw new Error(
      `${RUN_PROFILE_VAR}='${name}' is not a run profile. Available in ${dir}: ` + `${available.join(', ') || 'none'}.`,
    );
  }

  const path = join(dir, `${name}${PROFILE_SUFFIX}`);
  const bag = readEnvFile(path);
  requireNoDeploymentKeys(bag, path);

  const applied: Record<string, string> = {};
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(bag)) {
    if (key in env) {
      skipped.push(key);
      continue;
    }
    applied[key] = value;
  }

  return { name, path, applied, skipped };
}

/** Resolve the profile and put its values into the environment, leaving what was already set alone. */
export function applyRunProfile(options: RunProfileOptions = {}): RunProfile {
  const target = options.env ?? process.env;
  const profile = resolveRunProfile({ ...options, env: target });

  for (const [key, value] of Object.entries(profile.applied)) {
    target[key] = value;
  }

  return profile;
}

/** One line naming the profile and what it stood down on, for a driver to print before it runs. */
export function describeRunProfile(profile: RunProfile): string {
  const applied = Object.keys(profile.applied).sort().join(', ') || 'nothing';
  const stoodDown = profile.skipped.length === 0 ? '' : `, operator set ${[...profile.skipped].sort().join(', ')}`;
  return `run profile ${profile.name}: set ${applied}${stoodDown}`;
}

/** The declarations a run makes about itself, as they stand in the environment. */
export interface RunDeclarations {
  /** Raw `BROWSER_FETCH_BACKEND`. Unset is ordinary: most suites never open a browser. */
  byteSource: string | undefined;
  /** Raw `E2E_EXPECT_ABR`. Unset is a gap, because a profile is supposed to have declared it. */
  abrExpectation: string | undefined;
}

/**
 * Why this run cannot proceed as the profile it named, or `null` when nothing here contradicts it.
 *
 * Only what can be settled with no network and no deployment: a value no parser accepts, and a run
 * that declared nothing. Whether the stack can deliver what the profile asks for is a live question
 * and none of it is answered here.
 *
 * The two parsers are called rather than reimplemented, so the accepted spellings cannot drift from
 * the ones the drivers and the ABR gate actually enforce. They throw, and the throws are turned into
 * a returned reason so the preflight reports one legible failure instead of a stack trace.
 */
export function runProfileRefusal({ byteSource, abrExpectation }: RunDeclarations): string | null {
  try {
    byteSourceFromEnv(byteSource);
  } catch (error) {
    return (
      `${(error as Error).message}. A run profile sets this, so a value nothing reads means the ` +
      'run is not the condition its report will name.'
    );
  }

  let expectation;
  try {
    expectation = readAbrExpectation(abrExpectation ?? '');
  } catch (error) {
    return (error as Error).message;
  }

  if (expectation === 'undeclared') {
    return (
      'This run declared nothing about the ABR ladder, and a skipped ABR suite reports as zero ' +
      'tests rather than as skipped ones, so the summary would not say what was covered. Both ' +
      'shipped profiles set E2E_EXPECT_ABR=true. Something has blanked it in this environment, ' +
      'which beats the profile by design.'
    );
  }

  return null;
}

function requireNoDeploymentKeys(bag: EnvBag, path: string): void {
  const present = KEYS_A_PROFILE_CANNOT_HOLD.filter((name) => name in bag);
  if (present.length === 0) {
    return;
  }

  throw new Error(
    `${present.join(' and ')} cannot be set in ${path}. ${RUN_PROFILE_VAR} is what chooses that ` +
      'file, and E2E_PROFILE and E2E_PORT_SLOT name a deployment rather than a run. Pass them in ' +
      `the environment instead, for example: ${present.map((name) => `${name}=<value>`).join(' ')} pnpm e2e:smoke`,
  );
}
