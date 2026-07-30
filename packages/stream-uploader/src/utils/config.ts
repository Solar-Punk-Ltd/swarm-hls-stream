import { optional, optionalInt, required } from './env.js';

export const config = {
  beeUrl: required('BEE_URL'),
  stamp: required('STAMP'),
  streamKey: required('STREAM_KEY'),
  streamListTopic: required('STREAM_LIST_TOPIC'),
  manifestAccessUrl: optional('MANIFEST_ACCESS_URL', ''),
  apiPort: optionalInt('API_PORT', 3000),
  stateDir: optional('STATE_DIR', './state'),
  maxQueueSize: optionalInt('MAX_QUEUE_SIZE', 100),
  recoveryTimeout: optionalInt('RECOVERY_TIMEOUT', 60000),
  segmentStallMs: optionalInt('SEGMENT_STALL_MS', 30000),
  engine: optional('ENGINE', ''),
};
