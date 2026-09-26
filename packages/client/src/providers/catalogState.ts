import { Stream } from '@/types/stream';
import type { CatalogSnapshot } from '@/utils/catalogFeed';
import { nextStreamList } from '@/utils/catalogList';

/**
 * One catalog read, carrying the gateway it went to.
 *
 * The gateway travels with the body because a viewer can switch nodes while a read is in flight.
 * Without that identity, the response could be presented as the selected node's catalog.
 */
export interface CatalogRead {
  gateway: string;
  /** The parsed catalog, or null when the gateway had nothing newer to give. */
  streams: unknown;
  /** The feed slot {@link streams} was read from, or null without a body or when the gateway did not say. */
  slot: bigint | null;
}

/** What one poll of `gateway` hands to the stream list, from what the catalog reader returned. */
export function toCatalogRead(gateway: string, snapshot: CatalogSnapshot | null): CatalogRead {
  if (snapshot === null) {
    return { gateway, streams: null, slot: null };
  }
  return { gateway, streams: JSON.parse(snapshot.body), slot: snapshot.slot };
}

/**
 * The streams on screen, the gateway that served them and the feed slot they were read from, held
 * together so they cannot disagree.
 */
export interface StreamCatalog {
  streams: Stream[];
  /** Null before any read has landed. */
  gateway: string | null;
  /**
   * The feed slot {@link streams} was read from, which the next read on the same gateway has to be
   * newer than. Null before any read has landed, and when the gateway did not say.
   */
  slot: bigint | null;
}

interface SelectedGatewayRef {
  current: string;
}

/**
 * Build the functional state update for one catalog response.
 *
 * The selected gateway is read when React applies the update. A response can finish before a switch
 * but remain queued until after it, so checking when this function is created would still let the
 * old gateway replace the selected gateway's catalog.
 */
export function catalogUpdater(
  read: CatalogRead,
  selectedGateway: SelectedGatewayRef,
): (held: StreamCatalog) => StreamCatalog {
  return (held) => {
    if (read.gateway !== selectedGateway.current) {
      return held;
    }

    const streams = nextStreamList({
      held: held.streams,
      heldSlot: held.slot,
      fetched: read.streams,
      fetchedSlot: read.slot,
      isSameGateway: held.gateway === read.gateway,
    });

    return streams === null
      ? { streams: held.streams, gateway: read.gateway, slot: held.slot }
      : { streams, gateway: read.gateway, slot: read.slot };
  };
}
