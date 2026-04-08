import { readFileSync, writeFileSync } from 'fs';

/**
 * Update a key in a .env file. If the key exists, replaces its value.
 * If not, appends it at the end.
 */
export function writeEnvKey(envPath: string, key: string, value: string): void {
  const content = readFileSync(envPath, 'utf-8');
  const lines = content.split('\n');
  const pattern = new RegExp(`^${key}=`);
  let found = false;

  const updated = lines.map((line) => {
    if (pattern.test(line)) {
      found = true;
      return `${key}=${value}`;
    }
    return line;
  });

  if (!found) {
    updated.push(`${key}=${value}`);
  }

  writeFileSync(envPath, updated.join('\n'));
}
