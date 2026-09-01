import { FeedIndex, Identifier, Topic } from '@ethersphere/bee-js';
import { Binary } from 'cafe-utility';

export function makeFeedIdentifier(topic: Topic, index: FeedIndex): Identifier {
  return new Identifier(Binary.keccak256(Binary.concatBytes(topic.toUint8Array(), index.toUint8Array())));
}

/** The index a `/feeds/` lookup resolved to, which is where a sequential walk has to start. */
export function extractFeedIndex(response: Response): FeedIndex {
  const hex = response.headers.get('Swarm-Feed-Index');
  if (!hex) {
    throw new Error('Missing feed index header');
  }
  return FeedIndex.fromBigInt(BigInt(`0x${hex}`));
}
