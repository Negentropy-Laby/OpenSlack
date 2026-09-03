package runnerbindingcontract

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"reflect"
	"strconv"
	"sync"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
)

func validateControlGolden(
	value, message, stage, resolution, resolutionReceipt, stageReceipt, prior, budgetSource any,
) (Record, error) {
	return ValidateControlDeliveryReceiptForMessage(value, message, ControlDeliveryValidationContext{
		Stage: stage, Resolution: resolution, ResolutionReceipt: resolutionReceipt,
		StageReceipt: stageReceipt, PriorEventDelivery: prior, BudgetSourceResult: budgetSource,
	})
}

type exactGoldenVector struct {
	Value          any    `json:"value"`
	CanonicalBytes string `json:"canonicalBytes"`
	ByteLength     int    `json:"byteLength"`
	SHA256         string `json:"sha256"`
	Prepared       struct {
		Schema             string `json:"schema"`
		BodyHash           string `json:"bodyHash"`
		IdempotencyKey     string `json:"idempotencyKey"`
		RequestFingerprint string `json:"requestFingerprint"`
	} `json:"prepared"`
}

type operationGoldenExchange struct {
	Stage             exactGoldenVector `json:"stage"`
	StageReceipt      exactGoldenVector `json:"stageReceipt"`
	Resolution        exactGoldenVector `json:"resolution"`
	ResolutionReceipt exactGoldenVector `json:"resolutionReceipt"`
}

type controlGoldenExchange struct {
	Operation             Operation         `json:"operation"`
	Message               any               `json:"message"`
	Receipt               exactGoldenVector `json:"receipt"`
	BudgetSourceResult    any               `json:"budgetSourceResult"`
	PriorEventDeliveryRef *string           `json:"priorEventDeliveryRef"`
}

type negativeGoldenVector struct {
	ID        string `json:"id"`
	Operation string `json:"operation"`
	Input     any    `json:"input"`
	Expected  struct {
		Name    string    `json:"name"`
		Code    ErrorCode `json:"code"`
		Path    string    `json:"path"`
		Message string    `json:"message"`
	} `json:"expectedError"`
}

type runtimeAdmissionGoldenVector struct {
	Value          any    `json:"value"`
	CanonicalBytes string `json:"canonicalBytes"`
	ByteLength     int    `json:"byteLength"`
	SHA256         string `json:"sha256"`
	Prepared       struct {
		IdempotencyKey     string `json:"idempotencyKey"`
		RequestFingerprint string `json:"requestFingerprint"`
	} `json:"prepared"`
}

type runtimeAdmissionNegativeGolden struct {
	ID        string `json:"id"`
	Operation string `json:"operation"`
	Input     any    `json:"input"`
}

type bindingGoldenVectors struct {
	Schema          string            `json:"schema"`
	ContractVersion string            `json:"contractVersion"`
	Profile         string            `json:"profile"`
	SourceLocks     map[string]string `json:"sourceLocks"`
	OperationMatrix []struct {
		Operation             Operation                      `json:"operation"`
		TargetKind            string                         `json:"targetKind"`
		CompletionControlKind string                         `json:"completionControlKind"`
		RunnerDelta           RunnerDelta                    `json:"runnerDelta"`
		SourcePlane           string                         `json:"sourcePlane"`
		SourceEvidenceState   string                         `json:"sourceEvidenceState"`
		SourceRevisionDelta   int64                          `json:"sourceRevisionDelta"`
		SourceGenerationDelta int64                          `json:"sourceGenerationDelta"`
		SourceReceiptSchema   *string                        `json:"sourceReceiptSchema"`
		AuthorityReceiptHash  *AuthorityReceiptHashAlgorithm `json:"authorityReceiptHashAlgorithm"`
	} `json:"operationMatrix"`
	Positive struct {
		Operations       map[string]operationGoldenExchange `json:"operations"`
		SemanticVariants map[string]operationGoldenExchange `json:"semanticVariants"`
		ControlDelivery  struct {
			Accepted               map[string]exactGoldenVector     `json:"accepted"`
			ReconciliationRequired exactGoldenVector                `json:"reconciliationRequired"`
			Artifacts              map[string]controlGoldenExchange `json:"artifacts"`
			PriorEventDeliveries   map[string]struct {
				Message any               `json:"message"`
				Receipt exactGoldenVector `json:"receipt"`
			} `json:"priorEventDeliveries"`
			ByKind                       map[string]string `json:"byKind"`
			BudgetAuthorization          map[string]string `json:"budgetAuthorization"`
			BudgetDatabaseReconciliation struct {
				Message  any               `json:"message"`
				Receipt  exactGoldenVector `json:"receipt"`
				Decision any               `json:"decision"`
			} `json:"budgetDatabaseReconciliation"`
			Messages map[string]any `json:"messages"`
		} `json:"controlDelivery"`
		RuntimeAdmission struct {
			Request runtimeAdmissionGoldenVector `json:"request"`
			Receipt runtimeAdmissionGoldenVector `json:"receipt"`
		} `json:"runtimeAdmission"`
	} `json:"positive"`
	RuntimeAdmissionNegative []runtimeAdmissionNegativeGolden `json:"runtimeAdmissionNegative"`
	Negative                 []negativeGoldenVector           `json:"negative"`
}

func TestGoldenRuntimeAdmissionParity(t *testing.T) {
	t.Parallel()
	golden := loadBindingGolden(t)
	request := golden.Positive.RuntimeAdmission.Request
	prepared, err := PrepareRuntimeAdmission(request.Value)
	if err != nil {
		t.Fatalf("prepare runtime admission: %v", err)
	}
	requestHash := sha256.Sum256(prepared.ExactBytes)
	if string(prepared.ExactBytes) != request.CanonicalBytes || len(prepared.ExactBytes) != request.ByteLength ||
		hex.EncodeToString(requestHash[:]) != request.SHA256 ||
		prepared.IdempotencyKey != request.Prepared.IdempotencyKey ||
		prepared.RequestFingerprint != request.Prepared.RequestFingerprint {
		t.Fatalf("runtime admission request parity drifted: %+v", prepared)
	}
	receipt := golden.Positive.RuntimeAdmission.Receipt
	receiptHash := sha256.Sum256([]byte(receipt.CanonicalBytes))
	parsed, err := ParseRuntimeAdmissionReceiptBytes([]byte(receipt.CanonicalBytes), prepared)
	if err != nil {
		t.Fatalf("parse runtime admission receipt: %v", err)
	}
	parsedBytes, err := canonicalLF(parsed)
	if err != nil {
		t.Fatalf("canonicalize runtime admission receipt: %v", err)
	}
	if string(parsedBytes) != receipt.CanonicalBytes || len(receipt.CanonicalBytes) != receipt.ByteLength ||
		hex.EncodeToString(receiptHash[:]) != receipt.SHA256 {
		t.Fatalf("runtime admission receipt parity drifted: got=%+v want=%+v", parsed, receipt.Value)
	}
	for _, vector := range golden.RuntimeAdmissionNegative {
		var validationErr error
		switch vector.Operation {
		case "validate_runtime_admission":
			_, validationErr = ValidateRuntimeAdmission(vector.Input)
		case "validate_runtime_admission_receipt":
			_, validationErr = ValidateRuntimeAdmissionReceipt(vector.Input, prepared)
		default:
			t.Fatalf("unknown runtime admission golden operation %q", vector.Operation)
		}
		if validationErr == nil {
			t.Fatalf("runtime admission negative %q unexpectedly passed", vector.ID)
		}
	}
}

func TestGoldenPositiveOperationExchanges(t *testing.T) {
	t.Parallel()
	golden := loadBindingGolden(t)
	if golden.Schema != "openslack.workflow_runner_authority_binding_golden_vectors.v1" ||
		golden.ContractVersion != ContractVersion || golden.Profile != FutureRuntimeProfile {
		t.Fatalf("golden identity drifted: %+v", golden)
	}
	assertGoldenSourceLocks(t, golden)
	assertGoldenOperationMatrix(t, golden)
	if len(golden.Positive.Operations) != len(Operations()) {
		t.Fatalf("positive operation count = %d", len(golden.Positive.Operations))
	}
	for _, operation := range Operations() {
		operation := operation
		t.Run(string(operation), func(t *testing.T) {
			t.Parallel()
			exchange, ok := golden.Positive.Operations[string(operation)]
			if !ok {
				t.Fatalf("missing positive exchange for %s", operation)
			}
			stage := assertGoldenPrepared(t, exchange.Stage, "stage")
			stageReceipt := assertGoldenPrepared(t, exchange.StageReceipt, "receipt")
			resolution := assertGoldenPrepared(t, exchange.Resolution, "resolution")
			resolutionReceipt := assertGoldenPrepared(t, exchange.ResolutionReceipt, "receipt")
			if _, err := ValidateStageReceipt(stageReceipt, stage); err != nil {
				t.Fatalf("stage receipt contextual replay: %v", err)
			}
			if _, err := ValidateResolutionForStage(resolution, stage, stageReceipt); err != nil {
				t.Fatalf("resolution contextual replay: %v", err)
			}
			if _, err := ValidateResolutionReceipt(resolutionReceipt, resolution, stage, stageReceipt); err != nil {
				t.Fatalf("resolution receipt contextual replay: %v", err)
			}
		})
	}
}

func TestGoldenPositiveSemanticVariants(t *testing.T) {
	t.Parallel()
	golden := loadBindingGolden(t)
	if len(golden.Positive.SemanticVariants) != 9 {
		t.Fatalf("semantic variant count = %d", len(golden.Positive.SemanticVariants))
	}
	for name, exchange := range golden.Positive.SemanticVariants {
		name, exchange := name, exchange
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			stage := assertGoldenPrepared(t, exchange.Stage, "stage")
			stageReceipt := assertGoldenPrepared(t, exchange.StageReceipt, "receipt")
			resolution := assertGoldenPrepared(t, exchange.Resolution, "resolution")
			resolutionReceipt := assertGoldenPrepared(t, exchange.ResolutionReceipt, "receipt")
			if _, err := ValidateStageReceipt(stageReceipt, stage); err != nil {
				t.Fatalf("semantic stage receipt replay: %v", err)
			}
			if _, err := ValidateResolutionForStage(resolution, stage, stageReceipt); err != nil {
				t.Fatalf("semantic resolution replay: %v", err)
			}
			if _, err := ValidateResolutionReceipt(resolutionReceipt, resolution, stage, stageReceipt); err != nil {
				t.Fatalf("semantic resolution receipt replay: %v", err)
			}
		})
	}
}

func TestGoldenBudgetRevisionPlanesFollowTheirNamedSources(t *testing.T) {
	t.Parallel()
	golden := loadBindingGolden(t)
	for _, operation := range []Operation{OperationBudgetReserve, OperationBudgetSettle} {
		operation := operation
		t.Run(string(operation), func(t *testing.T) {
			t.Parallel()
			exchange := golden.Positive.Operations[string(operation)]
			stage := assertGoldenPrepared(t, exchange.Stage, "stage")
			resolution := assertGoldenPrepared(t, exchange.Resolution, "resolution")
			evidence, ok := asRecord(resolution["evidence"])
			if !ok {
				t.Fatal("budget resolution evidence must be an object")
			}
			_, request, err := validateBudgetPreparedWithSession(evidence["preparedRequest"], newBindingValidationSession(nil))
			if err != nil {
				t.Fatalf("validate budget prepared request: %v", err)
			}
			sourceAuthority, ok := asRecord(evidence["sourceAuthority"])
			if !ok {
				t.Fatal("budget source authority must be an object")
			}
			runnerHead, ok := asRecord(stage["runnerAuthority"])
			if !ok {
				t.Fatal("budget runner authority must be an object")
			}
			expectedRunnerRevision, expectedOK := runnerHead["expectedGlobalRunRevision"].(int64)
			acceptedRunnerRevision, acceptedOK := runnerHead["acceptedGlobalRunRevision"].(int64)
			delta, deltaErr := RunnerHeadDelta(operation)
			if request["expectedAccountRevision"] != sourceAuthority["expectedRevision"] ||
				!expectedOK || !acceptedOK || deltaErr != nil ||
				acceptedRunnerRevision != expectedRunnerRevision+delta.Revision {
				t.Fatalf("budget revision planes do not follow their named sources: request=%+v source=%+v stage=%+v", request, sourceAuthority, stage)
			}
		})
	}
}

func TestGoldenControlDeliveryReceipts(t *testing.T) {
	t.Parallel()
	golden := loadBindingGolden(t)
	acceptedMessages, ok := asRecord(golden.Positive.ControlDelivery.Messages["accepted"])
	if !ok {
		t.Fatal("accepted control messages must be an operation map")
	}
	if len(golden.Positive.ControlDelivery.Accepted) != len(Operations()) || len(acceptedMessages) != len(Operations()) {
		t.Fatalf("accepted control operation count = receipts:%d messages:%d", len(golden.Positive.ControlDelivery.Accepted), len(acceptedMessages))
	}
	for _, operation := range Operations() {
		operation := operation
		t.Run("accepted/"+string(operation), func(t *testing.T) {
			t.Parallel()
			vector, ok := golden.Positive.ControlDelivery.Accepted[string(operation)]
			if !ok {
				t.Fatalf("missing accepted receipt for %s", operation)
			}
			message, ok := acceptedMessages[string(operation)]
			if !ok {
				t.Fatalf("missing accepted control message for %s", operation)
			}
			receipt := assertGoldenPrepared(t, vector, "receipt")
			exchange := golden.Positive.Operations[string(operation)]
			validated, err := validateControlGolden(
				receipt,
				message,
				exchange.Stage.Value,
				exchange.Resolution.Value,
				exchange.ResolutionReceipt.Value,
				exchange.StageReceipt.Value,
				nil,
				nil,
			)
			if err != nil {
				t.Fatalf("control delivery contextual replay: %v", err)
			}
			if validated["status"] != "accepted" || validated["disposition"] != "accepted" || validated["operation"] != string(operation) {
				t.Fatalf("delivery/disposition semantics drifted: %+v", validated)
			}
		})
	}
	t.Run("reconciliationRequired", func(t *testing.T) {
		t.Parallel()
		receipt := assertGoldenPrepared(t, golden.Positive.ControlDelivery.ReconciliationRequired, "receipt")
		message, ok := golden.Positive.ControlDelivery.Messages["reconciliationRequired"]
		if !ok {
			t.Fatal("missing reconciliation-required control message")
		}
		exchange := golden.Positive.Operations[string(OperationEffectComplete)]
		validated, err := validateControlGolden(
			receipt,
			message,
			exchange.Stage.Value,
			exchange.Resolution.Value,
			exchange.ResolutionReceipt.Value,
			exchange.StageReceipt.Value,
			goldenPriorEventDelivery(t, golden, OperationEffectComplete),
			nil,
		)
		if err != nil {
			t.Fatalf("control delivery contextual replay: %v", err)
		}
		if validated["status"] != "accepted" || validated["disposition"] != "reconciliation_required" {
			t.Fatalf("delivery/disposition semantics drifted: %+v", validated)
		}
	})
	if len(golden.Positive.ControlDelivery.ByKind) != 5 {
		t.Fatalf("control kind count = %d", len(golden.Positive.ControlDelivery.ByKind))
	}
	for kind, reference := range golden.Positive.ControlDelivery.ByKind {
		kind, control := kind, goldenControlArtifact(t, golden, reference)
		t.Run("kind/"+kind, func(t *testing.T) {
			t.Parallel()
			exchange, ok := golden.Positive.Operations[string(control.Operation)]
			if kind == string(authoritycontract.KindBudgetAuthorization) {
				exchange, ok = golden.Positive.SemanticVariants["budgetReserveGoAuthority"]
			}
			if !ok {
				t.Fatalf("missing operation context for control kind %s", kind)
			}
			receipt := assertGoldenPrepared(t, control.Receipt, "receipt")
			validated, err := validateControlGolden(
				receipt,
				control.Message,
				exchange.Stage.Value,
				exchange.Resolution.Value,
				exchange.ResolutionReceipt.Value,
				exchange.StageReceipt.Value,
				controlPriorForGolden(t, golden, kind, control),
				control.BudgetSourceResult,
			)
			if err != nil {
				t.Fatalf("control kind contextual replay: %v", err)
			}
			if validated["controlKind"] != kind || validated["operation"] != string(control.Operation) {
				t.Fatalf("control kind binding drifted: %+v", validated)
			}
		})
	}
	if len(golden.Positive.ControlDelivery.BudgetAuthorization) != 2 {
		t.Fatalf("budget authorization result count = %d", len(golden.Positive.ControlDelivery.BudgetAuthorization))
	}
	budgetExchange := golden.Positive.SemanticVariants["budgetReserveGoAuthority"]
	budgetStage := assertGoldenPrepared(t, budgetExchange.Stage, "stage")
	for status, reference := range golden.Positive.ControlDelivery.BudgetAuthorization {
		status, control := status, goldenControlArtifact(t, golden, reference)
		t.Run("budgetAuthorization/"+status, func(t *testing.T) {
			t.Parallel()
			receipt := assertGoldenPrepared(t, control.Receipt, "receipt")
			validated, err := validateControlGolden(
				receipt, control.Message, budgetExchange.Stage.Value, budgetExchange.Resolution.Value,
				budgetExchange.ResolutionReceipt.Value, budgetExchange.StageReceipt.Value,
				goldenNamedPriorDelivery(t, golden, control.PriorEventDeliveryRef), control.BudgetSourceResult,
			)
			if err != nil {
				t.Fatalf("budget %s contextual replay: %v", status, err)
			}
			if validated["controlKind"] != string(authoritycontract.KindBudgetAuthorization) {
				t.Fatalf("budget %s control kind drifted: %+v", status, validated)
			}
			message, ok := asRecord(control.Message)
			if !ok {
				t.Fatal("budget control message must be an object")
			}
			payload, ok := asRecord(message["payload"])
			if !ok {
				t.Fatal("budget control payload must be an object")
			}
			runnerHead, ok := asRecord(budgetStage["runnerAuthority"])
			if !ok {
				t.Fatal("budget runner authority must be an object")
			}
			source, ok := asRecord(control.BudgetSourceResult)
			if !ok {
				t.Fatal("budget source result must be an object")
			}
			durable, err := parseBudgetDurableReceiptWithSession(source["durableReceiptBytes"], newBindingValidationSession(nil))
			if err != nil {
				t.Fatalf("parse budget durable receipt: %v", err)
			}
			if goldenInt64(t, message["runRevision"], "budget message run revision") !=
				goldenInt64(t, runnerHead["acceptedGlobalRunRevision"], "accepted runner revision") ||
				goldenInt64(t, payload["committedRunRevision"], "committed budget revision") !=
					goldenInt64(t, durable.projection["acceptedRunRevision"], "durable accepted revision") {
				t.Fatalf("budget %s revision planes were conflated: message=%+v runner=%+v", status, message, runnerHead)
			}
		})
	}
	t.Run("decisionChronologyWindow", func(t *testing.T) {
		cases := []struct {
			name, reference, sentAt string
			exchange                operationGoldenExchange
		}{
			{name: "budgetBoundary", reference: golden.Positive.ControlDelivery.BudgetAuthorization["reserved"], exchange: budgetExchange},
			{name: "effectInterior", reference: golden.Positive.ControlDelivery.ByKind[string(authoritycontract.KindEffectAuthorization)], sentAt: "2026-08-20T00:07:00.500Z", exchange: golden.Positive.Operations[string(OperationEffectAuthorize)]},
		}
		for _, testCase := range cases {
			t.Run(testCase.name, func(t *testing.T) {
				control := goldenControlArtifact(t, golden, testCase.reference)
				messageSource, messageOK := asRecord(control.Message)
				receiptSource, receiptOK := asRecord(control.Receipt.Value)
				var prior any
				if control.PriorEventDeliveryRef == nil {
					prior = goldenPriorEventDelivery(t, golden, control.Operation)
				} else {
					prior = goldenNamedPriorDelivery(t, golden, control.PriorEventDeliveryRef)
				}
				priorRecord, priorOK := asRecord(prior)
				priorMessage, priorMessageOK := asRecord(priorRecord["message"])
				priorReceipt, priorReceiptOK := asRecord(priorRecord["receipt"])
				if !messageOK || !receiptOK || !priorOK || !priorMessageOK || !priorReceiptOK {
					t.Fatal("decision chronology fixture must contain closed records")
				}
				message := cloneRecord(messageSource)
				sentAt := testCase.sentAt
				if sentAt == "" {
					sentAt, _ = priorMessage["sentAt"].(string)
				}
				priorSentAt, _ := priorMessage["sentAt"].(string)
				priorCommittedAt, _ := priorReceipt["committedAt"].(string)
				message["sentAt"] = sentAt
				if sentAt < priorSentAt || sentAt >= priorCommittedAt || testCase.sentAt != "" && sentAt <= priorSentAt {
					t.Fatalf("decision timestamp is outside the relaxed window: prior=%s decision=%s ACK=%s", priorSentAt, sentAt, priorCommittedAt)
				}
				_, prepared, err := prepareAuthorityMessageValue(message)
				if err != nil {
					t.Fatalf("prepare decision in chronology window: %v", err)
				}
				receipt := cloneRecord(receiptSource)
				receipt["messageDigest"] = prepared.MessageDigest
				if _, err := validateControlGolden(
					receipt, message, testCase.exchange.Stage.Value, testCase.exchange.Resolution.Value,
					testCase.exchange.ResolutionReceipt.Value, testCase.exchange.StageReceipt.Value,
					prior, control.BudgetSourceResult,
				); err != nil {
					t.Fatalf("decision in event-receipt message epoch was rejected: %v", err)
				}
			})
		}
	})
	t.Run("budgetDatabaseReconciliation/eventReceiptOnly", func(t *testing.T) {
		t.Parallel()
		control := golden.Positive.ControlDelivery.BudgetDatabaseReconciliation
		exchange := golden.Positive.SemanticVariants["budgetReserveGoAuthority"]
		receipt := assertGoldenPrepared(t, control.Receipt, "receipt")
		validated, err := validateControlGolden(
			receipt, control.Message, exchange.Stage.Value, exchange.Resolution.Value,
			exchange.ResolutionReceipt.Value, exchange.StageReceipt.Value, nil, nil,
		)
		if err != nil {
			t.Fatalf("database-unknown event receipt replay: %v", err)
		}
		if validated["disposition"] != "reconciliation_required" || control.Decision != nil {
			t.Fatalf("database-unknown must stop after seq3: %+v", validated)
		}
	})
	t.Run("singleCanonicalEncodingPerValidatedRecord", func(t *testing.T) {
		t.Parallel()
		operation := OperationCheckpointCommit
		exchange := golden.Positive.Operations[string(operation)]
		receipt := golden.Positive.ControlDelivery.Accepted[string(operation)].Value
		message := acceptedMessages[string(operation)]
		encoded := map[uintptr]int{}
		_, err := validateControlDeliveryReceiptForMessageWithObserver(
			receipt,
			message,
			ControlDeliveryValidationContext{
				Stage: exchange.Stage.Value, Resolution: exchange.Resolution.Value,
				ResolutionReceipt: exchange.ResolutionReceipt.Value, StageReceipt: exchange.StageReceipt.Value,
			},
			func(record Record) { encoded[reflect.ValueOf(record).Pointer()]++ },
			nil,
		)
		if err != nil {
			t.Fatalf("instrumented control delivery validation: %v", err)
		}
		if len(encoded) != 6 {
			t.Fatalf("canonical record encodes = %d, want 6", len(encoded))
		}
		for identity, count := range encoded {
			if count != 1 {
				t.Fatalf("canonical record %x encoded %d times", identity, count)
			}
		}
	})
	t.Run("singleBudgetValidationPasses", func(t *testing.T) {
		control := goldenControlArtifact(t, golden, golden.Positive.ControlDelivery.BudgetAuthorization["reserved"])
		exchange := golden.Positive.SemanticVariants["budgetReserveGoAuthority"]
		var events []string
		_, err := validateControlDeliveryReceiptForMessageWithObserver(
			control.Receipt.Value,
			control.Message,
			ControlDeliveryValidationContext{
				Stage: exchange.Stage.Value, Resolution: exchange.Resolution.Value,
				ResolutionReceipt: exchange.ResolutionReceipt.Value, StageReceipt: exchange.StageReceipt.Value,
				PriorEventDelivery: goldenNamedPriorDelivery(t, golden, control.PriorEventDeliveryRef),
				BudgetSourceResult: control.BudgetSourceResult,
			},
			nil,
			func(event string) { events = append(events, event) },
		)
		if err != nil {
			t.Fatalf("instrumented budget delivery validation: %v", err)
		}
		if !reflect.DeepEqual(events, []string{"budget_prepared_parse", "budget_durable_parse"}) {
			t.Fatalf("budget validation passes = %v", events)
		}
	})
}

func goldenControlPrior(t *testing.T, golden bindingGoldenVectors, kind string, operation Operation) any {
	t.Helper()
	if kind == string("event_receipt") {
		return nil
	}
	return goldenPriorEventDelivery(t, golden, operation)
}

func controlPriorForGolden(t *testing.T, golden bindingGoldenVectors, kind string, control controlGoldenExchange) any {
	t.Helper()
	if control.PriorEventDeliveryRef != nil {
		return goldenNamedPriorDelivery(t, golden, control.PriorEventDeliveryRef)
	}
	return goldenControlPrior(t, golden, kind, control.Operation)
}

func goldenControlArtifact(t *testing.T, golden bindingGoldenVectors, reference string) controlGoldenExchange {
	t.Helper()
	artifact, ok := golden.Positive.ControlDelivery.Artifacts[reference]
	if !ok {
		t.Fatalf("missing control delivery artifact %s", reference)
	}
	return artifact
}

func goldenNamedPriorDelivery(t *testing.T, golden bindingGoldenVectors, reference *string) any {
	t.Helper()
	if reference == nil {
		return nil
	}
	prior, ok := golden.Positive.ControlDelivery.PriorEventDeliveries[*reference]
	if !ok {
		t.Fatalf("missing prior event delivery artifact %s", *reference)
	}
	receipt := assertGoldenPrepared(t, prior.Receipt, "receipt")
	return Record{"message": prior.Message, "receipt": receipt}
}

func goldenPriorEventDelivery(t *testing.T, golden bindingGoldenVectors, operation Operation) Record {
	t.Helper()
	acceptedMessages, ok := asRecord(golden.Positive.ControlDelivery.Messages["accepted"])
	if !ok {
		t.Fatal("accepted control messages must be an operation map")
	}
	message, ok := acceptedMessages[string(operation)]
	if !ok {
		t.Fatalf("missing prior event-receipt message for %s", operation)
	}
	receipt, ok := golden.Positive.ControlDelivery.Accepted[string(operation)]
	if !ok {
		t.Fatalf("missing prior event-receipt ACK for %s", operation)
	}
	return Record{"message": message, "receipt": assertGoldenPrepared(t, receipt, "receipt")}
}

func TestGoldenNegativeReplay(t *testing.T) {
	t.Parallel()
	golden := loadBindingGolden(t)
	manifest := loadRunnerBindingManifest(t)
	ids := make([]string, 0, len(golden.Negative))
	seen := make(map[string]struct{}, len(golden.Negative))
	for _, vector := range golden.Negative {
		if _, exists := seen[vector.ID]; exists {
			t.Fatalf("duplicate negative vector id %q", vector.ID)
		}
		seen[vector.ID] = struct{}{}
		ids = append(ids, vector.ID)
	}
	if !reflect.DeepEqual(ids, manifest.NegativeVectorIDs) {
		t.Fatalf("negative vector inventory drifted: got=%v want=%v", ids, manifest.NegativeVectorIDs)
	}
	for _, vector := range golden.Negative {
		vector := vector
		t.Run(vector.ID, func(t *testing.T) {
			t.Parallel()
			err := replayGoldenNegative(vector.Operation, vector.Input)
			var contractErr *ContractError
			if !errors.As(err, &contractErr) {
				t.Fatalf("expected ContractError, got %T %v", err, err)
			}
			if vector.Expected.Name != "WorkflowRunnerAuthorityBindingContractError" ||
				contractErr.Code != vector.Expected.Code || contractErr.Path != vector.Expected.Path ||
				contractErr.Message != vector.Expected.Message {
				t.Fatalf("negative parity mismatch: got=%+v want=%+v", contractErr, vector.Expected)
			}
		})
	}
}

func TestGoldenBudgetNegativeEvidenceIsNotFalseGreen(t *testing.T) {
	t.Parallel()
	golden := loadBindingGolden(t)
	for _, id := range []string{
		"budget-runner-envelope-revision-drift",
		"budget-decision-valid-source-result-cross-splice",
		"budget-durable-request-cross-splice",
	} {
		vector := bindingNegativeByID(t, golden, id)
		input, ok := asRecord(vector.Input)
		if !ok {
			t.Fatalf("negative %s input must be an object", vector.ID)
		}
		switch vector.ID {
		case "budget-runner-envelope-revision-drift":
			message, messageOK := asRecord(input["message"])
			receipt, receiptOK := asRecord(input["receipt"])
			stage, stageOK := asRecord(input["stage"])
			runnerHead, runnerOK := asRecord(stage["runnerAuthority"])
			payload, payloadOK := asRecord(message["payload"])
			source, sourceOK := asRecord(input["budgetSourceResult"])
			if !messageOK || !receiptOK || !stageOK || !runnerOK || !payloadOK || !sourceOK {
				t.Fatal("budget envelope drift evidence shape is invalid")
			}
			prepared, err := authoritycontract.PrepareMessage(map[string]any(message))
			if err != nil {
				t.Fatalf("prepare drifted budget message: %v", err)
			}
			durable, err := parseBudgetDurableReceiptWithSession(source["durableReceiptBytes"], newBindingValidationSession(nil))
			if err != nil {
				t.Fatalf("parse drifted budget source receipt: %v", err)
			}
			if receipt["messageDigest"] != prepared.MessageDigest ||
				goldenInt64(t, message["runRevision"], "drifted message run revision") ==
					goldenInt64(t, runnerHead["acceptedGlobalRunRevision"], "accepted runner revision") ||
				goldenInt64(t, payload["committedRunRevision"], "committed budget revision") !=
					goldenInt64(t, durable.projection["acceptedRunRevision"], "durable accepted revision") {
				t.Fatal("budget envelope drift must preserve its exact digest and source-receipt binding")
			}
		case "budget-decision-valid-source-result-cross-splice":
			source, sourceOK := asRecord(input["budgetSourceResult"])
			decision, decisionOK := asRecord(source["decision"])
			request, requestOK := asRecord(decision["request"])
			resolution, resolutionOK := asRecord(input["resolution"])
			evidence, evidenceOK := asRecord(resolution["evidence"])
			originalPrepared, preparedOK := asRecord(evidence["preparedRequest"])
			if !sourceOK || !decisionOK || !requestOK || !resolutionOK || !evidenceOK || !preparedOK {
				t.Fatal("valid sibling budget source evidence shape is invalid")
			}
			prepared, err := budgetcontract.PrepareRequest("reserve", map[string]any(request), "qualification-caller")
			if err != nil {
				t.Fatalf("prepare valid sibling budget request: %v", err)
			}
			if _, err := ValidateBudgetSourceResult(source, prepared); err != nil {
				t.Fatalf("valid sibling budget source result must validate independently: %v", err)
			}
			if prepared.Body == originalPrepared["body"] {
				t.Fatal("sibling budget source result must differ from the original prepared request")
			}
		case "budget-durable-request-cross-splice":
			source, sourceOK := asRecord(input["budgetSourceResult"])
			decision, decisionOK := asRecord(source["decision"])
			request, requestOK := asRecord(decision["request"])
			resolution, resolutionOK := asRecord(input["resolution"])
			evidence, evidenceOK := asRecord(resolution["evidence"])
			originalPrepared, preparedOK := asRecord(evidence["preparedRequest"])
			if !sourceOK || !decisionOK || !requestOK || !resolutionOK || !evidenceOK || !preparedOK {
				t.Fatal("request cross-splice evidence shape is invalid")
			}
			canonicalRequest, err := budgetcontract.CanonicalJSON(request)
			if err != nil {
				t.Fatalf("canonicalize request cross-splice: %v", err)
			}
			if canonicalRequest+"\n" == originalPrepared["body"] ||
				vector.Expected.Path != "$/budgetSourceResult/receipt/request" {
				t.Fatal("request cross-splice must preserve a distinct decision request and exact nested failure path")
			}
		}
	}
}

func bindingNegativeByID(t *testing.T, golden bindingGoldenVectors, id string) negativeGoldenVector {
	t.Helper()
	for _, vector := range golden.Negative {
		if vector.ID == id {
			return vector
		}
	}
	t.Fatalf("missing negative golden vector %q", id)
	return negativeGoldenVector{}
}

func goldenInt64(t *testing.T, value any, label string) int64 {
	t.Helper()
	integer, ok := value.(int64)
	if !ok {
		t.Fatalf("%s is not an int64: %T", label, value)
	}
	return integer
}

var (
	bindingGoldenOnce  sync.Once
	bindingGoldenValue bindingGoldenVectors
	bindingGoldenErr   error
)

func loadBindingGolden(t *testing.T) bindingGoldenVectors {
	t.Helper()
	bindingGoldenOnce.Do(func() {
		var contents []byte
		contents, bindingGoldenErr = BundleFile("golden-vectors.json")
		if bindingGoldenErr != nil {
			return
		}
		if _, bindingGoldenErr = parseStrictJSON(contents, len(contents), 64, 500_000, 2*MaxStringBytes, MaxSafeInteger); bindingGoldenErr != nil {
			bindingGoldenErr = fmt.Errorf("strict decode golden vectors: %w", bindingGoldenErr)
			return
		}
		decoder := json.NewDecoder(bytes.NewReader(contents))
		decoder.UseNumber()
		if bindingGoldenErr = decoder.Decode(&bindingGoldenValue); bindingGoldenErr != nil {
			bindingGoldenErr = fmt.Errorf("decode golden vectors: %w", bindingGoldenErr)
			return
		}
		if bindingGoldenErr = ensureGoldenEOF(decoder); bindingGoldenErr != nil {
			bindingGoldenErr = fmt.Errorf("decode golden vectors: %w", bindingGoldenErr)
			return
		}
		if bindingGoldenErr = normalizeGoldenNumbers(reflect.ValueOf(&bindingGoldenValue)); bindingGoldenErr != nil {
			bindingGoldenErr = fmt.Errorf("normalize golden vectors: %w", bindingGoldenErr)
		}
	})
	if bindingGoldenErr != nil {
		t.Fatal(bindingGoldenErr)
	}
	return bindingGoldenValue
}

func ensureGoldenEOF(decoder *json.Decoder) error {
	var trailing any
	err := decoder.Decode(&trailing)
	if errors.Is(err, io.EOF) {
		return nil
	}
	if err == nil {
		return errors.New("golden vectors contain trailing JSON")
	}
	return err
}

func normalizeGoldenNumbers(value reflect.Value) error {
	if !value.IsValid() {
		return nil
	}
	switch value.Kind() {
	case reflect.Pointer:
		if !value.IsNil() {
			return normalizeGoldenNumbers(value.Elem())
		}
	case reflect.Interface:
		if value.IsNil() {
			return nil
		}
		normalized, err := normalizeGoldenDynamic(value.Interface())
		if err != nil {
			return err
		}
		value.Set(reflect.ValueOf(normalized))
	case reflect.Struct:
		for index := 0; index < value.NumField(); index++ {
			if err := normalizeGoldenNumbers(value.Field(index)); err != nil {
				return err
			}
		}
	case reflect.Map:
		iterator := value.MapRange()
		for iterator.Next() {
			entry := reflect.New(value.Type().Elem()).Elem()
			entry.Set(iterator.Value())
			if err := normalizeGoldenNumbers(entry); err != nil {
				return err
			}
			value.SetMapIndex(iterator.Key(), entry)
		}
	case reflect.Slice:
		for index := 0; index < value.Len(); index++ {
			if err := normalizeGoldenNumbers(value.Index(index)); err != nil {
				return err
			}
		}
	}
	return nil
}

func normalizeGoldenDynamic(value any) (any, error) {
	switch current := value.(type) {
	case json.Number:
		parsed, err := strconv.ParseInt(string(current), 10, 64)
		if err != nil {
			return nil, fmt.Errorf("golden number %q is not an integer: %w", current, err)
		}
		return parsed, nil
	case map[string]any:
		for key, entry := range current {
			normalized, err := normalizeGoldenDynamic(entry)
			if err != nil {
				return nil, err
			}
			current[key] = normalized
		}
		return current, nil
	case []any:
		for index, entry := range current {
			normalized, err := normalizeGoldenDynamic(entry)
			if err != nil {
				return nil, err
			}
			current[index] = normalized
		}
		return current, nil
	default:
		return value, nil
	}
}

func assertGoldenPrepared(t *testing.T, vector exactGoldenVector, domain string) Record {
	t.Helper()
	var (
		prepared Prepared
		err      error
		parsed   Record
	)
	switch domain {
	case "stage":
		prepared, err = PrepareStage(vector.Value)
		if err == nil {
			parsed, err = ParseStageBytes([]byte(vector.CanonicalBytes))
		}
	case "resolution":
		prepared, err = PrepareResolution(vector.Value)
		if err == nil {
			parsed, err = ParseResolutionBytes([]byte(vector.CanonicalBytes))
		}
	case "receipt":
		prepared, err = PrepareReceipt(vector.Value)
		if err == nil {
			parsed, err = ParseReceiptBytes([]byte(vector.CanonicalBytes))
		}
	default:
		t.Fatalf("unknown prepared domain %s", domain)
	}
	if err != nil {
		t.Fatalf("%s exact replay: %v", domain, err)
	}
	if prepared.Body != vector.CanonicalBytes || len([]byte(vector.CanonicalBytes)) != vector.ByteLength ||
		sha256Bytes([]byte(vector.CanonicalBytes)) != vector.SHA256 ||
		prepared.Schema != vector.Prepared.Schema || prepared.BodyHash != vector.Prepared.BodyHash ||
		prepared.IdempotencyKey != vector.Prepared.IdempotencyKey ||
		prepared.RequestFingerprint != vector.Prepared.RequestFingerprint ||
		!sameCanonical(prepared.Value, parsed) {
		t.Fatalf("%s exact-byte evidence drifted", domain)
	}
	return prepared.Value
}

func replayGoldenNegative(operation string, input any) error {
	switch operation {
	case "validate_stage":
		_, err := ValidateStage(input)
		return err
	case "validate_resolution":
		_, err := ValidateResolution(input)
		return err
	case "validate_stage_receipt":
		record, err := goldenInputRecord(input)
		if err != nil {
			return err
		}
		_, err = ValidateStageReceipt(record["receipt"], record["stage"])
		return err
	case "validate_resolution_receipt":
		record, err := goldenInputRecord(input)
		if err != nil {
			return err
		}
		_, err = ValidateResolutionReceipt(record["receipt"], record["resolution"], record["stage"], record["stageReceipt"])
		return err
	case "validate_control_delivery":
		record, err := goldenInputRecord(input)
		if err != nil {
			return err
		}
		_, err = validateControlGolden(
			record["receipt"], record["message"], record["stage"], record["resolution"], record["resolutionReceipt"],
			record["stageReceipt"], record["priorEventDelivery"], record["budgetSourceResult"],
		)
		return err
	case "validate_budget_source_result":
		record, err := goldenInputRecord(input)
		if err != nil {
			return err
		}
		_, err = ValidateBudgetSourceResult(record["sourceResult"], record["preparedRequest"])
		return err
	case "validate_resolution_for_stage":
		record, err := goldenInputRecord(input)
		if err != nil {
			return err
		}
		_, err = ValidateResolutionForStage(record["resolution"], record["stage"], record["stageReceipt"])
		return err
	default:
		return fmt.Errorf("unknown negative operation %q", operation)
	}
}

func goldenInputRecord(value any) (Record, error) {
	record, ok := asRecord(value)
	if !ok {
		return nil, fmt.Errorf("golden negative input is not an object")
	}
	return record, nil
}

func assertGoldenSourceLocks(t *testing.T, golden bindingGoldenVectors) {
	t.Helper()
	locks := SourceLocks()
	if len(golden.SourceLocks) != len(locks) {
		t.Fatalf("golden source lock count = %d", len(golden.SourceLocks))
	}
	for _, lock := range locks {
		if golden.SourceLocks[lock.Name] != lock.SHA256 {
			t.Fatalf("golden source lock %s drifted", lock.Name)
		}
	}
}

func assertGoldenOperationMatrix(t *testing.T, golden bindingGoldenVectors) {
	t.Helper()
	if len(golden.OperationMatrix) != len(Operations()) {
		t.Fatalf("golden operation matrix count = %d", len(golden.OperationMatrix))
	}
	for index, operation := range Operations() {
		entry := golden.OperationMatrix[index]
		kind, _ := ExpectedKind(operation)
		delta, _ := RunnerHeadDelta(operation)
		fact, _ := factFor(operation)
		receiptSchema, _ := SourceReceiptSchema(operation)
		state := "committed"
		sourceRevisionDelta := int64(1)
		if operation == OperationBudgetReserve || operation == OperationBudgetSettle {
			state = "prepared"
			sourceRevisionDelta = 0
		}
		sourceGenerationDelta := int64(0)
		if operation == OperationResumeAdvance {
			sourceGenerationDelta = 1
		}
		completionKind, completionErr := CompletionControlKind(operation)
		if entry.Operation != operation || entry.TargetKind != string(kind) || completionErr != nil || entry.CompletionControlKind != string(completionKind) || entry.RunnerDelta != delta ||
			entry.SourceEvidenceState != state || entry.SourceRevisionDelta != sourceRevisionDelta ||
			entry.SourceGenerationDelta != sourceGenerationDelta ||
			!nullableStringsEqual(entry.SourceReceiptSchema, receiptSchema) ||
			!nullableHashAlgorithmsEqual(entry.AuthorityReceiptHash, fact.AuthorityReceiptHash) {
			t.Fatalf("golden operation matrix drift at %s: %+v", operation, entry)
		}
	}
}

func nullableHashAlgorithmsEqual(actual *AuthorityReceiptHashAlgorithm, expected AuthorityReceiptHashAlgorithm) bool {
	if expected == AuthorityReceiptHashNone {
		return actual == nil
	}
	return actual != nil && *actual == expected
}
