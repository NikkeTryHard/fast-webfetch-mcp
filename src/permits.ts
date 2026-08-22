import { CONFIG } from "./config.js";

export type PermitLease = {
  count: number;
  release: () => void;
};

type PermitWaiter = {
  desired: number;
  resolve: (lease: PermitLease | undefined) => void;
  timer: NodeJS.Timeout;
};

/** Caps concurrent Crawl4AI workers; oversized demands queue FIFO until slots free up. */
export class WorkerPermitPool {
  private available: number;
  private readonly waiters: PermitWaiter[] = [];

  constructor(private readonly capacity: number) {
    this.available = capacity;
  }

  acquire(desired: number, timeoutMs: number): Promise<PermitLease | undefined> {
    const permits = Math.max(1, Math.min(desired, this.capacity));
    if (this.available > 0) return Promise.resolve(this.grant(Math.min(permits, this.available)));

    const { promise, resolve } = Promise.withResolvers<PermitLease | undefined>();
    const waiter: PermitWaiter = {
      desired: permits,
      resolve,
      timer: setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(undefined);
      }, timeoutMs),
    };
    this.waiters.push(waiter);
    return promise;
  }

  private grant(count: number): PermitLease {
    this.available -= count;
    let released = false;
    return {
      count,
      release: () => {
        if (released) return;
        released = true;
        this.available += count;
        this.drain();
      },
    };
  }

  private drain(): void {
    while (this.available > 0 && this.waiters.length > 0) {
      const waiter = this.waiters.shift();
      if (!waiter) return;
      clearTimeout(waiter.timer);
      waiter.resolve(this.grant(Math.min(waiter.desired, this.available)));
    }
  }
}

export const workerPermits = new WorkerPermitPool(CONFIG.multipleConcurrency);
