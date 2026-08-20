package runnerprotocols

import "testing"

func TestProtocolRegistryIsClosedAndReturnsIndependentCapabilities(t *testing.T) {
	if !IsSupported(V1) || !IsSupported(V2) || IsSupported("openslack.workflow_runner.v3") {
		t.Fatal("runner protocol registry is not the closed v1/v2 set")
	}
	if got := Enabled(false); len(got) != 1 || got[0] != V1 {
		t.Fatalf("default protocol set drifted: %v", got)
	}
	if got := Enabled(true); len(got) != 2 || got[0] != V1 || got[1] != V2 {
		t.Fatalf("v2 qualification protocol set drifted: %v", got)
	}
	first := Capabilities()
	first[0] = "mutated"
	if next := Capabilities(); !CapabilitiesMatch(next) || next[0] != "cancel_ack" {
		t.Fatalf("capability registry exposed mutable backing storage: %v", next)
	}
}
