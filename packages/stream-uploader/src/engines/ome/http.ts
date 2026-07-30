import { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { OmeAdmissionReply } from './../ome/interfaces.js';
import { RawBodyRequest } from './../types.js';

export function reply(res: Response, body: OmeAdmissionReply): void {
  res.json(body);
}

/**
 * Whether the request carries a valid OME admission signature over its raw body.
 *
 * An empty secret rejects. It cannot mean "signature checking is off", because the empty string is
 * a key anyone can use: a caller who knows the secret is empty computes `HMAC-SHA1('', body)` and
 * passes. Treating it as a valid configuration is what made unauthenticated ingest possible.
 */
export function verifyAdmissionSignature(req: Request, secret: string): boolean {
  if (!secret) {
    return false;
  }

  const signature = req.get('x-ome-signature');
  const rawBody = (req as RawBodyRequest).rawBody;
  if (!signature || !rawBody) {
    return false;
  }

  const expected = createHmac('sha1', secret).update(rawBody).digest('base64url');
  const received = Buffer.from(signature);
  const computed = Buffer.from(expected);
  return received.length === computed.length && timingSafeEqual(received, computed);
}
