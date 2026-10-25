import { AsyncLocalStorage } from "node:async_hooks";

export type OutboxLease = {
  readonly outboxId: string;
  readonly leaseToken: string;
};

const leaseStorage = new AsyncLocalStorage<OutboxLease>();

export class LeaseLostError extends Error {
  readonly outboxId: string;

  constructor(outboxId: string) {
    super(`Outbox lease is no longer owned: ${outboxId}`);
    this.name = "LeaseLostError";
    this.outboxId = outboxId;
  }
}

export function withOutboxLease<T extends { readonly id: string; readonly leaseToken: string }, R>(
  item: T,
  work: () => R,
): R {
  return leaseStorage.run({ outboxId: item.id, leaseToken: item.leaseToken }, work);
}

export function currentOutboxLease(outboxId: string): OutboxLease {
  const lease = leaseStorage.getStore();
  if (lease === undefined || lease.outboxId !== outboxId) throw new LeaseLostError(outboxId);
  return lease;
}
