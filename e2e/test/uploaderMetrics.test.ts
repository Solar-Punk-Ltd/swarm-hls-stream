import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { afterEach, describe, it } from 'node:test';

import { DROPPED_SEGMENTS_METRIC, METRICS_PREFIX, RUNG_LABEL } from '../src/harness/batchDrain.js';
import { rungCountersOf, uploaderMetricsCommand, uploaderMetricsScript } from '../src/harness/uploaderMetrics.js';

/**
 * Reading one per-rung counter off the uploader's Prometheus text, and doing it without ever holding
 * the token that guards it.
 *
 * ## ⛔⛔ Why the scrape runs INSIDE the container
 *
 * `GET /metrics` is behind `Authorization: Bearer $API_AUTH_TOKEN`, unlike `/health`, because it
 * names when the last segment landed and how many broadcasts have run. The harness has no copy of
 * that token and must not acquire one: a value passed as a command argument is in `ps` output on a
 * shared host for the length of the call, and a value read back into this process is in the harness's
 * own memory and one careless log line from a scrollback that outlives the run.
 *
 * So the request is made by the container that already holds the token, with the shell inside it
 * expanding `$API_AUTH_TOKEN`, and only the exposition text comes back out. ⚠️ `node -e` rather than
 * curl, because the image is `node:22-alpine` and has neither curl nor wget. That is the same reason
 * the compose healthcheck reaches `/health` with `node -e`, and it is recorded there too.
 *
 * ## What the parse is for
 *
 * `swarm_hls_rung_segments_dropped_total` is empty on a ladder that has lost nothing and carries one
 * line per rung once anything is lost, so the difference between "this rung lost nothing" and "the
 * scrape did not answer" is the difference between an absent label and an absent family.
 * `droppedSegmentsRefusal` in `harness/batchDrain.ts` draws that line, and it can only draw it if the
 * parse keeps the two apart, which is what these cover.
 */

const SCRAPE = [
  `# HELP ${METRICS_PREFIX}_segments_uploaded_total Segments whose payload reached Swarm.`,
  `# TYPE ${METRICS_PREFIX}_segments_uploaded_total counter`,
  `${METRICS_PREFIX}_segments_uploaded_total 412`,
  `# HELP ${METRICS_PREFIX}_rung_segments_uploaded_total The same, by ABR rung.`,
  `# TYPE ${METRICS_PREFIX}_rung_segments_uploaded_total counter`,
  `${METRICS_PREFIX}_rung_segments_uploaded_total{rung="1080p"} 21`,
  `${METRICS_PREFIX}_rung_segments_uploaded_total{rung="360p"} 103`,
  `# HELP ${DROPPED_SEGMENTS_METRIC} Read next to ${METRICS_PREFIX}_rung_segments_uploaded_total on the same label.`,
  `# TYPE ${DROPPED_SEGMENTS_METRIC} counter`,
  `${DROPPED_SEGMENTS_METRIC}{rung="1080p"} 82`,
  '',
].join('\n');

describe('rungCountersOf', () => {
  it('reads the labelled samples of the family it was asked for', () => {
    assert.deepEqual([...rungCountersOf(SCRAPE, DROPPED_SEGMENTS_METRIC, RUNG_LABEL)], [['1080p', 82]]);
  });

  it('reads a sibling family off the same scrape without confusing the two', () => {
    assert.deepEqual(
      [...rungCountersOf(SCRAPE, `${METRICS_PREFIX}_rung_segments_uploaded_total`, RUNG_LABEL)],
      [
        ['1080p', 21],
        ['360p', 103],
      ],
    );
  });

  /**
   * ⛔ The HELP text of the drop family names the upload family in prose, so a reader matching the
   * family name anywhere on a line would count a documentation sentence as a sample.
   */
  it('ignores the HELP and TYPE lines that carry the family name in them', () => {
    const helpOnly = [
      `# HELP ${DROPPED_SEGMENTS_METRIC} one rung dropping while its uploads sit still.`,
      `# TYPE ${DROPPED_SEGMENTS_METRIC} counter`,
      '',
    ].join('\n');

    assert.equal(rungCountersOf(helpOnly, DROPPED_SEGMENTS_METRIC, RUNG_LABEL).size, 0);
  });

  /**
   * ⛔ An absent family and a family whose every rung is zero must not read the same way, because
   * one is a scrape that did not answer and the other is a ladder that lost nothing.
   */
  it('is empty for a family the scrape does not carry at all', () => {
    assert.equal(rungCountersOf(SCRAPE, `${METRICS_PREFIX}_nothing_like_this_total`, RUNG_LABEL).size, 0);
  });

  it('keeps an explicit zero, which is a rung that lost nothing rather than a rung with no label', () => {
    const withZero = `${SCRAPE}${DROPPED_SEGMENTS_METRIC}{rung="720p"} 0\n`;

    assert.equal(rungCountersOf(withZero, DROPPED_SEGMENTS_METRIC, RUNG_LABEL).get('720p'), 0);
  });

  /** The unlabelled total of a family shares its name with the labelled samples and is not a rung. */
  it('skips the unlabelled sample of a family that has one', () => {
    const both = [`${METRICS_PREFIX}_segments_dropped_total 4`, `${DROPPED_SEGMENTS_METRIC}{rung="1080p"} 4`, ''].join(
      '\n',
    );

    assert.deepEqual([...rungCountersOf(both, `${METRICS_PREFIX}_segments_dropped_total`, RUNG_LABEL)], []);
    assert.deepEqual([...rungCountersOf(both, DROPPED_SEGMENTS_METRIC, RUNG_LABEL)], [['1080p', 4]]);
  });

  /**
   * ⛔⛔ The trap a greedy label class walks into. `{[^}]*="([^"]*)"}` captures whatever label comes
   * LAST, so a family that gains a second dimension is read by that one and the map is keyed by
   * stream instead of by rung. Nothing in the exposition looks wrong, and the drain suite refuses
   * with "the rung whose batch was drained is not the rung that lost segments", naming the product
   * for a label somebody added to a counter.
   */
  it('reads the label it was asked for by name, whichever position it sits in', () => {
    const twoLabels = [
      `${DROPPED_SEGMENTS_METRIC}{rung="1080p",stream="live/stream_1080p"} 82`,
      `${DROPPED_SEGMENTS_METRIC}{stream="live/stream_720p",rung="720p"} 3`,
      '',
    ].join('\n');

    assert.deepEqual(
      [...rungCountersOf(twoLabels, DROPPED_SEGMENTS_METRIC, RUNG_LABEL)],
      [
        ['1080p', 82],
        ['720p', 3],
      ],
    );
  });

  /** A family that does not carry the dimension asked for is empty, never keyed by another one. */
  it('is empty for a family that carries no label of that name', () => {
    const otherDimension = `${DROPPED_SEGMENTS_METRIC}{stream="live/stream_1080p"} 82\n`;

    assert.equal(rungCountersOf(otherDimension, DROPPED_SEGMENTS_METRIC, RUNG_LABEL).size, 0);
  });

  it('drops a sample whose value is not a number rather than reading it as zero', () => {
    const broken = `${DROPPED_SEGMENTS_METRIC}{rung="1080p"} NaN\n`;

    assert.equal(rungCountersOf(broken, DROPPED_SEGMENTS_METRIC, RUNG_LABEL).size, 0);
  });
});

describe('uploaderMetricsCommand', () => {
  it('runs the scrape inside the container, so the token stays where it lives', () => {
    const command = uploaderMetricsCommand('streamer1-stream-uploader-1');

    assert.match(command, /^docker exec streamer1-stream-uploader-1 node -e /);
    assert.match(command, /API_AUTH_TOKEN/);
  });

  /**
   * ⛔ The token must reach the request through the container's own environment and never through the
   * command line. A `ps` on a shared host shows every argument of every process on it.
   */
  it('names the token only as an environment lookup, never as a value', () => {
    const command = uploaderMetricsCommand('streamer1-stream-uploader-1');

    assert.match(command, /process\.env\.API_AUTH_TOKEN/);
    assert.doesNotMatch(command, /Bearer [A-Za-z0-9]/, 'a literal token would be visible in ps output');
  });

  it('reads the port the container was started with rather than a port this harness picked', () => {
    assert.match(uploaderMetricsCommand('x'), /process\.env\.API_PORT/);
  });

  /**
   * ⛔ What a status that is not a success does is proved by RUNNING the program, in "the scrape
   * program, run" below. Reading the text for `r.ok` and `process.exit(1)` passed with the condition
   * inverted, which is a test of the source against itself.
   */
  it('carries the whole program the run below exercises', () => {
    assert.ok(uploaderMetricsCommand('x').includes(uploaderMetricsScript()));
  });
});

/**
 * ⛔⛔⛔ The program is RUN here, because reading it proved nothing.
 *
 * Until 2026-09-05 these two properties were checked by asserting that the generated source text
 * contains `r.ok` and `process.exit(1)`. Invert the condition, or move the exit into a branch that
 * never runs, and both substrings survive untouched. That is the same shape as the mutation run this
 * repository once had which scored every mutant killed because its tests read build output.
 *
 * So the script goes to a real `node -e` against a real server, once answering 401 and once 200, and
 * what is asserted is the exit status, the stdout and the header the server was actually sent.
 *
 * ⛔ Why the status matters this much: an empty family is how `rungCountersOf` reports a scrape that
 * did not answer, and `droppedSegmentsRefusal` turns that into "the scrape did not answer" rather
 * than "nothing was lost". A 401 body arriving on stdout would parse to an empty family too, and the
 * drain suite would report a ladder that lost nothing on a rung whose batch had just run dry.
 */
describe('the scrape program, run', () => {
  const BODY = 'swarm_hls_rung_segments_dropped_total{rung="1080p"} 82\n';
  const TOKEN = 'not-a-real-token-and-never-a-live-one';

  /** What one request to the fake `/metrics` was, so the token's route can be asserted on. */
  interface Asked {
    readonly path: string | undefined;
    readonly authorization: string | undefined;
  }

  /** A server that answers one status, and records what it was asked. Closed after every case. */
  async function metricsServing(status: number, body: string): Promise<{ port: number; asked: Asked[] }> {
    const asked: Asked[] = [];
    const server = createServer((request, response) => {
      asked.push({ path: request.url, authorization: request.headers.authorization });
      response.writeHead(status, { 'content-type': 'text/plain' });
      response.end(body);
    });
    servers.push(server);

    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert.ok(address !== null && typeof address === 'object', 'the fake metrics server did not bind a port');
    return { port: address.port, asked };
  }

  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  });

  /** Runs the program the way `node -e` in the container does, on a deliberately bare environment. */
  function runScript(port: number): Promise<{ status: number | null; stdout: string; stderr: string }> {
    return new Promise((resolve) => {
      execFile(
        process.execPath,
        ['-e', uploaderMetricsScript()],
        { env: { API_PORT: String(port), API_AUTH_TOKEN: TOKEN }, timeout: 20_000 },
        (error, stdout, stderr) => {
          const status = error === null ? 0 : (error as NodeJS.ErrnoException & { code?: number }).code ?? null;
          resolve({ status: typeof status === 'number' ? status : null, stdout, stderr });
        },
      );
    });
  }

  it('writes the exposition to stdout and exits zero on a success', async () => {
    const { port, asked } = await metricsServing(200, BODY);

    const run = await runScript(port);

    assert.equal(run.status, 0);
    assert.equal(run.stdout, BODY);
    assert.equal(asked.length, 1);
    assert.equal(asked[0].path, '/metrics');
  });

  /** ⛔ The refused scrape. Nothing on stdout, non-zero status, and the status named on stderr. */
  it('exits non-zero with nothing on stdout when the token is refused', async () => {
    const { port } = await metricsServing(401, 'unauthorized');

    const run = await runScript(port);

    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.match(run.stderr, /401/);
  });

  it('fails a server error the same way, rather than handing back the error page', async () => {
    const { port } = await metricsServing(500, 'upstream exploded');

    const run = await runScript(port);

    assert.equal(run.status, 1);
    assert.equal(run.stdout, '');
    assert.doesNotMatch(run.stdout, /exploded/);
  });

  /** The token reaches the request through the environment it was given, as a bearer credential. */
  it('sends the token out of its own environment', async () => {
    const { port, asked } = await metricsServing(200, BODY);

    await runScript(port);

    assert.equal(asked[0].authorization, `Bearer ${TOKEN}`);
  });
});
