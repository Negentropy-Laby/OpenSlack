package authoritycontract_test

import (
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerprotocol"
)

func TestImportedContractHasNoAuthorityAndDoesNotExpandRunnerV1(t *testing.T) {
	if authoritycontract.Authority != "typescript" ||
		authoritycontract.AuthorityClaim != "NO_AUTHORITY" ||
		authoritycontract.HasDurableAuthority() {
		t.Fatalf(
			"authority boundary drift: authority=%q claim=%q durable=%t",
			authoritycontract.Authority,
			authoritycontract.AuthorityClaim,
			authoritycontract.HasDurableAuthority(),
		)
	}
	if runnerprotocol.ProtocolVersion != "openslack.workflow_runner.v1" {
		t.Fatalf("runnerprotocol v1 changed to %q", runnerprotocol.ProtocolVersion)
	}
	if _, err := runnerprotocol.DirectionForKind(runnerprotocol.Kind(authoritycontract.KindCheckpointCommit)); err == nil {
		t.Fatal("runnerprotocol v1 unexpectedly accepted a GS9-A v2 message kind")
	}
}
