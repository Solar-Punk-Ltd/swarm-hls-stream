import { Bee } from '@ethersphere/bee-js';

export function createBee(url: string): Bee {
  return new Bee(url);
}
