import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { ROOT_DIR } from '../../src/config.js';

/** The real deploy library, not a copy. A copy is a second thing to keep in step. */
export const LIB_PATH = join(ROOT_DIR, 'deploy', 'scripts', '_lib.sh');

/**
 * Field and record separators: control characters no env value in these fixtures contains, written
 * as octal escapes for `printf` on the shell side and as hex escapes on this side so neither copy
 * depends on a raw control byte surviving in a source file.
 */
const FS_OCTAL = '\\037';
const RS_OCTAL = '\\036';
const FS = '\x1f';
const RS = '\x1e';

/**
 * Run `snippet` with the repo's real `_lib.sh` sourced, and return its stdout.
 *
 * The library path arrives as `$1` rather than interpolated into the script, so nothing about where
 * the repository sits can reach the shell as syntax. Extra `args` follow as `$2` onward.
 */
export function inLib(snippet: string, ...args: readonly string[]): string {
  return execFileSync('bash', ['-c', `source "$1"\n${snippet}`, 'bash', LIB_PATH, ...args], {
    encoding: 'utf8',
  });
}

/**
 * Shell fragment printing `name`, whether it is set, and its value, as one record.
 *
 * "Set but empty" and "never set" have to stay distinguishable: `apply_port_slot` treats an empty
 * value as unset and fills in the default, so a helper reporting both as `''` would read a
 * divergence as a match. Only names this test file controls are interpolated, and they are shell
 * identifiers by construction.
 */
export function emitVar(name: string): string {
  return [
    `if declare -p ${name} >/dev/null 2>&1; then`,
    `  printf '%s${FS_OCTAL}set${FS_OCTAL}%s${RS_OCTAL}' '${name}' "$${name}"`,
    'else',
    `  printf '%s${FS_OCTAL}unset${FS_OCTAL}${RS_OCTAL}' '${name}'`,
    'fi',
  ].join('\n');
}

export interface ShellVar {
  readonly isSet: boolean;
  readonly value: string;
}

/** Parse the records `emitVar` produced back into a map. */
export function parseVars(stdout: string): Record<string, ShellVar> {
  const vars: Record<string, ShellVar> = {};
  for (const record of stdout.split(RS)) {
    if (record === '') {
      continue;
    }
    const [name, state, value = ''] = record.split(FS);
    vars[name] = { isSet: state === 'set', value };
  }
  return vars;
}

/**
 * Read the named shell variables after running `setup`, with `_lib.sh` sourced.
 *
 * Throws when the child did not report on every name it was asked about, rather than handing back a
 * partial map. Those two outcomes are indistinguishable downstream and they mean opposite things: a
 * variable the shell reports as unset is evidence about the shell, and a variable the shell never
 * reported on is evidence about nothing.
 *
 * Not hypothetical. During the review of this change a lens measured 8, 8 and 9 failures for three
 * mutations that reproduce at 1, 0 and 1, and the entire inflation was one run in which all nine
 * `PORT_VARS` came back absent. Every comparison in that block failed at once and read as a mirror
 * divergence, which is the single conclusion these tests exist to draw and the one thing an
 * environment failure must never be able to fake. Root cause is still unknown, so this cannot
 * prevent it. It makes it announce itself instead of being reported as a defect in the deploy.
 */
export function readVars(
  setup: string,
  names: readonly string[],
  ...args: readonly string[]
): Record<string, ShellVar> {
  const vars = parseVars(inLib([setup, ...names.map(emitVar)].join('\n'), ...args));
  const missing = names.filter((name) => !(name in vars));
  if (missing.length > 0) {
    throw new Error(
      `the shell child reported on ${Object.keys(vars).length} of ${names.length} variables, ` +
        `missing: ${missing.join(', ')}. This is an environment failure, not a mirror divergence.`,
    );
  }
  return vars;
}

/** Shell assignment lines for a fixture environment, for use as the `setup` of `readVars`. */
export function exportLines(env: Readonly<Record<string, string>>): string {
  return Object.entries(env)
    .map(([name, value]) => `export ${name}=${singleQuote(value)}`)
    .join('\n');
}

/** POSIX single-quoting, the same shape `_lib.sh`'s own `shell_quote` produces. */
function singleQuote(value: string): string {
  return `'${value.split("'").join("'\\''")}'`;
}
