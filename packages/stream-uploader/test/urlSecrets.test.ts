import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { publishKeyFromUrl } from '../src/utils/publishKey.js';
import { redactUrlSecrets, SRS_WEBHOOK_TOKEN_PARAM } from '../src/utils/urlSecrets.js';

/**
 * The redactor's own tests, which its move did not bring with it.
 *
 * When `redactWebhookToken` became `redactUrlSecrets` the implementation moved out of
 * `engines/srs/webhookToken.ts` and its tests stayed behind in `srsWebhookAuth.test.ts`, where every
 * case is about the SRS token. The function's responsibility doubled and its coverage did not move,
 * which is why two real defects and four untested branches were all sitting in one 78-line file.
 *
 * Those old token cases are deliberately left where they are: they still pass, they still pin the
 * behaviour they were written for, and duplicating them here would give one of the two copies room to
 * go stale. What is here is what the generalisation added.
 *
 * **The invariant.** This must redact at least every URL the corresponding check accepts. Being wider
 * costs nothing, being narrower puts a credential in a log. Every case below is an instance of it.
 */

const KEY = 'ZZ7SENTINEL7ZZ';

describe('the invariant: anything that authenticates is redacted', () => {
  /**
   * The WHATWG URL parser strips ASCII tab, newline and carriage return from its input before it
   * parses anything, so these spellings are the parameter `key` to `searchParams` and authenticate a
   * publisher. A matcher that does not strip them sees a different name and leaves the value.
   *
   * This is new rather than inherited. The token's gate is `req.query`, which Express fills without
   * any such stripping, so the narrower matcher was correct for the only secret it used to guard.
   */
  for (const name of ['k\tey', 'k\ney', 'k\rey', '\tkey', 'key\r']) {
    it(`redacts ${JSON.stringify(name)}, which the URL parser reads as "key"`, () => {
      const url = `srt://ome:10080/video/demo?${name}=${KEY}`;

      assert.equal(publishKeyFromUrl(url), KEY, 'the fixture has to actually authenticate');
      assert.equal(redactUrlSecrets(url).includes(KEY), false);
    });
  }

  /**
   * OME takes an entire publish URL as an SRT `streamid`, so the secret sits inside a value rather
   * than beside a name. `parseAppStream` supports that shape and names the URL in all three of its
   * failure paths, which a broadcaster reaches by mistyping their stream, so their first failed
   * attempt used to deposit a live credential at ERROR level.
   */
  for (const [label, url] of [
    ['plain', `srt://ome:10080?streamid=srt://ome:10080/video/demo?key=${KEY}`],
    ['percent-encoded', `srt://ome:10080?streamid=${encodeURIComponent(`srt://ome:10080/video/demo?key=${KEY}`)}`],
  ] as const) {
    it(`redacts a key nested inside a ${label} streamid`, () => {
      assert.equal(publishKeyFromUrl(url), KEY, 'the fixture has to actually authenticate');
      assert.equal(redactUrlSecrets(url).includes(KEY), false);
    });
  }

  it('redacts a webhook token nested the same way', () => {
    const url = `/hook?next=${encodeURIComponent(`http://h/x?${SRS_WEBHOOK_TOKEN_PARAM}=${KEY}`)}`;

    assert.equal(redactUrlSecrets(url).includes(KEY), false);
  });

  it('still redacts every top-level spelling the checker accepts', () => {
    for (const name of ['key', 'KEY', 'Key', '%6bey']) {
      const url = `srt://h/video/demo?${name}=${KEY}`;

      assert.equal(redactUrlSecrets(url).includes(KEY), false, `${name} leaked`);
    }
  });
});

describe('the paths the move left untested', () => {
  /**
   * A fragment is split off before the query is walked. Every mutant that removed that split survived,
   * because no case had a `#` in it at all.
   */
  it('does not treat a fragment as part of the query', () => {
    assert.equal(redactUrlSecrets('/x?a=1#b=2'), '/x?a=1#b=2');
    assert.equal(redactUrlSecrets(`/x?key=${KEY}#frag`), '/x?key=REDACTED#frag');
  });

  /**
   * A pair with no `=` is returned untouched. Removing that early return truncated the name by one
   * character before matching, so `keyX` became `key`, matched, and the pair was rewritten. Nothing
   * covered it, in either direction.
   */
  it('leaves a pair with no equals sign alone, and does not truncate its neighbour', () => {
    assert.equal(redactUrlSecrets('/x?flag&a=1'), '/x?flag&a=1');
    assert.equal(redactUrlSecrets(`/x?keyX=${KEY}`), `/x?keyX=${KEY}`, 'keyX is not key');
  });

  /**
   * A malformed percent escape in a parameter *name* reaches `decodeURIComponent` and throws. The
   * existing token case puts the malformed escape in the value, which never reaches that call, so the
   * catch was unreachable from the suite and deleting its body survived.
   */
  it('survives a malformed percent escape in a parameter name', () => {
    assert.equal(redactUrlSecrets('/x?%E0%A4=1'), '/x?%E0%A4=1');
    assert.equal(redactUrlSecrets(`/x?%E0%A4=1&key=${KEY}`), '/x?%E0%A4=1&key=REDACTED');
  });

  /**
   * `+` means a space in a query component, so `k+ey` is the parameter `k ey` and is not the key.
   * Replacing the space with an empty string made it match, which over-redacts rather than leaking,
   * but nothing noticed either way.
   */
  it('reads a plus in a name as a space, so k+ey is not key', () => {
    assert.equal(redactUrlSecrets(`/x?k+ey=${KEY}`), `/x?k+ey=${KEY}`);
    assert.equal(publishKeyFromUrl(`srt://h/video/demo?k+ey=${KEY}`), null, 'and it does not authenticate either');
  });
});

describe('what it leaves alone', () => {
  it('returns a url with no query unchanged', () => {
    assert.equal(redactUrlSecrets('/stream/start'), '/stream/start');
  });

  it('does not redact a parameter that merely contains the word', () => {
    assert.equal(redactUrlSecrets('/x?mykey=abc&keyring=def'), '/x?mykey=abc&keyring=def');
  });
});
