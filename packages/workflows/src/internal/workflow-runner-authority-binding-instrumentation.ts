import { AsyncLocalStorage } from 'node:async_hooks';

type EncodingObserver = (value: object) => void;
export type WorkflowRunnerAuthorityBindingValidationEvent =
  | 'budget_prepared_parse'
  | 'budget_durable_parse';
type ValidationObserver = (event: WorkflowRunnerAuthorityBindingValidationEvent) => void;

const ENCODING_OBSERVER = new AsyncLocalStorage<EncodingObserver>();
const VALIDATION_OBSERVER = new AsyncLocalStorage<ValidationObserver>();

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

/** @internal Test-only observation of expensive validation passes. */
export function withWorkflowRunnerAuthorityBindingValidationObserver<T>(
  observer: ValidationObserver,
  action: () => T,
): T {
  return VALIDATION_OBSERVER.run(observer, action);
}

export function observeWorkflowRunnerAuthorityBindingValidation(
  event: WorkflowRunnerAuthorityBindingValidationEvent,
): void {
  VALIDATION_OBSERVER.getStore()?.(event);
}
