import { parseManifest, ManifestStateManager, ManifestFetcher } from '../packages/client/src/components/SwarmHlsPlayer/ManifestManagement.ts'

const parsed = parseManifest('#EXTM3U\n#EXT-X-TARGETDURATION:4\n#EXTINF:4.000,\nseg0.ts\n')
console.log('parseManifest ->', JSON.stringify(parsed.segments))
const sm = ManifestStateManager.getInstance()
sm.updateManifest('t', parsed.headers, parsed.segments, false)
console.log('serialize     ->', JSON.stringify(sm.serialize('t', 'http://bee/bytes')))
console.log('fetcher built ->', new ManifestFetcher().beeUrl)
