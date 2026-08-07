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
  /**
   * What each source buffer holds, separately.
   *
   * `HTMLMediaElement.buffered` is the **intersection** across every source buffer, so one short
   * track truncates the element's whole timeline and the element cannot say which track did it. This
   * is the only place that distinguishes "the media is short" from "one of its two tracks is".
   */
  tracks: { mime: string; buffered: [number, number][] }[];
}

/** The window key the probe publishes itself under, shared by the installer and the reader. */
const PROBE_KEY = '__playerProbe';

/**
 * Where the live `SourceBuffer` objects are kept, apart from the serialisable probe.
 *
 * They cannot cross `page.evaluate`, and their `buffered` only means anything read in the page at
 * the moment it is asked, so the reader walks these rather than a snapshot taken at append time.
 */
const TRACKS_KEY = '__playerProbeTracks';

export async function installPlayerProbe(page: Page): Promise<void> {
  await page.addInitScript(
    ({ key, tracksKey, eventNames }: { key: string; tracksKey: string; eventNames: string[] }) => {
      const probe = { installed: false, sourceBuffers: [], appends: [], failures: [], events: [] } as {
        installed: boolean;
        sourceBuffers: string[];
        appends: { mime: string; bytes: number }[];
        failures: string[];
        events: { name: string; atMs: number; readyState: number }[];
      };
      (window as unknown as Record<string, unknown>)[key] = probe;
      const tracks: { mime: string; buffer: SourceBuffer }[] = [];
      (window as unknown as Record<string, unknown>)[tracksKey] = tracks;

      // Published before the hooks and wrapped around them, so an install that throws leaves a probe
      // that says so rather than one that reads as a quiet page. This script runs before any page
      // script, so nothing here reaches a console anyone is watching.
      try {
        // tsx compiles this file with esbuild's `keepNames`, which rewrites every function it can
        // name into `__name(fn, 'fn')` against a helper defined at **module** scope. Playwright
        // serialises this function's source alone, so the helper is not there and the script dies on
        // `ReferenceError: __name is not defined` before installing anything. Assigned onto
        // `globalThis` rather than declared as a local, because a local of that name is exactly what
        // the compiler is entitled to rename. `installTimerProbe` escapes it only by declaring no
        // named function at all.
        (globalThis as unknown as { __name?: unknown }).__name ??= (fn: unknown) => fn;

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

        // Patched rather than inferred from the `play` event. A `play()` that rejects fires no event
        // at all, and an autoplay the browser refused is exactly that case.
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

        // `pause()` the same way, because the interesting pause is the one nothing asked for: knowing
        // whether a call came from the page or from the browser is the difference between a bug in
        // the player and a policy in Chrome.
        const pause = HTMLMediaElement.prototype.pause;
        HTMLMediaElement.prototype.pause = function (this: HTMLMediaElement) {
          record('pause() called by the page', this.readyState);
          return pause.call(this);
        };

        // Both media source flavours. Chrome exposes `ManagedMediaSource` as its own global, and
        // hls.js prefers it where it exists, so patching only `MediaSource` can leave the hooks in
        // place and recording nothing at all.
        const sources = [
          MediaSource,
          (window as unknown as { ManagedMediaSource?: typeof MediaSource }).ManagedMediaSource,
        ];
        for (const source of sources) {
          if (!source?.prototype) {
            continue;
          }
          const addSourceBuffer = source.prototype.addSourceBuffer;
          source.prototype.addSourceBuffer = function (this: MediaSource, mime: string) {
            let buffer: SourceBuffer;
            try {
              buffer = addSourceBuffer.call(this, mime);
            } catch (error) {
              probe.failures.push(`addSourceBuffer(${mime}) threw: ${String(error)}`);
              throw error;
            }
            probe.sourceBuffers.push(mime);
            tracks.push({ mime, buffer });
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
        }

        // Last, so that reading it back true means every hook above was reached.
        probe.installed = true;
      } catch (error) {
        probe.failures.push(`the probe could not install itself: ${String(error)}`);
      }
    },
    { key: PROBE_KEY, tracksKey: TRACKS_KEY, eventNames: MEDIA_EVENTS },
  );
}

export function readPlayerProbe(page: Page): Promise<PlayerProbe> {
  return page.evaluate(
    ([key, tracksKey]: [string, string]) => {
      const probe = (window as unknown as Record<string, Omit<PlayerProbe, 'elements' | 'tracks'> | undefined>)[key];

      const readRanges = (ranges: TimeRanges): [number, number][] => {
        const out: [number, number][] = [];
        for (let range = 0; range < ranges.length; range++) {
          out.push([ranges.start(range), ranges.end(range)]);
        }
        return out;
      };

      const live = (window as unknown as Record<string, { mime: string; buffer: SourceBuffer }[] | undefined>)[
        tracksKey
      ];
      const tracks = (live ?? []).map((track) => {
        try {
          return { mime: track.mime, buffered: readRanges(track.buffer.buffered) };
        } catch (error) {
          // A source buffer detached from its media source throws on `buffered`, which is itself worth
          // reporting rather than losing the whole reading to.
          return { mime: track.mime, buffered: [] as [number, number][], detached: String(error) };
        }
      });
      const elements = [...document.querySelectorAll('video, audio')].map((node) => {
        const media = node as HTMLMediaElement;
        return {
          currentTime: media.currentTime,
          readyState: media.readyState,
          paused: media.paused,
          muted: media.muted,
          autoplay: media.autoplay,
          buffered: readRanges(media.buffered),
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
        tracks,
      };
    },
    [PROBE_KEY, TRACKS_KEY] as [string, string],
  );
}
