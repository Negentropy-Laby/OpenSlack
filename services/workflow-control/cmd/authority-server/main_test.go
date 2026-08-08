package main

import "testing"

func TestAuthorityServerRequiresSchemaVersionThree(t *testing.T) {
	if requiredSchemaVersion != 3 {
		t.Fatalf("schema version=%d", requiredSchemaVersion)
	}
}
