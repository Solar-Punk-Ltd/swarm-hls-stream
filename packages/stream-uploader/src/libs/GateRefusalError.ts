/**
 * A startup gate's refusal, carrying which node it was about.
 *
 * ## Why the node is on the error
 *
 * A gate's message names the node in prose, which is right for a person reading a log and useless to
 * anything that has to act on it. `waitForNode` is such a caller: it publishes which node the boot is
 * waiting for, and on a pool of four the node it was handed is the coordinator while the refusal that
 * ended the pass may be about the 1080p rung. A `/health` payload naming a coordinator that is
 * answering sends an operator to the machine that is working.
 *
 * ⛔ `nodeUrl` arrives with any credential already stripped, because it is published. The gates strip
 * it through the same `safeUrl` the pool's routing block answers with, so what reaches an
 * unauthenticated reader is what the `publishers` block already tells them.
 */
export class GateRefusalError extends Error {
  constructor(message: string, readonly nodeUrl: string) {
    super(message);
    this.name = 'GateRefusalError';
  }
}
