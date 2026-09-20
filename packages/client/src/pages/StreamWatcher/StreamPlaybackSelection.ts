import { type CompletedRecording, type MediaType, type Rendition, type Stream } from '@/types/stream';

interface PlaybackRoute {
  owner: string;
  topicString: string;
  mediaType: MediaType;
}

interface PlaybackInputs extends PlaybackRoute {
  kind: 'live';
  session: number;
  runNumber: number | undefined;
  renditions: Rendition[] | undefined;
  /** The completed bytes that close this selected live run without remounting its player. */
  pinnedRecording: CompletedRecording | undefined;
}

interface ReplayPlaybackInputs extends PlaybackRoute {
  kind: 'replay';
  session: number;
  runNumber: number;
  completedRecording: CompletedRecording;
  renditions: undefined;
}

type SelectedPlayback = PlaybackInputs | ReplayPlaybackInputs;

function copyCompletedRecording(recording: CompletedRecording): CompletedRecording {
  return {
    ...recording,
    master: { ...recording.master },
    expectedRenditions: [...recording.expectedRenditions],
    renditions: recording.renditions.map((rendition) => ({ ...rendition })),
  };
}

function hasCompletedRecording(
  stream: Stream | undefined,
): stream is Stream & { completedRecording: CompletedRecording } {
  const recording = stream?.completedRecording;
  return (
    recording !== undefined &&
    typeof recording.master?.reference === 'string' &&
    recording.renditions.every((rendition) => typeof rendition.reference === 'string')
  );
}

function isCurrentRun(stream: Stream | undefined): stream is Stream & { lifecycle: NonNullable<Stream['lifecycle']> } {
  return stream?.lifecycle?.version === 1 && ['live', 'waiting'].includes(stream.lifecycle.state);
}

function hasDifferentReplay(
  selected: SelectedPlayback | null,
  stream: Stream | undefined,
): stream is Stream & { completedRecording: CompletedRecording } {
  return (
    hasCompletedRecording(stream) &&
    (selected?.kind !== 'replay' || selected.runNumber !== stream.completedRecording.runNumber)
  );
}

/**
 * The player inputs chosen for one mounted watch page.
 *
 * The catalogue keeps polling after playback begins. Its entries describe the current broadcast,
 * so adopting a refreshed entry here could turn a viewer's replay into a live player. The route
 * boundary creates one of these for each intentional navigation and holds the first completed
 * catalogue lookup, including the legacy direct-playback case where no row exists.
 */
export class StreamPlaybackSelection {
  private selected: SelectedPlayback | null = null;
  private nextSession = 1;

  constructor(private readonly route: PlaybackRoute) {}

  get current(): SelectedPlayback | null {
    return this.selected;
  }

  select(stream: Stream | undefined): SelectedPlayback {
    if (this.selected === null) {
      this.selected = isCurrentRun(stream) || !hasCompletedRecording(stream) ? this.live(stream) : this.replay(stream);
    } else if (
      this.selected.kind === 'live' &&
      this.selected.runNumber !== undefined &&
      hasCompletedRecording(stream) &&
      stream.completedRecording.runNumber === this.selected.runNumber &&
      this.selected.pinnedRecording === undefined
    ) {
      this.selected = { ...this.selected, pinnedRecording: copyCompletedRecording(stream.completedRecording) };
    }

    return this.selected;
  }

  watchLive(stream: Stream | undefined): SelectedPlayback {
    if (isCurrentRun(stream) && this.selected?.runNumber !== stream.lifecycle.runNumber) {
      this.selected = this.live(stream);
    }
    return this.selected ?? this.select(stream);
  }

  watchReplay(stream: Stream | undefined): SelectedPlayback {
    if (hasDifferentReplay(this.selected, stream)) {
      this.selected = this.replay(stream);
    }
    return this.selected ?? this.select(stream);
  }

  private live(stream: Stream | undefined): PlaybackInputs {
    return {
      ...this.route,
      kind: 'live',
      session: this.nextSession++,
      runNumber: isCurrentRun(stream) ? stream?.lifecycle?.runNumber : undefined,
      // Catalogue objects are replaced and may also be updated in place by a caller. Copy each
      // rung, rather than retaining only the array identity, so the mounted player keeps the
      // master/rung inputs it actually started with.
      renditions: stream?.renditions?.map((rendition) => ({ ...rendition })),
      pinnedRecording: undefined,
    };
  }

  private replay(stream: Stream & { completedRecording: CompletedRecording }): ReplayPlaybackInputs {
    return {
      ...this.route,
      kind: 'replay',
      session: this.nextSession++,
      runNumber: stream.completedRecording.runNumber,
      completedRecording: copyCompletedRecording(stream.completedRecording),
      renditions: undefined,
    };
  }
}
