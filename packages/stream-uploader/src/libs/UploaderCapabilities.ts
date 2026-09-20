import { MEDIA_TYPE_AUDIO, MEDIA_TYPE_VIDEO } from '../types.js';

import { AbrLadder } from './AbrLadder.js';
import { UploaderCapabilities } from './AdminApiClient.js';

/** The exact shapes this process can accept under lifecycle-v1 enrollment. */
export function buildUploaderCapabilities(ladder?: AbrLadder): UploaderCapabilities {
  const renditions = (ladder?.rungs() ?? [])
    .map((rung) => ({
      name: rung.name,
      width: rung.width,
      height: rung.height,
      bandwidth: rung.configuredKbps * 1_000,
      avgBandwidth: rung.configuredKbps * 1_000,
    }))
    .sort((left, right) => left.name.localeCompare(right.name));
  return {
    lifecycleVersion: 1,
    capabilities: { durableCheckpointStore: 1, legacyRecordingAdoption: 1 },
    profiles: [
      { mediaType: MEDIA_TYPE_VIDEO, renditions },
      { mediaType: MEDIA_TYPE_AUDIO, renditions: [] },
    ],
  };
}
