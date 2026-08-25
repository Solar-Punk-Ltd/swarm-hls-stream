// One definition, in the shared package, because the client builds the same master playlist as a
// fallback for catalog entries written before masters were published, and a viewer can meet both in
// one session. The two used to be byte-identical copies, each carrying a comment saying they had to
// stay that way. Re-exported here rather than imported at every call site so the move stays
// invisible to the rest of the package. See ARCH-1.
export { buildMasterPlaylist, buildSwarmUri, SWARM_SCHEME } from '@swarm-hls-stream/shared';
