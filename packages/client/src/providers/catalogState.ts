import { Stream } from '@/types/stream';
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
}

/** The streams on screen and the gateway that served them, held together so they cannot disagree. */
export interface StreamCatalog {
  streams: Stream[];
  /** Null before any read has landed. */
  gateway: string | null;
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

    return {
      streams:
        nextStreamList({ held: held.streams, fetched: read.streams, isSameGateway: held.gateway === read.gateway }) ??
        held.streams,
      gateway: read.gateway,
    };
  };
}
