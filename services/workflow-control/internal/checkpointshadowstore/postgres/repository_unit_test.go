package postgres

import (
	"strings"
	"testing"
)

func TestCheckpointRunLockKeyIsTextSafeAndUnambiguous(t *testing.T) {
	first := checkpointRunLockKey("workspace-a", "run-b")
	second := checkpointRunLockKey("workspace", "a-run-b")
	if strings.ContainsRune(first, '\x00') {
		t.Fatal("checkpoint run lock key contains a PostgreSQL-invalid NUL byte")
	}
	if first == second {
		t.Fatal("checkpoint run lock key is ambiguous across workspace/run boundaries")
	}
}
