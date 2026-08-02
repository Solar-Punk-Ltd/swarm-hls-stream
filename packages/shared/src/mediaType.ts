export const MEDIA_TYPE_AUDIO = 'audio' as const;
export const MEDIA_TYPE_VIDEO = 'video' as const;

export type MediaType = typeof MEDIA_TYPE_AUDIO | typeof MEDIA_TYPE_VIDEO;
