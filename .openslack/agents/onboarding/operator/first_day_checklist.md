# First Day Checklist — operator

- [ ] Read `openslack.yaml`, `AGENTS.md`, `.openslack/policies/self_evolution.yaml`, and `docs/contributor/github-issues-loop.md`.
- [ ] Read `.openslack/agents/registry/operator.yaml`, `.openslack/agents/onboarding/operator/START_HERE.md`, and `.openslack/agents/onboarding/operator/claude_routine_prompt.md`.
- [ ] Have an administrator review the generated registration and provision local identity/authentication through supported setup.
- [ ] Run workspace validation and bootstrap from the repository root; missing local identity must fail.
- [ ] Confirm manual execution, correct repository, all required capabilities, risk and task/registry path intersection.
- [ ] Verify task readiness before making a real claim; no claim or heartbeat command is a dry-run probe.
- [ ] After a granted claim, record actual ownership, expiry, next heartbeat, branch, worktree, task ID and run ID.
- [ ] Validate allowed changes and use `task sync` with recorded IDs and exact paths.
- [ ] Keep human approval and live qualification separate from local structural checks.
- [ ] Never edit your own registry/prompts, expose credentials, push to main or fabricate completion evidence.
