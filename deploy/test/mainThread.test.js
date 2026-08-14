import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  ATTACH_WINDOW_S,
  awaitTarget,
  chooseTarget,
  describeUnsampled,
  summariseMainThread,
  utilisationBetween,
} from '../scripts/main-thread.mjs';

/**
 * Whether the viewer's ONE thread is out of room, which the container total cannot say.
 *
 * ⛔⛔⛔ THE TARGET CHOICE IS THE LOAD-BEARING PART OF THIS FILE, not the arithmetic. This attaches to
 * a Chrome that Playwright drives, and that Chrome has more than one page in it: the harness opens a
 * throwaway context and blocks its main thread on purpose for a second, to prove the timer sensor can
 * report a failure. A sampler that took the first page of type `page`, which is what `cdp.mjs` does
 * for a browser it launched itself, could sample that proof and report a pegged thread that the
 * harness pegged deliberately, in a context nobody was watching.
 *
 * ⛔⛔ EVERY ASSERTION ON A MEMBER IS PRECEDED BY ONE ON THE COUNT. Gate lesson AHU: a `find` that
 * returns undefined and a `filter` that returns nothing both make a property check vacuously true.
 *
 * ⭐ No clock anywhere in this file. Every function under test is fed timestamps, so a threshold can
 * never be relaxed to make a slow machine pass. That is gate lesson AHY, learned from a timing test
 * whose limit had been raised twice.
 */

const page = (url) => ({ type: 'page', url, webSocketDebuggerUrl: `ws://127.0.0.1:9333/devtools/page/${url}` });

const WATCH = '/watch/abc?qoe=1';
const PROOF = 'about:blank';

describe('choosing which page to sample', () => {
  it('takes the viewer, not the throwaway page the harness blocks on purpose', () => {
    const targets = [page(PROOF), page(`http://localhost:5173${WATCH}`), page(PROOF)];

    const choice = chooseTarget(targets, '/watch/');

    assert.equal(choice.unsampled.length, 2);
    assert.equal(choice.page.url, `http://localhost:5173${WATCH}`);
  });

  it('refuses when two pages match, rather than picking one of them silently', () => {
    const targets = [page('http://localhost:5173/watch/abc'), page('http://localhost:5173/watch/def')];

    assert.throws(() => chooseTarget(targets, '/watch/'), /ambiguous/);
  });

  it('refuses when none match, and names the pages it did see', () => {
    const targets = [page(PROOF), page('http://localhost:5173/')];

    assert.throws(
      () => chooseTarget(targets, '/watch/'),
      (error) => {
        assert.match(error.message, /nothing to sample/);
        assert.match(error.message, /about:blank/);
        return true;
      },
    );
  });

  it('calls the reading incomplete when something else could be running script', () => {
    const targets = [
      page('http://localhost:5173/watch/abc'),
      { type: 'service_worker', url: 'http://localhost:5173/weeb-3/service.js' },
    ];

    const choice = chooseTarget(targets, '/watch/');

    assert.equal(choice.unsampled.length, 1);
    assert.equal(choice.complete, false);
  });

  // ⭐ The control for the case above. Without it, a bug that returned `complete: false` for every
  // browser would pass the incompleteness test and be indistinguishable from a working gate.
  it('calls it complete when the other targets cannot run script', () => {
    const targets = [page('http://localhost:5173/watch/abc'), { type: 'browser', url: '' }];

    const choice = chooseTarget(targets, '/watch/');

    assert.equal(choice.unsampled.length, 1);
    assert.equal(choice.complete, true);
  });
});

/**
 * ⛔⛔⛔ THE ONE FUNCTION WITH NO TEST IS THE ONE THAT FAILED EVERY ARM.
 *
 * `awaitTarget` shipped uncovered because attaching looked like plumbing next to the target choice
 * above. It is not plumbing: it decides whether an arm has a saturation column at all, and its window
 * was ten seconds. Proving the sampler by hand pointed it at a Chrome already sitting on the watch
 * route, which is the one arrangement where that window is generous.
 *
 * ⭐ A real arm loads a HASH-ROUTER client, so `#/watch/…` cannot appear until the app has booted, and
 * the target list answers with the bare origin until it does. The sampler therefore has to distinguish
 * "no page yet" from "a page that is not the viewer yet", and keep waiting through both.
 */
describe('waiting for the viewer to exist', () => {
  const ROOT = [page('http://127.0.0.1:10074/')];
  const ROUTED = [page('http://127.0.0.1:10074/#/watch/video/abc?qoe=1')];

  /** Feeds `awaitTarget` one target list per call, holding the last one once they run out. */
  const withTargetLists = async (lists, body) => {
    const realFetch = globalThis.fetch;
    let call = 0;
    globalThis.fetch = async () => ({ json: async () => lists[Math.min(call++, lists.length - 1)] });
    try {
      return await body();
    } finally {
      globalThis.fetch = realFetch;
    }
  };

  it('keeps asking while a page exists but has not routed to the watch yet', async () => {
    const choice = await withTargetLists([ROOT, ROOT, ROOT, ROUTED], () => awaitTarget(9333, '/watch/', 2));

    assert.equal(choice.page.url, ROUTED[0].url);
    assert.equal(choice.complete, true);
  });

  it('gives up when the window closes before the client routes, and says how long it waited', async () => {
    await assert.rejects(
      () => withTargetLists([ROOT], () => awaitTarget(9333, '/watch/', 0.25)),
      /gave up after 0\.25s waiting for a page matching \/watch\//,
    );
  });

  // ⛔⛔ THE TWO ABOVE WOULD BOTH HAVE PASSED AGAINST THE BROKEN VERSION, and saying so is the point.
  // The defect was never the retry loop, which always worked. It was the DEFAULT window, and no unit
  // test can derive how long a real client takes to boot and route: the only instrument that could
  // answer that was an arm, which measured the page still at the bare origin ten seconds in. So this
  // pins the number rather than re-deriving it, and fails loudly if anyone shrinks it back.
  it('defaults to a window that covers a real arm booting, not just a port opening', () => {
    assert.ok(
      ATTACH_WINDOW_S >= 120,
      `the attach window is ${ATTACH_WINDOW_S}s. Ten seconds declined every arm of a paid sitting on 2026-08-14`,
    );
  });
});

describe('saying what was left unsampled', () => {
  it('shouts when a worker is unsampled, because that is where the work would be hiding', () => {
    const said = describeUnsampled({
      unsampled: [{ type: 'service_worker', url: 'http://x/weeb-3/service.js' }],
      complete: false,
    });

    assert.match(said, /INCOMPLETE/);
    assert.match(said, /service_worker/);
  });

  it('still says something when there is nothing to report, so silence never means passed', () => {
    const said = describeUnsampled({ unsampled: [], complete: true });

    assert.match(said, /whole browser/);
    assert.doesNotMatch(said, /INCOMPLETE/);
  });
});

describe('what the thread was doing between two readings', () => {
  it('is CPU seconds per wall second, needing no scaling', () => {
    const from = { Timestamp: 100, TaskDuration: 10 };
    const to = { Timestamp: 110, TaskDuration: 18 };

    assert.equal(utilisationBetween(from, to), 0.8);
  });

  it('answers null and never 0 when Chrome did not supply the metric', () => {
    const from = { Timestamp: 100, TaskDuration: null };
    const to = { Timestamp: 110, TaskDuration: 18 };

    assert.equal(utilisationBetween(from, to), null);
  });

  it('answers null when no wall time passed, rather than dividing by zero', () => {
    const at = { Timestamp: 100, TaskDuration: 10 };

    assert.equal(utilisationBetween(at, { ...at, TaskDuration: 12 }), null);
  });
});

describe('summarising an arm', () => {
  it('takes the mean end to end, so a stuttered stretch cannot weigh like a steady one', () => {
    const samples = [
      { Timestamp: 0, TaskDuration: 0 },
      { Timestamp: 1, TaskDuration: 1 },
      { Timestamp: 100, TaskDuration: 20 },
    ];

    const summary = summariseMainThread(samples);

    assert.equal(summary.usable, 3);
    assert.equal(summary.wallS, 100);
    assert.equal(summary.mean, 0.2);
  });

  it('reports the busiest interval, because a stall hides inside a comfortable average', () => {
    const samples = [
      { Timestamp: 0, TaskDuration: 0 },
      { Timestamp: 10, TaskDuration: 9.9 },
      { Timestamp: 110, TaskDuration: 20 },
    ];

    const summary = summariseMainThread(samples);

    assert.equal(summary.usable, 3);
    assert.equal(summary.peak, 0.99);
    assert.ok(summary.mean < 0.2, `mean ${summary.mean} should be far below the 0.99 peak`);
  });

  it('says the reading is unusable rather than reporting an idle thread', () => {
    const summary = summariseMainThread([{ Timestamp: 0, TaskDuration: null }]);

    assert.equal(summary.usable, 0);
    assert.equal(summary.mean, null);
    assert.equal(summary.peak, null);
  });
});
