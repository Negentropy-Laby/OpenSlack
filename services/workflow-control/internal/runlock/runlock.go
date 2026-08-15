package runlock

import "strconv"

// AdvisorySalt is shared by every writer of the workflow_control_runs head.
// A subsystem-specific idempotency lock may be taken first, but all writers
// must then acquire this run lock before checking reconciliation gates or
// mutating the canonical run row.
const AdvisorySalt int64 = 628239560154202

// Key length-prefixes both identities so distinct workspace/run pairs cannot
// alias when joined for the PostgreSQL advisory-lock input.
func Key(workspaceID, runID string) string {
	return strconv.Itoa(len(workspaceID)) + ":" + workspaceID + strconv.Itoa(len(runID)) + ":" + runID
}
