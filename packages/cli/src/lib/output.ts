const RED = '\x1b[0;31m';
const GREEN = '\x1b[0;32m';
const YELLOW = '\x1b[1;33m';
const CYAN = '\x1b[0;36m';
const DIM = '\x1b[2m';
const NC = '\x1b[0m';

export function info(msg: string): void {
  console.log(`${CYAN}---${NC} ${msg}`);
}

export function ok(msg: string): void {
  console.log(`${GREEN}\u2713${NC} ${msg}`);
}

export function warn(msg: string): void {
  console.log(`${YELLOW}!${NC} ${msg}`);
}

export function error(msg: string): void {
  console.error(`${RED}\u2717${NC} ${msg}`);
}

export function dim(msg: string): void {
  console.log(`${DIM}${msg}${NC}`);
}

export function table(label: string, value: string): void {
  console.log(`  ${label}: ${value}`);
}

export function header(title: string): void {
  console.log(`\n=== ${title} ===\n`);
}

export function spinner(msg: string): { stop: (finalMsg?: string) => void } {
  const frames = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f'];
  let i = 0;
  const interval = setInterval(() => {
    process.stdout.write(`\r${CYAN}${frames[i % frames.length]}${NC} ${msg}`);
    i++;
  }, 80);

  return {
    stop(finalMsg?: string) {
      clearInterval(interval);
      process.stdout.write('\r\x1b[K');
      if (finalMsg) ok(finalMsg);
    },
  };
}
