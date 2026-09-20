export interface StackPortProjection {
  uploaderApi: number;
  srsSrt: number;
  srsRtmp: number;
  srsHttp: number;
  srsHttpApi: number;
}

/** Mirrors the authoritative slot arithmetic in deploy/scripts/_lib.sh. */
export function stackPortsForSlot(portSlot: number): StackPortProjection {
  if (!Number.isSafeInteger(portSlot) || portSlot < 1 || portSlot > 99) {
    throw new RangeError('stack profile port slot is outside its allowed range');
  }
  return {
    uploaderApi: 10_000 + portSlot * 10,
    srsSrt: 10_001 + portSlot * 10,
    srsRtmp: 10_002 + portSlot * 10,
    srsHttp: 10_003 + portSlot * 10,
    srsHttpApi: 10_009 + portSlot * 10,
  };
}
