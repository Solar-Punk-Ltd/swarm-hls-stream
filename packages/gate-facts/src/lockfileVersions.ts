/** A lockfile key is `name@version`, optionally quoted, optionally carrying a peer-resolution suffix. */
const LOCKFILE_KEY = /^ {2}'?\/?(\S+?@[0-9][^:]*?)'?:\s*$/;

/**
 * Every `name@version` a lockfile pins, deduplicated.
 *
 * Two things have to come off the key before it is a package spec, and they come off in this order.
 * pnpm quotes any key starting with `@`, which is every scoped package, and it suffixes an entry
 * with its peer resolution as in `foo@1.0.0(bar@2.0.0)`. Stripping peers before quotes leaves the
 * suffix attached, because the closing paren is no longer at the end of the string.
 *
 * Getting this wrong does not fail loudly. It yields specs the registry cannot resolve, every lookup
 * errors, and a caller that treats an error as "no signature" reports a clean tree as mostly
 * unsigned. That is the exact shape of the confidently-wrong answer this artifact exists to prevent,
 * and it is what the first version of this parser produced: 85 unsigned and 135 versions against a
 * real 0 and 108.
 */
export function lockfileVersions(lockfile: string): string[] {
  const found = new Set<string>();
  for (const line of lockfile.split('\n')) {
    const key = LOCKFILE_KEY.exec(line);
    if (!key) {
      continue;
    }
    found.add(stripPeers(key[1]));
  }
  return [...found].sort();
}

function stripPeers(key: string): string {
  return key.replace(/\(.*\)$/, '');
}

/** The versions present in `head` and absent from `base`, which is what a dependency change introduces. */
export function introducedVersions(baseLockfile: string, headLockfile: string): string[] {
  const before = new Set(lockfileVersions(baseLockfile));
  return lockfileVersions(headLockfile).filter((v) => !before.has(v));
}

/**
 * Split a pnpm lockfile key into its package name and version.
 *
 * A scoped package carries an `@` in its name too, so splitting on the first `@` gives an empty
 * name and the wrong version for every `@scope/pkg` in the tree.
 */
export function splitVersion(spec: string): { name: string; version: string } {
  const at = spec.lastIndexOf('@');
  return at <= 0 ? { name: spec, version: '' } : { name: spec.slice(0, at), version: spec.slice(at + 1) };
}
