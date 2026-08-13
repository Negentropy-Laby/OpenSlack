package main

import "testing"

func TestEffectShadowRequiresSchemaFive(t *testing.T) {
	if minimumSchemaVersion != 5 || maximumSchemaVersion != 5 {
		t.Fatalf("schema range=%d..%d", minimumSchemaVersion, maximumSchemaVersion)
	}
}
