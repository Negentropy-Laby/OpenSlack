/** One absolute owned-resource close budget inside the supervisor's 25-second graceful window. */
export const OWNED_SHUTDOWN_MS = 24_000

export function shutdownDeadline(value?: number): number {
  const now = Date.now()
  if (value !== undefined && (!Number.isSafeInteger(value) || value <= now || value > now + OWNED_SHUTDOWN_MS)) {
    throw new Error('Invalid owned-resource shutdown deadline')
  }
  return value ?? now + OWNED_SHUTDOWN_MS
}

export function shutdownRemaining(deadline: number): number {
  const remaining = deadline - Date.now()
  if (!Number.isSafeInteger(remaining) || remaining <= 0) throw new Error('Owned-resource shutdown deadline exceeded')
  return remaining
}

export async function withinShutdown<T>(deadline: number, operation: () => Promise<T>): Promise<T> {
  const remaining = shutdownRemaining(deadline)
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([operation(), new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Owned-resource shutdown deadline exceeded')), remaining)
    })])
  } finally { if (timer) clearTimeout(timer) }
}
