import { Request, Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';

import { OmeAdmissionReply } from './../ome/interfaces.js';
import { RawBodyRequest } from './../types.js';

export function reply(res: Response, body: OmeAdmissionReply): void {
  res.json(body);
}

export function verifyAdmissionSignature(req: Request, secret: string): boolean {
  if (!secret) {
    return true;
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
