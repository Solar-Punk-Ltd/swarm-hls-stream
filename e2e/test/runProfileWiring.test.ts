import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * The run profile has to be in place before ANY code reads the variables it sets.
 *
 * ⛔⛔⛔ This is the whole reason the profile is applied when `src/config.ts` is imported rather than
 * inside `loadConfig()`. `browser/watch.ts` reads `BROWSER_FETCH_BACKEND` at the top of `main()` and
 * calls `loadConfig()` eleven lines further down, and `crash.ts` and `buffer-sweep.ts` do the same.
 * A profile applied inside `loadConfig()` would therefore be in place too late for the one key that
 * separates the two profiles, and the drivers would run on the build's default while every report
 * named the profile that had been asked for. This repo has already paid for that exact shape once:
 * those two drivers ignored `BROWSER_FETCH_BACKEND` entirely, and an unread variable looks exactly
 * like a variable set to its default.
 *
 * Proved by running a real process rather than by reading the source. The child imports `config.ts`
 * and nothing else, never calls `loadConfig()`, and prints what its environment holds.
 */

const E2E_DIR = dirname(dirname(fileURLToPath(import.meta.url)));
const TSX = join(E2E_DIR, 'node_modules', '.bin', 'tsx');
const CONFIG_URL = pathToFileURL(join(E2E_DIR, 'src', 'config.ts')).href;

/** Keys the profile decides. Cleared from the child's inherited environment unless a case sets them. */
const PROFILE_KEYS = ['BROWSER_FETCH_BACKEND', 'E2E_EXPECT_ABR', 'E2E_RUN_PROFILE'] as const;

const PROBE = `
const config = await import(process.argv[2]);
const keys = ${JSON.stringify(PROFILE_KEYS)};
process.stdout.write(
  JSON.stringify({
    env: Object.fromEntries(keys.map((key) => [key, key in process.env ? process.env[key] : null])),
    profile: config.runProfile.name,
    skipped: config.runProfile.skipped,
  }),
);
`;

const sandboxes: string[] = [];

after(() => {
  for (const dir of sandboxes) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function probeScript(): string {
  const dir = mkdtempSync(join(tmpdir(), 'e2e-wiring-'));
  sandboxes.push(dir);
  const path = join(dir, 'probe.mjs');
  writeFileSync(path, PROBE);
  return path;
}

interface Probe {
  env: Record<string, string | null>;
  profile: string;
  skipped: readonly string[];
}

/** What a fresh process holds after importing `src/config.ts` and doing nothing else. */
function afterImportingConfig(overrides: Readonly<Record<string, string>> = {}): Probe {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of PROFILE_KEYS) {
    delete env[key];
  }

  const stdout = execFileSync(TSX, [probeScript(), CONFIG_URL], {
    cwd: E2E_DIR,
    env: { ...env, ...overrides },
    encoding: 'utf8',
  });

  return JSON.parse(stdout) as Probe;
}

describe('the run profile is in place before anything reads it', () => {
  it('applies the default profile on importing config, without loadConfig being called', () => {
    const probe = afterImportingConfig();

    assert.equal(probe.profile, 'in-browser');
    assert.equal(probe.env.BROWSER_FETCH_BACKEND, 'weeb3');
    assert.equal(probe.env.E2E_EXPECT_ABR, 'true');
  });

  it('applies the profile the operator named', () => {
    const probe = afterImportingConfig({ E2E_RUN_PROFILE: 'light-client' });

    assert.equal(probe.profile, 'light-client');
    assert.equal(probe.env.BROWSER_FETCH_BACKEND, 'gateway');
  });

  /**
   * End to end, through a real import, in the direction that matters. An operator running the
   * default profile who exported the gateway byte source is asking for the gateway, and the file
   * that would otherwise have set `weeb3` stands down and says so.
   */
  it('leaves a value the operator exported exactly as they exported it', () => {
    const probe = afterImportingConfig({ BROWSER_FETCH_BACKEND: 'gateway' });

    assert.equal(probe.profile, 'in-browser');
    assert.equal(probe.env.BROWSER_FETCH_BACKEND, 'gateway');
    assert.deepEqual(probe.skipped, ['BROWSER_FETCH_BACKEND']);
  });

  it('fails the process on a profile name that does not exist, rather than running the default', () => {
    assert.throws(() => afterImportingConfig({ E2E_RUN_PROFILE: 'no-such-profile' }), /no-such-profile/);
  });
});
