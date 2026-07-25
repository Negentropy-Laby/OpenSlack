package calleraccess

import (
	"testing"
)

func TestValidateLoadedPepperGenerationsFailsClosedAndAllowsGraceGeneration(t *testing.T) {
	active := testPepper{id: "v2", value: []byte("active")}
	previous := testPepper{id: "v1", value: []byte("previous")}
	repo := newFakeRepo()
	repo.keys["old"] = AccessKeyRecord{KeyID: "old", PepperID: "v1", Status: "active"}
	if err := ValidateLoadedPepperGenerations(t.Context(), repo, NewPepperSet(active, previous)); err != nil {
		t.Fatalf("grace generation rejected: %v", err)
	}
	if err := ValidateLoadedPepperGenerations(t.Context(), repo, NewPepperSet(active, nil)); err == nil {
		t.Fatal("missing generation did not fail closed")
	}
	revoked := repo.keys["old"]
	revoked.Status = "revoked"
	repo.keys["old"] = revoked
	if err := ValidateLoadedPepperGenerations(t.Context(), repo, NewPepperSet(active, nil)); err != nil {
		t.Fatalf("revoked generation still required: %v", err)
	}
}
