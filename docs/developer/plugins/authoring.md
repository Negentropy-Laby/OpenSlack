# Plugin Authoring Preview

`@openslack/plugin-api` provides a zero-runtime-dependency contract, and `@openslack/sdk`
adds type-preserving authoring helpers without a host or kernel dependency. Both packages
remain `private: true`; they are not yet installable as public npm packages.

## Declarative manifests

Use the SDK helper for TypeScript inference and the runtime validator for authoring
feedback:

```ts
import { validatePluginManifest } from '@openslack/plugin-api';
import { defineManifest } from '@openslack/sdk';

const manifest = defineManifest({
  schema: 'openslack.plugin.v1',
  id: 'repository-observer',
  version: '1.0.0',
  name: 'Repository observer aliases',
  requires: { openslack: '>=0.2.0 <1.0.0' },
  gate: { mode: 'SHADOW', gateId: 'host.read-only' },
  capabilities: ['host.actions.read'],
  contributes: [
    {
      kind: 'action_alias',
      id: 'show-status',
      target: { kind: 'host_action', id: 'status.show' },
    },
  ],
});

const result = validatePluginManifest(manifest);
if (!result.valid) {
  console.error(result.findings);
}
```

`defineManifest` is intentionally an identity helper. It preserves literal types but does
not validate, register, authorize, or activate anything. Use `validatePluginManifest` or
`assertPluginManifestV1` for contract feedback.

For standalone JSON authoring, validate against the exported
`@openslack/plugin-api/plugin-manifest.schema.json` schema. Contract tests compile that
schema in strict JSON Schema 2020-12 mode and run it against the same JSON fixtures as the
runtime validator.

## Reviewed bundled descriptors

`defineBundledPlugin`, `defineBundledAction`, `defineBundledWorkflow`, and
`definePrmsBlocker` describe code that an OpenSlack application explicitly imports at its
composition root. They are not auto-discovery APIs and make no sandbox claim.

Bundled PRMS extensions can return only append-only blockers. Their return type cannot
represent PASS, approval counts, mergeability, or merge authorization. Bundled action plan
steps still require host validation and authorization.

## Author checklist

- Keep workspace/installed manifests declarative; never add an executable entry field.
- Request only the minimum capability set.
- Treat `SHADOW` and `ENFORCE` as requests subject to host policy.
- Use bounded constants or declared input pass-through mappings only.
- Do not infer activation or safety certification from validator success.
- Add every accepted and rejected contract case to the shared JSON fixture corpus.

See [Plugin Manifest v1](manifest.md) for the field contract and
[Embedding Boundary](embedding.md) for the runtime status.
