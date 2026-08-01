package contracttodelivery

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"testing"

	graph "github.com/Negentropy-Laby/OpenSlack/services/organization-graph"
)

type goldenFile struct {
	Schema       string `json:"schema"`
	Authority    string `json:"authority"`
	ProjectorID  string `json:"projectorId"`
	SourceSchema string `json:"sourceSchema"`
	Randomized   struct {
		Algorithm string `json:"algorithm"`
		Seed      string `json:"seed"`
		Cases     int    `json:"cases"`
	} `json:"randomized"`
	Cases []goldenCase `json:"cases"`
}

type goldenCase struct {
	ID                string `json:"id"`
	Family            string `json:"family"`
	Operation         string `json:"operation"`
	SourceSchemaValid bool   `json:"sourceSchemaValid"`
	Input             struct {
		Source json.RawMessage `json:"source"`
	} `json:"input"`
	Expected *struct {
		ProjectorID            string          `json:"projectorId"`
		Snapshot               json.RawMessage `json:"snapshot"`
		CanonicalSnapshotBytes struct {
			UTF8Base64 string `json:"utf8Base64"`
			ByteLength int    `json:"byteLength"`
			SHA256     string `json:"sha256"`
		} `json:"canonicalSnapshotBytes"`
		IntegrityHash string   `json:"integrityHash"`
		NodeIDs       []string `json:"nodeIds"`
		EdgeIDs       []string `json:"edgeIds"`
		Completeness  struct {
			SourcesRequested []string `json:"sourcesRequested"`
			SourcesObserved  []string `json:"sourcesObserved"`
			MissingSources   []string `json:"missingSources"`
			Warnings         []string `json:"warnings"`
		} `json:"completeness"`
		Warnings []string `json:"warnings"`
	} `json:"expected"`
	ExpectedError *struct {
		Name    string `json:"name"`
		Code    string `json:"code"`
		Message string `json:"message"`
		Path    string `json:"path"`
	} `json:"expectedError"`
}

func loadGolden(t *testing.T) goldenFile {
	t.Helper()
	path := filepath.Join("..", "internal", "contractmirror", "generated", "contract-to-delivery", "v1", "projector-golden-vectors.json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read golden vectors: %v", err)
	}
	var result goldenFile
	if err := json.Unmarshal(data, &result); err != nil {
		t.Fatalf("decode golden vectors: %v", err)
	}
	return result
}

func canonicalRaw(t *testing.T, raw json.RawMessage) []byte {
	t.Helper()
	value, err := graph.ParseCanonicalJSON(raw, graph.DefaultJSONLimits())
	if err != nil {
		t.Fatalf("parse expected canonical JSON: %v", err)
	}
	encoded, err := graph.CanonicalJSON(value)
	if err != nil {
		t.Fatalf("encode expected canonical JSON: %v", err)
	}
	return encoded
}

func TestGeneratedProjectorGoldenVectors(t *testing.T) {
	golden := loadGolden(t)
	if golden.Schema != "openslack.contract_to_delivery_projector_golden_vectors.v1" || golden.Authority != "typescript" {
		t.Fatalf("unexpected golden authority: schema=%q authority=%q", golden.Schema, golden.Authority)
	}
	if golden.ProjectorID != ProjectorID || golden.SourceSchema != SourceSchema {
		t.Fatalf("golden identity mismatch: projector=%q source=%q", golden.ProjectorID, golden.SourceSchema)
	}
	if golden.Randomized.Algorithm != "mulberry32.v1" || golden.Randomized.Seed != "0xc7d2b11c" || golden.Randomized.Cases != 16 {
		t.Fatalf("randomized contract drift: %+v", golden.Randomized)
	}
	if len(golden.Cases) == 0 {
		t.Fatal("golden vector file has no cases")
	}

	caseIDs := make(map[string]struct{}, len(golden.Cases))
	successes, failures := 0, 0
	for _, testCase := range golden.Cases {
		if _, exists := caseIDs[testCase.ID]; exists {
			t.Fatalf("duplicate golden case ID %q", testCase.ID)
		}
		caseIDs[testCase.ID] = struct{}{}
		if testCase.ExpectedError == nil {
			successes++
		} else {
			failures++
		}
		t.Run(testCase.ID, func(t *testing.T) {
			if testCase.Operation != "validate_and_project" {
				t.Fatalf("unsupported operation %q", testCase.Operation)
			}
			result, err := Project(testCase.Input.Source)
			if testCase.ExpectedError != nil {
				if err == nil {
					t.Fatal("Project succeeded, want contract error")
				}
				if testCase.ExpectedError.Name != "GraphContractError" {
					t.Fatalf("expected error name = %q", testCase.ExpectedError.Name)
				}
				var contractError *graph.ContractError
				if !errors.As(err, &contractError) {
					t.Fatalf("error type = %T, want *organizationgraph.ContractError: %v", err, err)
				}
				if string(contractError.Code) != testCase.ExpectedError.Code || contractError.Path != testCase.ExpectedError.Path {
					t.Fatalf("error metadata = (%s, %s), want (%s, %s)", contractError.Code, contractError.Path, testCase.ExpectedError.Code, testCase.ExpectedError.Path)
				}
				message := contractError.Path + ": " + contractError.Message
				if message != testCase.ExpectedError.Message {
					t.Fatalf("error message = %q, want %q", message, testCase.ExpectedError.Message)
				}
				return
			}
			if err != nil {
				t.Fatalf("Project failed: %v", err)
			}
			if testCase.Expected == nil {
				t.Fatal("successful vector has no expected result")
			}
			if result.ProjectorID != testCase.Expected.ProjectorID {
				t.Fatalf("projector ID = %q, want %q", result.ProjectorID, testCase.Expected.ProjectorID)
			}
			actual, err := graph.CanonicalJSON(graph.SnapshotValue(result.Snapshot))
			if err != nil {
				t.Fatalf("encode projected snapshot: %v", err)
			}
			expected := canonicalRaw(t, testCase.Expected.Snapshot)
			if !bytes.Equal(actual, expected) {
				t.Fatalf("projected canonical bytes differ: actual=%d expected=%d", len(actual), len(expected))
			}
			serialized, err := graph.SerializeSnapshot(result.Snapshot)
			if err != nil {
				t.Fatalf("serialize projected snapshot: %v", err)
			}
			expectedBytes, err := base64.StdEncoding.DecodeString(testCase.Expected.CanonicalSnapshotBytes.UTF8Base64)
			if err != nil {
				t.Fatalf("decode expected bytes: %v", err)
			}
			if !bytes.Equal(serialized, expectedBytes) {
				t.Fatalf("serialized snapshot bytes differ: actual=%d expected=%d", len(serialized), len(expectedBytes))
			}
			if len(serialized) != testCase.Expected.CanonicalSnapshotBytes.ByteLength {
				t.Fatalf("serialized byte length = %d, want %d", len(serialized), testCase.Expected.CanonicalSnapshotBytes.ByteLength)
			}
			digest := sha256.Sum256(serialized)
			if fmt.Sprintf("%x", digest) != testCase.Expected.CanonicalSnapshotBytes.SHA256 {
				t.Fatalf("serialized SHA-256 = %x, want %s", digest, testCase.Expected.CanonicalSnapshotBytes.SHA256)
			}
			if result.Snapshot.IntegrityHash != testCase.Expected.IntegrityHash {
				t.Fatalf("integrity hash = %q, want %q", result.Snapshot.IntegrityHash, testCase.Expected.IntegrityHash)
			}
			nodeIDs := make([]string, len(result.Snapshot.Nodes))
			for index, node := range result.Snapshot.Nodes {
				nodeIDs[index] = node.ID
			}
			if !slices.Equal(nodeIDs, testCase.Expected.NodeIDs) {
				t.Fatalf("node IDs differ\nactual: %v\nexpected: %v", nodeIDs, testCase.Expected.NodeIDs)
			}
			edgeIDs := make([]string, len(result.Snapshot.Edges))
			for index, edge := range result.Snapshot.Edges {
				edgeIDs[index] = edge.ID
			}
			if !slices.Equal(edgeIDs, testCase.Expected.EdgeIDs) {
				t.Fatalf("edge IDs differ\nactual: %v\nexpected: %v", edgeIDs, testCase.Expected.EdgeIDs)
			}
			actualCompleteness := result.Snapshot.Completeness
			if !slices.Equal(actualCompleteness.SourcesRequested, testCase.Expected.Completeness.SourcesRequested) ||
				!slices.Equal(actualCompleteness.SourcesObserved, testCase.Expected.Completeness.SourcesObserved) ||
				!slices.Equal(actualCompleteness.MissingSources, testCase.Expected.Completeness.MissingSources) ||
				!slices.Equal(actualCompleteness.Warnings, testCase.Expected.Completeness.Warnings) {
				t.Fatalf("completeness differs: actual=%+v expected=%+v", actualCompleteness, testCase.Expected.Completeness)
			}
			if !slices.Equal(actualCompleteness.Warnings, testCase.Expected.Warnings) {
				t.Fatalf("warnings = %v, want %v", actualCompleteness.Warnings, testCase.Expected.Warnings)
			}
		})
	}
	if successes == 0 || failures == 0 {
		t.Fatalf("golden vectors must cover success and error: successes=%d failures=%d", successes, failures)
	}
}
