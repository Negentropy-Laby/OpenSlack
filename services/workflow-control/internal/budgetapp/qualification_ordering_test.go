package budgetapp

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetstore"
)

// qualificationOnlyOrderingHarness is deliberately test-only. It demonstrates
// the minimum fail-closed call ordering needed by a future TypeScript-owned
// integration, but is not a runtime client and does not deliver runner v2,
// production routing, canary traffic, or a budget-authority cutover.
type qualificationOnlyOrderingHarness struct {
	handler      http.Handler
	cacheLookup  func() bool
	providerCall func()
	cachePublish func()
}

func (harness qualificationOnlyOrderingHarness) run(t *testing.T, reserveBody, settlementBody []byte) error {
	t.Helper()
	if harness.cacheLookup() {
		return nil
	}
	reserve := perform(t, harness.handler, http.MethodPost, RouteReserve, reserveBody, mutationHeaders(t, "reserve", reserveBody, true))
	reserveResponse, err := qualificationOnlyDurableResponse(reserve, "reserve", "reserved")
	if err != nil {
		return err
	}
	if reserveResponse.Record == nil || reserveResponse.Record.RecordKind != budgetstore.RecordKindReserveDecision {
		return fmt.Errorf("qualification reserve did not return a durable reserve decision")
	}
	harness.providerCall()
	settlement := perform(t, harness.handler, http.MethodPost, RouteSettle, settlementBody, mutationHeaders(t, "settle", settlementBody, true))
	settlementResponse, err := qualificationOnlyDurableResponse(settlement, "settle", "settled")
	if err != nil {
		return err
	}
	if settlementResponse.Record == nil || settlementResponse.Record.RecordKind != budgetstore.RecordKindSettlement ||
		settlementResponse.Record.OperationalProjection["cachePublishAuthorized"] != true {
		return fmt.Errorf("qualification settlement did not durably authorize cache publication")
	}
	harness.cachePublish()
	return nil
}

func qualificationOnlyDurableResponse(response *httptest.ResponseRecorder, operation, recordStatus string) (budgetstore.MutationResponse, error) {
	result := response.Result()
	if result.StatusCode != http.StatusCreated {
		return budgetstore.MutationResponse{}, fmt.Errorf("qualification %s status=%d", operation, result.StatusCode)
	}
	decoded, err := budgetstore.DecodeMutationResponse(response.Body.Bytes())
	if err != nil {
		return budgetstore.MutationResponse{}, fmt.Errorf("decode durable qualification %s response: %w", operation, err)
	}
	if decoded.Operation != operation || decoded.Record == nil || decoded.Record.OperationalProjection["status"] != recordStatus ||
		decoded.Receipt.OperationalProjection["status"] != "accepted" {
		return budgetstore.MutationResponse{}, fmt.Errorf("qualification %s durable response binding drifted", operation)
	}
	return decoded, nil
}

func TestQualificationOnlyOrderingHarnessGatesProviderAndCachePublishOnDurability(t *testing.T) {
	reserveBody := reserveBody(t, "100")
	reserveResult := reserveResult(t, reserveBody, "100")
	settlementBody, settlementResult := settlementResult(t, reserveResult)
	events := []string{}
	repository := &fakeRepository{
		reserve: func(context.Context, budgetstore.MutationInput) (budgetstore.MutationResult, error) {
			events = append(events, "reserve_durable")
			return reserveResult, nil
		},
		settle: func(context.Context, budgetstore.MutationInput) (budgetstore.MutationResult, error) {
			events = append(events, "settlement_durable")
			return settlementResult, nil
		},
	}
	harness := qualificationOnlyOrderingHarness{
		handler: newQualificationService(t, repository).Handler(),
		cacheLookup: func() bool {
			events = append(events, "cache_miss")
			return false
		},
		providerCall: func() {
			if len(events) == 0 || events[len(events)-1] != "reserve_durable" {
				t.Fatalf("provider callback ran before durable reserve: %v", events)
			}
			events = append(events, "provider")
		},
		cachePublish: func() {
			if len(events) == 0 || events[len(events)-1] != "settlement_durable" {
				t.Fatalf("cache publication ran before durable settlement: %v", events)
			}
			events = append(events, "cache_publish")
		},
	}
	if err := harness.run(t, reserveBody, settlementBody); err != nil {
		t.Fatal(err)
	}
	want := "cache_miss,reserve_durable,provider,settlement_durable,cache_publish"
	if got := joinQualificationEvents(events); got != want {
		t.Fatalf("qualification-only ordering drifted: got=%s want=%s", got, want)
	}
}

func TestQualificationOnlyOrderingHarnessCacheHitPerformsNoRepositoryMutation(t *testing.T) {
	mutations := 0
	repository := &fakeRepository{
		reserve: func(context.Context, budgetstore.MutationInput) (budgetstore.MutationResult, error) {
			mutations++
			return budgetstore.MutationResult{}, nil
		},
		settle: func(context.Context, budgetstore.MutationInput) (budgetstore.MutationResult, error) {
			mutations++
			return budgetstore.MutationResult{}, nil
		},
	}
	harness := qualificationOnlyOrderingHarness{
		handler:      newQualificationService(t, repository).Handler(),
		cacheLookup:  func() bool { return true },
		providerCall: func() { t.Fatal("provider callback ran for a cache hit") },
		cachePublish: func() { t.Fatal("cache publication ran for a cache hit") },
	}
	if err := harness.run(t, nil, nil); err != nil {
		t.Fatal(err)
	}
	if mutations != 0 {
		t.Fatalf("cache hit performed %d repository mutations", mutations)
	}
}

func TestQualificationOnlyOrderingHarnessFailsClosedBeforeCallbacks(t *testing.T) {
	reserveBody := reserveBody(t, "100")
	reserveResult := reserveResult(t, reserveBody, "100")
	settlementBody, settlement := settlementResult(t, reserveResult)
	for name, corrupt := range map[string]func(*budgetstore.MutationResult){
		"reserve":    func(result *budgetstore.MutationResult) { result.ExactResponseBytes = []byte("{}\n") },
		"settlement": func(result *budgetstore.MutationResult) { result.ExactResponseBytes = []byte("{}\n") },
	} {
		t.Run(name, func(t *testing.T) {
			providerCalls, publications := 0, 0
			badReserve, badSettlement := reserveResult, settlement
			if name == "reserve" {
				corrupt(&badReserve)
			} else {
				corrupt(&badSettlement)
			}
			repository := &fakeRepository{
				reserve: func(context.Context, budgetstore.MutationInput) (budgetstore.MutationResult, error) {
					return badReserve, nil
				},
				settle: func(context.Context, budgetstore.MutationInput) (budgetstore.MutationResult, error) {
					return badSettlement, nil
				},
			}
			harness := qualificationOnlyOrderingHarness{
				handler: newQualificationService(t, repository).Handler(), cacheLookup: func() bool { return false },
				providerCall: func() { providerCalls++ }, cachePublish: func() { publications++ },
			}
			if err := harness.run(t, reserveBody, settlementBody); err == nil {
				t.Fatal("corrupt durable response did not fail closed")
			}
			if name == "reserve" && providerCalls != 0 || publications != 0 {
				t.Fatalf("callbacks escaped durability gate: provider=%d publish=%d", providerCalls, publications)
			}
		})
	}
}

func settlementResult(t *testing.T, reserve budgetstore.MutationResult) ([]byte, budgetstore.MutationResult) {
	t.Helper()
	decision := reserve.Record
	request := decision["request"].(budgetcontract.Record)
	account := decision["afterAccount"].(budgetcontract.Record)
	reservation := reservationForDecision(t, decision)
	decisionHash, err := budgetcontract.HashValue("reserve-decision", decision)
	if err != nil {
		t.Fatal(err)
	}
	usage := budgetcontract.Record{
		"schema":       budgetcontract.SchemaProviderUsage,
		"providerHash": request["expectedProviderHash"], "modelHash": request["expectedModelHash"], "runHash": request["expectedProviderRunHash"],
		"attempt": "1", "calls": "1", "status": "reported", "inputTokens": "4", "outputTokens": "1", "totalTokens": "5",
		"outcome": "provider_response_accepted", "requestHash": "sha256:" + testBuildSHA, "outcomeHash": "sha256:" + testBuildSHA,
	}
	canonical, err := budgetcontract.CanonicalJSON(usage)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("openslack.provider-usage-receipt.v1\x00" + canonical))
	usage["receiptHash"] = "sha256:" + hex.EncodeToString(digest[:])
	usage, err = budgetcontract.ValidateProviderUsage(usage)
	if err != nil {
		t.Fatal(err)
	}
	settlementRequest, err := budgetcontract.ValidateSettlementRequest(budgetcontract.Record{
		"schema":          budgetcontract.SchemaSettlementRequest,
		"contractVersion": budgetcontract.ContractVersion, "authority": budgetcontract.Authority,
		"writer": budgetcontract.Writer, "goRole": budgetcontract.GoRole,
		"goAuthorityClaim": budgetcontract.GoAuthorityClaim, "goAuthorityEligible": false,
		"workspaceId": request["workspaceId"], "runId": request["runId"], "accountId": request["accountId"],
		"reservationId": request["reservationId"], "callId": request["callId"], "providerAttempt": request["providerAttempt"],
		"expectedProviderHash": request["expectedProviderHash"], "expectedModelHash": request["expectedModelHash"], "expectedProviderRunHash": request["expectedProviderRunHash"],
		"correlationId": "correlation-settlement", "policyHash": request["policyHash"], "route": request["route"],
		"expectedAccountRevision": int64(1), "expectedRunRevision": int64(2), "reserveDecisionHash": decisionHash,
		"usageEvidenceStatus": "trusted", "usageReceiptHash": usage["receiptHash"], "providerUsage": usage,
		"rateNanoUsdPerToken": request["rateNanoUsdPerToken"], "requestedAt": "2026-08-15T00:00:02.000Z",
	})
	if err != nil {
		t.Fatal(err)
	}
	prepared, err := budgetcontract.PrepareRequest("settle", settlementRequest, testCaller)
	if err != nil {
		t.Fatal(err)
	}
	evaluation, err := budgetcontract.EvaluateSettlement(account, reservation, settlementRequest, "2026-08-15T00:00:03.000Z")
	if err != nil {
		t.Fatal(err)
	}
	recordHash, _ := budgetcontract.HashValue("settlement", evaluation.Settlement)
	ledgerHash, _ := budgetcontract.HashValue("ledger-entry", evaluation.LedgerEntry)
	receipt, err := budgetcontract.ValidateReceipt(budgetcontract.Record{
		"schema":          budgetcontract.SchemaReceipt,
		"contractVersion": budgetcontract.ContractVersion, "authority": budgetcontract.Authority,
		"writer": budgetcontract.Writer, "goRole": budgetcontract.GoRole,
		"goAuthorityClaim": budgetcontract.GoAuthorityClaim, "goAuthorityEligible": false,
		"operation": "settle", "status": "accepted", "workspaceId": testWorkspace, "runId": testRunID,
		"accountId": "account-1", "reservationId": "reservation-1", "callId": "call-1",
		"expectedAccountRevision": int64(1), "acceptedAccountRevision": int64(2),
		"expectedRunRevision": int64(2), "acceptedRunRevision": int64(3),
		"idempotencyKey": prepared.IdempotencyKey, "requestFingerprint": prepared.RequestFingerprint,
		"requestHash": prepared.RequestHash, "recordHash": recordHash, "ledgerEntryHash": ledgerHash,
		"correlationId": "correlation-settlement", "serviceBuildHash": testBuildSHA,
		"committedAt": "2026-08-15T00:00:03.000Z", "reconciliationToken": nil,
	})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := budgetcontract.ValidateReceiptForResult(receipt, prepared, evaluation.Settlement, evaluation.LedgerEntry, nil); err != nil {
		t.Fatal(err)
	}
	recordOuter := durableRecord(t, budgetstore.RecordKindSettlement, evaluation.Settlement)
	ledgerOuter := durableRecord(t, budgetstore.RecordKindLedgerEntry, evaluation.LedgerEntry)
	receiptOuter := durableRecord(t, budgetstore.RecordKindReceipt, receipt)
	responseValue := budgetstore.MutationResponse{Schema: budgetstore.MutationResponseSchema, Operation: "settle", Record: &recordOuter, Receipt: receiptOuter}
	response, err := budgetstore.EncodeMutationResponse("settle", &recordOuter, receiptOuter, nil)
	if err != nil {
		t.Fatal(err)
	}
	return []byte(prepared.Body), budgetstore.MutationResult{
		Operation: "settle", Status: "settled", Record: evaluation.Settlement, LedgerEntry: evaluation.LedgerEntry, Receipt: receipt,
		DurableRecord: &recordOuter, DurableLedgerEntry: &ledgerOuter, DurableReceipt: receiptOuter, Response: responseValue,
		ExactRecordBytes: durableBytes(t, recordOuter), ExactLedgerBytes: durableBytes(t, ledgerOuter), ExactReceiptBytes: durableBytes(t, receiptOuter),
		ExactResponseBytes: response, ReceiptID: "wf-budget-receipt-settlement", RecordedAt: time.Date(2026, 8, 15, 0, 0, 3, 0, time.UTC),
	}
}

func joinQualificationEvents(events []string) string {
	result := ""
	for index, event := range events {
		if index > 0 {
			result += ","
		}
		result += event
	}
	return result
}
