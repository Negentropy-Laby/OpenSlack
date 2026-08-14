package main

import (
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/databaseready"
)

func TestCheckpointShadowRequiresSchemaFour(t *testing.T) {
	if databaseready.CheckpointProfile.Minimum != 4 || databaseready.CheckpointProfile.Maximum != databaseready.CurrentSchemaVersion {
		t.Fatalf("schema range=%d..%d", databaseready.CheckpointProfile.Minimum, databaseready.CheckpointProfile.Maximum)
	}
}
