package workflowcontrol

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

type contractManifest struct {
	Schema            string `json:"schema"`
	ContractVersion   string `json:"contractVersion"`
	Authority         string `json:"authority"`
	AuthorityBoundary struct {
		Writer                      string `json:"writer"`
		LocalStore                  string `json:"localStore"`
		TypeScriptRemainsSoleWriter bool   `json:"typescriptRemainsSoleWriter"`
		GoRole                      string `json:"goRole"`
		AuthorityEligible           bool   `json:"authorityEligible"`
	} `json:"authorityBoundary"`
	ObservedBehavior struct {
		ProductionInitialState               RunState                `json:"productionInitialState"`
		DormantStates                        []RunState              `json:"dormantStatesWithoutProductionWriter"`
		States                               []RunState              `json:"states"`
		Transitions                          map[RunState][]RunState `json:"transitions"`
		CheckpointStates                     []CheckpointState       `json:"checkpointStates"`
		CheckpointPersistenceAtomic          bool                    `json:"checkpointPersistenceAtomic"`
		ControlPathsCanBypassTransitionTable bool                    `json:"controlPathsCanBypassTransitionTable"`
		BudgetWarningKinds                   []string                `json:"budgetWarningKinds"`
	} `json:"observedBehavior"`
	ApprovalPlanes     json.RawMessage `json:"approvalPlanes"`
	ProjectionBoundary json.RawMessage `json:"projectionBoundary"`
	Canonicalization   json.RawMessage `json:"canonicalization"`
	Limits             json.RawMessage `json:"limits"`
	QualificationGaps  []string        `json:"qualificationGaps"`
	ErrorCodes         []ErrorCode     `json:"errorCodes"`
	Deferred           json.RawMessage `json:"deferred"`
	Artifacts          map[string]struct {
		Path       string `json:"path"`
		ByteLength int    `json:"byteLength"`
		SHA256     string `json:"sha256"`
	} `json:"artifacts"`
	BundleFiles []string `json:"bundleFiles"`
}

func TestManifestAndExactMirrorParity(t *testing.T) {
	mirrorRoot := "internal/contractmirror/generated/v1"
	manifestBytes, err := os.ReadFile(filepath.Join(mirrorRoot, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	var manifest contractManifest
	decodeClosed(t, manifestBytes, &manifest)
	if manifest.Schema != "openslack.workflow_control_contract_manifest.v1" || manifest.ContractVersion != "v1" || manifest.Authority != Authority {
		t.Fatalf("manifest identity drift: %+v", manifest)
	}
	if manifest.AuthorityBoundary.Writer != "@openslack/workflows" || manifest.AuthorityBoundary.LocalStore != ".openslack.local/workflows/runs" || !manifest.AuthorityBoundary.TypeScriptRemainsSoleWriter || manifest.AuthorityBoundary.GoRole != GoRole || manifest.AuthorityBoundary.AuthorityEligible {
		t.Fatalf("authority boundary drift: %+v", manifest.AuthorityBoundary)
	}
	if manifest.ObservedBehavior.ProductionInitialState != RunRunning || manifest.ObservedBehavior.CheckpointPersistenceAtomic || !manifest.ObservedBehavior.ControlPathsCanBypassTransitionTable {
		t.Fatalf("observed behavior drift: %+v", manifest.ObservedBehavior)
	}
	if !reflect.DeepEqual(manifest.QualificationGaps, QualificationGaps()) {
		t.Fatalf("qualification gap drift: %v", manifest.QualificationGaps)
	}
	expectedErrors := []ErrorCode{ErrorInvalid, ErrorUnknownField, ErrorLimitExceeded, ErrorInvalidTransition, ErrorApprovalPlaneMismatch, ErrorSensitiveField}
	if !reflect.DeepEqual(manifest.ErrorCodes, expectedErrors) {
		t.Fatalf("error code drift: %v", manifest.ErrorCodes)
	}

	for artifactName, artifact := range manifest.Artifacts {
		mirror, readErr := os.ReadFile(filepath.Join(mirrorRoot, filepath.FromSlash(artifact.Path)))
		if readErr != nil {
			t.Fatalf("%s mirror: %v", artifactName, readErr)
		}
		source, readErr := os.ReadFile(filepath.Join("..", "..", "packages", "workflows", "contracts", "workflow-control", "v1", filepath.FromSlash(artifact.Path)))
		if readErr != nil {
			t.Fatalf("%s source: %v", artifactName, readErr)
		}
		if !reflect.DeepEqual(mirror, source) {
			t.Fatalf("%s mirror differs from TypeScript authority bytes", artifactName)
		}
		digest := sha256.Sum256(mirror)
		if len(mirror) != artifact.ByteLength || hex.EncodeToString(digest[:]) != artifact.SHA256 {
			t.Fatalf("%s manifest digest drift", artifactName)
		}
	}
	if !reflect.DeepEqual(manifest.BundleFiles, []string{"schemas/workflow-control-observation.v1.schema.json", "schemas/workflow-control-read-model.v1.schema.json", "golden-vectors.json", "manifest.json"}) {
		t.Fatalf("bundle file drift: %v", manifest.BundleFiles)
	}
}

func TestMirrorSchemasRemainClosed(t *testing.T) {
	for _, name := range []string{"workflow-control-observation.v1.schema.json", "workflow-control-read-model.v1.schema.json"} {
		input, err := os.ReadFile(filepath.Join("internal/contractmirror/generated/v1/schemas", name))
		if err != nil {
			t.Fatal(err)
		}
		var schema map[string]any
		if err := json.Unmarshal(input, &schema); err != nil {
			t.Fatal(err)
		}
		if schema["additionalProperties"] != false {
			t.Fatalf("%s is not closed", name)
		}
	}
}
