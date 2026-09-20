import { ManagedStateLock } from '../../src/libs/ManagedStateLock.js';

const stateDir = process.argv[2];
if (!stateDir) {
  throw new Error('state directory is required');
}

ManagedStateLock.acquire(stateDir);
process.stdout.write('ready\n');
setInterval(() => {}, 1_000);
