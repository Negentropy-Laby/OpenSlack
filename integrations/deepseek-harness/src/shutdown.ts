/** One process-local monotonic close budget inside the supervisor's 25-second graceful window. */
import { HARNESS_CLEANUP_BUDGET } from '@openslack/agent-runtime/internal/bridge-wire'
export const OWNED_SHUTDOWN_MS = HARNESS_CLEANUP_BUDGET.ownedMs

/** Only a bounded remaining duration crosses a process boundary, never a clock reading. */
export function shutdownBudget(remainingMs: number = OWNED_SHUTDOWN_MS): number {
  if (!Number.isSafeInteger(remainingMs) || remainingMs < 1 || remainingMs > OWNED_SHUTDOWN_MS) {
    throw new Error('Invalid owned-resource shutdown budget')
  }
  return remainingMs
}

export function shutdownDeadline(remainingMs: number = OWNED_SHUTDOWN_MS): number {
  return performance.now() + shutdownBudget(remainingMs)
}

/** This value is local to the caller/connection's process; it must never be serialized. */
export function adoptShutdownDeadline(value?: number): number {
  if (value === undefined) return shutdownDeadline()
  const now = performance.now()
  if (!Number.isFinite(value) || !Number.isSafeInteger(Math.floor(value)) || value <= now || value > now + OWNED_SHUTDOWN_MS) {
    throw new Error('Invalid local owned-resource shutdown deadline')
  }
  return value
}

export function shutdownRemaining(deadline: number): number {
  const remaining = Math.floor(deadline - performance.now())
  if (!Number.isSafeInteger(remaining) || remaining < 1) throw new Error('Owned-resource shutdown deadline exceeded')
  return remaining
}

export async function withinShutdown<T>(deadline: number, operation: () => Promise<T>): Promise<T> {
  const remaining = shutdownRemaining(deadline)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // Arm the existing bound before calling potentially synchronous work. A
    // late resolution must not beat an overdue timer in the microtask queue.
    const expired = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Owned-resource shutdown deadline exceeded')), remaining)
    })
    const result = await Promise.race([operation(), expired])
    shutdownRemaining(deadline)
    return result
  } finally { if (timer) clearTimeout(timer) }
}
