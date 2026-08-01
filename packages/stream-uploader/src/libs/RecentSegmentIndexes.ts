/**
 * The segment indexes a stream has already taken, bounded so a broadcast cannot grow the set for as
 * long as it runs. It used to be a plain `Set` that only the end of the stream emptied, which at two
 * second segments is around 43,000 entries a day and never fewer. See CON-8.
 *
 * Two generations rather than a scan for the oldest, because the whole point is a cost that does not
 * grow with the stream: `has` and `add` are both O(1) and nothing is ever iterated. Retiring the older
 * generation wholesale is what buys that, and it is why the guarantee below is a floor rather than an
 * exact window.
 */
export class RecentSegmentIndexes {
  private current = new Set<number>();
  private previous = new Set<number>();

  /**
   * @param windowSize How many further distinct indexes an index is guaranteed to survive. At most
   *   twice this many are held at once, which is the memory bound.
   */
  constructor(private readonly windowSize: number) {}

  has(index: number): boolean {
    return this.current.has(index) || this.previous.has(index);
  }

  add(index: number): void {
    if (this.current.size >= this.windowSize) {
      this.previous = this.current;
      this.current = new Set();
    }
    this.current.add(index);
  }

  get size(): number {
    return this.current.size + this.previous.size;
  }
}
