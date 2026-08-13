package main

import "testing"

func TestCheckpointShadowRequiresSchemaFour(t *testing.T) {
	if minimumSchemaVersion != 4 || maximumSchemaVersion != 5 {
		t.Fatalf("schema range=%d..%d", minimumSchemaVersion, maximumSchemaVersion)
	}
}
