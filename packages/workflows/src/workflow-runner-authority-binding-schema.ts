import {
  WORKFLOW_BINDING_ERROR_MESSAGE_MAX_BYTES,
  isCanonicalUtcTimestamp,
} from './internal/workflow-binding-field-rules.js';

/** Register before compiling strict Ajv 2020 schemas. maxLength counts code points, not bytes. */
export const WORKFLOW_RUNNER_AUTHORITY_BINDING_SCHEMA_FORMATS = Object.freeze({
  'openslack-canonical-utc': isCanonicalUtcTimestamp,
  'openslack-utf8-512': (value: string): boolean =>
    Buffer.byteLength(value, 'utf8') <= WORKFLOW_BINDING_ERROR_MESSAGE_MAX_BYTES,
});

export function registerWorkflowRunnerAuthorityBindingSchemaFormats<
  T extends {
    addFormat(name: string, validate: (value: string) => boolean): unknown;
  },
>(validator: T): T {
  for (const [name, format] of Object.entries(WORKFLOW_RUNNER_AUTHORITY_BINDING_SCHEMA_FORMATS))
    validator.addFormat(name, format);
  return validator;
}
