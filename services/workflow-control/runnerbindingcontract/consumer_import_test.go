package runnerbindingcontract_test

import (
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerbindingcontract"
)

func TestConsumerCanImportPureMirrorWithoutReceivingAuthority(t *testing.T) {
	if runnerbindingcontract.HasDurableAuthority() {
		t.Fatal("imported F2a mirror claimed durable authority")
	}
}
