---
schema: openslack.document.v1
id: contributor-scenario-pack
status: In Review
authority: canonical
audience:
  - contributors
owner: project-governance
updated: 2026-07-29
sources:
  - docs/reference/document-path-migration-v1.yaml
---

# Scenario Pack v1

Status: implemented declarative contract. `openslack.scenario_pack.v1` is a
scenario-definition format, not an extension of `openslack.plugin.v1` and not an executable plugin
system. The locked projection-only `software-delivery` and `contract-to-delivery-lite` Packs are
the current built-in instances of this contract. The governed mutation contract is implemented.
The default stock MCP remains read-only; Contract-to-Delivery rehearsal, authenticated Qoder
qualification, and live adapter qualification remain pending.

## Directory Contract

```text
scenarios/<scenario-id>/
├── scenario.yaml
├── scenario.lock.json
├── ontology.yaml
├── projections.yaml
├── workflows.yaml
├── capabilities.yaml
├── policies.yaml
├── views.yaml
├── notifications.yaml
└── fixtures/
```

`scenario.yaml` declares the exact closed file set and pack identity/version. Undeclared files are
rejected. Optional fixture files must be individually declared with byte and record bounds.

`scenario.lock.json` pins the SHA-256 and byte length of every declared file except the lock itself.
It also pins the scenario ID/version and closed file list. No self-referential lock hash is used.

## Allowed Declarations

A pack may declare only:

- bounded ontology types, fields, and relationships;
- mappings to host-registered projector IDs;
- references to host-registered workflow IDs;
- requests for host-registered capability IDs;
- policy constraints that only narrow execution;
- view definitions over bounded graph fields;
- mappings from typed lifecycle events to host-owned notification intent types;
- visibly labelled, bounded demo fixtures.

Links in views use a host-registered deep-link template ID and bounded template arguments. A pack
cannot supply a URL.

## Forbidden Content

Every schema is closed and rejects:

```text
raw command or argv
shell or subprocess
module, package, entrypoint, or source-code path
JavaScript/TypeScript/WASM or another executable
arbitrary URL, endpoint, redirect, or webhook target
credential name, reference, or value
unregistered or wildcard capability
approval, merge, trust, CODEOWNER, or identity decision
dynamic code, UI, template language, or expression evaluator
```

The pack cannot register an adapter, projector, workflow, capability, policy implementation, MCP
tool, or notification backend. Reviewed packages are imported explicitly at an application
composition root.

## Loading

The loader reuses the Plugin Host's safety methods, not its manifest schema or registries:

1. resolve the pack root under an explicitly configured scenario root;
2. reject symlinked roots, files, and directories;
3. read bounded exact bytes through no-follow handles;
4. require fatal UTF-8 and reject BOMs and duplicate keys;
5. validate `scenario.yaml` and every declared file against a closed schema;
6. compare exact bytes and lengths with `scenario.lock.json`;
7. resolve every referenced ID against sealed host catalogs;
8. intersect requested capabilities with host and actor authority;
9. return an immutable definition or fail without partial registration.

Limits cover file count, directory entries, file bytes, total bytes, YAML aliases/depth/items, text
length, fixture records, and diagnostics. Diagnostics identify the file and stable error code but
do not echo arbitrary fixture values.

## Host-Owned Catalogs

The composition root seals catalogs before loading packs:

```text
projectors
workflows
capabilities and risk metadata
adapters
deep-link templates
notification intent types
```

A reference is valid only if the current OpenSlack build already registered it. A pack cannot
change a registration, raise a trust level, or convert a missing ID into a dynamic import.

Capability requests use canonical IDs. Legacy workflow namespaces are normalized by host code
before intersection; a pack never controls the normalizer.

## Scenario Instances

Loading a definition does not create an instance or perform an effect. Preview produces a
canonical, read-only instantiation plan bound to:

```text
definition ID/version/hash
normalized input hash
target scope and source versions
actor/workspace/correlation
workflow and capability resolution
effect manifest and risk
```

Instance creation occurs only through governed plan confirmation. It is idempotent by definition
hash, input hash, and target scope. Remote effects are recorded step by step; they are not
described as transactionally rolled back.

## Initial Packs

`software-delivery` is the first built-in locked projection foundation.
`contract-to-delivery-lite` is the second built-in locked Pack and registers the sealed composite
projector that adds Customer, Contract, Project, Milestone, Acceptance, and Outcome ontology around
the reused Work Item, Agent, and Deliverable subgraph. Both Packs are currently projection-only and
grant no workflow, notification, deep-link, or mutation authority. Their executable host dispatch
is static code; Pack files cannot provide module paths or projector functions.

The manufacturing 90-day workflow remains a deterministic technical fixture and fallback. It is
not a second lead scenario.

## Relationship to Plugin v1

`openslack.plugin.v1` currently admits declarative action and workflow aliases. Scenario Pack has a
different schema, store, lock, catalog, and lifecycle. Neither format can embed executable code or
grant authority, and neither successful validation result is activation approval.

See [Plugin Manifest v1](plugins/manifest.md) and
[Scenario Pack Security Boundary](../security/scenario-pack-boundary.md).
