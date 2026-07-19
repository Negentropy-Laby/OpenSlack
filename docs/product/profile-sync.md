# Profile Sync Robot

The Profile Sync Robot keeps an organization's GitHub profile README in sync with an upstream whitepapers or content repository. It treats the whitepapers repo as the source of truth and produces a focused, auditable projection inside the target profile repository.

## Use Case

Teams publish insights, posts, or whitepapers in a dedicated repository (for example, `Negentropy-Laby/whitepapers`). The robot periodically pulls the latest posts, validates them against the configured policy, renders a profile-friendly block, and opens a pull request to patch the organization's `.github/profile/README.md` between marker comments. The result is a living public profile that stays current without hand-editing.

## Pipeline

Profile Sync runs through a fixed, observable pipeline:

1. **Collect** — Fetch the latest posts from the configured source repository (`source.repo`, `source.path`, `source.branch`).
2. **Validate** — Filter posts by age, status, or allowed tags; enforce the configured `max_posts` limit; validate that the source and target repositories are reachable and that the marker exists in the target README.
3. **Render** — Convert the selected posts into a Markdown block (title, date, summary, link) suitable for the target profile README.
4. **Patch** — Replace the content between the marker comments in `.github/profile/README.md` with the rendered block. The rest of the README is untouched.
5. **PR** — Commit the patch and open a draft PR against the target repository (`target.repo`, `target.branch`). If an open profile-sync PR already exists, the configured `on_existing_pr` policy applies (`skip` by default).
6. **Audit** — Emit a sync event, record the run evidence, and surface the result via `openslack collaboration workflow profile-sync status`. When the PR is merged, the profile update is treated as a governed change in the normal PRMS review flow.

## Configuration

Configuration lives in `.openslack/profile-sync.yaml`.

```yaml
schema: openslack.profile_sync.v1
source:
  repo: Negentropy-Laby/whitepapers
  branch: main
  path: posts
target:
  repo: Negentropy-Laby/.github
  branch: main
  path: profile/README.md
  marker: latest-insights
mode: manual
max_posts: 5
pr:
  draft: true
  labels: [profile:sync]
failure_issue:
  enabled: true
on_existing_pr: skip
```

| Field            | Meaning                                                                                |
| ---------------- | -------------------------------------------------------------------------------------- |
| `source.repo`    | Content truth source.                                                                  |
| `target.repo`    | Repository whose `profile/README.md` is the projection.                                |
| `target.marker`  | HTML-comment marker that bounds the injected block.                                    |
| `mode`           | `manual` (operator-triggered) or future scheduled mode.                                |
| `max_posts`      | Maximum posts to include in one sync.                                                  |
| `pr.draft`       | Whether the sync PR is opened as a draft.                                              |
| `on_existing_pr` | Action when an open profile-sync PR already exists: `skip`, `update`, or `create_new`. |

All values can be overridden on the command line with flags such as `--source`, `--target`, `--path`, `--posts`, `--marker`, `--max`, and `--on-existing-pr`.

## Commands

Profile Sync is a built-in workflow under the Collaboration Layer. It is read-only by default; `run` requires explicit confirmation.

```bash
# Check source/target reachability and marker presence
openslack collaboration workflow profile-sync check

# Preview the rendered patch without side effects
openslack collaboration workflow profile-sync preview --format diff

# Preview the rendered patch as Markdown
openslack collaboration workflow profile-sync preview --format markdown

# Run the full pipeline and open a PR (prompts for confirmation)
openslack collaboration workflow profile-sync run

# Show last sync date, pending PR, and any failure state
openslack collaboration workflow profile-sync status
```

Use `check` and `preview` first. `run` mutates the target repository and opens a PR, so it is gated by confirmation or `--yes`.

## Safety & Governance

- The robot only changes the content between the configured markers; the surrounding README is preserved.
- Sync PRs are opened as draft by default and must pass normal PRMS and human review before merge.
- A `failure_issue` can be created when the pipeline fails, so operators can triage without silent drift.
- The source repository remains the content authority; the target profile is a projection, not an original source of truth.

## Negentropy-Lab Projection

From a Negentropy-Lab perspective, the whitepapers repository is the **content truth source** and `.github/profile/README.md` is a **projection** of that truth. The sync event, the opened PR, and the associated run evidence can be absorbed by Negentropy-Lab as audit data, but OpenSlack does not own or mutate Negentropy-Lab `AuthorityState`.

For the broader integration framing, see [docs/product/negentropy-lab-integration.md](negentropy-lab-integration.md).
