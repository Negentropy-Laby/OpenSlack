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
	ProjectionBoundary struct {
		CredentialFree                  bool     `json:"credentialFree"`
		AllowedSensitiveRepresentations []string `json:"allowedSensitiveRepresentations"`
		ForbiddenRawFields              []string `json:"forbiddenRawFields"`
	} `json:"projectionBoundary"`
	Canonicalization json.RawMessage `json:"canonicalization"`
	Limits           struct {
		MaxObservationBytes  int     `json:"maxObservationBytes"`
		MaxJSONDepth         int     `json:"maxJsonDepth"`
		MaxJSONNodes         int     `json:"maxJsonNodes"`
		MaxIdentifierBytes   int     `json:"maxIdentifierBytes"`
		MaxWorkflowNameBytes int     `json:"maxWorkflowNameBytes"`
		MaxPhaseNameBytes    int     `json:"maxPhaseNameBytes"`
		MaxPhaseCheckpoints  int     `json:"maxPhaseCheckpoints"`
		MaxBudgetWarnings    int     `json:"maxBudgetWarnings"`
		MaxCount             int     `json:"maxCount"`
		MaxTokens            int64   `json:"maxTokens"`
		MaxCostUSD           float64 `json:"maxCostUsd"`
	} `json:"limits"`
	QualificationGaps []string        `json:"qualificationGaps"`
	ErrorCodes        []ErrorCode     `json:"errorCodes"`
	Deferred          json.RawMessage `json:"deferred"`
	Artifacts         map[string]struct {
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
	expectedStates := []RunState{
		RunCreated, RunPreviewed, RunConfirmed, RunRunning, RunPaused,
		RunPausedWaitingApproval, RunResuming, RunCompleted, RunFailed, RunCancelled,
	}
	if !reflect.DeepEqual(manifest.ObservedBehavior.States, expectedStates) ||
		!reflect.DeepEqual(manifest.ObservedBehavior.DormantStates, []RunState{RunCreated, RunPreviewed, RunConfirmed}) ||
		!reflect.DeepEqual(manifest.ObservedBehavior.CheckpointStates, []CheckpointState{CheckpointCompleted, CheckpointFailed, CheckpointSkipped}) ||
		!reflect.DeepEqual(manifest.ObservedBehavior.BudgetWarningKinds, []string{"threshold", "exceeded"}) {
		t.Fatalf("observed vocabulary drift: %+v", manifest.ObservedBehavior)
	}
	expectedTransitions := make(map[RunState][]RunState, len(expectedStates))
	for _, from := range expectedStates {
		expectedTransitions[from] = []RunState{}
		for _, to := range expectedStates {
			if _, allowed := transitions[from][to]; allowed {
				expectedTransitions[from] = append(expectedTransitions[from], to)
			}
		}
	}
	if !reflect.DeepEqual(manifest.ObservedBehavior.Transitions, expectedTransitions) {
		t.Fatalf("transition table drift:\n got  %#v\n want %#v", manifest.ObservedBehavior.Transitions, expectedTransitions)
	}
	if !reflect.DeepEqual(manifest.QualificationGaps, QualificationGaps()) {
		t.Fatalf("qualification gap drift: %v", manifest.QualificationGaps)
	}
	expectedForbidden := []string{"args", "result", "detail", "capability", "decision", "evidence", "attestationNonce", "nonce", "token", "secret", "prompt", "output"}
	if !manifest.ProjectionBoundary.CredentialFree || !reflect.DeepEqual(manifest.ProjectionBoundary.AllowedSensitiveRepresentations, []string{"sha256-hash", "status-count"}) || !reflect.DeepEqual(manifest.ProjectionBoundary.ForbiddenRawFields, expectedForbidden) {
		t.Fatalf("projection boundary drift: %+v", manifest.ProjectionBoundary)
	}
	if manifest.Limits.MaxObservationBytes != MaxObservationBytes || manifest.Limits.MaxJSONDepth != MaxJSONDepth || manifest.Limits.MaxJSONNodes != MaxJSONNodes || manifest.Limits.MaxIdentifierBytes != MaxIdentifierBytes || manifest.Limits.MaxWorkflowNameBytes != MaxWorkflowNameBytes || manifest.Limits.MaxPhaseNameBytes != MaxPhaseNameBytes || manifest.Limits.MaxPhaseCheckpoints != MaxPhaseCheckpoints || manifest.Limits.MaxBudgetWarnings != MaxBudgetWarnings || manifest.Limits.MaxCount != MaxCount || manifest.Limits.MaxTokens != MaxTokens || manifest.Limits.MaxCostUSD != MaxCostUSD {
		t.Fatalf("contract limit drift: %+v", manifest.Limits)
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
