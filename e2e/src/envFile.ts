/**
 * Reads the same `.env` files the deploy scripts read, by the same rules.
 *
 * The suite has to arrive at the ports and names the running stack actually uses, and the only
 * source of those is the env files `deploy.sh` fed to docker compose. Re-deriving them with a
 * general-purpose dotenv parser is where this goes wrong quietly: `load_env_file` in
 * `deploy/scripts/_lib.sh` has its own rules for quoting, inline comments and precedence, and a
 * parser that disagrees produces a port number that looks fine and points at nothing.
 *
 * `test/envFile.test.ts` runs the fixtures through the real shell function and compares.
 */

import { readFileSync } from 'node:fs';

/** Resolved `KEY=VALUE` pairs. Values are always strings, as they are in the shell. */
export type EnvBag = Readonly<Record<string, string>>;

/** `_lib.sh` skips any line whose key is not a shell identifier rather than failing on it. */
const SHELL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse one env file's text into pairs, following `load_env_file`.
 *
 * Values are taken literally, never evaluated: a `$`, backtick or `!` in a secret is data. A quoted
 * value runs to its closing quote, an unquoted one ends at a dotenv-style inline comment
 * (whitespace then `#`) and keeps no trailing whitespace. Earlier lines win over later ones, which
 * is the file-local half of "already set wins".
 */
export function parseEnvText(text: string): EnvBag {
  const parsed: Record<string, string> = {};

  for (const line of text.split('\n')) {
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    // A line with no `=` at all is not skipped: both of the shell's expansions leave it whole, so
    // `load_env_file` exports it as its own value. Measured, not assumed — a typo'd key line
    // `BARE_WORD` really does reach docker compose as `BARE_WORD=BARE_WORD`, and a parser that
    // dropped it would disagree with the deployment about what is set.
    const separator = line.indexOf('=');
    const key = separator === -1 ? line : line.slice(0, separator);
    if (!SHELL_IDENTIFIER.test(key) || key in parsed) {
      continue;
    }
    parsed[key] = parseValue(separator === -1 ? line : line.slice(separator + 1));
  }

  return parsed;
}

function parseValue(raw: string): string {
  const quote = raw.startsWith('"') ? '"' : raw.startsWith("'") ? "'" : '';
  if (quote !== '') {
    const closing = raw.indexOf(quote, 1);
    return closing === -1 ? raw.slice(1) : raw.slice(1, closing);
  }
  return raw.replace(/\s#.*$/s, '').replace(/\s+$/, '');
}

/** Parse an env file, or an empty bag if it is not there. A missing file is normal, not an error. */
export function readEnvFile(path: string): EnvBag {
  try {
    return parseEnvText(readFileSync(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw error;
  }
}

/**
 * Merge bags under the shell's precedence: whatever is already set wins, so the FIRST bag holding a
 * key decides it. Callers pass most-authoritative first, which for a deploy means the process
 * environment, then the root env file, then the engine's.
 */
export function layerEnv(...bags: readonly EnvBag[]): EnvBag {
  const merged: Record<string, string> = {};
  for (const bag of bags) {
    for (const [key, value] of Object.entries(bag)) {
      if (!(key in merged)) {
        merged[key] = value;
      }
    }
  }
  return merged;
}

/** The process environment as a bag, dropping the keys Node reports as undefined. */
export function processEnv(source: NodeJS.ProcessEnv = process.env): EnvBag {
  return Object.fromEntries(
    Object.entries(source).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
