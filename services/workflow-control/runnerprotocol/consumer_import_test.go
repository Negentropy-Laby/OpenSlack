package runnerprotocol_test

import (
	"testing"

	runnerprotocol "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerprotocol"
)

func TestPackageIsImportableWithoutRuntimeDependencies(t *testing.T) {
	if runnerprotocol.ProtocolVersion != "openslack.workflow_runner.v1" {
		t.Fatalf("unexpected protocol version %q", runnerprotocol.ProtocolVersion)
	}
	direction, err := runnerprotocol.DirectionForKind(runnerprotocol.KindEffectOutcome)
	if err != nil {
		t.Fatal(err)
	}
	if direction != runnerprotocol.DirectionRunnerToControl || !runnerprotocol.CanReceiveEventReceipt(runnerprotocol.KindEffectOutcome) {
		t.Fatalf("unexpected imported contract boundary: direction=%q receiptable=%t", direction, runnerprotocol.CanReceiveEventReceipt(runnerprotocol.KindEffectOutcome))
	}
	rules := runnerprotocol.ProtocolAdvancementRules()
	if !rules.CancelRequestPreemptsReceiptWait || !rules.CancelAckQueuedBehindOutstandingWorkerEvent ||
		!rules.CancelValidityEvaluatedAtRunnerReceipt || !rules.AppliedCancelAckMayFollowExpiry {
		t.Fatalf("cancel advancement rules are incomplete: %#v", rules)
	}
	rules.ReceiptRequiredFor[0] = runnerprotocol.KindEventReceipt
	if runnerprotocol.ProtocolAdvancementRules().ReceiptRequiredFor[0] == runnerprotocol.KindEventReceipt {
		t.Fatal("advancement rule slices were not defensively copied")
	}
	manifest := runnerprotocol.ContractManifestBytes()
	manifest[0] = 0
	if runnerprotocol.ContractManifestBytes()[0] == 0 {
		t.Fatal("embedded contract bytes were not defensively copied")
	}
}
