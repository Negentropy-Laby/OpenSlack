package organizationgraph

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"reflect"
	"sort"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphjson"
)

func TestGeneratedManifestMatchesGoContract(t *testing.T) {
	data, err := os.ReadFile("internal/contractmirror/generated/v1/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest struct {
		Schema       string `json:"schema"`
		Authority    string `json:"authority"`
		GraphSchemas struct {
			Snapshot string `json:"snapshot"`
			Delta    string `json:"delta"`
		} `json:"graphSchemas"`
		AuthorityProviders  []string          `json:"authorityProviders"`
		HardLimits          map[string]int    `json:"hardLimits"`
		ValueLimits         map[string]int    `json:"valueLimits"`
		StrictJSONLimits    map[string]int    `json:"strictJsonLimits"`
		QueryProtocolLimits map[string]int    `json:"queryProtocolLimits"`
		Algorithms          map[string]string `json:"algorithms"`
		ErrorCodes          struct {
			CanonicalJSON []string `json:"canonicalJson"`
			GraphContract []string `json:"graphContract"`
			GraphQuery    []string `json:"graphQuery"`
			StrictJSON    []string `json:"strictJson"`
		} `json:"errorCodes"`
		Artifacts map[string]struct {
			Path   string `json:"path"`
			SHA256 string `json:"sha256"`
		} `json:"artifacts"`
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&manifest); err != nil {
		t.Fatal(err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		t.Fatalf("manifest contains trailing JSON data: %v", err)
	}
	if manifest.Schema != "openslack.organization_graph_contract_manifest.v1" ||
		manifest.Authority != "typescript" {
		t.Fatalf("manifest identity drift: %s/%s", manifest.Schema, manifest.Authority)
	}
	if manifest.GraphSchemas.Snapshot != graphcontract.SnapshotSchema ||
		manifest.GraphSchemas.Delta != graphcontract.DeltaSchema {
		t.Fatalf("schema drift: %+v", manifest.GraphSchemas)
	}
	if !reflect.DeepEqual(manifest.AuthorityProviders, graphcontract.AuthorityProviders()) {
		t.Fatalf("authority-provider drift: %v", manifest.AuthorityProviders)
	}
	expectedLimits := map[string]int{
		"depth": graphcontract.MaxDepth, "nodes": graphcontract.MaxNodes,
		"edges": graphcontract.MaxEdges, "responseBytes": graphcontract.MaxResponseBytes,
		"propertyDepth": graphcontract.MaxPropertyDepth, "propertyKeys": graphcontract.MaxPropertyKeys,
		"propertyItems": graphcontract.MaxPropertyItems, "evidenceRefs": graphcontract.MaxEvidenceRefs,
		"owners": graphcontract.MaxOwners, "sourceEventIds": graphcontract.MaxSourceEventIDs,
		"snapshotNodes": graphcontract.MaxSnapshotNodes, "snapshotEdges": graphcontract.MaxSnapshotEdges,
		"deltaEvidenceRefs": graphcontract.MaxDeltaEvidenceRefs,
		"traversalSteps":    graphcontract.MaxTraversalSteps,
	}
	if !reflect.DeepEqual(manifest.HardLimits, expectedLimits) {
		t.Fatalf("hard-limit drift:\n got %v\nwant %v", manifest.HardLimits, expectedLimits)
	}
	expectedValueLimits := map[string]int{
		"boundedStringCharacters":       MaxBoundedStringCharacters,
		"identifierCharacters":          MaxIdentifierCharacters,
		"dateTimeCharacters":            MaxDateTimeCharacters,
		"authorityObjectTypeCharacters": MaxAuthorityObjectTypeCharacters,
		"propertyStringCharacters":      MaxPropertyStringCharacters,
		"completenessItems":             MaxCompletenessItems,
		"queryFilterItems":              MaxQueryFilterItems,
	}
	if !reflect.DeepEqual(manifest.ValueLimits, expectedValueLimits) {
		t.Fatalf("value-limit drift:\n got %v\nwant %v", manifest.ValueLimits, expectedValueLimits)
	}
	defaults := graphjson.DefaultLimits()
	if defaults.MaxDepth == nil || defaults.MaxNodes == nil || defaults.MaxStringLength == nil {
		t.Fatal("default strict-JSON limits must be explicit")
	}
	expectedStrictLimits := map[string]int{
		"maxDepth":        *defaults.MaxDepth,
		"maxNodes":        *defaults.MaxNodes,
		"maxStringLength": *defaults.MaxStringLength,
	}
	if !reflect.DeepEqual(manifest.StrictJSONLimits, expectedStrictLimits) {
		t.Fatalf("strict-JSON limit drift:\n got %v\nwant %v", manifest.StrictJSONLimits, expectedStrictLimits)
	}
	expectedQueryLimits := map[string]int{
		"defaultCursorTtlMs":            int(DefaultCursorTTLMS),
		"minCursorTtlMs":                int(MinCursorTTLMS),
		"maxCursorTtlMs":                int(MaxCursorTTLMS),
		"minResponseBytes":              MinQueryResponseBytes,
		"cursorCharacters":              CursorCharacters,
		"cursorSecretMinBytes":          CursorSecretMinBytes,
		"cursorSecretMaxBytes":          CursorSecretMaxBytes,
		"cursorPayloadDepth":            CursorPayloadDepth,
		"cursorPayloadNodes":            CursorPayloadNodes,
		"cursorPayloadStringCharacters": CursorPayloadStringCharacters,
	}
	if !reflect.DeepEqual(manifest.QueryProtocolLimits, expectedQueryLimits) {
		t.Fatalf("query-protocol limit drift:\n got %v\nwant %v", manifest.QueryProtocolLimits, expectedQueryLimits)
	}
	expectedAlgorithms := map[string]string{
		"strictJson":         AlgorithmStrictJSON,
		"canonicalJson":      AlgorithmCanonicalJSON,
		"nodeIdentity":       AlgorithmNodeIdentity,
		"edgeIdentity":       AlgorithmEdgeIdentity,
		"snapshotIntegrity":  AlgorithmSnapshotIntegrity,
		"deltaIntegrity":     AlgorithmDeltaIntegrity,
		"queryNormalization": AlgorithmQueryNormalization,
		"queryCursor":        AlgorithmQueryCursor,
		"explain":            AlgorithmExplain,
	}
	if !reflect.DeepEqual(manifest.Algorithms, expectedAlgorithms) {
		t.Fatalf("algorithm drift:\n got %v\nwant %v", manifest.Algorithms, expectedAlgorithms)
	}

	assertStringSet(t, "canonical errors", manifest.ErrorCodes.CanonicalJSON, []string{
		string(graphjson.CanonicalNonFinite), string(graphjson.CanonicalUnsupported),
		string(graphjson.CanonicalForbidden), string(graphjson.CanonicalUndefined),
		string(graphjson.CanonicalSparseArray),
	})
	assertStringSet(t, "contract errors", manifest.ErrorCodes.GraphContract, []string{
		string(ContractSchemaInvalid), string(ContractBoundExceeded), string(ContractScopeInvalid),
		string(ContractReferenceInvalid), string(ContractPropertyUnsafe), string(ContractIntegrityInvalid),
	})
	assertStringSet(t, "query errors", manifest.ErrorCodes.GraphQuery, []string{
		string(QueryInvalid), string(QueryCursorInvalid), string(QueryCursorExpired),
		string(QueryCursorMismatch), string(QueryTargetNotFound), string(QueryPathNotFound),
	})
	assertStringSet(t, "strict errors", manifest.ErrorCodes.StrictJSON, []string{
		string(graphjson.ErrorUTF8Invalid), string(graphjson.ErrorBOMForbidden),
		string(graphjson.ErrorSyntax), string(graphjson.ErrorDuplicateKey), string(graphjson.ErrorLimit),
	})

	artifactNames := make([]string, 0, len(manifest.Artifacts))
	for artifactName := range manifest.Artifacts {
		artifactNames = append(artifactNames, artifactName)
	}
	assertStringSet(t, "artifacts", artifactNames, []string{
		"snapshotSchema", "deltaSchema", "goldenVectors",
	})
	for artifactName, artifact := range manifest.Artifacts {
		mirrorPath := "internal/contractmirror/generated/v1/" + artifact.Path
		mirror, readErr := os.ReadFile(mirrorPath)
		if readErr != nil {
			t.Fatalf("%s: %v", artifactName, readErr)
		}
		sum := sha256.Sum256(mirror)
		if hex.EncodeToString(sum[:]) != artifact.SHA256 {
			t.Fatalf("%s digest does not match manifest", artifactName)
		}
		source, sourceErr := os.ReadFile("../../packages/organization-graph/contracts/v1/" + artifact.Path)
		if sourceErr != nil {
			t.Fatalf("%s source: %v", artifactName, sourceErr)
		}
		if !reflect.DeepEqual(mirror, source) {
			t.Fatalf("%s mirror differs from TypeScript authority bytes", artifactName)
		}
	}
}

func assertStringSet(t *testing.T, name string, actual, expected []string) {
	t.Helper()
	actual = append([]string{}, actual...)
	expected = append([]string{}, expected...)
	sort.Strings(actual)
	sort.Strings(expected)
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("%s drift:\n got %v\nwant %v", name, actual, expected)
	}
}
