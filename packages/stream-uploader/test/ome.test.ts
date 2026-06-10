import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseAppStream } from '../src/engines/ome.js';

describe('parseAppStream', () => {
  it('parses app and stream from the URL path', () => {
    assert.deepEqual(parseAppStream('srt://127.0.0.1:10080/video/test'), { app: 'video', stream: 'test' });
  });

  it('parses RTMP URLs', () => {
    assert.deepEqual(parseAppStream('rtmp://host:1935/audio/show'), { app: 'audio', stream: 'show' });
  });

  it('parses app and stream from the streamid query param', () => {
    assert.deepEqual(parseAppStream('srt://127.0.0.1:10080?streamid=srt://127.0.0.1:10080/video/test'), {
      app: 'video',
      stream: 'test',
    });
  });

  it('parses a percent-encoded streamid query param', () => {
    assert.deepEqual(parseAppStream('srt://127.0.0.1:10080?streamid=srt%3A%2F%2F127.0.0.1%3A10080%2Fvideo%2Ftest'), {
      app: 'video',
      stream: 'test',
    });
  });

  it('prefers the URL path over the streamid query param', () => {
    assert.deepEqual(parseAppStream('srt://host:10080/video/test?streamid=srt://host:10080/audio/other'), {
      app: 'video',
      stream: 'test',
    });
  });

  it('returns undefined fields when the URL has no app/stream and no streamid', () => {
    assert.deepEqual(parseAppStream('srt://127.0.0.1:10080'), { app: undefined, stream: undefined });
    assert.deepEqual(parseAppStream('srt://127.0.0.1:10080/video'), { app: 'video', stream: undefined });
  });

  it('returns undefined fields when the streamid has no app/stream', () => {
    assert.deepEqual(parseAppStream('srt://host:10080?streamid=srt://host:10080/video'), {
      app: 'video',
      stream: undefined,
    });
  });

  it('throws when the URL is not parseable', () => {
    assert.throws(() => parseAppStream('not a url'), /Could not parse app\/stream/);
  });
});
