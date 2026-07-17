# Plugin Testkit and Registration Preflight

`@openslack/plugin-testkit` is a deterministic authoring and CI validator for v1
declarative manifests. Its only runtime package dependency is
`@openslack/plugin-api`. It does not import plugin code, execute contributions,
grant activation, or replace the Red `@openslack/plugin-host` boundary.

Run it through the established Self-Evolution command group:

```bash
openslack self plugin check ./my-plugin
openslack self plugin check ./my-plugin/plugin.json --format json
openslack self plugin check .openslack/plugins/my-plugin --verify-integrity
```

`--verify-integrity` accepts only a manifest beneath
`.openslack/plugins/<plugin-id>/plugin.json` and compares the exact manifest
bytes with the canonical `.openslack/plugins.lock` entry. Without that flag,
G17 is reported as `SKIP`; no integrity claim is made.

## G1-G17 contract

| Check | Contract                                                                                                                    |
| ----- | --------------------------------------------------------------------------------------------------------------------------- |
| G1    | Select exactly `plugin.json` or its containing directory.                                                                   |
| G2    | Reject traversal and any lexical or real-path escape from the selected trust root.                                          |
| G3    | Reject symlinks, junctions, non-directory ancestors, and non-regular manifests.                                             |
| G4    | Read at most 256 KiB and reject identity or size changes during the read.                                                   |
| G5    | Decode UTF-8 fatally and reject a BOM.                                                                                      |
| G6    | Parse bounded strict JSON and reject duplicate keys, invalid syntax, excessive depth/nodes/strings, and non-finite numbers. |
| G7    | Enforce `openslack.plugin.v1`, required fields, types, and exact-field schemas.                                             |
| G8    | Reject executable, callback, command, module, URL, lifecycle, and implementation fields.                                    |
| G9    | Enforce canonical plugin IDs and reserve built-in/constitutional namespaces.                                                |
| G10   | Enforce canonical semantic plugin versions.                                                                                 |
| G11   | Compare the requested OpenSlack range with the exact host version.                                                          |
| G12   | Validate the requested `SHADOW`/`ENFORCE` gate and gate identity.                                                           |
| G13   | Enforce the declarative capability allowlist, uniqueness, and contribution coherence.                                       |
| G14   | Validate contribution kinds/identities and reject local registry collisions.                                                |
| G15   | Reject approval, merge, mutation, authority, risk, or confirmation laundering.                                              |
| G16   | Restrict input definitions and mappings to bounded scalar constants or declared input pass-throughs.                        |
| G17   | Validate canonical lock schema/order/source, identity, requested gate, and exact SHA-256 bytes.                             |

The JSON report schema is `openslack.plugin_check_report.v1`. A clean authoring
preflight reports `READY_TO_REGISTER`; any finding reports `BLOCKED`. Finding
codes come from the public `PLUGIN_DIAGNOSTIC_CODES` contract and use the same
stable strings as the Host boundary.

Every report includes `authorizationNotice: HOST_REAUTHORIZATION_REQUIRED`.
This is load-bearing: a clean report is not activation evidence. Registration
always makes the Red Host reload the source, verify its own lock and compatibility
rules, resolve the actual host target catalog, intersect capabilities, and write
the required audit facts.

The repository evaluation contract is
`.openslack/self/eval_suites/plugin/EV-PLUGIN-001.yaml`; package tests execute its
scenarios against the production checker.
