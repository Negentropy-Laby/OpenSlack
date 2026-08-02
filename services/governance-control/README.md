# Governance Control contract module

This GS4 module is a credential-free, pure Go read model for Operator governed
plans. It validates the frozen TypeScript runtime contract, verifies canonical
hash bindings, and projects records without exposing confirmation capabilities
or their stored hashes.

The authority boundary is deliberately narrow:

- `@openslack/operator` remains the only writer and execution authority.
- `.openslack.local/operator/governed-plans` remains the runtime store.
- Memory Bank is documentation and governance context, never a runtime store.
- This module has no filesystem, database, HTTP, GitHub, Qoder mutation, or
  workflow execution capability.

Generated contract bytes live in
`packages/operator/contracts/governed-plan/v1` and are mirrored exactly under
`internal/contractmirror/generated/v1`. Refresh or verify them with:

```bash
bun run governance:golden generate
bun run governance:golden -- --check
```

Run the pure-module qualification with:

```bash
bash scripts/go-check.sh services/governance-control
```

For a fast isolated local subset from the module directory:

```bash
GOWORK=off go test -race ./...
```
