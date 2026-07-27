# Scenario Pack Security Boundary

Status: planned security contract. `openslack.scenario_pack.v1` is a code-free request format. A
valid pack is not authorized, active, trusted, or executable merely because it passes schema and
integrity checks.

## Core Invariant

Scenario Packs may select only definitions that reviewed host code already registered. They cannot
create execution authority.

Effective capability is always:

```text
pack requested
  intersect host catalog and policy
  intersect active actor grant
  minus non-overridable forbidden capabilities
```

The host applies this after legacy permission normalization and again when confirming a plan.

## Threat Model

| Threat                                              | Control                                                                 |
| --------------------------------------------------- | ----------------------------------------------------------------------- |
| Executable file disguised as a scenario asset       | closed file kinds; no module/entrypoint/source path fields              |
| Dynamic import through workflow/projector reference | sealed ID catalogs; no fallback resolution                              |
| URL or webhook exfiltration                         | URL fields forbidden; host-owned deep-link/backend templates            |
| Capability escalation                               | canonical allowlist, no wildcard/unknown IDs, host/actor intersection   |
| Embedded approval or trust                          | approval, identity, CODEOWNER, merge, and trust fields forbidden        |
| Symlink/path escape                                 | realpath containment, no-follow read, regular-file and same-file checks |
| Validate-one-read/use-another race                  | schema and hash over one bounded exact-byte handle                      |
| Parser amplification                                | file/byte/depth/item/alias limits and duplicate-key rejection           |
| Fixture presented as live authority                 | mandatory `demo_fixture` provenance and version hash                    |
| Pack update races active instance                   | definition hash pinned in preview and instance                          |
| Partial registration                                | validate and resolve all files/IDs before atomic immutable publication  |

## Forbidden Authority

A pack cannot:

- register or execute code, modules, commands, shells, URLs, adapters, projectors, or MCP tools;
- grant capabilities or permissions;
- choose an OpenSlack/GitHub actor or App installation;
- originate plan confirmation, workflow-effect approval, GitHub review, or merge;
- change policy, risk-zone classification, Workflow Trust, CODEOWNERS, or constitutional rules;
- select credential material, arbitrary notification destinations, or external endpoints;
- claim live authority for a fixture, cache, projection, or recorded rehearsal.

Unknown fields fail closed rather than being ignored for forward compatibility.

## Exact-Byte Integrity

`scenario.yaml` declares one closed file set. `scenario.lock.json` records exact SHA-256 and byte
length for every declared file except itself.

The loader:

1. resolves the configured scenario root and candidate directory;
2. rejects symlinks, traversal, alternate data streams, and non-regular files;
3. reads bounded bytes through a no-follow handle;
4. verifies identity and containment before and after read;
5. requires fatal UTF-8, no BOM, no duplicate keys, and bounded YAML features;
6. validates closed schemas;
7. compares the same bytes with the lock;
8. resolves all referenced IDs and capabilities from sealed host catalogs;
9. returns one deeply immutable definition only after every check passes.

Whitespace changes alter exact-byte hashes and require an intentional lock update. A lock proves
file identity, not safety or authority; host policy remains independent.

## Registered Reference Boundary

Projector, workflow, capability, adapter, notification intent, and deep-link template IDs are
host-owned. Missing IDs are errors. The loader never attempts `import()`, `require()`, executable
path resolution, package lookup, URL fetch, or registry discovery.

The pack may narrow host policy through declarative constraints. Any field that would broaden a
timeout, budget, capability, target, trust, or risk ceiling is rejected or intersected down to the
host maximum.

## Preview and Execution

Loading and preview are read-only. Preview pins:

```text
definition ID/version/hash
input hash and target scope
source versions/head SHAs
actor/workspace/correlation
resolved workflow/projector/adapter IDs
capabilities, risk, owner, effects, and approvals
```

Execution occurs only after the generic OpenSlack canonical-plan confirmation path rereads and
revalidates those facts. A pack cannot implement its own executor or confirmation logic.

Partial remote execution is recorded as completed effects, failed step, owner, recovery action, and
reconciliation evidence. The runtime does not claim transactional rollback of GitHub or another
external system.

## Fixtures and Reset

Fixture roots are explicitly configured and kept separate from live target scopes. Every fixture
authority reference uses provider `demo_fixture` and a versioned fixture hash.

`openslack_demo_reset` is available only in local `demo_mode`, is contained to the fixture
workspace, and resets local instance/graph/artifact state. It never closes, deletes, rewrites, or
relabels live GitHub objects. Live rehearsals use a fresh scenario namespace.

## Relationship to Other Extension Surfaces

Scenario Pack is not:

- an `openslack.plugin.v1` action/workflow alias manifest;
- a reviewed bundled code contribution;
- a Qoder Skill or Workbench;
- the externally governed Negentropy-Lab
  [`scenario-pack.extension`](negentropy-slot-boundary.md), which is a SHADOW projection
  contribution rather than an OpenSlack Scenario Pack;
- a notification vendor registry.

Each surface keeps its own schema, trust owner, lifecycle, and activation evidence. No successful
validation in one surface authorizes another.

## Required Adversarial Evidence

Before runtime use, tests must reject:

- executable/module/URL/raw-command/credential fields;
- unknown and wildcard capabilities;
- undeclared, missing, duplicate, reordered, or hash-mismatched files;
- BOM, invalid UTF-8, duplicate keys, YAML aliases/depth bombs, and oversized inputs;
- traversal, symlink, alternate-data-stream, non-regular-file, and mid-read replacement cases;
- unregistered workflow/projector/adapter/deep-link/notification IDs;
- fixture provenance rewritten as live authority;
- definition, actor, permission, registry, source-head, and plan-hash drift.

Passing these tests supports a local security gate only. Repository review and PRMS governance
remain required for the implementing code.

## Related Documents

- [Scenario Runtime product contract](../product/scenario-runtime.md)
- [Scenario Pack v1](../developer/scenario-pack.md)
- [Plugin trust model](plugin-trust-model.md)
- [Workflow execution security](workflow-execution.md)
