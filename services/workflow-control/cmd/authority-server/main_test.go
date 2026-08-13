package main

import "testing"

func TestAuthorityServerRequiresSchemaVersionThree(t *testing.T) {
	if minimumSchemaVersion != 3 || maximumSchemaVersion != 5 {
		t.Fatalf("minimum schema version=%d", minimumSchemaVersion)
	}
}
