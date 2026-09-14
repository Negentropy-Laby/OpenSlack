# First Day Checklist — codex_qualification_rext

- [ ] Read `openslack.yaml`, `AGENTS.md`, `.openslack/policies/self_evolution.yaml`, and `docs/contributor/github-issues-loop.md`.
- [ ] Read `.openslack/agents/registry/codex_qualification_rext.yaml` and this package's `START_HERE.md` and `codex_automation_prompt.md`.
- [ ] Confirm independent administrator review and merge of the configuration.
- [ ] Have the administrator provision local identity and configured authentication without exposing credential contents.
- [ ] Run workspace validation and bootstrap from the repository root; missing identity must fail.
- [ ] Verify Issue #411's readiness, all required capabilities, risk, repository and allowed/denied paths before any real claim.
- [ ] Use manual targeted invocation only; no cron or Actions schedule is installed.
- [ ] After a granted claim, record actual ownership, expiry, next heartbeat, worktree, task ID and run ID.
- [ ] Confirm authorized creation paths can be used without granting any wider path.
- [ ] Submit preparation through the governed task/PR flow; keep authenticated execution and exact human approval separate.
- [ ] Preserve evidence on failures; never self-edit registry/prompts, access credentials, push to main or declare an unobserved R-EXT PASS.
