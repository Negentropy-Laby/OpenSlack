package softwaredelivery

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"slices"
	"testing"

	graph "github.com/Negentropy-Laby/OpenSlack/services/organization-graph"
)

const (
	softwareDeliveryManifestSchema = "openslack.software_delivery_projector_contract_manifest.v1"
	softwareDeliveryVectorSchema   = "openslack.software_delivery_projector_golden_vectors.v1"
	softwareDeliveryAuthority      = "typescript"
	softwareDeliveryVectorSeed     = "0x5d02a11c"
	softwareDeliveryRandomCases    = 16
)

type softwareDeliveryManifest struct {
	Schema              string `json:"schema"`
	Authority           string `json:"authority"`
	SourceSchema        string `json:"sourceSchema"`
	ProjectorID         string `json:"projectorId"`
	GraphSnapshotSchema string `json:"graphSnapshotSchema"`
	SourceLimits        struct {
		ObservationsPerKind     int `json:"observationsPerKind"`
		TotalObservations       int `json:"totalObservations"`
		TotalRelations          int `json:"totalRelations"`
		SourceBytes             int `json:"sourceBytes"`
		SourceJSONNodes         int `json:"sourceJsonNodes"`
		SourceObjectProperties  int `json:"sourceObjectProperties"`
		SourceArrayItems        int `json:"sourceArrayItems"`
		ProjectedSnapshotBytes  int `json:"projectedSnapshotBytes"`
		LabelsPerIssue          int `json:"labelsPerIssue"`
		RelationsPerObservation int `json:"relationsPerObservation"`
		CompletenessEntries     int `json:"completenessEntries"`
		TextBytes               int `json:"textBytes"`
	} `json:"sourceLimits"`
	ProjectorContract struct {
		NodeTypes []string `json:"nodeTypes"`
		EdgeTypes []string `json:"edgeTypes"`
	} `json:"projectorContract"`
	Algorithms struct {
		Validation        string `json:"validation"`
		Projection        string `json:"projection"`
		CanonicalSnapshot string `json:"canonicalSnapshot"`
		NodeIdentity      string `json:"nodeIdentity"`
		EdgeIdentity      string `json:"edgeIdentity"`
		SnapshotIntegrity string `json:"snapshotIntegrity"`
		RandomizedCases   string `json:"randomizedCases"`
	} `json:"algorithms"`
	Randomized struct {
		Seed  string `json:"seed"`
		Cases int    `json:"cases"`
	} `json:"randomized"`
	ErrorCodes struct {
		GraphContract []string `json:"graphContract"`
		StrictJSON    []string `json:"strictJson"`
	} `json:"errorCodes"`
	VectorInventory softwareDeliveryVectorInventory `json:"vectorInventory"`
	Artifacts       struct {
		SourceSchema           softwareDeliveryArtifact `json:"sourceSchema"`
		ProjectorGoldenVectors softwareDeliveryArtifact `json:"projectorGoldenVectors"`
	} `json:"artifacts"`
}

type softwareDeliveryVectorInventory struct {
	Total         int            `json:"total"`
	Success       int            `json:"success"`
	Error         int            `json:"error"`
	SchemaValid   int            `json:"schemaValid"`
	SchemaInvalid int            `json:"schemaInvalid"`
	Families      map[string]int `json:"families"`
	Random        int            `json:"random"`
}

type softwareDeliveryArtifact struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

func TestGeneratedManifestMatchesSoftwareDeliveryContract(t *testing.T) {
	mirrorRoot := filepath.Join("..", "internal", "contractmirror", "generated", "software-delivery", "v1")
	authorityRoot := filepath.Join("..", "..", "..", "packages", "organization-graph", "contracts", "software-delivery", "v1")
	manifestPath := filepath.Join(mirrorRoot, "manifest.json")
	manifestBytes, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatalf("read software-delivery manifest: %v", err)
	}

	// encoding/json accepts duplicate object keys. Parse with the shared strict
	// JSON implementation first, then use a closed struct for shape checking.
	if _, err := graph.ParseCanonicalJSON(manifestBytes, graph.DefaultJSONLimits()); err != nil {
		t.Fatalf("strict-parse software-delivery manifest: %v", err)
	}
	var manifest softwareDeliveryManifest
	decodeClosedJSON(t, manifestBytes, &manifest)

	if manifest.Schema != softwareDeliveryManifestSchema || manifest.Authority != softwareDeliveryAuthority {
		t.Fatalf("manifest identity drift: schema=%q authority=%q", manifest.Schema, manifest.Authority)
	}
	if manifest.SourceSchema != SourceSchema || manifest.ProjectorID != ProjectorID || manifest.GraphSnapshotSchema != graph.SnapshotSchema {
		t.Fatalf("manifest contract identity drift: source=%q projector=%q graph=%q", manifest.SourceSchema, manifest.ProjectorID, manifest.GraphSnapshotSchema)
	}

	expectedLimits := manifest.SourceLimits
	expectedLimits.ObservationsPerKind = MaxObservationsPerKind
	expectedLimits.TotalObservations = MaxTotalObservations
	expectedLimits.TotalRelations = MaxTotalRelations
	expectedLimits.SourceBytes = MaxSourceBytes
	expectedLimits.SourceJSONNodes = MaxSourceJSONNodes
	expectedLimits.SourceObjectProperties = MaxSourceProperties
	expectedLimits.SourceArrayItems = MaxSourceArrayItems
	expectedLimits.ProjectedSnapshotBytes = MaxProjectedBytes
	expectedLimits.LabelsPerIssue = MaxLabelsPerIssue
	expectedLimits.RelationsPerObservation = MaxRelationsPerItem
	expectedLimits.CompletenessEntries = MaxCompletenessEntries
	expectedLimits.TextBytes = MaxTextBytes
	if manifest.SourceLimits != expectedLimits {
		t.Fatalf("source-limit drift:\n got %+v\nwant %+v", manifest.SourceLimits, expectedLimits)
	}

	expectedAlgorithms := manifest.Algorithms
	expectedAlgorithms.Validation = "openslack.software_delivery_source_validation.v1"
	expectedAlgorithms.Projection = ProjectorID
	expectedAlgorithms.CanonicalSnapshot = "openslack.ecmascript_canonical_json.v1+lf"
	expectedAlgorithms.NodeIdentity = graph.AlgorithmNodeIdentity
	expectedAlgorithms.EdgeIdentity = graph.AlgorithmEdgeIdentity
	expectedAlgorithms.SnapshotIntegrity = graph.AlgorithmSnapshotIntegrity
	expectedAlgorithms.RandomizedCases = "mulberry32.v1"
	if manifest.Algorithms != expectedAlgorithms {
		t.Fatalf("algorithm drift:\n got %+v\nwant %+v", manifest.Algorithms, expectedAlgorithms)
	}
	if manifest.Randomized.Seed != softwareDeliveryVectorSeed || manifest.Randomized.Cases != softwareDeliveryRandomCases {
		t.Fatalf("randomized contract drift: %+v", manifest.Randomized)
	}

	if !slices.Equal(manifest.ProjectorContract.NodeTypes, expectedSoftwareDeliveryNodeTypes) {
		t.Fatalf("projector node-type inventory drift:\n got %v\nwant %v", manifest.ProjectorContract.NodeTypes, expectedSoftwareDeliveryNodeTypes)
	}
	if !slices.Equal(manifest.ProjectorContract.EdgeTypes, expectedSoftwareDeliveryEdgeTypes) {
		t.Fatalf("projector edge-type inventory drift:\n got %v\nwant %v", manifest.ProjectorContract.EdgeTypes, expectedSoftwareDeliveryEdgeTypes)
	}
	if !slices.Equal(manifest.ErrorCodes.GraphContract, expectedSoftwareDeliveryGraphErrors) {
		t.Fatalf("graph error-code inventory drift: %v", manifest.ErrorCodes.GraphContract)
	}
	if !slices.Equal(manifest.ErrorCodes.StrictJSON, expectedSoftwareDeliveryJSONErrors) {
		t.Fatalf("strict-JSON error-code inventory drift: %v", manifest.ErrorCodes.StrictJSON)
	}

	expectedInventory := frozenSoftwareDeliveryVectorInventory()
	if !reflect.DeepEqual(manifest.VectorInventory, expectedInventory) {
		t.Fatalf("vector inventory drift:\n got %+v\nwant %+v", manifest.VectorInventory, expectedInventory)
	}

	assertSoftwareDeliveryArtifact(t, mirrorRoot, authorityRoot, "source schema", manifest.Artifacts.SourceSchema,
		filepath.Join("schemas", "software-delivery-source-snapshot.v1.schema.json"))
	vectorBytes := assertSoftwareDeliveryArtifact(t, mirrorRoot, authorityRoot, "projector golden vectors",
		manifest.Artifacts.ProjectorGoldenVectors, "projector-golden-vectors.json")
	assertSoftwareDeliveryVectorInventory(t, vectorBytes, manifest)

	authorityManifest, err := os.ReadFile(filepath.Join(authorityRoot, "manifest.json"))
	if err != nil {
		t.Fatalf("read TypeScript-authority manifest: %v", err)
	}
	if !bytes.Equal(manifestBytes, authorityManifest) {
		t.Fatal("Go service manifest mirror differs from TypeScript-authority bytes")
	}
}

func decodeClosedJSON(t *testing.T, data []byte, destination any) {
	t.Helper()
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		t.Fatalf("closed-decode JSON: %v", err)
	}
	if err := decoder.Decode(&struct{}{}); !errors.Is(err, io.EOF) {
		t.Fatalf("JSON contains trailing data: %v", err)
	}
}

func assertSoftwareDeliveryArtifact(t *testing.T, mirrorRoot, authorityRoot, name string, artifact softwareDeliveryArtifact, expectedPath string) []byte {
	t.Helper()
	if artifact.Path != expectedPath {
		t.Fatalf("%s path = %q, want %q", name, artifact.Path, expectedPath)
	}
	mirror, err := os.ReadFile(filepath.Join(mirrorRoot, expectedPath))
	if err != nil {
		t.Fatalf("read mirrored %s: %v", name, err)
	}
	digest := sha256.Sum256(mirror)
	if hex.EncodeToString(digest[:]) != artifact.SHA256 {
		t.Fatalf("%s raw-byte SHA-256 does not match manifest", name)
	}
	authority, err := os.ReadFile(filepath.Join(authorityRoot, expectedPath))
	if err != nil {
		t.Fatalf("read TypeScript-authority %s: %v", name, err)
	}
	if !bytes.Equal(mirror, authority) {
		t.Fatalf("mirrored %s differs from TypeScript-authority bytes", name)
	}
	return mirror
}

func assertSoftwareDeliveryVectorInventory(t *testing.T, data []byte, manifest softwareDeliveryManifest) {
	t.Helper()
	var vectors projectorGoldenFile
	if err := json.Unmarshal(data, &vectors); err != nil {
		t.Fatalf("decode projector vector inventory: %v", err)
	}
	if vectors.Schema != softwareDeliveryVectorSchema || vectors.Authority != softwareDeliveryAuthority ||
		vectors.ProjectorID != ProjectorID || vectors.SourceSchema != SourceSchema {
		t.Fatalf("vector identity drift: schema=%q authority=%q projector=%q source=%q",
			vectors.Schema, vectors.Authority, vectors.ProjectorID, vectors.SourceSchema)
	}
	if vectors.Randomized.Algorithm != manifest.Algorithms.RandomizedCases ||
		vectors.Randomized.Seed != manifest.Randomized.Seed || vectors.Randomized.Cases != manifest.Randomized.Cases {
		t.Fatalf("vector randomized contract does not match manifest: %+v", vectors.Randomized)
	}

	expectedCases := frozenSoftwareDeliveryVectorCases()
	actualCases := make(map[string]string, len(vectors.Cases))
	actualInventory := softwareDeliveryVectorInventory{Families: make(map[string]int)}
	for _, vector := range vectors.Cases {
		if _, exists := actualCases[vector.ID]; exists {
			t.Fatalf("duplicate vector ID %q", vector.ID)
		}
		actualCases[vector.ID] = vector.Family
		actualInventory.Total++
		actualInventory.Families[vector.Family]++
		if vector.ExpectedError == nil {
			actualInventory.Success++
		} else {
			actualInventory.Error++
		}
		if vector.SourceSchemaValid {
			actualInventory.SchemaValid++
		} else {
			actualInventory.SchemaInvalid++
		}
		if vector.Family == "randomized_valid" {
			actualInventory.Random++
		}
	}
	if !reflect.DeepEqual(actualCases, expectedCases) {
		t.Fatalf("vector case inventory drift:\n got %v\nwant %v", actualCases, expectedCases)
	}
	if !reflect.DeepEqual(actualInventory, manifest.VectorInventory) {
		t.Fatalf("vector contents do not match manifest inventory:\n got %+v\nwant %+v", actualInventory, manifest.VectorInventory)
	}
}

func frozenSoftwareDeliveryVectorInventory() softwareDeliveryVectorInventory {
	return softwareDeliveryVectorInventory{
		Total:         42,
		Success:       27,
		Error:         15,
		SchemaValid:   31,
		SchemaInvalid: 11,
		Families: map[string]int{
			"aggregate_boundary":    1,
			"all_missing":           1,
			"authority_boundary":    1,
			"boundary_valid":        1,
			"complete":              1,
			"historical":            1,
			"incomplete_synthetic":  1,
			"incomplete_truncation": 1,
			"invalid":               15,
			"ordering":              2,
			"randomized_valid":      16,
			"utf16":                 1,
		},
		Random: softwareDeliveryRandomCases,
	}
}

func frozenSoftwareDeliveryVectorCases() map[string]string {
	return map[string]string{
		"projector-complete-existing-chain":                           "complete",
		"projector-historical-repository-fixture":                     "historical",
		"projector-all-sources-missing":                               "all_missing",
		"projector-incomplete-synthetic-authority":                    "incomplete_synthetic",
		"projector-boundary-valid":                                    "boundary_valid",
		"projector-utf16-bmp-commit-title":                            "utf16",
		"projector-multi-record-ordering":                             "ordering",
		"projector-multi-record-ordering-permuted":                    "ordering",
		"projector-active-claim-expires-at-generated-at":              "authority_boundary",
		"projector-missing-bindings-dangling-completeness-truncation": "incomplete_truncation",
		"projector-aggregate-relations-exact-limit":                   "aggregate_boundary",
		"projector-invalid-unexpected-root-property":                  "invalid",
		"projector-invalid-unexpected-key-utf16-order":                "invalid",
		"projector-invalid-missing-authority-version":                 "invalid",
		"projector-invalid-incomplete-without-warning":                "invalid",
		"projector-invalid-missing-batch-with-item":                   "invalid",
		"projector-invalid-duplicate-semantic-issue":                  "invalid",
		"projector-invalid-date-offset-boundary":                      "invalid",
		"projector-invalid-completed-check-without-conclusion":        "invalid",
		"projector-invalid-evidence-ref-over-bound":                   "invalid",
		"projector-invalid-labels-over-bound":                         "invalid",
		"projector-invalid-relations-over-bound":                      "invalid",
		"projector-invalid-projector-version":                         "invalid",
		"projector-invalid-review-date-parse-millisecond-tie":         "invalid",
		"projector-invalid-utf16-split-surrogate-title":               "invalid",
		"projector-invalid-aggregate-relations-over-limit":            "invalid",
		"projector-randomized-valid-00":                               "randomized_valid",
		"projector-randomized-valid-01":                               "randomized_valid",
		"projector-randomized-valid-02":                               "randomized_valid",
		"projector-randomized-valid-03":                               "randomized_valid",
		"projector-randomized-valid-04":                               "randomized_valid",
		"projector-randomized-valid-05":                               "randomized_valid",
		"projector-randomized-valid-06":                               "randomized_valid",
		"projector-randomized-valid-07":                               "randomized_valid",
		"projector-randomized-valid-08":                               "randomized_valid",
		"projector-randomized-valid-09":                               "randomized_valid",
		"projector-randomized-valid-10":                               "randomized_valid",
		"projector-randomized-valid-11":                               "randomized_valid",
		"projector-randomized-valid-12":                               "randomized_valid",
		"projector-randomized-valid-13":                               "randomized_valid",
		"projector-randomized-valid-14":                               "randomized_valid",
		"projector-randomized-valid-15":                               "randomized_valid",
	}
}

var expectedSoftwareDeliveryNodeTypes = []string{
	"accepted_transition", "agent_run", "artifact_revision", "coordination.handoff",
	"core.work_item", "execution_context", "execution_lease", "governance.decision",
	"human_decision", "informational.actor_observation", "informational.agent_run_observation",
	"informational.check_observation", "informational.claim_observation", "informational.commit_observation",
	"informational.decision_observation", "informational.handoff_observation", "informational.issue_observation",
	"informational.merge_observation", "informational.pr_observation", "informational.prms_observation",
	"informational.repository_observation", "informational.review_observation",
	"informational.workflow_run_observation", "informational.worktree_observation", "organization.actor",
	"outcome", "prms_report", "projection.source_batch", "reviewable_deliverable", "software.repository",
	"verification_evidence", "workflow_run",
}

var expectedSoftwareDeliveryEdgeTypes = []string{
	"accepted_by", "assessed_by", "assigned_to", "closes_as", "contains", "coordinates",
	"decomposes_to", "executed_by", "executes_in", "from_actor", "governs", "hosts_run",
	"implemented_by", "included_in", "leased_by", "observed_assessment", "observed_merge",
	"observed_review", "owned_by", "performed_by", "produces", "reviewed_by", "to_actor", "verified_by",
}

var expectedSoftwareDeliveryGraphErrors = []string{
	string(graph.ContractSchemaInvalid), string(graph.ContractBoundExceeded), string(graph.ContractScopeInvalid),
	string(graph.ContractReferenceInvalid), string(graph.ContractPropertyUnsafe), string(graph.ContractIntegrityInvalid),
}

var expectedSoftwareDeliveryJSONErrors = []string{
	string(graph.JSONUTF8Invalid), string(graph.JSONBOMForbidden), string(graph.JSONSyntaxInvalid),
	string(graph.JSONDuplicateKey), string(graph.JSONLimitExceeded),
}
