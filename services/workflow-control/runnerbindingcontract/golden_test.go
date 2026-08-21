package runnerbindingcontract

import (
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
)

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
	Operation          Operation         `json:"operation"`
	Message            any               `json:"message"`
	Receipt            exactGoldenVector `json:"receipt"`
	BudgetSourceResult any               `json:"budgetSourceResult"`
	PriorEventDelivery any               `json:"priorEventDelivery"`
}

type budgetControlGoldenExchange struct {
	Message            any               `json:"message"`
	Receipt            exactGoldenVector `json:"receipt"`
	PriorEventDelivery any               `json:"priorEventDelivery"`
	SourceResult       any               `json:"sourceResult"`
}

type bindingGoldenVectors struct {
	Schema          string            `json:"schema"`
	ContractVersion string            `json:"contractVersion"`
	Profile         string            `json:"profile"`
	SourceLocks     map[string]string `json:"sourceLocks"`
	OperationMatrix []struct {
		Operation             Operation   `json:"operation"`
		TargetKind            string      `json:"targetKind"`
		RunnerDelta           RunnerDelta `json:"runnerDelta"`
		SourcePlane           string      `json:"sourcePlane"`
		SourceEvidenceState   string      `json:"sourceEvidenceState"`
		SourceRevisionDelta   int64       `json:"sourceRevisionDelta"`
		SourceGenerationDelta int64       `json:"sourceGenerationDelta"`
		SourceReceiptSchema   *string     `json:"sourceReceiptSchema"`
	} `json:"operationMatrix"`
	Positive struct {
		Operations       map[string]operationGoldenExchange `json:"operations"`
		SemanticVariants map[string]operationGoldenExchange `json:"semanticVariants"`
		ControlDelivery  struct {
			Accepted                     map[string]exactGoldenVector           `json:"accepted"`
			ReconciliationRequired       exactGoldenVector                      `json:"reconciliationRequired"`
			ByKind                       map[string]controlGoldenExchange       `json:"byKind"`
			BudgetAuthorization          map[string]budgetControlGoldenExchange `json:"budgetAuthorization"`
			BudgetDatabaseReconciliation struct {
				Message  any               `json:"message"`
				Receipt  exactGoldenVector `json:"receipt"`
				Decision any               `json:"decision"`
			} `json:"budgetDatabaseReconciliation"`
			Messages map[string]any `json:"messages"`
		} `json:"controlDelivery"`
	} `json:"positive"`
	Negative []struct {
		ID        string `json:"id"`
		Operation string `json:"operation"`
		Input     any    `json:"input"`
		Expected  struct {
			Name    string    `json:"name"`
			Code    ErrorCode `json:"code"`
			Path    string    `json:"path"`
			Message string    `json:"message"`
		} `json:"expectedError"`
	} `json:"negative"`
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
			validated, err := ValidateControlDeliveryReceiptForMessage(
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
		validated, err := ValidateControlDeliveryReceiptForMessage(
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
	for kind, control := range golden.Positive.ControlDelivery.ByKind {
		kind, control := kind, control
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
			validated, err := ValidateControlDeliveryReceiptForMessage(
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
	for status, control := range golden.Positive.ControlDelivery.BudgetAuthorization {
		status, control := status, control
		t.Run("budgetAuthorization/"+status, func(t *testing.T) {
			t.Parallel()
			exchange := golden.Positive.SemanticVariants["budgetReserveGoAuthority"]
			receipt := assertGoldenPrepared(t, control.Receipt, "receipt")
			validated, err := ValidateControlDeliveryReceiptForMessage(
				receipt, control.Message, exchange.Stage.Value, exchange.Resolution.Value,
				exchange.ResolutionReceipt.Value, exchange.StageReceipt.Value,
				goldenPriorValue(control.PriorEventDelivery), control.SourceResult,
			)
			if err != nil {
				t.Fatalf("budget %s contextual replay: %v", status, err)
			}
			if validated["controlKind"] != string(authoritycontract.KindBudgetAuthorization) {
				t.Fatalf("budget %s control kind drifted: %+v", status, validated)
			}
		})
	}
	t.Run("budgetDatabaseReconciliation/eventReceiptOnly", func(t *testing.T) {
		t.Parallel()
		control := golden.Positive.ControlDelivery.BudgetDatabaseReconciliation
		exchange := golden.Positive.SemanticVariants["budgetReserveGoAuthority"]
		receipt := assertGoldenPrepared(t, control.Receipt, "receipt")
		validated, err := ValidateControlDeliveryReceiptForMessage(
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
			exchange.Stage.Value,
			exchange.Resolution.Value,
			exchange.ResolutionReceipt.Value,
			exchange.StageReceipt.Value,
			nil,
			nil,
			func(record Record) { encoded[reflect.ValueOf(record).Pointer()]++ },
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
	if control.PriorEventDelivery != nil {
		return goldenPriorValue(control.PriorEventDelivery)
	}
	return goldenControlPrior(t, golden, kind, control.Operation)
}

func goldenPriorValue(value any) any {
	record, ok := asRecord(value)
	if !ok {
		return value
	}
	receipt, ok := asRecord(record["receipt"])
	if ok && receipt["value"] != nil {
		return Record{"message": record["message"], "receipt": receipt["value"]}
	}
	return value
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
	return Record{"message": message, "receipt": receipt.Value}
}

func TestGoldenNegativeReplay(t *testing.T) {
	t.Parallel()
	golden := loadBindingGolden(t)
	if len(golden.Negative) != 59 {
		t.Fatalf("negative count = %d", len(golden.Negative))
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

func loadBindingGolden(t *testing.T) bindingGoldenVectors {
	t.Helper()
	contents, err := BundleFile("golden-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var golden bindingGoldenVectors
	if err := json.Unmarshal(contents, &golden); err != nil {
		t.Fatalf("decode golden vectors: %v", err)
	}
	return golden
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
		_, err = ValidateControlDeliveryReceiptForMessage(
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
		if entry.Operation != operation || entry.TargetKind != string(kind) || entry.RunnerDelta != delta ||
			entry.SourceEvidenceState != state || entry.SourceRevisionDelta != sourceRevisionDelta ||
			entry.SourceGenerationDelta != sourceGenerationDelta ||
			!nullableStringsEqual(entry.SourceReceiptSchema, receiptSchema) {
			t.Fatalf("golden operation matrix drift at %s: %+v", operation, entry)
		}
	}
}
