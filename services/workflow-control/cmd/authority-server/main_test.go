package main

import (
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/databaseready"
)

func TestAuthorityServerRequiresSchemaVersionThree(t *testing.T) {
	if databaseready.AuthorityProfile.Minimum != 3 || databaseready.AuthorityProfile.Maximum != databaseready.CurrentSchemaVersion {
		t.Fatalf("schema range=%d..%d", databaseready.AuthorityProfile.Minimum, databaseready.AuthorityProfile.Maximum)
	}
}
