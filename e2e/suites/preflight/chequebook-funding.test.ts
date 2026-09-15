import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { loadConfig } from '../../src/config.js';
import {
  chequebookFundingRefusal,
  describeChequebookFunding,
  MIN_CHEQUEBOOK_BZZ,
  readChequebookFunding,
} from '../../src/harness/chequebookFunding.js';
import { makeHost, uploaderHealth } from '../../src/harness/host.js';
import { nodesBehind } from '../../src/harness/publishers.js';

/**
 * Preflight — every Bee node this stage publishes through must hold enough SWAP chequebook balance to
 * pay for the bandwidth it consumes pushing segments to Swarm. This is a funding precondition, not a
 * scenario: it runs first (ahead of scenarios/ and service/) so a drained chequebook fails loudly and
 * early instead of surfacing later as opaque upload stalls.
 *
 * Read-only, and it used to not be: the deposit it once made itself was removed on the owner's
 * decision of 2026-08-03. The reasoning, the floor and every sentence it refuses with live in
 * `src/harness/chequebookFunding.ts`, because nothing under `suites/` runs in CI and because the
 * latency and long-run benches ask the same question without going anywhere near this directory.
 * That leaves this file as wiring and a place to print what the stage is holding.
 */
const cfg = loadConfig();

describe('preflight — every bee node this stage publishes through is funded for bandwidth', () => {
  const host = makeHost(cfg);

  it(`every node holds at least ${MIN_CHEQUEBOOK_BZZ} BZZ available`, async () => {
    const health = await uploaderHealth(host, cfg);
    const readings = await readChequebookFunding(host, nodesBehind(health.publishers, cfg.ports.beeUploaderApi));

    describeChequebookFunding(readings).forEach((line) => console.log(line));

    const refusal = chequebookFundingRefusal(readings);
    if (refusal !== null) {
      assert.fail(refusal);
    }
  });
});
