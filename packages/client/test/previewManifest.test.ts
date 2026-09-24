import { buildMasterPlaylist, type Rendition } from '@swarm-hls-stream/shared';
import { describe, expect, it } from 'vitest';

import { fetchPreviewManifest, type PreviewEntry, rungSlotsKey } from '@/components/StreamPreview/previewManifest';
import { STREAM_STATUS_LIVE, STREAM_STATUS_VOD } from '@/types/stream';
import { thumbnailManifestUrl } from '@/utils/thumbnailManifest';

/**
 * Which playlists a stream card reads to find its first frame.
 *
 * ⛔ The card that stayed blank, 2026-09-24 on the tester's viewer: a 10.1 hour ladder recording.
 * Its catalog entry names the master's final slot, and the card read that directly, then read the
 * first rung's playlist by a head lookup. A head lookup searches the feed for its newest update and
 * grows with the feed, and on a feed that long it outlasted the preview's 10 second limit, while
 * the entry already named the rung's final slot in `Rendition.index`.
 *
 * These assert on the URLs asked for, because the URL is the change.
 */

const GATEWAY = 'http://gw';
const OWNER = '1f6e0f8a9b7c3d5e2a4b6c8d0e1f2a3b4c5d6e7f';
const LADDER_TOPIC = 'a-finished-ladder';
const RUNG_360 = 'a-finished-ladder-360p';
const RUNG_720 = 'a-finished-ladder-720p';
const MASTER_SLOT = 842;
const SLOT_360 = 18219;
const SLOT_720 = 18220;

function rendition(name: string, topic: string, index?: number): Rendition {
  return { name, width: 640, height: 360, topic, bandwidth: 800_000, avgBandwidth: 700_000, index };
}

/** The master names 360p first, the rung a card reads. */
const MASTER = buildMasterPlaylist(OWNER, [rendition('360p', RUNG_360), rendition('720p', RUNG_720)]);
const RUNG_PLAYLIST = ['#EXTM3U', '#EXT-X-VERSION:3', '#EXT-X-TARGETDURATION:2', '#EXTINF:2.0,', 'a'.repeat(64)].join(
  '\n',
);

interface Recorded {
  asked: string[];
  fetcher: typeof fetch;
}

/** A gateway answering the master at the entry's own address and a rung playlist anywhere else. */
function gateway(entry: PreviewEntry): Recorded {
  const masterUrl = thumbnailManifestUrl(GATEWAY, entry.owner, entry.topic, entry.index);
  const asked: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    const url = String(input);
    asked.push(url);
    return new Response(url === masterUrl ? MASTER : RUNG_PLAYLIST, { status: 200 });
  }) as typeof fetch;
  return { asked, fetcher };
}

async function rungUrlAskedFor(entry: PreviewEntry): Promise<string> {
  const { asked, fetcher } = gateway(entry);
  const { segments } = await fetchPreviewManifest(GATEWAY, entry, new AbortController().signal, fetcher);

  expect(asked).toHaveLength(2);
  expect(segments).toHaveLength(1);
  return asked[1];
}

describe('fetchPreviewManifest on a ladder', () => {
  /**
   * Listed out of master order on purpose, so the rung is found by the topic the master names rather
   * than by its position in the entry.
   */
  it('reads a finished ladder rung at the slot its catalog entry recorded', async () => {
    const url = await rungUrlAskedFor({
      owner: OWNER,
      topic: LADDER_TOPIC,
      index: MASTER_SLOT,
      state: STREAM_STATUS_VOD,
      renditions: [rendition('720p', RUNG_720, SLOT_720), rendition('360p', RUNG_360, SLOT_360)],
    });

    expect(url).toBe(thumbnailManifestUrl(GATEWAY, OWNER, RUNG_360, SLOT_360));
    expect(url).toContain('/soc/');
  });

  /** A live rung is still being written, so a slot would name an old playlist rather than the newest. */
  it('keeps the head lookup for a live ladder', async () => {
    const url = await rungUrlAskedFor({
      owner: OWNER,
      topic: LADDER_TOPIC,
      state: STREAM_STATUS_LIVE,
      renditions: [rendition('360p', RUNG_360, SLOT_360), rendition('720p', RUNG_720)],
    });

    expect(url).toBe(thumbnailManifestUrl(GATEWAY, OWNER, RUNG_360));
    expect(url).toContain('/feeds/');
  });

  /** The admin's own entry can list a rung that never recorded, with no index to give. */
  it('keeps the head lookup for a finished rung the entry names no slot for', async () => {
    const url = await rungUrlAskedFor({
      owner: OWNER,
      topic: LADDER_TOPIC,
      index: MASTER_SLOT,
      state: STREAM_STATUS_VOD,
      renditions: [rendition('360p', RUNG_360), rendition('720p', RUNG_720, SLOT_720)],
    });

    expect(url).toBe(thumbnailManifestUrl(GATEWAY, OWNER, RUNG_360));
  });

  /** An entry written before rungs carried their slots lists no renditions to read one from. */
  it('keeps the head lookup for a finished entry with no renditions listed', async () => {
    const url = await rungUrlAskedFor({
      owner: OWNER,
      topic: LADDER_TOPIC,
      index: MASTER_SLOT,
      state: STREAM_STATUS_VOD,
    });

    expect(url).toBe(thumbnailManifestUrl(GATEWAY, OWNER, RUNG_360));
  });
});

/** What the card's effect reacts to in place of the renditions array the catalog poll replaces. */
describe('rungSlotsKey', () => {
  const finished = (slot360: number) => ({
    state: STREAM_STATUS_VOD,
    renditions: [rendition('360p', RUNG_360, slot360), rendition('720p', RUNG_720, SLOT_720)],
  });

  it('stays the same for a fresh array naming the same slots, so a catalog poll does not refetch', () => {
    expect(rungSlotsKey(finished(SLOT_360))).toBe(rungSlotsKey(finished(SLOT_360)));
  });

  it('changes when a rung slot changes', () => {
    expect(rungSlotsKey(finished(SLOT_360 + 1))).not.toBe(rungSlotsKey(finished(SLOT_360)));
  });

  it('is empty for a live entry, which reads no rung by slot', () => {
    expect(rungSlotsKey({ ...finished(SLOT_360), state: STREAM_STATUS_LIVE })).toBe('');
  });
});
