import {
  CLIENT_LOG_UNKNOWN,
  FRAGMENT_ABORTED,
  FRAGMENT_ERRORED,
  FRAGMENT_LOADED,
  FRAGMENT_TIMED_OUT,
  type FragmentOutcome,
  fragmentRequested,
  fragmentSettled,
} from '@swarm-hls-stream/shared';
import type {
  Fragment,
  FragmentLoaderContext,
  HlsConfig,
  Loader,
  LoaderCallbacks,
  LoaderConfiguration,
  LoaderContext,
  PlaylistLoaderContext,
} from 'hls.js';
import Hls from 'hls.js';

import { RequestJitter, StaggeredTask } from '@/utils/requestJitter';

import { activeFetchBackend, FETCH_BACKEND_WEEB3, segmentRefFromUrl } from './fetchBackend';
import { ManifestFetcher } from './ManifestManagement';
import { weeb3FetchBackend } from './Weeb3FetchBackend';

export const manifestFetcher = new ManifestFetcher();

/**
 * The stagger every fragment request goes through, shared by every player on the page.
 *
 * A module singleton beside {@link manifestFetcher} and for the same reason: hls.js constructs
 * loaders itself, passing only its own config, so there is no constructor to inject through. Tests
 * reach it by spying on the instance.
 */
export const requestJitter = new RequestJitter();

const PlaylistLoader = Hls.DefaultConfig.loader as unknown as {
  new (config: HlsConfig): Loader<PlaylistLoaderContext>;
};

export class CustomManifestLoader extends PlaylistLoader {
  constructor(config: HlsConfig) {
    super(config);
  }

  load(context: PlaylistLoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<PlaylistLoaderContext>) {
    if (!['manifest', 'level'].includes(context.type)) {
      super.load(context, config, callbacks);
      return;
    }

    // `manifest` is the top-level request — the one whose answer decides whether this stream is a
    // ladder at all, so it goes through the path that reads the source feed and looks. `level` is
    // one rung, which is a feed like any other.
    const manifest =
      context.type === 'manifest' ? manifestFetcher.fetchSource(context.url) : manifestFetcher.fetch(context.url);

    manifest
      .then((data) => {
        callbacks.onSuccess({ url: context.url, data, code: 200 }, this.stats, context, undefined);
      })
      .catch((error) => {
        callbacks.onError?.({ code: 0, text: error.message }, context, undefined, this.stats);
      });
  }
}

const FragmentLoader = Hls.DefaultConfig.loader as unknown as {
  new (config: HlsConfig): Loader<FragmentLoaderContext>;
};

export class CustomFragmentLoader extends FragmentLoader {
  /**
   * The stagger waiting to hand this fragment to the transport, if one is.
   *
   * ⛔ Held so {@link abort} and {@link destroy} can cancel it. hls.js abandons in-flight fragments
   * routinely, on a level switch, a seek and every teardown, and a stagger that fired anyway would
   * start a transfer for a fragment nobody is waiting for any more, against the loader hls.js has
   * already finished with. That is a request the gateway pays for and nothing consumes.
   */
  private pendingStagger: StaggeredTask | null = null;

  /**
   * Set once hls.js has abandoned this fragment, so a retrieval still in flight answers nobody.
   *
   * ⛔ Only the weeb-3 path needs this. The gateway path hands the transfer to hls.js's own loader,
   * which owns its cancellation, but `retrieveBytes` takes no abort signal and cannot be called off.
   * The most that can be done is to drop the answer, and dropping it is required: hls.js treats a
   * success on a fragment it has finished with as belonging to whatever it is loading now.
   */
  private abandoned = false;

  /**
   * What this loader's one fragment is and when it was asked for, until the attempt ends.
   *
   * ⭐ Read once at the top of {@link load} rather than at each ending, because the endings do not all
   * carry the fragment: an abort arrives as stats and a context, and the stagger cancels with nothing at
   * all. Nulled by {@link recordSettle}, which is also what keeps one attempt to one settle line: hls.js
   * routinely destroys a loader that has already succeeded, and a second line for the same fragment would
   * be double-counted by anything pairing the two halves.
   */
  private attempt: FragmentAttempt | null = null;

  /**
   * Whether an in-tab retrieval is still running, which is the one ending {@link abandon} must not stamp
   * itself.
   *
   * ⛔ **Not "has this fragment left yet", which is the question that was asked here twice and answered
   * wrongly both times.** The first version read {@link pendingStagger} being set as "still held back",
   * and `RequestJitter.stagger` runs its task synchronously at the shipped bound of zero and returns the
   * handle afterwards, so that field is non-null for the whole life of every ordinary fragment. The
   * second read it as "handed to a byte source" and left the gateway path's ending to hls.js's own
   * loader, which does not always produce one: `XhrLoader.destroy` nulls its callbacks and only then
   * aborts itself, so a teardown with no `abort()` in front of it never reaches the wrapped `onAbort`
   * and the attempt settled nowhere at all.
   *
   * ⭐ The in-tab path is genuinely the exception, which is why this field survives rather than going
   * away with that second answer. `retrieveBytes` takes no abort signal, so an abandoned retrieval keeps
   * costing the node until it answers, and {@link retrieveThroughWeeb3} settles it at the answer so the
   * elapsed is that work rather than zero.
   */
  private retrievalOutstanding = false;

  constructor(config: HlsConfig) {
    super(config);
  }

  load(context: FragmentLoaderContext, config: LoaderConfiguration, callbacks: LoaderCallbacks<LoaderContext>) {
    // ⛔ One attempt to one settle line, enforced here rather than rested on hls.js. A second `load` on
    // one instance is unreachable in 1.6.15, whose own loader throws `Loader can only be used once` and
    // whose fragment loader builds one loader per fragment, but if it ever became reachable the first
    // attempt would lose its ending and hand its elapsed to the second. That is a missing line and a
    // wrong number rather than a crash, which is the kind of defect this instrument cannot afford.
    // `recordSettle` is a no-op when no attempt is outstanding, so this costs an ordinary load nothing.
    this.recordSettle(FRAGMENT_ABORTED);

    const url = context.url;
    this.abandoned = false;
    this.retrievalOutstanding = false;
    this.attempt = attemptBegun(context);

    recordFragmentRequest(this.attempt, context);

    // Every playlist this client hands hls.js names its segments absolutely, so anything else here is
    // a bug upstream rather than a URL to repair, and it is not repairable anyway. A preview playlist
    // is a blob, and hls.js resolving `/bytes/<ref>` against `blob:http://viewer/<uuid>` returns
    // `blob:http:/bytes/<ref>`: the origin and the blob id are gone, so there is no gateway left to
    // resolve against.
    //
    // This used to rebuild the path against `window.location.origin`, which is the client. Its nginx
    // proxies `/bee/` and not `/bytes/`, so the fragment 404'd at a host that never had it and
    // nothing said the fallback was the reason. Failing here costs the same fragment and says why.
    //
    // Not optional-chained, unlike the manifest loader above. hls.js declares `onError` required, and
    // this is the one path that returns without reaching the transport: chaining it would turn a
    // missing callback into a fragment that never succeeds and never fails, which is the silent hang
    // this change exists to remove. A thrown TypeError is the louder answer and the correct one.
    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      // ⛔ Settled BEFORE the callback, and the order is load-bearing. hls.js's fragment loader destroys
      // this loader from inside its own `onError` (`FragmentLoader.resetLoader`, 1.6.15), re-entrantly,
      // while this `load` is still on the stack, so a settle written afterwards would find the attempt
      // already recorded as aborted and this refusal would never be reported as the error it is.
      this.recordSettle(FRAGMENT_ERRORED);
      callbacks.onError(
        { code: 0, text: `fragment url is not absolute, so it names no gateway: ${url}` },
        context,
        undefined,
        this.stats,
      );
      return;
    }

    // Held back by a bounded random delay, because at the live edge every viewer of one broadcast is
    // chasing the same newest segment and asks for it as soon as their playlist reload lands. The
    // gateway is limited by how many ask in the same instant rather than by how many ask at all, so
    // this is the request most worth taking off the shared tick. A zero bound calls the transport
    // synchronously, exactly as it did before this existed.
    this.pendingStagger = requestJitter.stagger(() => {
      this.pendingStagger = null;

      // ⭐ Inside the stagger rather than in front of it, so the two backends are reached through
      // exactly the same path and differ in one thing: where the bytes come from. The stagger is
      // currently a synchronous no-op (`GATEWAY_REQUEST_JITTER_MS` is 0), so this costs nothing
      // today, and it keeps the arms comparable for an operator who turns it back on.
      //
      // ⛔ Read here rather than held from the constructor, so a switch mid-broadcast takes effect on
      // the next fragment. hls.js builds a loader per fragment, so a constructor read would look like
      // it worked and lag by one, and a loader already in flight would finish on the old backend
      // while the harness had moved on. That is the shape of an arm that measures the wrong thing.
      if (activeFetchBackend() === FETCH_BACKEND_WEEB3) {
        this.retrieveThroughWeeb3(context, callbacks);
        return;
      }

      // ⭐ All four endings are wrapped, so the gateway path settles wherever it stops, and the two byte
      // sources account for their attempts the same way. hls.js's own fragment loader supplies all four,
      // `onAbort` included, and each wrapper forwards what it was handed untouched. Three of them are
      // the attempt's real ending. The fourth is now a duplicate, and says so where it is defined.
      super.load(context, config, {
        ...callbacks,
        // A segment that arrived is proof the gateway is answering, and the manifest side is the only
        // half that ever holds off on the belief that it is not. Its backoff doubles from the failure
        // that set it, so an outage of twenty seconds went unnoticed for thirty: the gateway was back
        // for ten of them and the one thing still talking to it was this. Reported here because the
        // player fetches segments anyway on hls.js's own retry cadence, so the signal is free.
        onSuccess: (response, stats, ctx, networkDetails) => {
          this.recordSettle(FRAGMENT_LOADED);
          manifestFetcher.feedHealth.recordGatewayReachable();
          callbacks.onSuccess(response, stats, ctx, networkDetails);
        },
        onError: (error, ctx, networkDetails, stats) => {
          this.recordSettle(FRAGMENT_ERRORED);
          callbacks.onError(error, ctx, networkDetails, stats);
        },
        onTimeout: (stats, ctx, networkDetails) => {
          this.recordSettle(FRAGMENT_TIMED_OUT);
          callbacks.onTimeout(stats, ctx, networkDetails);
        },
        // ⚠️ Optional-chained where the three above are not, because hls.js declares only this one
        // optional. Supplying it regardless costs nothing: the transport calls it, this settles, and a
        // caller that had none is handed nothing.
        //
        // ⭐ The settle here is the DUPLICATE, not the primary, and {@link abandon} is what actually
        // ends an abandoned gateway attempt. It has to be that way round: `XhrLoader.abort` calls this
        // back but `XhrLoader.destroy` nulls its callbacks before aborting itself, so a loader torn down
        // without an abort in front of it reaches this never. `recordSettle` drops whichever of the two
        // arrives second, and this one stays so that the forwarding to hls.js keeps happening.
        onAbort: (stats, ctx, networkDetails) => {
          this.recordSettle(FRAGMENT_ABORTED);
          callbacks.onAbort?.(stats, ctx, networkDetails);
        },
      });
    });
  }

  abort(): void {
    this.abandon();
    super.abort();
  }

  destroy(): void {
    this.abandon();
    super.destroy();
  }

  private abandon(): void {
    this.abandoned = true;
    if (!this.retrievalOutstanding) {
      // ⛔ This is where an abandoned attempt ends, whether or not it ever reached a byte source, and it
      // used to be only the ones that had not. hls.js's own loader is not a reliable owner of the
      // ending: `XhrLoader.destroy` nulls its callbacks and then aborts itself, so a gateway attempt
      // torn down without an `abort()` in front of it produced no `onAbort`, no settle and a request
      // line with nothing after it. Settling here depends on no base-class internal, and the wrapped
      // `onAbort` becomes the duplicate that `recordSettle` drops.
      //
      // The one attempt this must NOT stamp is an in-tab retrieval, which always answers and is settled
      // where it answers. {@link retrievalOutstanding} says why.
      this.recordSettle(FRAGMENT_ABORTED);
    }
    this.pendingStagger?.cancel();
    this.pendingStagger = null;
  }

  /**
   * Announce how this fragment's one attempt ended.
   *
   * ⛔ **An instrument, and only an instrument**, exactly as {@link recordFragmentRequest} is. Nothing
   * below reads it, no fragment waits on it and no branch depends on it. `clientLog.ts` owns the wording,
   * which the e2e harness parses.
   *
   * ⭐ At most one line per attempt, because the attempt is cleared here. hls.js destroys a loader it has
   * already finished with, and a second line naming the same level and segment number would be counted
   * twice by anything pairing the two halves of this instrument.
   *
   * ⭐ That guard is also what lets several endings be wired to one attempt without any of them having to
   * know which will arrive: the first one wins and the rest are silent. The wrapped `onAbort` after
   * {@link abandon} and a weeb-3 answer that lands after a teardown are both that second caller.
   */
  private recordSettle(outcome: FragmentOutcome): void {
    const attempt = this.attempt;
    if (attempt === null) {
      return;
    }
    this.attempt = null;

    try {
      const elapsedMs = Math.round(performance.now() - attempt.askedAtMs);
      console.debug(fragmentSettled(attempt.level, attempt.sn, outcome, elapsedMs));
    } catch {
      // Silent by design. A viewer whose console throws still has to get their video.
    }
  }

  /**
   * Fetch this segment from the Swarm node in this tab instead of from a gateway.
   *
   * ⛔⛔⛔ **The gateway's health is deliberately not reported here**, which is the one place the two
   * backends must not be symmetrical. A segment that arrived proves the gateway is answering only when
   * the gateway is what served it. These bytes came from a node in this tab, so calling
   * `recordGatewayReachable` would end the manifest side's backoff on evidence about something else,
   * and a viewer whose gateway had genuinely gone would keep asking it at full rate while believing it
   * was live. The feed and the manifest still travel through the gateway on this path.
   *
   * ⚠️ The stats below are the only timing a weeb-3 segment has. There is no network request for the
   * browser's request log or a performance entry to describe, so a harness comparing the two backends
   * reads this, and it has to be filled in rather than left at its zeroes.
   */
  private retrieveThroughWeeb3(context: FragmentLoaderContext, callbacks: LoaderCallbacks<LoaderContext>): void {
    const ref = segmentRefFromUrl(context.url);
    if (!ref) {
      // ⛔ Before the callback, for the reason written out at the url check in {@link load}: hls.js
      // destroys this loader from inside its own `onError`, re-entrantly, and that re-entrancy is what
      // decides whether this refusal reads as `errored` or as `aborted`.
      this.recordSettle(FRAGMENT_ERRORED);
      callbacks.onError(
        { code: 0, text: `fragment url carries no Swarm reference: ${context.url}` },
        context,
        undefined,
        this.stats,
      );
      return;
    }

    const stats = this.stats;
    stats.loading.start = performance.now();

    // Both arms below end the attempt, whatever hls.js does in the meantime, so {@link abandon} leaves
    // this one alone rather than stamping it at the teardown.
    this.retrievalOutstanding = true;

    weeb3FetchBackend.retrieveBytes(ref).then(
      (bytes) => {
        if (this.abandoned) {
          // ⭐ Settled here rather than at the abort, because this is when the retrieval actually
          // finished. `retrieveBytes` takes no abort signal, so an abandoned fragment keeps costing the
          // node until it answers, and an arm that stamped the ending at the abort would report that
          // work as free.
          this.recordSettle(FRAGMENT_ABORTED);
          return;
        }
        // ⛔⛔⛔ **`first` is the start, not the arrival, and that one line is the whole of hls.js's
        // ABR on this path.** hls.js excludes time-to-first-byte from its bandwidth maths on purpose,
        // because waiting is not throughput. It samples `parsing.end - loading.start - min(first -
        // start, estimatedTtfb)` against the byte count (`AbrController.onFragBuffered`, hls.js
        // 1.6.15) and feeds `first - start` straight into that TTFB estimate from `onFragLoaded`.
        // Stamping `first` at arrival told it the entire retrieval was latency and the download itself
        // was the millisecond of demuxing left over, so it divided half a megabyte by about three
        // milliseconds and believed the viewer had 74 to 109 Mbps. Measured live 2026-08-30, n=3: an
        // in-tab viewer rode 1080p through a link capped at 2800 kbps while its picture ran at 0.55 of
        // real time, and never stepped down, because on those numbers 1080p was affordable.
        //
        // A weeb-3 retrieval has no observable split between waiting and transferring, since the bytes
        // appear at once. Charging all of it to transfer is the conservative half of that ignorance:
        // it can only under-state the connection, and a viewer who under-states their connection
        // watches a lower rung rather than a frozen one.
        stats.loading.first = stats.loading.start;
        stats.loading.end = performance.now();
        stats.loaded = bytes.byteLength;
        stats.total = bytes.byteLength;
        this.recordSettle(FRAGMENT_LOADED);
        callbacks.onSuccess({ url: context.url, data: asArrayBuffer(bytes), code: 200 }, stats, context, undefined);
      },
      (error: unknown) => {
        if (this.abandoned) {
          this.recordSettle(FRAGMENT_ABORTED);
          return;
        }
        this.recordSettle(FRAGMENT_ERRORED);
        callbacks.onError(
          { code: 0, text: `weeb-3 could not retrieve ${ref}: ${errorText(error)}` },
          context,
          undefined,
          stats,
        );
      },
    );
  }
}

/** One fragment's one attempt, as both halves of the instrument have to name it. */
interface FragmentAttempt {
  level: number | string;
  sn: number | string;
  /**
   * `performance.now`, which is monotonic, so an NTP step mid-broadcast cannot write a duration that
   * never happened. It is also the clock the loading stats a few lines away are already stamped from.
   *
   * ⛔ This carries no clock identity and needs none. An elapsed is a difference within one clock
   * whatever the clock is, and the older wall-clock reading here claimed to let a reader add it to a
   * harness timestamp, which was never true of a duration and is not what any reader does: the harness
   * stamps each line as it hears it. The reader keeps its tolerance of a duration it cannot parse all
   * the same, because losing an outcome to an unreadable number is the one thing it must never do.
   */
  askedAtMs: number;
}

/**
 * Read the fragment's address once, at the moment hls.js asked for it.
 *
 * ⭐ Once rather than per line, because the endings do not all carry the fragment. An abort arrives as
 * stats and a context, and a cancelled stagger arrives as nothing, so a settle that went looking for
 * `context.frag` would name the level for some endings and not others.
 *
 * ⛔ Never null, however unreadable the fragment is. A missing attempt would mean no settle line at
 * all, and a request with no ending is the exact ambiguity this pair exists to remove.
 */
function attemptBegun(context: FragmentLoaderContext): FragmentAttempt {
  const askedAtMs = performance.now();
  // `context.frag` is required by hls.js's own types and is absent in every unit test that drives this
  // loader directly, which is a shape a future hls.js could arrive in as well.
  try {
    const frag: Fragment | undefined = context.frag;
    return { level: frag?.level ?? CLIENT_LOG_UNKNOWN, sn: frag?.sn ?? CLIENT_LOG_UNKNOWN, askedAtMs };
  } catch {
    return { level: CLIENT_LOG_UNKNOWN, sn: CLIENT_LOG_UNKNOWN, askedAtMs };
  }
}

/**
 * Announce which level hls.js has just asked for a fragment of.
 *
 * ⛔ **An instrument, and only an instrument.** Nothing below reads it, no fragment waits on it and no
 * branch in this loader depends on it. `clientLog.ts` owns the wording, which the e2e harness parses.
 *
 * ⭐ **At the top of `load`, above every branch.** hls.js builds a loader per fragment and calls
 * `load` once per attempt, so one line here is one line per attempt. It sits above the url check and
 * above the byte-source split on purpose: the question is which level was ASKED for, and a line
 * placed after either branch would answer it only for the fragments that got past that branch. The
 * two backends record identically, which is the whole basis for reading one arm against the other.
 *
 * ⚠️ This is the only place the level index is observable at all. The shipped overlay reports what
 * was decoded, what ABR would pick next and what the player believes it can afford, and none of the
 * three says which rung the fragments in flight belong to.
 */
function recordFragmentRequest(attempt: FragmentAttempt, context: FragmentLoaderContext): void {
  // A logging line must never cost a fragment.
  try {
    console.debug(fragmentRequested(attempt.level, attempt.sn, rungOf(context)));
  } catch {
    // Silent by design. A viewer whose console throws still has to get their video.
  }
}

/**
 * The rung this fragment belongs to, which is its own playlist's address.
 *
 * ⛔ **Not the fragment url, which names no rung.** Every segment this client plays is
 * `<gateway>/bytes/<reference>` and a Swarm reference says nothing about which rendition produced it.
 * `baseurl` is the level playlist the fragment was parsed out of, `swarm://<owner>/<topic>`, and the
 * topic is the rung's identity everywhere else in this project.
 *
 * Guarded on its own rather than left to the caller's catch. It is a getter over a field hls.js sets,
 * so it is the one part of the line that can throw, and losing the level index because the rung was
 * unreadable would silence the reading this exists for.
 */
function rungOf(context: FragmentLoaderContext): string {
  try {
    return context.frag?.baseurl || CLIENT_LOG_UNKNOWN;
  } catch {
    return CLIENT_LOG_UNKNOWN;
  }
}

/**
 * hls.js demuxes an `ArrayBuffer`, and wasm hands back a view.
 *
 * Copied only when the view is a window onto something larger, because handing over the whole backing
 * buffer would give hls.js bytes either side of the segment.
 */
function asArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const buffer = bytes.buffer as ArrayBuffer;
  if (bytes.byteOffset === 0 && bytes.byteLength === buffer.byteLength) {
    return buffer;
  }
  return buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
