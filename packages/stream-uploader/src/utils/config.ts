import { optional, optionalInt, required } from './env.js';

export const config = {
  beeUrl: required('BEE_URL'),
  stamp: required('STAMP'),
  streamKey: required('STREAM_KEY'),
  streamListTopic: required('STREAM_LIST_TOPIC'),
  manifestAccessUrl: optional('MANIFEST_ACCESS_URL', ''),
  // Zero is a real port here: it asks the OS for an ephemeral one. Every other floor is 1, because
  // zero would disable the thing the variable configures rather than tune it.
  apiPort: optionalInt('API_PORT', 3000, { min: 0, max: 65535 }),
  stateDir: optional('STATE_DIR', './state'),
  maxQueueSize: optionalInt('MAX_QUEUE_SIZE', 100, { min: 1 }),
  recoveryTimeout: optionalInt('RECOVERY_TIMEOUT', 60000, { min: 1 }),
  segmentStallMs: optionalInt('SEGMENT_STALL_MS', 30000, { min: 1 }),
  engine: optional('ENGINE', ''),
};
