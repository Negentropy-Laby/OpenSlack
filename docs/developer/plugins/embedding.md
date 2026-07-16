# Plugin Embedding Boundary

The current packages establish portable types, authoring helpers, and a private governed host.
They do not yet make OpenSlack a public, installable embedding platform.

## Available now

- `@openslack/plugin-api`: manifest types, strict JSON Schema, authoring validator,
  lifecycle vocabulary, host policy ports, and host-derived activation-evidence types;
- `@openslack/sdk`: type-preserving manifest/descriptor helpers, blockers-only PRMS result
  normalization, and type re-exports;
- `@openslack/plugin-host`: exact-byte manifest and lock loading, Red-local validation,
  instance-scoped registries and lifecycle, host-policy authorization, required audit writes,
  and blockers-only PRMS normalization;
- reviewed bundled descriptor types for code explicitly imported by an application
  composition root.

These packages are private monorepo packages. There is still no dynamic CLI/Operator/TUI
registry, directory watcher, npm package scan, public consumer release, or auto-discovered code
execution path in this stage.

## Not an execution API

OpenSlack v1 deliberately does not execute auto-discovered third-party code. A `workspace`
or installed `plugin` provider is a standalone `plugin.json` document with declarative
aliases only. The authoring validator neither reads files nor establishes trust.

The governed Red host implements:

1. bounded exact-byte reads and strict JSON parsing;
2. realpath containment, regular-file checks, and symlink/path-escape rejection;
3. manifest hashing and `.openslack/plugins.lock` comparison;
4. independent non-overridable capability, namespace, contribution-kind, entrypoint, and
   risk-ceiling checks;
5. instance-scoped registration, lifecycle transitions, audit events, and action-time
   authorization.

Audit metadata is limited to host-produced scalar facts. The host must bound and redact every
value before persistence; plugin-returned objects and prose are not audit metadata.

The host receives policy through `HostPolicyPort`; `plugin-api` does not import the kernel,
GitHub clients, credentials, or PRMS implementations. Requested capabilities become
effective only after intersection with host and actor allowlists. Approval and CODEOWNER
evidence remain host-derived current-state facts.

## Product claim

Until the public packages have a portable dependency closure and pass a clean external consumer
runtime test, describe this surface as a **private plugin host and authoring preview**. Do not
claim public embedding, executable third-party plugins, sandboxing, or dynamic product-surface
registration based on these packages alone.
