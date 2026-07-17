# Repository PR Projection

`openslack pr queue` has two deliberately separate data paths.

- With no repository selector it retains the current workspace PRMS queue and
  runs the existing doctor-derived readiness logic.
- With repeated `--repo` or `--all` it runs an informational multi-repository
  projection. The projection does not call doctor, classify risk, evaluate
  approvals, or make merge decisions.

## Bounded data flow

The projection shares one GitHub installation/token context across its
configured repositories. A global concurrency limiter and request budget cover
PR list, check pagination, and follow-up state reads. The defaults are:

```text
concurrency: 4
api budget: 100
cache TTL: 60 seconds
open PR limit: 20 per repository
```

Budget exhaustion returns the successfully collected records with
`partial=true`. It never triggers an unbounded retry or silently converts
missing evidence into a merge-readiness result.

## Local state

Projection state is isolated from the Issue watch cursor:

```text
.openslack.local/pr-projection/cache/<repository>.json
.openslack.local/pr-projection/cursors/<repository>.json
```

Files use schema-versioned, display-only DTOs and atomic replacement. Cache
records contain repository identity, PR number/title/author/state/draft, head
SHA, update time, and aggregate check counts. They do not contain PR bodies,
review prose, reviewer identities, approval decisions, policy output, or doctor
evidence.

## Synthetic changes

Polling compares the last projection cursor with current live state and can
produce only:

```text
pull_request.state_changed
checks.summary_changed
```

These values are `synthetic:true`, `source:poll`, and use the separate
`RepositoryProjectionChange` union. They are not cast to `RepositoryEvent` and
are not passed to PR doctor, approval, merge, Workflow Trust, or governance.
