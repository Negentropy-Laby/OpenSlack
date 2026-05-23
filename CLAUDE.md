# Claude Code Entry Point

Read `AGENTS.md` first. It is the canonical instruction file for this repository.

## Immediate Startup Checklist

1. Read `docs/status/current.md` for generated current state.
2. Read `.openslack/modules.yaml` for the product module registry.
3. Read `README.md` for the user-facing product overview.
4. Read `docs/user-guide.md` only when you need the full CLI reference.
5. Follow every constraint in `AGENTS.md` before making changes.

## Working Rule

Do not infer current status from old phase documents. Treat archived specs and old acceptance documents as historical context only.

## Safe Default Commands

```bash
pnpm openslack status
pnpm openslack doctor
pnpm openslack status verify
pnpm openslack pr doctor <PR_NUMBER>
```

## Never Do These

- Do not push directly to `main`.
- Do not approve PRs.
- Do not bypass rulesets.
- Do not edit secrets or credential files.
- Do not hand-edit generated status without running `pnpm openslack status generate` and `pnpm openslack status verify`.

For everything else, follow `AGENTS.md`.
