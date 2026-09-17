/**
 * Whether two feed owners are one address.
 *
 * Both services derive the owner from a private key and print it as hex, but not alike: bee-js prints
 * forty hex digits, and the admin's rows and public config may carry a `0x` prefix, in either case.
 * Compared without the prefix and without case, because a viewer's gateway resolves `owner/topic` on
 * the bytes and nothing else about the spelling is load-bearing.
 */
export function sameFeedOwner(left: string, right: string): boolean {
  return normalise(left) === normalise(right);
}

function normalise(owner: string): string {
  return owner.trim().toLowerCase().replace(/^0x/, '');
}
