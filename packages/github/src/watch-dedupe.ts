import { WatchDeliveryQueue } from './watch-delivery-queue.js';
import { canonicalizeRepositoryName } from './repository-event.js';

/**
 * @deprecated Use WatchDeliveryQueue. This subclass exists only so persisted v0.1
 * callers can migrate without restoring the retired check-then-record implementation.
 */
export class WatchDedupeStore extends WatchDeliveryQueue {
  buildStableKey(event: {
    owner: string;
    repo: string;
    issueNumber: number;
    action: string;
    updatedAt: string;
  }): string {
    const repository = canonicalizeRepositoryName(event.owner, event.repo);
    if (!repository) throw new TypeError('Invalid GitHub repository identity.');
    return `github:issues.${event.action}:${repository.canonicalFullName}:issue:${event.issueNumber}:${event.updatedAt}`;
  }

  buildPushStableKey(event: { owner: string; repo: string; ref: string; after: string }): string {
    const repository = canonicalizeRepositoryName(event.owner, event.repo);
    if (!repository) throw new TypeError('Invalid GitHub repository identity.');
    return `github:push:${repository.canonicalFullName}:${event.ref}:${event.after}`;
  }
}

export * from './watch-delivery-queue.js';
