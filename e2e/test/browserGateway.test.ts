import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  type GatewaySample,
  gatewaySection,
  parseGatewaySample,
  sampleGatewayWith,
  startGatewaySampling,
  summarizeGateway,
} from '../src/browser/gatewayHealth.js';

const HEALTHY_OUTPUT = [
  '0.031 200',
  '1.42',
  '{"totalBalance":"227039111999998600","availableBalance":"80000000000000000"}',
  '{"connectedPeers":92,"neighborhoodSize":135,"isReachable":true,"isWarmingUp":false}',
].join('\n');

const at = (atMs: number, overrides: Partial<GatewaySample> = {}): GatewaySample => ({
  atMs,
  answered: true,
  serviceMs: 30,
  connectedPeers: 92,
  neighbourhoodSize: 135,
  isReachable: true,
  isWarmingUp: false,
  hostLoad1: 1.4,
  chequebookAvailableBzz: 8,
  ...overrides,
});

/**
 * The half of a run nothing has ever recorded.
 *
 * `docs/bench/the-fourteen-minute-collapse-2026-08-07.md` located a read-path slowdown to the second
 * and could not say what caused it, because every figure in it was measured at the browser. A browser
 * can see that answers got slower. It cannot see whether the node was busy, whether the host was, or
 * whether the node had lost the peers it retrieves through.
 */
describe('reading a gateway sample off the host', () => {
  it('reads the four lines the remote command emits', () => {
    const sample = parseGatewaySample(HEALTHY_OUTPUT, 1_000);

    assert.deepEqual(sample, {
      atMs: 1_000,
      answered: true,
      serviceMs: 31,
      connectedPeers: 92,
      neighbourhoodSize: 135,
      isReachable: true,
      isWarmingUp: false,
      hostLoad1: 1.42,
      chequebookAvailableBzz: 8,
    });
  });

  /**
   * ⭐ The reading added after the instrument had already shipped, because checking the deployment's
   * funds before a proving run found the gateway's spendable balance at **0.0000007 BZZ** against a
   * 14.7 BZZ chequebook, every last unit of it committed to outstanding cheques. A gateway in that
   * state is healthy by every other signal here — `/health` answered in 1.1ms, 134 peers, reachability
   * Public — and cannot pay for retrieval past the free tier.
   *
   * That is a candidate cause for the fourteen-minute collapse, whose shape it matches: both request
   * kinds slowing together at one instant, no errors, no refusals, demand unchanged. Sampling service
   * time, load and peers and not this would have watched the run and missed it.
   */
  it('reads the spendable balance, which is what a gateway pays for reads with', () => {
    assert.equal(parseGatewaySample(HEALTHY_OUTPUT, 0).chequebookAvailableBzz, 8);
  });

  it('reads a chequebook drained to nothing as nothing, not as missing', () => {
    const drained = ['0.001 200', '1.0', '{"totalBalance":"147039111999998600","availableBalance":"6999983500"}', '{}'];

    const sample = parseGatewaySample(drained.join('\n'), 0);

    assert.equal(sample.answered, true, 'a node with no BZZ still answers, which is the whole problem');
    assert.ok(
      sample.chequebookAvailableBzz !== null && sample.chequebookAvailableBzz < 0.001,
      `read ${sample.chequebookAvailableBzz} BZZ where the node had 0.0000007`,
    );
  });

  it('keeps the rest when the chequebook read is the one that failed', () => {
    const sample = parseGatewaySample('0.03 200\n0.5\n\n{"connectedPeers":7}', 0);

    assert.equal(sample.answered, true);
    assert.equal(sample.connectedPeers, 7);
    assert.equal(sample.chequebookAvailableBzz, null);
  });

  /**
   * ⭐ The measurement the whole module is for, and the reason curl reports its own timing rather than
   * the harness timing the ssh round trip. `/health` touches no chunks, so a slow one is a slow node
   * where a slow `/bytes/` could be a slow node, a slow peer or a slow disk. Timed from the laptop it
   * would carry the ssh latency to the host, which is the one term guaranteed to move on its own.
   */
  it('takes the service time from curl on the host, not from the round trip to it', () => {
    assert.equal(parseGatewaySample('2.500 200\n0.1\n{}\n{}', 0).serviceMs, 2_500);
  });

  it('reads a bee that answered something other than 200 as not answering', () => {
    const sample = parseGatewaySample('0.004 503\n0.5\n{}\n{}', 0);

    assert.equal(sample.answered, false);
    assert.equal(sample.serviceMs, 4, 'a refusal is still a timing, and a fast refusal is worth seeing');
  });

  /**
   * A sampler that throws costs the run it was watching, and a bench run costs BZZ. Every shape of
   * bad output is a sample that says the node did not answer, which is itself the observation.
   */
  for (const [name, output] of [
    ['a curl that timed out and printed nothing', ''],
    ['ssh output that is not the three lines', 'Connection closed by remote host'],
    ['a timing field that is not a number', 'slow 200\n0.5\n{}\n{}'],
  ] as const) {
    it(`survives ${name}`, () => {
      const sample = parseGatewaySample(output, 7);

      assert.equal(sample.atMs, 7);
      assert.equal(sample.answered, false);
    });
  }

  /**
   * The one bad shape that is **not** a failed sample, and the distinction is the point. `/health`
   * answering 200 means the node answered, whatever the second request did, and losing the peer
   * counts must not cost the timing that is the sharpest signal here. A reverse proxy answering with
   * HTML is one shape a node too busy to serve `/topology` takes, which is the case being measured.
   */
  it('keeps the timing when topology comes back as something other than JSON', () => {
    const sample = parseGatewaySample('0.03 200\n0.5\n{}\n<html>502 Bad Gateway</html>', 7);

    assert.equal(sample.answered, true);
    assert.equal(sample.serviceMs, 30);
    assert.equal(sample.connectedPeers, null);
  });

  it('keeps the bee reading when only the host load is missing', () => {
    const sample = parseGatewaySample('0.03 200\n\n{}\n{"connectedPeers":5}', 0);

    assert.equal(sample.answered, true);
    assert.equal(sample.connectedPeers, 5);
    assert.equal(sample.hostLoad1, null);
  });

  it('keeps the timing when topology is empty, since a node can answer and report nothing', () => {
    const sample = parseGatewaySample('0.03 200\n0.5\n{}\n{}', 0);

    assert.equal(sample.answered, true);
    assert.equal(sample.connectedPeers, null);
  });
});

describe('sampling the gateway alongside the browser', () => {
  it('records what the host said', async () => {
    const sample = await sampleGatewayWith(async () => HEALTHY_OUTPUT, 5);

    assert.equal(sample.answered, true);
    assert.equal(sample.connectedPeers, 92);
  });

  /**
   * The failure that must not end a run. An ssh drop mid-broadcast is ordinary, and a sampler that
   * propagated it would throw away the browser measurement the run was actually for.
   */
  it('records an ssh that threw as a sample rather than raising it', async () => {
    const sample = await sampleGatewayWith(async () => {
      throw new Error('ssh: connect to host 1.2.3.4 port 22: Connection refused');
    }, 5);

    assert.equal(sample.answered, false);
    assert.equal(sample.atMs, 5);
  });

  // Bounded, because the way this can break is by not terminating. A `stop` that never resolves hangs
  // the whole file rather than failing it, and a suite that hangs on a defect reports nothing at all.
  it('keeps sampling after one fails, and hands back everything it has', { timeout: 5_000 }, async () => {
    let call = 0;
    const sampling = startGatewaySampling({
      intervalMs: 1,
      read: async () => {
        call += 1;
        if (call === 2) {
          throw new Error('transient');
        }
        return HEALTHY_OUTPUT;
      },
    });

    while (call < 3) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    const samples = await sampling.stop();

    assert.ok(samples.length >= 3, `only ${samples.length} samples survived one failure`);
    assert.equal(samples[1].answered, false);
    assert.equal(samples[2].answered, true);
  });

  it('stops sampling once it is told to, so nothing outlives the browser', { timeout: 5_000 }, async () => {
    let reads = 0;
    const sampling = startGatewaySampling({
      intervalMs: 1,
      read: async () => {
        reads += 1;
        return HEALTHY_OUTPUT;
      },
    });

    while (reads < 2) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    // Raced rather than awaited. A sampler that never stops makes `stop` never resolve, and awaiting
    // it turns the defect into a suite that hangs and reports nothing, which is worse than a failure.
    const settled = await Promise.race([
      sampling.stop().then(() => 'stopped'),
      new Promise((resolve) => setTimeout(() => resolve('still running'), 500)),
    ]);
    assert.equal(settled, 'stopped', 'stop() never resolved, so the sampler outlives the run that started it');

    const afterStop = reads;
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.equal(reads, afterStop, `the sampler read ${reads - afterStop} more times after being stopped`);
  });

  /**
   * The ordering `stop` promises. A sample already over the wire when the browser closes belongs in
   * the run, and a `stop` that returned before it landed would let a push arrive after the caller had
   * begun assembling the report around the same array.
   */
  it('waits for the sample already in flight before it returns', { timeout: 5_000 }, async () => {
    let order = 0;
    let readFinishedAt: number | null = null;
    let started = 0;

    // A real delay rather than a promise released by the test. The first version handed the read a
    // deferred and resolved it around `stop`, which put both continuations in the same microtask
    // queue: the read always landed first and the assertion held whether or not `stop` waited at all.
    const sampling = startGatewaySampling({
      intervalMs: 1,
      read: async () => {
        started += 1;
        await new Promise((resolve) => setTimeout(resolve, 60));
        readFinishedAt = ++order;
        return HEALTHY_OUTPUT;
      },
    });
    while (started < 1) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    await sampling.stop();
    const stopReturnedAt = ++order;

    assert.notEqual(readFinishedAt, null, 'stop returned before the sample in flight had finished at all');
    assert.ok(
      readFinishedAt! < stopReturnedAt,
      'stop returned before the sample in flight landed, so it can be pushed into an array the report is ' +
        'already being built from',
    );
  });

  /**
   * What the interval costs at the end of a run. The first version sat out the full gap inside `stop`,
   * so a five-second sampling interval added up to five seconds to every run's shutdown while the
   * report waited on it.
   */
  it('stops without sitting out the rest of the interval', { timeout: 5_000 }, async () => {
    const sampling = startGatewaySampling({ intervalMs: 30_000, read: async () => HEALTHY_OUTPUT });
    await new Promise((resolve) => setTimeout(resolve, 5));

    const startedAt = Date.now();
    await sampling.stop();

    assert.ok(Date.now() - startedAt < 1_000, `stop took ${Date.now() - startedAt}ms of a 30s interval`);
  });
});

/**
 * The summary answers one question, and deliberately not more than one: did the node's own service
 * time step during the run, and if so when. That is the shape the collapse had, and it is a
 * description rather than a threshold, so it cannot quietly fail to fire.
 */
describe('summarizing what the gateway did during a run', () => {
  it('says a run that never moved did not move', () => {
    const steady = Array.from({ length: 10 }, (_, i) => at(i * 6_000));

    const summary = summarizeGateway(steady);

    assert.equal(summary.minutes.length, 1);
    assert.equal(summary.serviceStepRatio, 1);
    assert.deepEqual(summary.warnings, []);
  });

  /**
   * ⭐ The collapse's own shape, rebuilt: fourteen minutes of one service time, then six of about five
   * times that. The browser measured a 4.86x step in segment transfers and could not attribute it.
   */
  it('reports the step and the minute it landed in', () => {
    const before = Array.from({ length: 140 }, (_, i) => at(i * 6_000, { serviceMs: 30 }));
    const after = Array.from({ length: 60 }, (_, i) => at(840_000 + i * 6_000, { serviceMs: 150 }));

    const summary = summarizeGateway([...before, ...after]);

    assert.equal(summary.serviceStepRatio, 5);
    assert.equal(summary.slowestMinute, 14);
    assert.match(summary.warnings.join(' '), /service time/i);
  });

  it('counts the samples the node did not answer at all', () => {
    const samples = [at(0), at(6_000, { answered: false }), at(12_000, { answered: false })];

    const summary = summarizeGateway(samples);

    assert.equal(summary.unanswered, 2);
    assert.match(summary.warnings.join(' '), /did not answer/i);
  });

  /** A retrieval slowdown from losing the peers it retrieves through would show here and nowhere else. */
  it('reports the peer count falling away, which a browser cannot see at all', () => {
    // Two samples inside the second minute, so the minute has a min and a max that differ. A minute
    // holding one sample cannot tell the two apart, and the first version of this test held one each.
    const samples = [
      at(0, { connectedPeers: 90 }),
      at(60_000, { connectedPeers: 88 }),
      at(90_000, { connectedPeers: 12 }),
    ];

    const summary = summarizeGateway(samples);

    assert.equal(summary.minutes[0].connectedPeers, 90);
    assert.equal(summary.minutes[1].connectedPeers, 12, 'a minute that ended healthy hid the peers it lost');
    assert.match(summary.warnings.join(' '), /peers/i);
  });

  /**
   * ⛔ The warning worth having above all the others here, because it names a cause rather than a
   * symptom. A gateway whose spendable balance reaches zero stops issuing cheques and is throttled by
   * its peers to the free tier, which is a read path slowing down with every other signal healthy.
   */
  it('warns when the spendable balance ran out during the run', () => {
    const samples = [at(0, { chequebookAvailableBzz: 0.4 }), at(60_000, { chequebookAvailableBzz: 0.0000007 })];

    const summary = summarizeGateway(samples);

    assert.equal(summary.minutes[1].chequebookAvailableBzz, 0.0000007);
    assert.match(summary.warnings.join(' '), /pay|chequebook|balance/i);
  });

  it('says nothing about a balance that stayed comfortable', () => {
    const summary = summarizeGateway([
      at(0, { chequebookAvailableBzz: 8 }),
      at(60_000, { chequebookAvailableBzz: 7.9 }),
    ]);

    assert.doesNotMatch(summary.warnings.join(' '), /chequebook/i);
  });

  it('takes the minute low, so a balance that ran out inside a minute is not hidden', () => {
    const samples = [
      at(0, { chequebookAvailableBzz: 5 }),
      at(60_000, { chequebookAvailableBzz: 5 }),
      at(90_000, { chequebookAvailableBzz: 0 }),
    ];

    assert.equal(summarizeGateway(samples).minutes[1].chequebookAvailableBzz, 0);
  });

  it('says nothing at all about a run it has no samples for', () => {
    const summary = summarizeGateway([]);

    assert.deepEqual(summary.minutes, []);
    assert.equal(summary.serviceStepRatio, null);
    assert.match(summary.warnings.join(' '), /no gateway samples/i);
  });

  it('renders a minute table a reader can line up against the browser one', () => {
    const lines = gatewaySection(summarizeGateway([at(0), at(60_000, { serviceMs: 200 })])).join('\n');

    assert.match(lines, /\| 0 \|/);
    assert.match(lines, /\| 1 \|/);
    assert.match(lines, /200/);
  });

  it('renders the reason rather than an empty table when there are no samples', () => {
    const lines = gatewaySection(summarizeGateway([])).join('\n');

    assert.match(lines, /no gateway samples/i);
    // The header, not a row. An empty minute list renders no rows either way, so a report that lost
    // its guard prints an empty table under a heading and reads as a node that was asked and said
    // nothing, rather than as a node that was never asked.
    assert.doesNotMatch(lines, /\| minute \|/);
  });
});
