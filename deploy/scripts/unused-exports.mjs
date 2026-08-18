#!/usr/bin/env node
/**
 * Refuse a change that widens the repo's unused export surface.
 *
 * ## What it counts, and what it deliberately does not
 *
 * An export is "unreferenced" when its name appears in no file other than the ones that declare it.
 * That is not the same as dead code. Most of the current entries are symbols exported for a reader's
 * benefit and then only used inside their own module, which costs nothing at runtime and everything
 * in API surface: every exported name is a promise that something may import it.
 *
 * ⛔ It is a name check, not a type-aware one. A symbol referenced only in a comment counts as used,
 * and a dynamic `obj[name]` lookup does not. Both directions are wrong in the safe direction: this
 * gate can miss an unused export, and it will not invent one.
 *
 * ## Why a ratchet rather than a threshold
 *
 * There are 148 of these today and fixing them is not this gate's job. A number written down is not
 * a control, so this exits non-zero the moment the count rises above the recorded baseline, which is
 * the one moment the information is cheap to act on. Lowering the baseline is a normal part of
 * removing an export, and the gate prints the exact command.
 *
 * Usage:
 *   node deploy/scripts/unused-exports.mjs            # check against the baseline, exit 1 if worse
 *   node deploy/scripts/unused-exports.mjs --list     # print every unreferenced export
 *   node deploy/scripts/unused-exports.mjs --write    # record the current count as the baseline
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = resolve(HERE, '..', '..');

/**
 * Both overridable so the gate can be run against a fixture tree. A gate tested only against the
 * repo it guards can be proved to pass and never proved to refuse, which is the half that matters.
 */
export const BASELINE_PATH = process.env.UNUSED_EXPORTS_BASELINE ?? join(HERE, 'unused-exports-baseline.json');
const ROOTS = process.env.UNUSED_EXPORTS_ROOTS
  ? process.env.UNUSED_EXPORTS_ROOTS.split(',').filter(Boolean)
  : ['packages', 'e2e', 'deploy'];
/** Build output and tool scratch are copies of the source, so they double every count they touch. */
const SKIP = ['node_modules', '/dist', '.stryker-tmp', 'coverage', '/build', '/.next'];

const EXPORT_DECL = /^export\s+(?:declare\s+)?(?:async\s+)?(?:function|const|let|class|interface|type|enum)\s+(\w+)/gm;

function sourceFiles(root) {
  const out = [];
  const walk = (dir) => {
    if (SKIP.some((s) => dir.includes(s))) return;
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e);
      let st;
      try {
        st = statSync(p);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(p);
      else if (/\.tsx?$/.test(e) && !e.endsWith('.d.ts')) out.push(p);
    }
  };
  // An absolute root is a fixture tree; a relative one is a directory of this repo.
  walk(resolve(REPO_ROOT, root));
  return out;
}

/**
 * @param {string[]} [roots] override for tests, which point it at a fixture tree
 * @returns {{name: string, file: string}[]} sorted, so two runs on one tree agree
 */
export function findUnusedExports(roots = ROOTS) {
  const files = roots.flatMap(sourceFiles);
  const text = new Map(files.map((p) => [p, readFileSync(p, 'utf8')]));

  /** @type {Map<string, string[]>} */
  const declaredIn = new Map();
  for (const [p, t] of text) {
    for (const m of t.matchAll(EXPORT_DECL)) {
      const list = declaredIn.get(m[1]) ?? [];
      list.push(p);
      declaredIn.set(m[1], list);
    }
  }

  const unused = [];
  for (const [name, decls] of declaredIn) {
    const word = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    let referenced = false;
    for (const [p, t] of text) {
      if (decls.includes(p)) continue;
      if (word.test(t)) {
        referenced = true;
        break;
      }
    }
    if (!referenced) {
      const file = decls[0].startsWith(REPO_ROOT) ? decls[0].slice(REPO_ROOT.length + 1) : decls[0];
      unused.push({ name, file });
    }
  }
  return unused.sort((a, b) => a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
}

export function readBaseline() {
  if (!existsSync(BASELINE_PATH)) return null;
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
}

function main() {
  const argv = process.argv.slice(2);
  const unused = findUnusedExports();

  if (argv.includes('--list')) {
    for (const u of unused) console.log(`${u.file}\t${u.name}`);
    console.log(`\n${unused.length} unreferenced exports`);
    return 0;
  }

  if (argv.includes('--write')) {
    writeFileSync(BASELINE_PATH, `${JSON.stringify({ count: unused.length }, null, 2)}\n`);
    console.log(`unused-exports: baseline recorded at ${unused.length}`);
    return 0;
  }

  const baseline = readBaseline();
  if (baseline === null) {
    console.error('unused-exports: no baseline. Record one with --write, and commit it.');
    return 2;
  }

  if (unused.length > baseline.count) {
    console.error(
      `unused-exports: REFUSING. ${unused.length} unreferenced exports against a baseline of ${baseline.count}.`,
    );
    console.error('  Every exported name is a promise something may import it. Either use it, stop');
    console.error('  exporting it, or record the new surface deliberately:');
    console.error('    node deploy/scripts/unused-exports.mjs --list');
    console.error('    node deploy/scripts/unused-exports.mjs --write');
    return 1;
  }

  if (unused.length < baseline.count) {
    console.log(
      `unused-exports: ${unused.length} against a baseline of ${baseline.count}. ` +
        'Lower the baseline so the ground gained is held:',
    );
    console.log('    node deploy/scripts/unused-exports.mjs --write');
    return 0;
  }

  console.log(`unused-exports: ${unused.length}, level with the baseline`);
  return 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.exit(main());
