import { AsyncLocalStorage } from 'node:async_hooks';

type EncodingObserver = (value: object) => void;

const ENCODING_OBSERVER = new AsyncLocalStorage<EncodingObserver>();

/** @internal Test-only observation of actual canonical encoding cache misses. */
export function withWorkflowRunnerAuthorityBindingEncodingObserver<T>(
  observer: EncodingObserver,
  action: () => T,
): T {
  return ENCODING_OBSERVER.run(observer, action);
}

export function observeWorkflowRunnerAuthorityBindingEncoding(value: object): void {
  ENCODING_OBSERVER.getStore()?.(value);
}
