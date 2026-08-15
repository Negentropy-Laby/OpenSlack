package main

import (
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/databaseready"
)

func TestEffectShadowSupportsSchemaThroughVersionSix(t *testing.T) {
	if databaseready.EffectProfile.Minimum != 5 || databaseready.EffectProfile.Maximum != databaseready.CurrentSchemaVersion {
		t.Fatalf("schema range=%d..%d", databaseready.EffectProfile.Minimum, databaseready.EffectProfile.Maximum)
	}
}
