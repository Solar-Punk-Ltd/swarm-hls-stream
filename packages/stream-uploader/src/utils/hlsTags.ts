// The tags moved to the shared package when the client stopped keeping its own spelling of them.
// Kept as a re-export so ManifestManager and the engine-side playlist parsers keep their existing
// import path. See ARCH-1.
export {
  HLS_DISCONTINUITY,
  HLS_ENDLIST,
  HLS_EXTINF,
  HLS_M3U,
  HLS_MEDIA_SEQUENCE,
  HLS_PLAYLIST_TYPE,
  HLS_PLAYLIST_TYPE_VOD,
  HLS_PROGRAM_DATE_TIME,
  HLS_STREAM_INF,
  HLS_TARGET_DURATION,
  HLS_VERSION,
} from '@swarm-hls-stream/shared';
