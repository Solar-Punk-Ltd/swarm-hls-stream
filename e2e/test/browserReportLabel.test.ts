import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeGop } from '../src/browser/report.js';
import { envNumberOrNull } from '../src/browser/runFiles.js';

/**
 * That a report names the configuration it watched, or admits it was not told.
 *
 * `BROWSER_GOP_SECONDS` carried a 0.25 fallback and reached nothing but the report's opening
 * sentence. Every browser run started without it published a headline naming a segment length the
 * deployment stopped producing at #155, while the numbers underneath stayed correct. That is the
 * shape that survives review: nothing looks wrong, and the artefact is filed against a configuration
 * it never ran.
 */
describe('naming the broadcast a browser report watched', () => {
  it('names the GOP it was told about', () => {
    assert.equal(describeGop(0.5), 'a 0.5s-GOP broadcast');
  });

  it('says the GOP is unrecorded rather than supplying a plausible one', () => {
    const described = describeGop(null);

    assert.match(described, /unrecorded/);
    // The specific number that used to appear, named so a reintroduced fallback fails here.
    assert.doesNotMatch(described, /0\.25/);
    assert.doesNotMatch(described, /\d+(\.\d+)?s-GOP/);
  });

  it('reads an absent environment variable as absent, not as a default', () => {
    delete process.env.BROWSER_GOP_SECONDS_TEST;

    assert.equal(envNumberOrNull('BROWSER_GOP_SECONDS_TEST'), null);
  });

  it('reads an empty environment variable as absent, since a blank is how a shell passes nothing', () => {
    process.env.BROWSER_GOP_SECONDS_TEST = '';

    assert.equal(envNumberOrNull('BROWSER_GOP_SECONDS_TEST'), null);
  });

  it('reads a value that was supplied', () => {
    process.env.BROWSER_GOP_SECONDS_TEST = '2';

    assert.equal(envNumberOrNull('BROWSER_GOP_SECONDS_TEST'), 2);
    delete process.env.BROWSER_GOP_SECONDS_TEST;
  });

  it('still refuses a value that is not a positive number, rather than quietly reading null', () => {
    process.env.BROWSER_GOP_SECONDS_TEST = 'soon';

    assert.throws(() => envNumberOrNull('BROWSER_GOP_SECONDS_TEST'), /must be a positive number/);
    delete process.env.BROWSER_GOP_SECONDS_TEST;
  });
});
