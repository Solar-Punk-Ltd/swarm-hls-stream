/**
 * This service's own word that a Bee node is not answering, as opposed to a transport error.
 *
 * ## Why a class rather than a message
 *
 * `isNodeUnavailable` reads a failure that arrived from somewhere else: a code from the socket, a
 * status from the node, or the text a gate wrapped around either. That reading is evidence, and it is
 * as narrow as it can be made, because everything it does not recognise ends the boot.
 *
 * This is the other direction. Two places in the boot establish the same fact themselves and have no
 * error to hand on: the reachability probe in front of the gates, which asked the node and was told
 * no, and `StreamCatalog.init`, which got a 503 for a feed head from a node that does not report
 * itself ready. Throwing a plain `Error` there would leave them phrasing a sentence in the hope the
 * classifier matches it, which is a coupling nobody would notice breaking.
 */
export class NodeUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NodeUnreachableError';
  }
}
