package contracts_test

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/getkin/kin-openapi/openapi3"
)

func TestEffectShadowOpenAPIIsClosedAndValid(t *testing.T) {
	repoRoot, serviceRoot := roots(t)
	document, err := openapi3.NewLoader().LoadFromFile(filepath.Join(serviceRoot, "docs", "api", "effect-shadow-openapi.yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if err := document.Validate(context.Background()); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{
		"/health/live",
		"/health/ready",
		"/version",
		"/metrics",
		"/v1/shadow/workflow-control/effect-events",
		"/v1/shadow/workflow-control/runs/{runId}/occurrences/{occurrenceId}/approvals/{approvalId}/head",
		"/v1/shadow/workflow-control/receipts/{idempotencyKey}",
		"/v1/shadow/workflow-control/outbox:pending",
	} {
		if document.Paths.Find(path) == nil {
			t.Fatalf("missing effect shadow path %s", path)
		}
	}
	for _, name := range []string{
		"HumanDecision", "ObservationCreated", "ObservationDecided", "ObservationAudit",
		"EnvelopeCreated", "EnvelopeDecided", "EnvelopeAudit", "AcceptedReceipt",
		"ReconciliationReceipt", "Head", "OutboxPayload", "OutboxRead", "OutboxPage", "Error",
	} {
		schema := document.Components.Schemas[name]
		if schema == nil || schema.Value == nil || schema.Value.AdditionalProperties.Has == nil || *schema.Value.AdditionalProperties.Has {
			t.Fatalf("schema %s is not closed", name)
		}
	}

	post := document.Paths.Value("/v1/shadow/workflow-control/effect-events").Post
	for _, status := range []string{"200", "201", "202", "401", "409", "413", "415", "422", "500", "503"} {
		if post.Responses.Value(status) == nil {
			t.Fatalf("effect observation is missing response %s", status)
		}
	}
	replay := post.Responses.Value("200")
	if replay.Value == nil || replay.Value.Headers["Idempotency-Replayed"] == nil || replay.Value.Headers["Idempotency-Replayed"].Value == nil || !replay.Value.Headers["Idempotency-Replayed"].Value.Required {
		t.Fatal("effect exact replay response is missing its required replay header")
	}
	for _, path := range []string{
		"/v1/shadow/workflow-control/runs/{runId}/occurrences/{occurrenceId}/approvals/{approvalId}/head",
		"/v1/shadow/workflow-control/receipts/{idempotencyKey}",
		"/v1/shadow/workflow-control/outbox:pending",
	} {
		operation := document.Paths.Value(path).Get
		for _, status := range []string{"200", "401", "500", "503"} {
			if operation.Responses.Value(status) == nil {
				t.Fatalf("%s is missing response %s", path, status)
			}
		}
	}

	goldenBody, err := os.ReadFile(filepath.Join(repoRoot, "packages", "workflows", "contracts", "workflow-effect-control", "v1", "golden-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var golden struct {
		Vectors struct {
			Observer map[string]struct {
				Value map[string]any `json:"value"`
			} `json:"observer"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(goldenBody, &golden); err != nil {
		t.Fatal(err)
	}
	for name, schemaName := range map[string]string{
		"approvalCreated": "EnvelopeCreated",
		"approvalDecided": "EnvelopeDecided",
		"auditRecorded":   "EnvelopeAudit",
	} {
		vector, ok := golden.Vectors.Observer[name]
		if !ok {
			t.Fatalf("missing D1 observer golden %s", name)
		}
		if err := document.Components.Schemas[schemaName].Value.VisitJSON(vector.Value); err != nil {
			t.Fatalf("D1 %s envelope failed OpenAPI schema: %v", name, err)
		}
	}

	hash := strings.Repeat("a", 64)
	key := "openslack.workflow-effect-control-shadow.v1." + hash
	accepted := map[string]any{
		"schema": "openslack.workflow_effect_shadow_receipt.v1", "status": "accepted",
		"idempotencyKey": key, "receiptId": "wecs-receipt-contract", "observationId": "wecs-observation-contract",
		"workspaceId": "workspace-d1", "runId": "run-d1-001",
		"occurrenceId":   "WFOCCURRENCE-61fab545a40de2141957929d2633d542ac952d9c7ee9b51a65d221b2d060855d",
		"approvalId":     "WFAPPROVAL-88aa80c6febf987893127397761d6b7df46e3b2dccd649550367104541cd2bb6",
		"sourceSequence": float64(1), "operation": "approval_created", "parity": "matched", "mismatchCode": nil,
		"reconciliationToken": nil, "envelopeHash": hash, "observationHash": hash, "serviceBuildHash": hash,
		"committedAt": "2026-08-12T00:00:03.000Z",
	}
	receiptSchema := document.Components.Schemas["Receipt"].Value
	if err := receiptSchema.VisitJSON(accepted); err != nil {
		t.Fatalf("accepted receipt failed schema: %v", err)
	}
	mismatch := effectShadowClone(t, accepted)
	mismatch["parity"] = "mismatched"
	mismatch["mismatchCode"] = "EFFECT_HEAD_DRIFT"
	if err := receiptSchema.VisitJSON(mismatch); err != nil {
		t.Fatalf("mismatched receipt failed schema: %v", err)
	}
	reconciliation := effectShadowClone(t, accepted)
	reconciliation["status"] = "reconciliation_required"
	reconciliation["parity"] = "unknown"
	reconciliation["observationId"] = nil
	reconciliation["committedAt"] = nil
	reconciliation["mismatchCode"] = nil
	reconciliation["reconciliationToken"] = "wecs-reconciliation-contract"
	if err := receiptSchema.VisitJSON(reconciliation); err != nil {
		t.Fatalf("reconciliation receipt failed schema: %v", err)
	}
	invalid := effectShadowClone(t, accepted)
	invalid["unexpected"] = true
	if err := receiptSchema.VisitJSON(invalid); err == nil {
		t.Fatal("receipt with additional field unexpectedly matched")
	}

	payload := map[string]any{
		"schema": "openslack.workflow_effect_shadow_outbox_payload.v1", "eventId": "WECS-OUTBOX-contract",
		"eventType": "effect_decision_observed", "authority": "typescript", "goRole": "observer_only",
		"nonAuthorizingObservation": true, "goEffectDecisionAuthority": false, "goEffectExecutionAuthority": false,
		"workspaceId": "workspace-d1", "runId": "run-d1-001",
		"occurrenceId":   "WFOCCURRENCE-61fab545a40de2141957929d2633d542ac952d9c7ee9b51a65d221b2d060855d",
		"approvalId":     "WFAPPROVAL-88aa80c6febf987893127397761d6b7df46e3b2dccd649550367104541cd2bb6",
		"sourceSequence": float64(2), "operation": "approval_decided", "observationId": "wecs-observation-contract",
		"observationHash": hash, "approvalStatus": "approved", "decision": "approved",
		"auditEventId": "WFAPPROVAL-AUDIT-6ff02f155d29dc4bde00caa01c80c37056954faf53c30b5860f3abf81883f8c4",
		"bindingHash":  hash, "observedAt": "2026-08-12T00:00:05.000Z",
	}
	outbox := map[string]any{
		"schema": "openslack.workflow_effect_shadow_outbox_read.v1", "status": "pending", "eventId": "WECS-OUTBOX-contract",
		"eventType": "effect_decision_observed", "workspaceId": "workspace-d1", "runId": "run-d1-001",
		"occurrenceId": payload["occurrenceId"], "approvalId": payload["approvalId"], "sourceSequence": float64(2),
		"operation": "approval_decided", "observationId": "wecs-observation-contract", "observationHash": hash,
		"payloadHash": hash, "payload": payload, "recordedAt": "2026-08-12T00:00:05.000Z",
	}
	if err := document.Components.Schemas["OutboxRead"].Value.VisitJSON(outbox); err != nil {
		t.Fatalf("outbox read failed schema: %v", err)
	}
	page := map[string]any{
		"schema": "openslack.workflow_effect_shadow_outbox_page.v1", "items": []any{outbox},
		"count": float64(1), "nextCursor": "Y3Vyc29y",
	}
	if err := document.Components.Schemas["OutboxPage"].Value.VisitJSON(page); err != nil {
		t.Fatalf("outbox page failed schema: %v", err)
	}
	for name, mutate := range map[string]func(map[string]any){
		"missing field": func(value map[string]any) { delete(value["payload"].(map[string]any), "bindingHash") },
		"extra field":   func(value map[string]any) { value["payload"].(map[string]any)["rawReason"] = "forbidden" },
		"transition drift": func(value map[string]any) {
			value["eventType"] = "effect_audit_recorded"
			value["payload"].(map[string]any)["eventType"] = "effect_audit_recorded"
		},
		"decision drift": func(value map[string]any) {
			value["payload"].(map[string]any)["decision"] = "rejected"
		},
	} {
		value := effectShadowClone(t, outbox)
		mutate(value)
		if err := document.Components.Schemas["OutboxRead"].Value.VisitJSON(value); err == nil {
			t.Fatalf("outbox %s unexpectedly matched", name)
		}
	}

	head := map[string]any{
		"schema": "openslack.workflow_effect_shadow_head.v1", "workspaceId": "workspace-d1",
		"runId": "run-d1-001", "occurrenceId": payload["occurrenceId"], "approvalId": payload["approvalId"],
		"lastSourceSequence": float64(1), "lastOperation": "approval_created", "lastObservationHash": hash,
		"matchedSourceSequence": float64(1), "matchedOperation": "approval_created", "matchedObservationHash": hash,
		"mismatchLatched": false, "mismatchCode": nil, "serviceBuildHash": hash,
		"updatedAt": "2026-08-12T00:00:05.000Z",
	}
	if err := document.Components.Schemas["Head"].Value.VisitJSON(head); err != nil {
		t.Fatalf("head failed schema: %v", err)
	}
	for name, mutate := range map[string]func(map[string]any){
		"last operation drift": func(value map[string]any) { value["lastOperation"] = "audit_recorded" },
		"unlatched null prefix": func(value map[string]any) {
			value["matchedSourceSequence"], value["matchedOperation"], value["matchedObservationHash"] = nil, nil, nil
		},
	} {
		value := effectShadowClone(t, head)
		mutate(value)
		if err := document.Components.Schemas["Head"].Value.VisitJSON(value); err == nil {
			t.Fatalf("head %s unexpectedly matched", name)
		}
	}
}

func effectShadowClone(t *testing.T, value map[string]any) map[string]any {
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
