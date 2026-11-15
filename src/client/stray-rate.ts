import type { BosLink } from './bos-link.js';

const takers = new WeakMap<BosLink, (body: Uint8Array) => void>();

export function takesStrayRate(link: BosLink, take: (body: Uint8Array) => void): void {
  takers.set(link, take);
}

/** Gives the link a BOS rate notice that came on a different connection of the session. */
export function strayRate(link: BosLink, body: Uint8Array): void {
  takers.get(link)?.(body);
}
