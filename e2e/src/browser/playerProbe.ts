/**
 * What the media element did, as opposed to what the network did.
 *
 * A request log ends at "a segment arrived", and every fault past that point looks identical from
 * there: a segment refused by the demuxer, a segment appended into a buffer nothing plays from, and
 * a player that never started are one line each in the network trace and three different bugs. This
 * records the other half.
 *
 * Installed as an init script, so it is in place before the page's own scripts run and sees the very
 * first append and the very first event. Media events do not bubble, so the listeners are registered
 * on the capture phase, which reaches `document` regardless.
 */

import { type Page } from 'playwright-core';

/**
 * Everything a media element reports about starting, stalling and stopping.
 *
 * Passed into the init script as an argument rather than closed over, because the script is
 * serialised to source and sent to the page, so it cannot see anything in this module.
 */
const MEDIA_EVENTS = [
  'loadedmetadata',
  'loadeddata',
  'canplay',
  'canplaythrough',
  'play',
  'playing',
  'pause',
  'waiting',
  'stalled',
  'suspend',
  'seeking',
  'seeked',
  'ended',
  'error',
  'emptied',
];

export interface ProbeEvent {
  name: string;
  atMs: number;
  readyState: number;
}

export interface MediaElementReading {
  currentTime: number;
  readyState: number;
  paused: boolean;
  muted: boolean;
  autoplay: boolean;
  buffered: [number, number][];
  error: string | null;
}

export interface PlayerProbe {
  /**
   * Whether every hook below is actually in place, set by the last statement the init script runs.
   *
   * Not a formality. The counters are all empty until something happens, so "installed and saw
   * nothing" and "never installed" read identically, and the second silently answers every question
   * with the reassuring value. This is the difference, and a reader must check it before believing
   * an empty `sourceBuffers` on a page that plainly played something.
   */
  installed: boolean;
  /** MIME types the player asked `MediaSource` for, in order. */
  sourceBuffers: string[];
  appends: { mime: string; bytes: number }[];
  /** Appends and source buffers that threw, which is a segment the browser refused. */
  failures: string[];
  events: ProbeEvent[];
  /** Every media element on the page, since a page holding two is itself an answer. */
  elements: MediaElementReading[];
}

/** The window key the probe publishes itself under, shared by the installer and the reader. */
const PROBE_KEY = '__playerProbe';

export async function installPlayerProbe(page: Page): Promise<void> {
  await page.addInitScript(
    ({ key, eventNames }: { key: string; eventNames: string[] }) => {
      const probe = { installed: false, sourceBuffers: [], appends: [], failures: [], events: [] } as {
        installed: boolean;
        sourceBuffers: string[];
        appends: { mime: string; bytes: number }[];
        failures: string[];
        events: { name: string; atMs: number; readyState: number }[];
      };
      (window as unknown as Record<string, unknown>)[key] = probe;

      const record = (name: string, readyState: number): void => {
        probe.events.push({ name, atMs: Math.round(performance.now()), readyState });
      };

      for (const name of eventNames) {
        document.addEventListener(
          name,
          (event) => {
            const target = event.target;
            if (target instanceof HTMLMediaElement) {
              record(name, target.readyState);
            }
          },
          true,
        );
      }

      // Patched rather than inferred from the `play` event. A `play()` that rejects fires no event at
      // all, and an autoplay the browser refused is exactly that case.
      const play = HTMLMediaElement.prototype.play;
      HTMLMediaElement.prototype.play = function (this: HTMLMediaElement) {
        record('play() called', this.readyState);
        return play.call(this).then(
          () => record('play() resolved', this.readyState),
          (error: unknown) => {
            record(`play() rejected: ${String(error)}`, this.readyState);
            throw error;
          },
        );
      };

      const addSourceBuffer = MediaSource.prototype.addSourceBuffer;
      MediaSource.prototype.addSourceBuffer = function (this: MediaSource, mime: string) {
        let buffer: SourceBuffer;
        try {
          buffer = addSourceBuffer.call(this, mime);
        } catch (error) {
          probe.failures.push(`addSourceBuffer(${mime}) threw: ${String(error)}`);
          throw error;
        }
        probe.sourceBuffers.push(mime);
        buffer.addEventListener('error', () => probe.failures.push(`the source buffer for ${mime} errored`));

        const appendBuffer = buffer.appendBuffer.bind(buffer);
        buffer.appendBuffer = (data: BufferSource) => {
          probe.appends.push({ mime, bytes: data.byteLength });
          try {
            appendBuffer(data);
          } catch (error) {
            probe.failures.push(`appending ${data.byteLength}B to ${mime} threw: ${String(error)}`);
            throw error;
          }
        };
        return buffer;
      };

      // Last, so that reading it back true means every hook above was reached.
      probe.installed = true;
    },
    { key: PROBE_KEY, eventNames: MEDIA_EVENTS },
  );
}

export function readPlayerProbe(page: Page): Promise<PlayerProbe> {
  return page.evaluate((key: string) => {
    const probe = (window as unknown as Record<string, Omit<PlayerProbe, 'elements'> | undefined>)[key];
    const elements = [...document.querySelectorAll('video, audio')].map((node) => {
      const media = node as HTMLMediaElement;
      const buffered: [number, number][] = [];
      for (let range = 0; range < media.buffered.length; range++) {
        buffered.push([media.buffered.start(range), media.buffered.end(range)]);
      }
      return {
        currentTime: media.currentTime,
        readyState: media.readyState,
        paused: media.paused,
        muted: media.muted,
        autoplay: media.autoplay,
        buffered,
        error: media.error ? `${media.error.code}: ${media.error.message}` : null,
      };
    });

    return {
      installed: probe?.installed ?? false,
      sourceBuffers: probe?.sourceBuffers ?? [],
      appends: probe?.appends ?? [],
      failures: probe?.failures ?? ['the probe never ran'],
      events: probe?.events ?? [],
      elements,
    };
  }, PROBE_KEY);
}
