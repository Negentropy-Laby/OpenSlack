/** Serialize operations by key while allowing unrelated keys to proceed concurrently. */
export function enqueueByKey<T>(
  queues: Map<string, Promise<unknown>>,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => undefined).then(operation);
  queues.set(key, current);
  void current
    .finally(() => {
      if (queues.get(key) === current) queues.delete(key);
    })
    .catch(() => undefined);
  return current;
}
