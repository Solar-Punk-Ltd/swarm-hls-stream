/**
 * Reading a set of runs as a grid, and answering the one question the bench could never answer alone:
 * how small the player's live buffer can be.
 *
 * `playerConfig.ts` carries `LIVE_SYNC_DURATION_S = 10` and its own note says why it had not been
 * cut: the per-hop split was unusable, and five samples is not a spread. LAT-9 closed the first, and
 * a sweep closes the second, so the number is finally answerable from data instead of from caution.
 */

/** One measured segment, reduced to the two quantities the buffer question needs. */
export interface BufferSample {
  totalMs: number;
  segmentMs: number;
}

/**
 * The smallest live buffer that would not have stalled on these samples.
 *
 * Derived rather than guessed. A player holding playback `B` behind the live edge needs segment `i`'s
 * media by the wall-clock instant its own playback reaches the end of it. Playing at 1x from some
 * start `(t0, m0)`, that instant is `t0 + (mediaEnd[i] - m0)`, and the segment is fetchable at
 * `fetchedAtMs[i]`. Writing `k = t0 - m0`, which is the latency playback actually runs at, no stall
 * requires `k >= fetchedAtMs[i] - mediaEnd[i]` for every segment.
 *
 * `mediaEnd[i]` is `capturedAtMs[i] + segmentMs`, so that bound is exactly `totalMs - segmentMs`, the
 * same term `viewerLatencyMs` subtracts. The live edge is the newest segment's **last** frame while
 * the total is anchored on its **first**, which is why the segment comes out and not in.
 *
 * **This is a lower bound over what was observed, not a safe setting.** A slower segment than any
 * here stalls a player configured at exactly this. Add `pollIntervalMs` for the cadence a real client
 * asks at, and a margin, which `recommendBufferMs` does.
 */
export function minimumSafeBufferMs(samples: readonly BufferSample[]): number {
  if (samples.length === 0) {
    throw new Error('no samples, so nothing bounds the buffer');
  }
  return Math.max(...samples.map((sample) => sample.totalMs - sample.segmentMs));
}

export interface BufferRecommendation {
  /** The largest edge-to-fetchable delay observed, which is the hard floor. */
  observedFloorMs: number;
  /** That floor plus the client's poll cadence and a margin. */
  recommendedMs: number;
  /** How many samples the floor was taken across, since a floor over few samples is a weak one. */
  samples: number;
  /** The margin applied, carried so a reader can re-derive the recommendation. */
  marginMs: number;
}

/**
 * A buffer to actually configure, from the observed floor.
 *
 * The margin is one segment rather than a percentage. What the buffer absorbs is a segment arriving
 * later than any that was measured, and the natural unit of "one late arrival" is a segment: a
 * percentage would shrink the allowance exactly where segments are short and arrivals are most
 * frequent.
 *
 * `pollIntervalMs` is added because the floor is when a segment became fetchable, while a player
 * learns of it on its next poll, so a client asking every `pollIntervalMs` can be that much later
 * than the instant measured here.
 */
export function recommendBufferMs(
  samples: readonly BufferSample[],
  pollIntervalMs: number,
  segmentMs: number,
): BufferRecommendation {
  const observedFloorMs = minimumSafeBufferMs(samples);
  const marginMs = segmentMs;
  return {
    observedFloorMs,
    recommendedMs: observedFloorMs + pollIntervalMs + marginMs,
    samples: samples.length,
    marginMs,
  };
}

/** One measured segment, reduced to what the delivery question needs. */
export interface DeliverySample {
  /** Video PES packets found in the segment's bytes, which for this encode is one per frame. */
  videoPacketCount: number;
  segmentMs: number;
  fps: number;
}

export interface FrameDelivery {
  /** Median share of the expected frames that arrived, across the samples. */
  medianRatio: number;
  /** The single worst segment, since one gap is a visible glitch a median absorbs. */
  worstRatio: number;
}

/**
 * Whether a viewer gets the frame rate the publisher was asked for.
 *
 * Frames present in the segment against `fps x segment`, as a ratio so a half-second row is not
 * scored against a four-second one and a deliberately lower frame rate is not read as a fault.
 *
 * **It falls below 1 for two different reasons and does not distinguish them**, which is why it is
 * named for the symptom. Both were measured on 2026-08-03 and both are invisible to every latency
 * column, because a thin segment is cut, uploaded and served on entirely ordinary timings:
 *
 * - Frames lost in transit. Publishing from a workstation put about 15% of SRT packets on the floor,
 *   and segments arrived carrying 14 to 24 video frames where 60 were sent.
 * - Frames never produced. Three 1080p runs at 6000kbps emitted 30 frames over 1.6 to 2.0 seconds,
 *   so the segment stretched to fit a GOP that took too long to fill and the stream ran at 15 to
 *   18fps. The manifest agreed with the bytes, and `ffmpeg` alone reaches 76fps at those settings, so
 *   it was contention on the publish path rather than the encoder's capacity.
 *
 * Telling them apart needs the publisher's own frame count, which the bench does not collect. What
 * this answers is the question a viewer would ask, and a run it flags is worth opening.
 */
export function frameDelivery(samples: readonly DeliverySample[]): FrameDelivery {
  const ratios = samples.map((sample) => {
    if (sample.segmentMs <= 0) {
      throw new Error('a segment with no duration expects no frames, so its delivery has no meaning');
    }
    return sample.videoPacketCount / (sample.fps * (sample.segmentMs / 1_000));
  });
  return { medianRatio: median(ratios), worstRatio: Math.min(...ratios) };
}

/**
 * How far the worst arrival sat above the typical one.
 *
 * {@link minimumSafeBufferMs} takes the worst sample, because one stall is a stall, and that makes it
 * the right number to configure and the wrong one to judge a setting by: it cannot distinguish a
 * setting whose arrivals cluster from one that is usually quick and occasionally very slow. Two rows
 * with the same median can demand very different buffers, and this is the difference.
 */
export function arrivalTailMs(samples: readonly BufferSample[]): number {
  const delays = samples.map((sample) => sample.totalMs - sample.segmentMs);
  return Math.max(...delays) - median(delays);
}

/** Every run taken at one setting, collapsed into the row a grid prints. */
export interface GridRow {
  label: string;
  runs: number;
  samples: number;
  medianTotalMs: number;
  minTotalMs: number;
  maxTotalMs: number;
  /** Median of each hop across every sample at this setting. */
  hopMs: Record<string, number>;
  /**
   * Median absolute clock skew across the runs, which is the only thing the artifact records that
   * says where the publisher ran. On the deployment host it measured 3ms and from a workstation
   * 157ms, so a row mixing the two is comparing two networks rather than two settings.
   */
  skewMs: number;
  /** What a viewer would sit behind live here, at the buffer this setting can support. */
  buffer: BufferRecommendation;
  /** Whether the picture that arrived is the picture that was published. */
  delivery: FrameDelivery;
  /** How far the worst arrival sat above the typical one, which is what the buffer has to absorb. */
  tailMs: number;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) {
    throw new Error('no values to take a median of');
  }
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)];
}
