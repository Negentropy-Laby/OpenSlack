package organizationgraph

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"math"
	"os"
	"sort"
	"strings"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphjson"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphquery"
)

type goldenFile struct {
	Schema                  string       `json:"schema"`
	Authority               string       `json:"authority"`
	CanonicalizationRuntime string       `json:"canonicalizationRuntime"`
	Cases                   []goldenCase `json:"cases"`
}

type queryDTO struct {
	ScenarioInstanceID string    `json:"scenarioInstanceId"`
	RootNodeIDs        []string  `json:"rootNodeIds"`
	NodeTypes          []string  `json:"nodeTypes"`
	EdgeTypes          []string  `json:"edgeTypes"`
	Statuses           []string  `json:"statuses"`
	Direction          Direction `json:"direction"`
	Depth              *int      `json:"depth"`
	MaxNodes           *int      `json:"maxNodes"`
	MaxEdges           *int      `json:"maxEdges"`
	MaxResponseBytes   *int      `json:"maxResponseBytes"`
	IncludeEvidence    *bool     `json:"includeEvidence"`
	Cursor             *string   `json:"cursor"`
}

func (value queryDTO) input() QueryInput {
	return QueryInput{
		ScenarioInstanceID: value.ScenarioInstanceID, RootNodeIDs: value.RootNodeIDs,
		NodeTypes: value.NodeTypes, EdgeTypes: value.EdgeTypes, Statuses: value.Statuses,
		Direction: value.Direction, Depth: value.Depth, MaxNodes: value.MaxNodes,
		MaxEdges: value.MaxEdges, MaxResponseBytes: value.MaxResponseBytes,
		IncludeEvidence: value.IncludeEvidence, Cursor: value.Cursor,
	}
}

type goldenCase struct {
	ID            string          `json:"id"`
	Family        string          `json:"family"`
	Operation     string          `json:"operation"`
	Input         json.RawMessage `json:"input"`
	Expected      json.RawMessage `json:"expected"`
	ExpectedError json.RawMessage `json:"expectedError"`
}

type byteContractDTO struct {
	UTF8Base64 string `json:"utf8Base64"`
	ByteLength int    `json:"byteLength"`
	SHA256     string `json:"sha256"`
}

type errorMetadata struct {
	Name    string `json:"name"`
	Message string `json:"message"`
}

type integritySerializationExpected struct {
	CanonicalValue json.RawMessage `json:"canonicalValue"`
	IntegrityHash  string          `json:"integrityHash"`
	Serialized     byteContractDTO `json:"serialized"`
	TrailingLF     bool            `json:"trailingLf"`
}

func decodeGolden(t *testing.T, data []byte, target any) {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		t.Fatal(err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		t.Fatalf("golden JSON contains trailing data: %v", err)
	}
}

func taggedGoldenValue(t *testing.T, kind string) graphjson.Value {
	t.Helper()
	switch kind {
	case "undefined_object_member":
		return graphjson.Object{"value": graphjson.Undefined}
	case "nan":
		return math.NaN()
	case "positive_infinity":
		return math.Inf(1)
	case "negative_infinity":
		return math.Inf(-1)
	case "sparse_array":
		return graphjson.SparseArray{
			Length: 2, Elements: map[int]graphjson.Value{1: "present"},
		}
	case "bigint", "symbol", "function":
		return struct{ Kind string }{Kind: kind}
	case "mixed_nonfinite_then_forbidden":
		return graphjson.Object{"a": math.NaN(), "constructor": float64(1)}
	case "long_string_above_strict_limit":
		return strings.Repeat("x", 32_769)
	case "depth_above_strict_limit":
		var value graphjson.Value = float64(0)
		for range 65 {
			value = graphjson.Array{value}
		}
		return value
	case "unpaired_high_surrogate_string":
		return string([]byte{0xed, 0xa0, 0x80})
	case "unpaired_low_surrogate_key":
		return graphjson.Object{string([]byte{0xed, 0xb0, 0x80}): true}
	default:
		t.Fatalf("unknown tagged JavaScript value %q", kind)
		return nil
	}
}

func loadGolden(t *testing.T) goldenFile {
	t.Helper()
	data, err := os.ReadFile("internal/contractmirror/generated/v1/golden-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var result goldenFile
	decodeGolden(t, data, &result)
	return result
}

func findGolden(t *testing.T, id string) goldenCase {
	t.Helper()
	for _, testCase := range loadGolden(t).Cases {
		if testCase.ID == id {
			return testCase
		}
	}
	t.Fatalf("missing golden case %s", id)
	return goldenCase{}
}

func canonicalSnapshotRaw(t *testing.T) json.RawMessage {
	t.Helper()
	testCase := findGolden(t, "snapshot-canonical-integrity-and-serialization")
	var expected integritySerializationExpected
	decodeGolden(t, testCase.Expected, &expected)
	return expected.CanonicalValue
}

func TestGeneratedCanonicalAndStrictJSONVectors(t *testing.T) {
	for _, testCase := range loadGolden(t).Cases {
		testCase := testCase
		switch testCase.Family {
		case "canonical_json":
			t.Run(testCase.ID, func(t *testing.T) {
				var value graphjson.Value
				switch testCase.Operation {
				case "parse_then_canonicalize":
					var input byteContractDTO
					decodeGolden(t, testCase.Input, &input)
					raw, err := base64.StdEncoding.DecodeString(input.UTF8Base64)
					if err != nil {
						t.Fatal(err)
					}
					value, err = graphjson.Parse(raw, graphjson.Limits{})
					if err != nil {
						t.Fatal(err)
					}
				case "canonicalize_tagged_javascript_value":
					var input struct {
						ValueSpec struct {
							Kind string `json:"kind"`
						} `json:"valueSpec"`
					}
					decodeGolden(t, testCase.Input, &input)
					value = taggedGoldenValue(t, input.ValueSpec.Kind)
				default:
					t.Fatalf("unknown canonical operation %q", testCase.Operation)
				}
				var expected byteContractDTO
				decodeGolden(t, testCase.Expected, &expected)
				actual, err := graphjson.Encode(value)
				if err != nil {
					t.Fatal(err)
				}
				want, err := base64.StdEncoding.DecodeString(expected.UTF8Base64)
				if err != nil {
					t.Fatal(err)
				}
				if string(actual) != string(want) {
					t.Fatalf("got %s, want %s", actual, want)
				}
			})
		case "canonical_json_error":
			t.Run(testCase.ID, func(t *testing.T) {
				var expected struct {
					errorMetadata
					Code graphjson.CanonicalErrorCode `json:"code"`
					Path string                       `json:"path"`
				}
				decodeGolden(t, testCase.ExpectedError, &expected)
				var value graphjson.Value
				if testCase.Operation == "parse_then_canonicalize" {
					var input struct {
						byteContractDTO
					}
					decodeGolden(t, testCase.Input, &input)
					raw, err := base64.StdEncoding.DecodeString(input.UTF8Base64)
					if err != nil {
						t.Fatal(err)
					}
					value, err = graphjson.Parse(raw, graphjson.Limits{})
					if err != nil {
						t.Fatal(err)
					}
				} else if testCase.Operation == "canonicalize_tagged_javascript_value" {
					var input struct {
						ValueSpec struct {
							Kind string `json:"kind"`
						} `json:"valueSpec"`
					}
					decodeGolden(t, testCase.Input, &input)
					value = taggedGoldenValue(t, input.ValueSpec.Kind)
				} else {
					t.Fatalf("unknown canonical error operation %q", testCase.Operation)
				}
				_, err := graphjson.Encode(value)
				var canonicalError *graphjson.CanonicalError
				if !errors.As(err, &canonicalError) || canonicalError.Code != expected.Code || canonicalError.Path != expected.Path {
					t.Fatalf("got %v, want %s at %s", err, expected.Code, expected.Path)
				}
			})
		case "strict_json_error":
			t.Run(testCase.ID, func(t *testing.T) {
				if testCase.Operation != "parse_strict_graph_json" {
					t.Fatalf("unknown strict JSON operation %q", testCase.Operation)
				}
				var input struct {
					byteContractDTO
					Limits struct {
						MaxDepth        *int `json:"maxDepth"`
						MaxNodes        *int `json:"maxNodes"`
						MaxStringLength *int `json:"maxStringLength"`
					} `json:"limits"`
				}
				var expected struct {
					errorMetadata
					Code   graphjson.ErrorCode `json:"code"`
					Offset int                 `json:"offset"`
				}
				decodeGolden(t, testCase.Input, &input)
				decodeGolden(t, testCase.ExpectedError, &expected)
				raw, err := base64.StdEncoding.DecodeString(input.UTF8Base64)
				if err != nil {
					t.Fatal(err)
				}
				_, err = graphjson.Parse(raw, graphjson.Limits{
					MaxDepth: input.Limits.MaxDepth, MaxNodes: input.Limits.MaxNodes,
					MaxStringLength: input.Limits.MaxStringLength,
				})
				var strictError *graphjson.Error
				if !errors.As(err, &strictError) || strictError.Code != expected.Code || strictError.Offset != expected.Offset {
					t.Fatalf("got %v, want %s at %d", err, expected.Code, expected.Offset)
				}
			})
		}
	}
}

func TestGeneratedIdentityVectors(t *testing.T) {
	for _, testCase := range loadGolden(t).Cases {
		if testCase.Family != "identity" {
			continue
		}
		testCase := testCase
		t.Run(testCase.ID, func(t *testing.T) {
			var input struct {
				ScenarioInstanceID     string        `json:"scenarioInstanceId"`
				Type                   string        `json:"type"`
				From                   string        `json:"from"`
				To                     string        `json:"to"`
				AuthorityRef           *AuthorityRef `json:"authorityRef"`
				ReobservedAuthorityRef *AuthorityRef `json:"reobservedAuthorityRef"`
			}
			var expected struct {
				Value           string `json:"value"`
				ReobservedValue string `json:"reobservedValue"`
			}
			decodeGolden(t, testCase.Input, &input)
			decodeGolden(t, testCase.Expected, &expected)
			var actual string
			var err error
			switch testCase.Operation {
			case "derive_graph_node_id":
				if input.AuthorityRef == nil || input.ReobservedAuthorityRef == nil {
					t.Fatal("node identity vector requires both authority observations")
				}
				actual, err = DeriveNodeID(input.ScenarioInstanceID, input.Type, *input.AuthorityRef)
				if err == nil {
					var reobserved string
					reobserved, err = DeriveNodeID(
						input.ScenarioInstanceID,
						input.Type,
						*input.ReobservedAuthorityRef,
					)
					if err == nil && reobserved != expected.ReobservedValue {
						t.Fatalf("reobserved identity got %q, want %q", reobserved, expected.ReobservedValue)
					}
				}
			case "derive_graph_edge_id":
				actual, err = DeriveEdgeID(input.ScenarioInstanceID, input.Type, input.From, input.To, input.AuthorityRef)
			default:
				t.Fatalf("unknown identity operation %q", testCase.Operation)
			}
			if err != nil || actual != expected.Value {
				t.Fatalf("got %q, %v; want %q", actual, err, expected.Value)
			}
		})
	}
}

func TestGeneratedSnapshotAndDeltaSerializationVectors(t *testing.T) {
	for _, testCase := range loadGolden(t).Cases {
		if testCase.ID != "snapshot-canonical-integrity-and-serialization" &&
			testCase.ID != "delta-canonical-integrity-and-serialization" {
			continue
		}
		testCase := testCase
		t.Run(testCase.ID, func(t *testing.T) {
			var input struct {
				Value json.RawMessage `json:"value"`
			}
			var expected integritySerializationExpected
			decodeGolden(t, testCase.Input, &input)
			decodeGolden(t, testCase.Expected, &expected)
			want, err := base64.StdEncoding.DecodeString(expected.Serialized.UTF8Base64)
			if err != nil {
				t.Fatal(err)
			}
			if testCase.Family == "snapshot_integrity" {
				value, err := graphcontract.ParseSnapshot(input.Value)
				if err != nil {
					t.Fatal(err)
				}
				sealed, err := graphcontract.SealSnapshot(value)
				if err != nil {
					t.Fatal(err)
				}
				actual, err := graphcontract.SerializeSnapshot(sealed)
				if err != nil {
					t.Fatal(err)
				}
				if sealed.IntegrityHash != expected.IntegrityHash || string(actual) != string(want) {
					t.Fatalf("snapshot parity mismatch: hash=%s bytesEqual=%v", sealed.IntegrityHash, string(actual) == string(want))
				}
			} else {
				value, err := graphcontract.ParseDelta(input.Value)
				if err != nil {
					t.Fatal(err)
				}
				sealed, err := graphcontract.SealDelta(value)
				if err != nil {
					t.Fatal(err)
				}
				actual, err := graphcontract.SerializeDelta(sealed)
				if err != nil {
					t.Fatal(err)
				}
				if sealed.IntegrityHash != expected.IntegrityHash || string(actual) != string(want) {
					t.Fatalf("delta parity mismatch: hash=%s bytesEqual=%v", sealed.IntegrityHash, string(actual) == string(want))
				}
			}
		})
	}
}

func TestGeneratedQueryAndExplainVectors(t *testing.T) {
	vectors := loadGolden(t)
	for _, testCase := range vectors.Cases {
		testCase := testCase
		switch {
		case testCase.ID == "query-normalization-hash":
			t.Run(testCase.ID, func(t *testing.T) {
				if testCase.Family != "query" || testCase.Operation != "graph_query_hash" {
					t.Fatalf(
						"query hash vector routing drifted to %s/%s",
						testCase.Family,
						testCase.Operation,
					)
				}
				var input struct {
					Value queryDTO `json:"value"`
				}
				var expected struct {
					Value string `json:"value"`
				}
				decodeGolden(t, testCase.Input, &input)
				decodeGolden(t, testCase.Expected, &expected)
				actual, err := QueryHash(input.Value.input())
				if err != nil || actual != expected.Value {
					t.Fatalf("got %q, %v; want %q", actual, err, expected.Value)
				}
			})
		case testCase.Family == "query" || testCase.Family == "query_cursor":
			if testCase.Operation != "query_graph" {
				t.Fatalf("unknown query operation %q for %s", testCase.Operation, testCase.ID)
			}
			t.Run(testCase.ID, func(t *testing.T) {
				var input struct {
					Snapshot json.RawMessage `json:"snapshot"`
					Query    queryDTO        `json:"query"`
					Options  struct {
						CursorSecret string `json:"cursorSecret"`
						CursorTTLMS  *int64 `json:"cursorTtlMs"`
						Now          int64  `json:"now"`
					} `json:"options"`
				}
				decodeGolden(t, testCase.Input, &input)
				snapshot, err := ParseSnapshot(input.Snapshot)
				if err != nil {
					t.Fatal(err)
				}
				actual, err := Query(snapshot, input.Query.input(), QueryOptions{
					CursorSecret: []byte(input.Options.CursorSecret), CursorTTLMS: input.Options.CursorTTLMS,
					NowMS: input.Options.Now,
				})
				if err != nil {
					t.Fatal(err)
				}
				actualBytes, err := graphjson.Encode(graphquery.ResultValue(actual))
				if err != nil {
					t.Fatal(err)
				}
				expectedValue, err := graphjson.Parse(testCase.Expected, graphjson.Limits{})
				if err != nil {
					t.Fatal(err)
				}
				expectedBytes, err := graphjson.Encode(expectedValue)
				if err != nil {
					t.Fatal(err)
				}
				if string(actualBytes) != string(expectedBytes) {
					t.Fatalf("query parity mismatch:\n got %s\nwant %s", actualBytes, expectedBytes)
				}
			})
		case testCase.Family == "explain":
			t.Run(testCase.ID, func(t *testing.T) {
				if testCase.Operation != "explain_graph" {
					t.Fatalf("unknown explain operation %q", testCase.Operation)
				}
				var input struct {
					Snapshot json.RawMessage `json:"snapshot"`
					Explain  struct {
						ScenarioInstanceID string    `json:"scenarioInstanceId"`
						TargetID           string    `json:"targetId"`
						RootNodeID         *string   `json:"rootNodeId"`
						Direction          Direction `json:"direction"`
						Depth              *int      `json:"depth"`
					} `json:"explain"`
				}
				decodeGolden(t, testCase.Input, &input)
				snapshot, err := ParseSnapshot(input.Snapshot)
				if err != nil {
					t.Fatal(err)
				}
				actual, err := Explain(snapshot, ExplainInput{
					ScenarioInstanceID: input.Explain.ScenarioInstanceID, TargetID: input.Explain.TargetID,
					RootNodeID: input.Explain.RootNodeID, Direction: input.Explain.Direction,
					Depth: input.Explain.Depth,
				})
				if err != nil {
					t.Fatal(err)
				}
				actualBytes, err := graphjson.Encode(graphquery.ExplanationValue(actual))
				if err != nil {
					t.Fatal(err)
				}
				expectedValue, err := graphjson.Parse(testCase.Expected, graphjson.Limits{})
				if err != nil {
					t.Fatal(err)
				}
				expectedBytes, err := graphjson.Encode(expectedValue)
				if err != nil {
					t.Fatal(err)
				}
				if string(actualBytes) != string(expectedBytes) {
					t.Fatalf("explain parity mismatch:\n got %s\nwant %s", actualBytes, expectedBytes)
				}
			})
		}
	}
}

func TestGeneratedIntegrityBehaviorVectors(t *testing.T) {
	for _, id := range []string{
		"snapshot-generated-at-excluded-from-integrity",
		"delta-generated-at-excluded-from-integrity",
	} {
		id := id
		t.Run(id, func(t *testing.T) {
			testCase := findGolden(t, id)
			var input struct {
				Value    json.RawMessage `json:"value"`
				Baseline json.RawMessage `json:"baseline"`
			}
			var expected struct {
				IntegrityHash         string `json:"integrityHash"`
				BaselineIntegrityHash string `json:"baselineIntegrityHash"`
			}
			decodeGolden(t, testCase.Input, &input)
			decodeGolden(t, testCase.Expected, &expected)
			if strings.HasPrefix(id, "snapshot-") {
				value, err := ParseSnapshot(input.Value)
				if err != nil {
					t.Fatal(err)
				}
				baseline, err := ParseSnapshot(input.Baseline)
				if err != nil {
					t.Fatal(err)
				}
				sealed, err := SealSnapshot(value)
				if err != nil {
					t.Fatal(err)
				}
				baselineSealed, err := SealSnapshot(baseline)
				if err != nil {
					t.Fatal(err)
				}
				if sealed.IntegrityHash != expected.IntegrityHash ||
					baselineSealed.IntegrityHash != expected.BaselineIntegrityHash ||
					sealed.IntegrityHash != baselineSealed.IntegrityHash {
					t.Fatalf(
						"generatedAt changed snapshot integrity: value=%s baseline=%s",
						sealed.IntegrityHash,
						baselineSealed.IntegrityHash,
					)
				}
			} else {
				value, err := ParseDelta(input.Value)
				if err != nil {
					t.Fatal(err)
				}
				baseline, err := ParseDelta(input.Baseline)
				if err != nil {
					t.Fatal(err)
				}
				sealed, err := SealDelta(value)
				if err != nil {
					t.Fatal(err)
				}
				baselineSealed, err := SealDelta(baseline)
				if err != nil {
					t.Fatal(err)
				}
				if sealed.IntegrityHash != expected.IntegrityHash ||
					baselineSealed.IntegrityHash != expected.BaselineIntegrityHash ||
					sealed.IntegrityHash != baselineSealed.IntegrityHash {
					t.Fatalf(
						"generatedAt changed delta integrity: value=%s baseline=%s",
						sealed.IntegrityHash,
						baselineSealed.IntegrityHash,
					)
				}
			}
		})
	}

	for _, test := range []struct {
		id       string
		snapshot bool
	}{
		{"snapshot-integrity-verify-success-and-failure", true},
		{"delta-integrity-verify-success-and-failure", false},
	} {
		test := test
		t.Run(test.id, func(t *testing.T) {
			testCase := findGolden(t, test.id)
			var input struct {
				Valid    json.RawMessage `json:"valid"`
				Tampered json.RawMessage `json:"tampered"`
			}
			var expected struct {
				Valid    bool `json:"valid"`
				Tampered bool `json:"tampered"`
			}
			decodeGolden(t, testCase.Input, &input)
			decodeGolden(t, testCase.Expected, &expected)
			if test.snapshot {
				valid, err := ParseSnapshot(input.Valid)
				if err != nil {
					t.Fatal(err)
				}
				tampered, err := ParseSnapshot(input.Tampered)
				if err != nil {
					t.Fatal(err)
				}
				validResult, validErr := VerifySnapshotIntegrity(valid)
				tamperedResult, tamperedErr := VerifySnapshotIntegrity(tampered)
				if validErr != nil || tamperedErr != nil ||
					validResult != expected.Valid || tamperedResult != expected.Tampered {
					t.Fatalf(
						"got valid=%v/%v tampered=%v/%v, want valid=%v tampered=%v",
						validResult, validErr, tamperedResult, tamperedErr, expected.Valid, expected.Tampered,
					)
				}
			} else {
				valid, err := ParseDelta(input.Valid)
				if err != nil {
					t.Fatal(err)
				}
				tampered, err := ParseDelta(input.Tampered)
				if err != nil {
					t.Fatal(err)
				}
				validResult, validErr := VerifyDeltaIntegrity(valid)
				tamperedResult, tamperedErr := VerifyDeltaIntegrity(tampered)
				if validErr != nil || tamperedErr != nil ||
					validResult != expected.Valid || tamperedResult != expected.Tampered {
					t.Fatalf(
						"got valid=%v/%v tampered=%v/%v, want valid=%v tampered=%v",
						validResult, validErr, tamperedResult, tamperedErr, expected.Valid, expected.Tampered,
					)
				}
			}
		})
	}

	t.Run("snapshot-validity-submillisecond-date-parse-precision", func(t *testing.T) {
		testCase := findGolden(t, "snapshot-validity-submillisecond-date-parse-precision")
		var expected struct {
			Accepted       bool            `json:"accepted"`
			CanonicalValue json.RawMessage `json:"canonicalValue"`
		}
		var input struct {
			Value json.RawMessage `json:"value"`
		}
		decodeGolden(t, testCase.Input, &input)
		decodeGolden(t, testCase.Expected, &expected)
		value, err := ParseSnapshot(input.Value)
		if err != nil {
			t.Fatal(err)
		}
		sealed, err := SealSnapshot(value)
		if !expected.Accepted || err != nil {
			t.Fatalf("submillisecond vector rejected: err=%v", err)
		}
		actualBytes, err := graphjson.Encode(graphcontract.SnapshotValue(sealed))
		if err != nil {
			t.Fatal(err)
		}
		expectedValue, err := graphjson.Parse(expected.CanonicalValue, graphjson.Limits{})
		if err != nil {
			t.Fatal(err)
		}
		expectedBytes, err := graphjson.Encode(expectedValue)
		if err != nil {
			t.Fatal(err)
		}
		if string(actualBytes) != string(expectedBytes) {
			t.Fatalf("submillisecond canonical parity mismatch:\n got %s\nwant %s", actualBytes, expectedBytes)
		}
	})
}

func TestCanonicalizationDoesNotAliasInputPointers(t *testing.T) {
	snapshot, err := ParseSnapshot(canonicalSnapshotRaw(t))
	if err != nil {
		t.Fatal(err)
	}
	validTo := "2026-07-27T08:00:00.000Z"
	snapshot.Nodes[0].ValidTo = &validTo
	snapshot.Edges[0].ValidTo = &validTo
	authority := snapshot.Nodes[0].AuthorityRef
	snapshot.Edges[0].AuthorityRef = &authority
	snapshot.Edges[0].ID, err = DeriveEdgeID(
		snapshot.Edges[0].ScenarioInstanceID,
		snapshot.Edges[0].Type,
		snapshot.Edges[0].From,
		snapshot.Edges[0].To,
		snapshot.Edges[0].AuthorityRef,
	)
	if err != nil {
		t.Fatal(err)
	}
	edgeID := snapshot.Edges[0].ID
	canonical, err := CanonicalizeSnapshot(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	*snapshot.Nodes[0].Status = "mutated-status"
	*snapshot.Nodes[0].Owners[0].DisplayName = "mutated-owner"
	*snapshot.Nodes[0].ValidTo = "2026-07-28T08:00:00.000Z"
	snapshot.Edges[0].AuthorityRef.ObjectID = "mutated-authority"
	*snapshot.Edges[0].ValidTo = "2026-07-28T08:00:00.000Z"
	var canonicalEdge *Edge
	for index := range canonical.Edges {
		if canonical.Edges[index].ID == edgeID {
			canonicalEdge = &canonical.Edges[index]
			break
		}
	}
	if canonicalEdge == nil || canonicalEdge.AuthorityRef == nil || canonicalEdge.ValidTo == nil {
		t.Fatal("canonical edge clone was not retained")
	}
	if *canonical.Nodes[0].Status == "mutated-status" ||
		*canonical.Nodes[0].Owners[0].DisplayName == "mutated-owner" ||
		*canonical.Nodes[0].ValidTo == "2026-07-28T08:00:00.000Z" ||
		canonicalEdge.AuthorityRef.ObjectID == "mutated-authority" ||
		*canonicalEdge.ValidTo == "2026-07-28T08:00:00.000Z" {
		t.Fatal("canonical snapshot retained mutable pointers from input")
	}
}

func TestGeneratedContractErrorVectors(t *testing.T) {
	for _, testCase := range loadGolden(t).Cases {
		if testCase.Family != "contract_error" {
			continue
		}
		testCase := testCase
		t.Run(testCase.ID, func(t *testing.T) {
			var expected struct {
				errorMetadata
				Code ContractErrorCode `json:"code"`
				Path string            `json:"path"`
			}
			var input struct {
				Value json.RawMessage `json:"value"`
			}
			decodeGolden(t, testCase.ExpectedError, &expected)
			decodeGolden(t, testCase.Input, &input)
			var err error
			if testCase.Operation == "seal_graph_delta" {
				var delta Delta
				delta, err = ParseDelta(input.Value)
				if err == nil {
					_, err = SealDelta(delta)
				}
			} else {
				var snapshot Snapshot
				snapshot, err = ParseSnapshot(input.Value)
				if err == nil && testCase.Operation == "assert_graph_snapshot_integrity" {
					_, err = AssertSnapshotIntegrity(snapshot)
				} else if err == nil && testCase.Operation == "seal_graph_snapshot" {
					_, err = SealSnapshot(snapshot)
				} else if err == nil {
					t.Fatalf("unknown contract operation %q", testCase.Operation)
				}
			}
			var contractError *ContractError
			if !errors.As(err, &contractError) || contractError.Code != expected.Code || contractError.Path != expected.Path {
				t.Fatalf("got %v, want %s at %s", err, expected.Code, expected.Path)
			}
		})
	}
}

func TestGeneratedQueryErrorVectors(t *testing.T) {
	for _, testCase := range loadGolden(t).Cases {
		if testCase.Family != "query_error" {
			continue
		}
		testCase := testCase
		t.Run(testCase.ID, func(t *testing.T) {
			var expected struct {
				errorMetadata
				Code QueryErrorCode `json:"code"`
			}
			var input struct {
				Snapshot  json.RawMessage `json:"snapshot"`
				Query     queryDTO        `json:"query"`
				ValueSpec struct {
					Kind string `json:"kind"`
				} `json:"valueSpec"`
				Explain struct {
					ScenarioInstanceID string    `json:"scenarioInstanceId"`
					TargetID           string    `json:"targetId"`
					RootNodeID         *string   `json:"rootNodeId"`
					Direction          Direction `json:"direction"`
					Depth              *int      `json:"depth"`
				} `json:"explain"`
				Options struct {
					CursorSecret string `json:"cursorSecret"`
					CursorTTLMS  *int64 `json:"cursorTtlMs"`
					Now          int64  `json:"now"`
				} `json:"options"`
			}
			decodeGolden(t, testCase.ExpectedError, &expected)
			decodeGolden(t, testCase.Input, &input)
			var actualErr error
			if testCase.Operation == "graph_query_hash_tagged_input" {
				var scenarioInstanceID string
				switch input.ValueSpec.Kind {
				case "unpaired_high_surrogate_scenario_instance_id":
					scenarioInstanceID = string([]byte{0xed, 0xa0, 0x80})
				case "unpaired_low_surrogate_scenario_instance_id":
					scenarioInstanceID = string([]byte{0xed, 0xb0, 0x80})
				default:
					t.Fatalf("unknown tagged query input %q", input.ValueSpec.Kind)
				}
				_, actualErr = QueryHash(QueryInput{ScenarioInstanceID: scenarioInstanceID})
			} else if testCase.Operation == "explain_graph" {
				snapshot, err := ParseSnapshot(input.Snapshot)
				if err != nil {
					t.Fatal(err)
				}
				_, actualErr = Explain(snapshot, ExplainInput{
					ScenarioInstanceID: input.Explain.ScenarioInstanceID,
					TargetID:           input.Explain.TargetID,
					RootNodeID:         input.Explain.RootNodeID,
					Direction:          input.Explain.Direction,
					Depth:              input.Explain.Depth,
				})
			} else if testCase.Operation == "query_graph" {
				snapshot, err := ParseSnapshot(input.Snapshot)
				if err != nil {
					t.Fatal(err)
				}
				_, actualErr = Query(snapshot, input.Query.input(), QueryOptions{
					CursorSecret: []byte(input.Options.CursorSecret),
					CursorTTLMS:  input.Options.CursorTTLMS,
					NowMS:        input.Options.Now,
				})
			} else {
				t.Fatalf("unknown query error operation %q", testCase.Operation)
			}
			var queryError *QueryError
			if !errors.As(actualErr, &queryError) || queryError.Code != expected.Code {
				t.Fatalf("got %v, want %s", actualErr, expected.Code)
			}
		})
	}
}

func TestGeneratedVectorCoverageIsExhaustive(t *testing.T) {
	handled := map[string]struct{}{
		"canonical-object-order-and-negative-zero": {}, "canonical-ecmascript-number-boundaries": {},
		"canonical-utf16-key-order": {}, "canonical-cjk-key-order": {},
		"canonical-non-emoji-astral-key-order": {},
		"canonical-string-escaping":            {}, "canonical-control-character-escaping": {},
		"canonical-string-above-strict-json-limit": {}, "canonical-depth-above-strict-json-limit": {},
		"canonical-forbidden-key-__proto__": {}, "canonical-forbidden-key-prototype": {},
		"canonical-forbidden-key-constructor": {}, "node-identity-authority-object-only": {},
		"canonical-undefined-object-member": {}, "canonical-nan": {},
		"canonical-positive-infinity": {}, "canonical-negative-infinity": {},
		"canonical-sparse-array": {}, "canonical-bigint": {}, "canonical-symbol": {},
		"canonical-function":                       {},
		"canonical-mixed-error-precedence":         {},
		"canonical-unpaired-high-surrogate-string": {}, "canonical-unpaired-low-surrogate-key": {},
		"edge-identity-without-authority": {}, "edge-identity-with-authority": {},
		"snapshot-canonical-integrity-and-serialization": {}, "snapshot-generated-at-excluded-from-integrity": {},
		"snapshot-integrity-verify-success-and-failure": {}, "snapshot-validity-submillisecond-date-parse-precision": {},
		"delta-canonical-integrity-and-serialization": {}, "delta-generated-at-excluded-from-integrity": {},
		"delta-integrity-verify-success-and-failure": {}, "query-normalization-hash": {},
		"query-first-page-and-cursor": {}, "query-second-page-preserves-expiry": {},
		"query-byte-limit-truncation-and-response-size": {}, "explain-node-path": {}, "explain-edge-path": {},
		"contract-scenario-scope-error": {}, "contract-schema-error": {}, "contract-bound-error": {},
		"contract-reference-error": {}, "contract-property-error": {}, "integrity-mismatch-error": {},
		"contract-property-nbsp-script-error": {}, "contract-property-nbsp-bearer-error": {},
		"contract-snapshot-error-precedence": {}, "contract-delta-error-precedence": {},
		"contract-datetime-offset-hour-error": {}, "contract-datetime-offset-minute-error": {},
		"query-depth-error": {}, "query-unpaired-high-surrogate-error": {},
		"query-unpaired-low-surrogate-error": {}, "query-expiry-overflow-error": {},
		"cursor-expired-error": {}, "cursor-query-mismatch-error": {},
		"cursor-malformed-error": {}, "cursor-tampered-error": {}, "cursor-noncanonical-base64url-error": {},
		"cursor-nonzero-tail-bits-error": {}, "cursor-noncanonical-json-error": {},
		"cursor-offset-out-of-contract-bounds-error": {},
		"explain-target-not-found-error":             {}, "explain-path-not-found-error": {}, "explain-empty-root-error": {},
		"strict-json-invalid-utf8": {}, "strict-json-bom": {},
		"strict-json-duplicate-decoded-key": {}, "strict-json-syntax": {},
		"strict-json-unpaired-high-surrogate": {}, "strict-json-unpaired-low-surrogate": {}, "strict-json-limit": {},
		"strict-json-zero-max-depth": {}, "strict-json-negative-max-depth": {},
		"strict-json-zero-max-nodes": {}, "strict-json-negative-max-nodes": {},
		"strict-json-zero-max-string-length": {}, "strict-json-negative-max-string-length": {},
	}
	allowedOperations := map[string]struct{}{
		"canonical_json|parse_then_canonicalize":                    {},
		"canonical_json|canonicalize_tagged_javascript_value":       {},
		"canonical_json_error|parse_then_canonicalize":              {},
		"canonical_json_error|canonicalize_tagged_javascript_value": {},
		"identity|derive_graph_node_id":                             {},
		"identity|derive_graph_edge_id":                             {},
		"snapshot_integrity|seal_graph_snapshot":                    {},
		"snapshot_integrity|verify_graph_snapshot_integrity":        {},
		"delta_integrity|seal_graph_delta":                          {},
		"delta_integrity|verify_graph_delta_integrity":              {},
		"query|graph_query_hash":                                    {},
		"query|query_graph":                                         {},
		"query_cursor|query_graph":                                  {},
		"explain|explain_graph":                                     {},
		"contract_error|seal_graph_snapshot":                        {},
		"contract_error|seal_graph_delta":                           {},
		"contract_error|assert_graph_snapshot_integrity":            {},
		"query_error|query_graph":                                   {},
		"query_error|explain_graph":                                 {},
		"query_error|graph_query_hash_tagged_input":                 {},
		"strict_json_error|parse_strict_graph_json":                 {},
	}
	vectors := loadGolden(t)
	if len(vectors.Cases) != len(handled) {
		t.Fatalf("golden vector count changed: got %d, handled %d", len(vectors.Cases), len(handled))
	}
	seen := make(map[string]struct{}, len(vectors.Cases))
	for _, testCase := range vectors.Cases {
		if _, exists := seen[testCase.ID]; exists {
			t.Fatalf("duplicate golden vector ID %s", testCase.ID)
		}
		seen[testCase.ID] = struct{}{}
		if _, exists := handled[testCase.ID]; !exists {
			t.Fatalf("unhandled golden vector %s", testCase.ID)
		}
		if _, exists := allowedOperations[testCase.Family+"|"+testCase.Operation]; !exists {
			t.Fatalf(
				"unhandled golden family/operation %s/%s for %s",
				testCase.Family,
				testCase.Operation,
				testCase.ID,
			)
		}
		delete(handled, testCase.ID)
	}
	if len(handled) != 0 {
		missing := make([]string, 0, len(handled))
		for id := range handled {
			missing = append(missing, id)
		}
		sort.Strings(missing)
		t.Fatalf("declared golden vectors are missing from the fixture: %v", missing)
	}
}
