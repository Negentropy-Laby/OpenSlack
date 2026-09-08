export const WORKFLOW_BINDING_HASH_PATTERN = '^[0-9a-f]{64}$';
export const WORKFLOW_BINDING_REFERENCE_PATTERN = '^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$';
export const WORKFLOW_BINDING_TIME_PATTERN =
  '^\\d{4}-\\d{2}-\\d{2}T\\d{2}:\\d{2}:\\d{2}\\.\\d{3}Z$';
export const WORKFLOW_BINDING_ERROR_MESSAGE_MAX_BYTES = 512;
