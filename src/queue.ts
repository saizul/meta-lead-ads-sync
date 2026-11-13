/** A small in-process work queue with a concurrency limit and an idle signal. */
export class WorkQueue<T> {
  private readonly items: T[] = [];
  private running = 0;
  private idleWaiters: Array<() => void> = [];
  private closed = false;

  constructor(
    private readonly worker: (item: T) => Promise<unknown>,
    private readonly concurrency = 2,
    private readonly onError: (error: unknown, item: T) => void = () => {},
    readonly maxSize = 10_000,
  ) {
    if (!Number.isInteger(concurrency) || concurrency < 1) throw new RangeError('concurrency must be >= 1');
  }

  get size(): number {
    return this.items.length;
  }

  get active(): number {
    return this.running;
  }

  /** Add work. Returns false when the queue is full or closed. */
  push(item: T): boolean {
    if (this.closed || this.items.length >= this.maxSize) return false;
    this.items.push(item);
    this.pump();
    return true;
  }

  private pump(): void {
    while (this.running < this.concurrency && this.items.length > 0) {
      const item = this.items.shift() as T;
      this.running++;
      Promise.resolve()
        .then(() => this.worker(item))
        .catch((error) => this.onError(error, item))
        .finally(() => {
          this.running--;
          this.pump();
          if (this.running === 0 && this.items.length === 0) {
            const waiters = this.idleWaiters;
            this.idleWaiters = [];
            waiters.forEach((w) => w());
          }
        });
    }
  }

  /** Resolves when nothing is queued or running. */
  onIdle(): Promise<void> {
    if (this.running === 0 && this.items.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }

  /** Stop accepting work and wait for what is queued. */
  async close(): Promise<void> {
    this.closed = true;
    await this.onIdle();
  }
}
