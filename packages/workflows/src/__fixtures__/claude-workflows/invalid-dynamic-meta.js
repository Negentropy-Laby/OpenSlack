// Fixture: NON-static meta that should be REJECTED by analyzeStaticMeta.
// Uses computed meta values (function calls) which cannot be statically extracted.
// analyzeStaticMeta should throw when processing this file.

function computeName() {
  return 'dynamic-name';
}

export const meta = {
  name: computeName(),
  description: 'Dynamic meta that should be rejected',
  phases: [{ title: 'Scan', detail: 'Scan phase' }],
};
