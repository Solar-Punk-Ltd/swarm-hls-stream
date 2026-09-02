/**
 * The Chrome flag that makes a plain-http client origin a secure context, when it needs one.
 *
 * ⛔ **weeb-3 0.0.341001 does not boot outside a secure context.** Its glue registers a ServiceWorker
 * under `/weeb-3/` the moment the node starts, and `navigator.serviceWorker` simply does not exist on
 * an insecure page, so the boot dies with `could not install ServiceWorker relay listener: Cannot read
 * properties of undefined (reading 'addEventListener')` and the viewer gets no in-tab node at all.
 * Measured 2026-09-02 19:17: the same client that joined the network in 833 ms at
 * `http://127.0.0.1:10074` booted nothing at `http://host.docker.internal:10074`, which is where
 * `--own-network` runs reach it. Loopback is secure by definition, anything else over http is not.
 *
 * The production answer is https, which is how the runtime's author deploys it. Inside the harness the
 * answer is Chrome's own escape hatch for exactly this, which names one origin and nothing else, so a
 * run still fails loudly if the client moves.
 */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname) || hostname.endsWith('.localhost');
}

/**
 * @returns the launch arguments that make `clientUrl`'s origin a secure context, empty when it
 *   already is one (https, or any loopback host) or when there is no client URL to name
 */
export function secureContextArgs(clientUrl: string | undefined): string[] {
  if (!clientUrl) {
    return [];
  }
  let origin: URL;
  try {
    origin = new URL(clientUrl);
  } catch {
    return [];
  }
  if (origin.protocol !== 'http:' || isLoopback(origin.hostname)) {
    return [];
  }
  return [`--unsafely-treat-insecure-origin-as-secure=${origin.origin}`];
}
