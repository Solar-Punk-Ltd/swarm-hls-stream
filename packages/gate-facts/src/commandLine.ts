const DEFAULT_BASE = 'main';

interface CommandLine {
  base: string;
  /** Undefined when `--head` was not given, which the artifact reports differently from a head named on purpose. */
  head: string | undefined;
}

function flagValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

/** The comparison `pnpm gate:facts` was asked for, read from its command line. */
export function readCommandLine(argv: readonly string[]): CommandLine {
  return { base: flagValue(argv, '--base') ?? DEFAULT_BASE, head: flagValue(argv, '--head') };
}
