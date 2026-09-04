/**
 * Reading the uploader's own per-rung counters, without the harness ever holding the token.
 *
 * ## ⛔⛔ Why the scrape runs inside the container
 *
 * `GET /metrics` sits behind `Authorization: Bearer $API_AUTH_TOKEN`, unlike `GET /health`, because
 * it names when the last segment landed and how many broadcasts have run. This harness has no copy
 * of that token and must not acquire one. A secret passed as a command argument is in `ps` output on
 * a shared host for the length of the call, and this bench host is shared. A secret read back into
 * this process is in the harness's memory and one careless log line away from a scrollback that
 * outlives the run.
 *
 * So the request is made by the process that already holds the token: the shell inside the uploader
 * container expands `$API_AUTH_TOKEN` itself, and only the exposition text comes back out.
 *
 * ⚠️ `node -e` rather than curl or wget, because the image is `node:22-alpine` and ships neither.
 * The compose healthcheck reaches `/health` the same way and records the same reason.
 *
 * ## What a reading is worth
 *
 * The unlabelled totals cannot answer a per-rung question: `segments_dropped_total` climbs the same
 * whether one rung of four lost everything or all four lost a little, which is the whole reason the
 * labelled families exist. ⚠️ They are also **lifetime** counters, so a suite comparing one run
 * against another has to difference two scrapes rather than read one. The drain suite reads a single
 * scrape on purpose, because its broadcast is the only one that has ever drained a batch on this
 * stage and a non-zero label is therefore attributable on its own.
 *
 * The parse is pure so `test/uploaderMetrics.test.ts` covers it under `pnpm verify`, which nothing
 * under `suites/` is.
 */

import { shellQuoted } from './shellQuote.js';

/**
 * The port fallback, which is the compose healthcheck's own.
 *
 * ⚠️ Mirrors the `process.env.API_PORT||3000` in `deploy/docker-compose.yml`. Read from the
 * container's environment rather than from this harness's config for the reason `containerEnv`
 * records: a container keeps the environment it was started with, and an env file edited since the
 * last deploy describes an intention rather than what is listening.
 */
const DEFAULT_API_PORT = 3000;

function escapedForRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * One Prometheus sample of a labelled family, read off the label it was asked for by name.
 *
 * ⛔ Anchored at the start of the line and requiring the brace immediately after the family name.
 * The drop family's own HELP text names the upload family in prose, so a reader matching the name
 * anywhere on a line would count a documentation sentence as a sample, and a family with an
 * unlabelled total beside its labelled ones would count that total as a rung.
 *
 * ⛔⛔ And anchored on the LABEL NAME, not on whatever label comes last. `[^}]*="([^"]*)"` is greedy,
 * so on `{rung="1080p",stream="live/x"}` it captures the stream and the map is keyed by the wrong
 * dimension entirely. Nothing in the exposition would look wrong: the drain suite would refuse with
 * "the rung whose batch was drained is not the rung that lost segments", which is a false red naming
 * the product for a second label somebody added to a counter. The renderer declares a `labelName`
 * per family and this is where it belongs.
 */
function samplePattern(family: string, labelName: string): RegExp {
  const anyOtherLabels = '[^}]*';
  return new RegExp(
    `^${escapedForRegExp(family)}\\{(?:${anyOtherLabels},)?${escapedForRegExp(labelName)}=` +
      `"([^"]*)"(?:,${anyOtherLabels})?\\}\\s+(\\S+)$`,
  );
}

/**
 * The labelled samples of one metric family, by label value.
 *
 * Empty for a family the scrape does not carry, and empty for a scrape that answered nothing. ⛔ Those
 * two are the same answer here and are deliberately told apart one layer up, by whoever knows what
 * the family should be carrying: see `droppedSegmentsRefusal` in `batchDrain.ts`.
 *
 * ⚠️ A sample whose value is not a finite number is dropped rather than read as zero. Zero is a
 * legitimate value of every counter here, and a rung reading zero because its line was unparseable
 * would be reported as a rung that lost nothing.
 *
 * @param labelName the dimension to key the map by, which the renderer declares per family. Mirrored
 * as `RUNG_LABEL` in `batchDrain.ts` and held against the rendered exposition by
 * `batchDrainMirrors.test.ts`.
 */
export function rungCountersOf(body: string, family: string, labelName: string): ReadonlyMap<string, number> {
  const pattern = samplePattern(family, labelName);
  const counters = new Map<string, number>();

  for (const line of body.split('\n')) {
    const match = pattern.exec(line.trim());
    if (match === null) {
      continue;
    }
    const value = Number(match[2]);
    if (Number.isFinite(value)) {
      counters.set(match[1], value);
    }
  }
  return counters;
}

/**
 * The command that scrapes `/metrics` from inside the uploader container.
 *
 * Composed here rather than at a call site so `test/uploaderMetrics.test.ts` can assert the two
 * properties that matter and cannot be checked from a live run: that the token is named only as an
 * environment lookup, and that a status which is not a success fails the command instead of coming
 * back as a body. An empty family is how this harness reports a scrape that did not answer, so a
 * 401 arriving as text would be read as a ladder that lost nothing.
 */
export function uploaderMetricsCommand(container: string): string {
  const script =
    `const port = process.env.API_PORT || ${DEFAULT_API_PORT};` +
    'fetch(`http://127.0.0.1:${port}/metrics`, { headers: { authorization: `Bearer ${process.env.API_AUTH_TOKEN}` } })' +
    '.then((r) => (r.ok ? r.text() : Promise.reject(new Error(`${r.status} from /metrics`))))' +
    '.then((text) => process.stdout.write(text))' +
    '.catch((error) => { console.error(String(error)); process.exit(1); })';

  return `docker exec ${container} node -e ${shellQuoted(script)}`;
}
