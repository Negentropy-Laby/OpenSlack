# Workflow Control

This module is the GS7-A pure Go consumer of the TypeScript-owned Workflow Control v1 contract.
It validates the closed observation record, evaluates the frozen RunStore transition table, and
projects a deterministic credential-free read model for cross-language differential tests.

It is intentionally not a service process yet. This stage has no HTTP server, database, migration,
Docker image, worker, scheduler, lease, approval decision, workflow execution, resume, effect, or
user-visible read authority. `@openslack/workflows` remains the only runtime writer and execution
authority. A later GS7-B change must separately qualify any durable shadow store; GS8 owns the
runner protocol, and GS9 owns any authority cutover.

Run the module tests with the pinned repository toolchain:

```bash
GOWORK=off go test ./...
GOWORK=off go test -race ./... -count=5
```
