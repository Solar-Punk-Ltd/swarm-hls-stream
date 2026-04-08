export const MEDIA_TYPE_AUDIO = 'audio' as const;
export const MEDIA_TYPE_VIDEO = 'video' as const;

export type MediaType = typeof MEDIA_TYPE_AUDIO | typeof MEDIA_TYPE_VIDEO;

export type StreamState = 'live' | 'vod';

export interface Stream {
  owner: string;
  topic: string;
  state?: StreamState;
  duration?: string;
  index?: number;
  timestamp: number;
  mediatype: MediaType;
  title: string;
}
