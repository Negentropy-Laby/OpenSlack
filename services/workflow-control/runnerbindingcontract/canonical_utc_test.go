package runnerbindingcontract

import (
	"encoding/json"
	"os"
	"testing"
)

func TestSharedCanonicalUTCCorpus(t *testing.T) {
	data, err := os.ReadFile("../../../packages/workflows/contracts/workflow-runner-authority-binding/canonical-utc-corpus.json")
	if err != nil {
		t.Fatal(err)
	}
	var corpus []struct {
		Value    string `json:"value"`
		Accepted bool   `json:"accepted"`
	}
	if err := json.Unmarshal(data, &corpus); err != nil {
		t.Fatal(err)
	}
	for _, row := range corpus {
		t.Run(row.Value, func(t *testing.T) {
			_, err := timestampValue(row.Value, "$.time")
			if (err == nil) != row.Accepted {
				t.Fatalf("accepted=%v error=%v", row.Accepted, err)
			}
		})
	}
}
