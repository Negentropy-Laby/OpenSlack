package contracts_test

import (
	"context"
	"encoding/json"
	"path/filepath"
	"strings"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
)

func TestCheckpointShadowOpenAPIIsClosedAndValid(t *testing.T) {
	_, serviceRoot := roots(t)
	document, err := openapi3.NewLoader().LoadFromFile(filepath.Join(serviceRoot, "docs", "api", "checkpoint-shadow-openapi.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if err := document.Validate(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/health/live", "/health/ready", "/version", "/metrics", "/v1/shadow/workflow-control/checkpoints", "/v1/shadow/workflow-control/runs/{runId}/checkpoint-head", "/v1/shadow/workflow-control/receipts/{idempotencyKey}"} {
		if document.Paths.Find(path) == nil {
			t.Fatalf("missing checkpoint shadow path %s", path)
		}
	}
	for _, name := range []string{"RunnerBinding", "Checkpoint", "CheckpointObservation", "CheckpointEnvelope", "CheckpointReceipt", "CheckpointHead", "Error"} {
		schema := document.Components.Schemas[name]
		if schema == nil || schema.Value == nil || schema.Value.AdditionalProperties.Has == nil || *schema.Value.AdditionalProperties.Has {
			t.Fatalf("schema %s is not closed", name)
		}
	}
	post := document.Paths.Value("/v1/shadow/workflow-control/checkpoints").Post
	for _, status := range []string{"200", "201", "202", "401", "409", "415", "422", "500", "503"} {
		if post.Responses.Value(status) == nil {
			t.Fatalf("checkpoint observation is missing response %s", status)
		}
	}
	replay := post.Responses.Value("200")
	if replay.Value == nil || replay.Value.Headers["Idempotency-Replayed"] == nil || replay.Value.Headers["Idempotency-Replayed"].Value == nil || replay.Value.Headers["Idempotency-Replayed"].Value.Required == false {
		t.Fatal("checkpoint exact replay response is missing its required replay header")
	}
	for _, path := range []string{"/v1/shadow/workflow-control/runs/{runId}/checkpoint-head", "/v1/shadow/workflow-control/receipts/{idempotencyKey}"} {
		operation := document.Paths.Value(path).Get
		for _, status := range []string{"200", "401", "404", "500", "503"} {
			if operation.Responses.Value(status) == nil {
				t.Fatalf("%s is missing response %s", path, status)
			}
		}
	}

	hash := strings.Repeat("a", 64)
	key := "openslack.workflow-checkpoint-shadow.v1." + hash
	accepted := map[string]any{
		"schema": "openslack.workflow_checkpoint_shadow_receipt.v1", "status": "accepted",
		"idempotencyKey": key, "receiptId": "wccs-receipt-contract", "observationId": "wccs-observation-contract",
		"workspaceId": "workspace.contract", "runId": "run-contract", "sourceSequence": float64(1),
		"operation": "checkpoint_commit", "parity": "matched", "mismatchCode": nil, "reconciliationToken": nil,
		"envelopeHash": hash, "observationHash": hash, "serviceBuildHash": hash, "committedAt": "2026-08-12T00:00:00.000Z",
	}
	receiptSchema := document.Components.Schemas["CheckpointReceipt"].Value
	if err := receiptSchema.VisitJSON(accepted); err != nil {
		t.Fatalf("accepted receipt failed schema: %v", err)
	}
	mismatch := checkpointShadowClone(t, accepted)
	mismatch["parity"] = "mismatched"
	mismatch["mismatchCode"] = "manifest_hash_drift"
	if err := receiptSchema.VisitJSON(mismatch); err != nil {
		t.Fatalf("mismatched receipt failed schema: %v", err)
	}
	reconciliation := checkpointShadowClone(t, accepted)
	reconciliation["status"] = "reconciliation_required"
	reconciliation["parity"] = "unknown"
	reconciliation["observationId"] = nil
	reconciliation["committedAt"] = nil
	reconciliation["reconciliationToken"] = "wccs-reconciliation-contract"
	if err := receiptSchema.VisitJSON(reconciliation); err != nil {
		t.Fatalf("reconciliation receipt failed schema: %v", err)
	}
	for name, invalid := range map[string]map[string]any{
		"accepted missing observation": func() map[string]any {
			value := checkpointShadowClone(t, accepted)
			value["observationId"] = nil
			return value
		}(),
		"accepted with token": func() map[string]any {
			value := checkpointShadowClone(t, accepted)
			value["reconciliationToken"] = "unexpected"
			return value
		}(),
		"unknown accepted": func() map[string]any {
			value := checkpointShadowClone(t, accepted)
			value["parity"] = "unknown"
			return value
		}(),
		"additional field": func() map[string]any {
			value := checkpointShadowClone(t, accepted)
			value["unexpected"] = true
			return value
		}(),
	} {
		if err := receiptSchema.VisitJSON(invalid); err == nil {
			t.Fatalf("%s unexpectedly matched checkpoint receipt", name)
		}
	}

	observation := map[string]any{
		"schema": "openslack.workflow_checkpoint_shadow_observation.v1", "authority": "typescript", "goRole": "observer_only",
		"runId": "run-contract", "revision": float64(2), "resumeGeneration": float64(0),
		"workflowSourceHash": hash, "manifestHash": hash, "inputHash": hash,
		"runner":          map[string]any{"workspaceId": "workspace.contract", "jobId": "job-contract", "attemptId": "attempt-contract", "leaseId": "lease-contract", "fencingToken": float64(1), "correlationId": "correlation-contract", "runnerBuildHash": hash},
		"checkpoint":      map[string]any{"checkpointId": "checkpoint-contract", "phaseId": "phase-0", "phaseIndex": float64(0), "commitPoint": "after_phase_work", "artifactRef": "artifacts/checkpoint.json", "artifactHash": hash, "resultHash": nil, "cacheKeyHash": nil, "committedRevision": float64(2), "resumeGeneration": float64(0), "committedAt": "2026-08-12T00:00:00.000Z"},
		"priorCheckpoint": nil, "nextPhaseId": nil, "nextPhaseIndex": nil,
	}
	head := map[string]any{
		"schema": "openslack.workflow_checkpoint_shadow_head.v1", "goRole": "observer_only", "workspaceId": "workspace.contract", "runId": "run-contract",
		"sourceSequence": float64(1), "operation": "checkpoint_commit", "matchedSourceSequence": float64(1), "mismatchLatched": false,
		"observationHash": hash, "observation": observation, "updatedAt": "2026-08-12T00:00:00.000Z",
	}
	if err := document.Components.Schemas["CheckpointHead"].Value.VisitJSON(head); err != nil {
		t.Fatalf("checkpoint head failed schema: %v", err)
	}
}

func checkpointShadowClone(t *testing.T, value map[string]any) map[string]any {
	t.Helper()
	body, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	var clone map[string]any
	if err := json.Unmarshal(body, &clone); err != nil {
		t.Fatal(err)
	}
	return clone
}
