package contracttodelivery

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

type artifact struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}

type vectorInventory struct {
	Total         int            `json:"total"`
	Success       int            `json:"success"`
	Error         int            `json:"error"`
	SchemaValid   int            `json:"schemaValid"`
	SchemaInvalid int            `json:"schemaInvalid"`
	Families      map[string]int `json:"families"`
	Random        int            `json:"random"`
}

type manifest struct {
	Schema              string `json:"schema"`
	Authority           string `json:"authority"`
	SourceSchema        string `json:"sourceSchema"`
	ProjectorID         string `json:"projectorId"`
	GraphSnapshotSchema string `json:"graphSnapshotSchema"`
	SourceLimits        struct {
		ObservationsPerKind    int `json:"observationsPerKind"`
		TotalObservations      int `json:"totalObservations"`
		TotalRelations         int `json:"totalRelations"`
		SourceBytes            int `json:"sourceBytes"`
		SourceJSONNodes        int `json:"sourceJsonNodes"`
		SourceObjectProperties int `json:"sourceObjectProperties"`
		SourceArrayItems       int `json:"sourceArrayItems"`
		ProjectedSnapshotBytes int `json:"projectedSnapshotBytes"`
		CompletenessEntries    int `json:"completenessEntries"`
		TextBytes              int `json:"textBytes"`
	} `json:"sourceLimits"`
	ProjectorContract struct {
		NodeTypes []string `json:"nodeTypes"`
		EdgeTypes []string `json:"edgeTypes"`
	} `json:"projectorContract"`
	Algorithms struct {
		Validation        string `json:"validation"`
		Projection        string `json:"projection"`
		NestedProjection  string `json:"nestedProjection"`
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
	VectorInventory vectorInventory `json:"vectorInventory"`
	Artifacts       struct {
		SourceSchema           artifact `json:"sourceSchema"`
		ProjectorGoldenVectors artifact `json:"projectorGoldenVectors"`
	} `json:"artifacts"`
}

func decodeClosed(t *testing.T, data []byte, destination any) {
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

func assertArtifact(t *testing.T, mirrorRoot, authorityRoot, name string, value artifact, expectedPath string) []byte {
	t.Helper()
	if value.Path != expectedPath {
		t.Fatalf("%s path = %q, want %q", name, value.Path, expectedPath)
	}
	mirror, err := os.ReadFile(filepath.Join(mirrorRoot, expectedPath))
	if err != nil {
		t.Fatalf("read mirrored %s: %v", name, err)
	}
	digest := sha256.Sum256(mirror)
	if hex.EncodeToString(digest[:]) != value.SHA256 {
		t.Fatalf("%s raw-byte SHA-256 does not match manifest", name)
	}
	authority, err := os.ReadFile(filepath.Join(authorityRoot, expectedPath))
	if err != nil {
		t.Fatalf("read authority %s: %v", name, err)
	}
	if !bytes.Equal(mirror, authority) {
		t.Fatalf("mirrored %s differs from TypeScript-authority bytes", name)
	}
	return mirror
}

func TestGeneratedManifestMatchesContractToDeliveryContract(t *testing.T) {
	mirrorRoot := filepath.Join("..", "internal", "contractmirror", "generated", "contract-to-delivery", "v1")
	authorityRoot := filepath.Join("..", "..", "..", "packages", "organization-graph", "contracts", "contract-to-delivery", "v1")
	manifestBytes, err := os.ReadFile(filepath.Join(mirrorRoot, "manifest.json"))
	if err != nil {
		t.Fatalf("read manifest: %v", err)
	}
	if _, err := graph.ParseCanonicalJSON(manifestBytes, graph.DefaultJSONLimits()); err != nil {
		t.Fatalf("strict-parse manifest: %v", err)
	}
	var value manifest
	decodeClosed(t, manifestBytes, &value)
	if value.Schema != "openslack.contract_to_delivery_projector_contract_manifest.v1" || value.Authority != "typescript" {
		t.Fatalf("manifest authority drift: schema=%q authority=%q", value.Schema, value.Authority)
	}
	if value.SourceSchema != SourceSchema || value.ProjectorID != ProjectorID || value.GraphSnapshotSchema != graph.SnapshotSchema {
		t.Fatalf("manifest identity drift: source=%q projector=%q graph=%q", value.SourceSchema, value.ProjectorID, value.GraphSnapshotSchema)
	}
	limits := value.SourceLimits
	limits.ObservationsPerKind = MaxObservationsPerKind
	limits.TotalObservations = MaxTotalObservations
	limits.TotalRelations = MaxTotalRelations
	limits.SourceBytes = MaxSourceBytes
	limits.SourceJSONNodes = MaxSourceJSONNodes
	limits.SourceObjectProperties = MaxSourceProperties
	limits.SourceArrayItems = MaxSourceArrayItems
	limits.ProjectedSnapshotBytes = MaxProjectedBytes
	limits.CompletenessEntries = MaxCompletenessEntries
	limits.TextBytes = MaxTextBytes
	if value.SourceLimits != limits {
		t.Fatalf("source-limit drift: %+v", value.SourceLimits)
	}
	expectedNodes := []string{
		"accepted_transition", "agent_run", "artifact_revision", "business.acceptance", "business.contract",
		"business.customer", "business.milestone", "business.outcome", "business.project", "coordination.handoff",
		"core.work_item", "execution_context", "execution_lease", "governance.decision", "human_decision",
		"informational.acceptance_observation", "informational.actor_observation", "informational.agent_run_observation",
		"informational.check_observation", "informational.claim_observation", "informational.commit_observation",
		"informational.decision_observation", "informational.handoff_observation", "informational.issue_observation",
		"informational.merge_observation", "informational.outcome_observation", "informational.pr_observation",
		"informational.prms_observation", "informational.repository_observation", "informational.review_observation",
		"informational.workflow_run_observation", "informational.worktree_observation", "organization.actor", "outcome",
		"prms_report", "projection.source_batch", "reviewable_deliverable", "software.repository", "verification_evidence", "workflow_run",
	}
	expectedEdges := []string{
		"accepted_as", "accepted_by", "approved_by", "assessed_by", "assigned_to", "closes_as", "closes_work_item",
		"contains", "contract_delivered_by", "contracts_for", "coordinates", "decomposes_to", "delivers_project",
		"executed_by", "executes_in", "from_actor", "governs", "hosts_run", "implemented_by", "included_in",
		"leased_by", "milestone_contains", "observed_assessment", "observed_merge", "observed_review", "owned_by",
		"performed_by", "produces", "realizes", "reviewed_by", "scoped_to", "substantiated_by", "to_actor",
		"tracks_milestone", "transitioned_by", "verified_by",
	}
	if !slices.Equal(value.ProjectorContract.NodeTypes, expectedNodes) || !slices.Equal(value.ProjectorContract.EdgeTypes, expectedEdges) {
		t.Fatalf("projector type inventory drifted")
	}
	algorithms := value.Algorithms
	algorithms.Validation = "openslack.contract_to_delivery_source_validation.v1"
	algorithms.Projection = ProjectorID
	algorithms.NestedProjection = "openslack.software_delivery.v1"
	algorithms.CanonicalSnapshot = "openslack.ecmascript_canonical_json.v1+lf"
	algorithms.NodeIdentity = graph.AlgorithmNodeIdentity
	algorithms.EdgeIdentity = graph.AlgorithmEdgeIdentity
	algorithms.SnapshotIntegrity = graph.AlgorithmSnapshotIntegrity
	algorithms.RandomizedCases = "mulberry32.v1"
	if value.Algorithms != algorithms {
		t.Fatalf("algorithm drift: %+v", value.Algorithms)
	}
	if value.Randomized.Seed != "0xc7d2b11c" || value.Randomized.Cases != 16 {
		t.Fatalf("randomized contract drift: %+v", value.Randomized)
	}
	expectedInventory := vectorInventory{
		Total: 43, Success: 32, Error: 11, SchemaValid: 37, SchemaInvalid: 6, Random: 16,
		Families: map[string]int{
			"acceptance_boundary": 5, "all_missing": 1, "boundary_valid": 1, "bridge_drift": 1,
			"complete": 1, "historical": 1, "incomplete": 1, "invalid": 11, "ordering": 1,
			"outcome_boundary": 4, "randomized_valid": 16,
		},
	}
	if !reflect.DeepEqual(value.VectorInventory, expectedInventory) {
		t.Fatalf("vector inventory drift: got %+v want %+v", value.VectorInventory, expectedInventory)
	}
	assertArtifact(t, mirrorRoot, authorityRoot, "source schema", value.Artifacts.SourceSchema,
		filepath.Join("schemas", "contract-to-delivery-source-snapshot.v1.schema.json"))
	vectors := assertArtifact(t, mirrorRoot, authorityRoot, "golden vectors", value.Artifacts.ProjectorGoldenVectors,
		"projector-golden-vectors.json")
	var golden goldenFile
	decodeClosed(t, vectors, &golden)
	if len(golden.Cases) != value.VectorInventory.Total {
		t.Fatalf("golden case count = %d, want %d", len(golden.Cases), value.VectorInventory.Total)
	}
	authorityManifest, err := os.ReadFile(filepath.Join(authorityRoot, "manifest.json"))
	if err != nil {
		t.Fatalf("read authority manifest: %v", err)
	}
	if !bytes.Equal(manifestBytes, authorityManifest) {
		t.Fatal("Go mirror manifest differs from TypeScript-authority bytes")
	}
}
