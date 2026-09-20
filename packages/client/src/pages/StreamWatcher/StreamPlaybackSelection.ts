import {
  type CompletedRecording,
  type MediaType,
  type Rendition,
  type Stream,
} from '@/types/stream';

export interface PlaybackRoute {
  owner: string;
  topicString: string;
  mediaType: MediaType;
}

export interface PlaybackInputs extends PlaybackRoute {
  kind: 'live';
  session: number;
  renditions: Rendition[] | undefined;
}

export interface ReplayPlaybackInputs extends PlaybackRoute {
  kind: 'replay';
  session: number;
  completedRecording: CompletedRecording;
  renditions: undefined;
}

export type SelectedPlayback = PlaybackInputs | ReplayPlaybackInputs;

function copyCompletedRecording(recording: CompletedRecording): CompletedRecording {
  return {
    ...recording,
    master: { ...recording.master },
    expectedRenditions: [...recording.expectedRenditions],
    renditions: recording.renditions.map((rendition) => ({ ...rendition })),
  };
}

function hasCompletedRecording(stream: Stream | undefined): stream is Stream & { completedRecording: CompletedRecording } {
  const recording = stream?.completedRecording;
  return (
    recording !== undefined &&
    typeof recording.master?.reference === 'string' &&
    recording.renditions.every((rendition) => typeof rendition.reference === 'string')
  );
}

function isCurrentRun(stream: Stream | undefined): boolean {
  return stream?.lifecycle?.version === 1 && ['live', 'waiting'].includes(stream.lifecycle.state);
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
    }

    return this.selected;
  }

  watchLive(stream: Stream | undefined): SelectedPlayback {
    if (isCurrentRun(stream) && this.selected?.kind !== 'live') {
      this.selected = this.live(stream);
    }
    return this.selected ?? this.select(stream);
  }

  watchReplay(stream: Stream | undefined): SelectedPlayback {
    if (hasCompletedRecording(stream) && this.selected?.kind !== 'replay') {
      this.selected = this.replay(stream);
    }
    return this.selected ?? this.select(stream);
  }

  private live(stream: Stream | undefined): PlaybackInputs {
    return {
      ...this.route,
      kind: 'live',
      session: this.nextSession++,
      // Catalogue objects are replaced and may also be updated in place by a caller. Copy each
      // rung, rather than retaining only the array identity, so the mounted player keeps the
      // master/rung inputs it actually started with.
      renditions: stream?.renditions?.map((rendition) => ({ ...rendition })),
    };
  }

  private replay(stream: Stream & { completedRecording: CompletedRecording }): ReplayPlaybackInputs {
    return {
      ...this.route,
      kind: 'replay',
      session: this.nextSession++,
      completedRecording: copyCompletedRecording(stream.completedRecording),
      renditions: undefined,
    };
  }
}
