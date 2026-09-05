/** Normative formats for authority-binding JSON Schema format-assertion validators.
 * JSON Schema maxLength counts Unicode code points; the wire contract bounds UTF-8 bytes.
 */
export const WORKFLOW_RUNNER_AUTHORITY_BINDING_SCHEMA_FORMATS = Object.freeze({
  'openslack-utf8-512': (value: string): boolean => Buffer.byteLength(value, 'utf8') <= 512,
});
