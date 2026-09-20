import { type MediaType, type Rendition, type Stream } from '@/types/stream';

export interface PlaybackRoute {
  owner: string;
  topicString: string;
  mediaType: MediaType;
}

export interface PlaybackInputs extends PlaybackRoute {
  renditions: Rendition[] | undefined;
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
  private selected: PlaybackInputs | null = null;

  constructor(private readonly route: PlaybackRoute) {}

  get current(): PlaybackInputs | null {
    return this.selected;
  }

  select(stream: Stream | undefined): PlaybackInputs {
    if (this.selected === null) {
      this.selected = {
        ...this.route,
        // Catalogue objects are replaced and may also be updated in place by a caller. Copy each
        // rung, rather than retaining only the array identity, so the mounted player keeps the
        // master/rung inputs it actually started with.
        renditions: stream?.renditions?.map((rendition) => ({ ...rendition })),
      };
    }

    return this.selected;
  }
}
