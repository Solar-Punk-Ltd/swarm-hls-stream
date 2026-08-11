import { Bee } from '@ethersphere/bee-js';

import { createBee } from './bee-client.js';
import { NamedTarget } from './config-reader.js';
import { error, header } from './output.js';

/**
 * The publisher that owns a rung, by name.
 *
 * Throws rather than falling back to some default node. A postage batch belongs to whichever node
 * bought it and can only be spent by that node, so naming the wrong one does not fail here — it
 * fails much later, as a rung that quietly stops publishing with a perfectly healthy batch sitting
 * on a node that is not using it.
 *
 * Validated against BEE_PUBLISHERS rather than against ABR_LADDER, which lives in the engine's own
 * `.env` and is not loaded here. In a working config the two agree: the uploader refuses to start
 * unless the publisher list covers the ladder exactly.
 */
export function selectPublisherByRung(publishers: NamedTarget[], rung: string | undefined): NamedTarget {
  const configured = publishers.filter((node) => node.rung !== undefined);

  if (configured.length === 0) {
    throw new Error(
      'BEE_PUBLISHERS is not set, so there are no rungs to buy for. Set it first (see .env.sample), ' +
        'or buy on the single node with the bee API directly.',
    );
  }

  const rungs = configured.map((node) => node.rung).join(', ');

  if (!rung) {
    throw new Error(`Which rung? Pass it first, e.g. \`pnpm stamp:buy 360p\`. Configured rungs: ${rungs}`);
  }

  const matched = configured.find((node) => node.rung === rung);
  if (!matched) {
    throw new Error(`No node configured for rung "${rung}". Configured rungs: ${rungs}`);
  }

  return matched;
}

/**
 * The nodes a command should act on, after applying `--url`.
 *
 * An override that matches a configured node keeps that node's identity — its rung and its
 * configured batch — rather than becoming an anonymous URL, so `--url` pointed at a known publisher
 * still reports and writes back as that rung.
 */
export function selectNodes(targets: NamedTarget[], urlOverride?: string): NamedTarget[] {
  if (!urlOverride) {
    return targets;
  }

  const matched = targets.find((node) => node.target?.url === urlOverride);
  return [matched ?? { name: urlOverride, target: { url: urlOverride, host: urlOverride, port: 0 } }];
}

/**
 * Runs `inspect` against every node, carrying on when one of them fails.
 *
 * Continuing past a failure is the point. With a node per rung, one unreachable node must not hide
 * the state of the other three — finding out *which* one is broken is what these commands are for.
 *
 * `--url` narrows to exactly one node, which is how to reach something the config does not know
 * about at all. It replaces the list rather than overriding the first entry's URL, because applying
 * one URL to four named nodes would print four headers for one node.
 */
export async function forEachNode(
  targets: NamedTarget[],
  urlOverride: string | undefined,
  inspect: (bee: Bee, node: NamedTarget) => Promise<void>,
): Promise<void> {
  for (const node of selectNodes(targets, urlOverride)) {
    if (!node.target) {
      header(`${node.name} (disabled)`);
      continue;
    }

    header(`${node.name} (${node.target.url})`);

    try {
      await inspect(createBee(node.target.url), node);
    } catch (err) {
      error(`Unreachable: ${err instanceof Error ? err.message : 'unknown error'}`);
    }
  }
}
