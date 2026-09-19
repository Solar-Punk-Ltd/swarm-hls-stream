import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * A `curl` that answers one status for every URL, put in a sandbox's own bin directory ahead of the
 * real one, the way `makeSandbox` puts its `docker` and `ssh` stubs there.
 *
 * `health.sh` asks for the status code with `-w "%{http_code}"` and reads it off standard output, so
 * printing a number is the whole of what a service's health is here. `reachable: false` is the other
 * answer a health check has to tell apart: curl itself failing, which is what a port with nothing
 * behind it gives, and which the script reports as unreachable rather than as a status.
 *
 * Any test driving a script that reaches a service needs this. Without it the real curl runs against
 * whatever is listening on the developer's own machine, which is neither reproducible nor quick.
 *
 * @param sandbox a `makeSandbox` result
 * @param status the HTTP status to answer with, as a string
 * @param reachable false to make curl itself fail, which is a refused connection rather than a status
 */
export function stubCurl(sandbox, { status = '200', reachable = true } = {}) {
  const curl = join(sandbox.binDir, 'curl');
  writeFileSync(curl, reachable ? `#!/bin/sh\nprintf '%s' '${status}'\n` : '#!/bin/sh\nexit 7\n');
  chmodSync(curl, 0o755);
}
