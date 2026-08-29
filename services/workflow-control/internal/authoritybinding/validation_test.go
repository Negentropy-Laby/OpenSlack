package authoritybinding

import (
	"encoding/json"
	"os"
	"testing"
)

type identityVectors struct {
	Schema string `json:"schema"`
	Tokens []struct {
		Value string `json:"value"`
		Valid bool   `json:"valid"`
	} `json:"tokens"`
	Epochs []struct {
		Value string `json:"value"`
		Valid bool   `json:"valid"`
	} `json:"epochs"`
}

func TestBearerTokenAndRoutingEpochVectors(t *testing.T) {
	bytes, err := os.ReadFile("testdata/routing_identity_vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors identityVectors
	if err := json.Unmarshal(bytes, &vectors); err != nil || vectors.Schema != "openslack.workflow_control_routing_identity_vectors.v1" {
		t.Fatalf("invalid routing identity vectors: %v", err)
	}
	for _, test := range vectors.Tokens {
		if ValidBearerToken(test.Value) != test.Valid {
			t.Fatalf("bearer validity for %q drifted", test.Value)
		}
	}
	for _, test := range vectors.Epochs {
		_, valid := ParseRoutingEpoch(test.Value)
		if valid != test.Valid {
			t.Fatalf("epoch validity for %q drifted", test.Value)
		}
	}
}
