# Plugin Manifest v1

`openslack.plugin.v1` is OpenSlack's standalone JSON contract for declarative plugin
metadata. The contract is currently a private authoring preview: it describes requests,
not permissions, and does not make a plugin active.

The source of truth is
`packages/plugin-api/src/plugin-manifest.schema.json`. The runtime validator and JSON
Schema are exercised against the same fixture corpus.

## Root object

Every object is closed. Unknown fields are rejected, including fields that attempt to
declare an executable entrypoint, provider kind, lifecycle state, activation evidence,
approval, identity, or policy authority.

| Field                 | Meaning                                                              |
| --------------------- | -------------------------------------------------------------------- |
| `schema`              | Exactly `openslack.plugin.v1`                                        |
| `id`                  | Lowercase kebab-case local identity outside host-reserved namespaces |
| `version`             | Plugin version                                                       |
| `name`, `description` | Bounded display metadata                                             |
| `requires.openslack`  | Requested OpenSlack version range; compatibility remains host-owned  |
| `gate`                | Requested host gate (`SHADOW` or `ENFORCE`) and host-owned gate ID   |
| `capabilities`        | Requested capabilities from the closed declarative allowlist         |
| `contributes`         | Declarative aliases only                                             |

Example:

```json
{
  "schema": "openslack.plugin.v1",
  "id": "repository-observer",
  "version": "1.0.0",
  "name": "Repository observer aliases",
  "requires": { "openslack": ">=0.2.0 <1.0.0" },
  "gate": { "mode": "SHADOW", "gateId": "host.read-only" },
  "capabilities": ["host.actions.read", "host.workflows.read"],
  "contributes": [
    {
      "kind": "action_alias",
      "id": "show-status",
      "target": { "kind": "host_action", "id": "status.show" }
    },
    {
      "kind": "workflow_alias",
      "id": "inspect-repository",
      "target": { "kind": "host_workflow", "id": "repository.inspect" }
    }
  ]
}
```

## Declarative contribution boundary

Workspace and installed manifests may contribute only:

- `action_alias`, targeting an existing host action;
- `workflow_alias`, targeting an existing pre-registered host workflow.

Input mappings accept only finite string, number, or boolean constants and pass-through
references to declared inputs. Raw commands, argv, shells, templates, filesystem paths,
module names, URLs, risk metadata, and confirmation flags are forbidden. `pr.merge` is
explicitly forbidden as an action-alias target.

The authoring validator cannot decide whether a referenced action is actually read-only,
whether a workflow exists, or whether mapped fields belong to the target schema. The Red
plugin host independently resolves those facts and applies the current capability and risk
policy before registration and again before execution.

## Trust ownership

The manifest requests a gate mode and capabilities. It never supplies effective
capabilities, approval evidence, CODEOWNER state, lifecycle transitions, provider kind, or
source integrity. Those values are derived by the host. A successful schema or runtime
validation result means only that the document satisfies the authoring contract.

Raw-byte concerns such as UTF-8/BOM handling, duplicate JSON keys, size limits, realpath
containment, symlink rejection, exact-buffer hashing, and lock comparison belong to the Red
host/integrity loader. They are not claims made by this authoring validator.
