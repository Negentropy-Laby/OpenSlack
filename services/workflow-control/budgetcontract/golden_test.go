package budgetcontract

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

type exactVector struct {
	Value          any    `json:"value"`
	CanonicalBytes string `json:"canonicalBytes"`
	ByteLength     int    `json:"byteLength"`
	SHA256         string `json:"sha256"`
}

type negativeVector struct {
	ID                  string `json:"id"`
	Operation           string `json:"operation"`
	Input               any    `json:"input"`
	SchemaArtifact      string `json:"schemaArtifact"`
	ExpectedSchemaValid bool   `json:"expectedSchemaValid"`
	Expected            struct {
		Code ErrorCode `json:"code"`
		Path string    `json:"path"`
	} `json:"expectedError"`
}

type goldenVectors struct {
	Schema          string `json:"schema"`
	ContractVersion string `json:"contractVersion"`
	Authority       string `json:"authority"`
	Vectors         struct {
		Arithmetic struct {
			Decimal       []struct{ Input, Expected string } `json:"decimal"`
			USDToNanoUSD  []struct{ Input, Expected string } `json:"usdToNanoUsd"`
			ChargeNanoUSD []struct {
				Tokens              string `json:"tokens"`
				RateNanoUSDPerToken string `json:"rateNanoUsdPerToken"`
				Expected            string `json:"expected"`
			} `json:"chargeNanoUsd"`
		} `json:"arithmetic"`
		Records  map[string]exactVector    `json:"records"`
		Folds    map[string]map[string]any `json:"folds"`
		Negative []negativeVector          `json:"negative"`
	} `json:"vectors"`
}

type bundleManifest struct {
	Schema            string `json:"schema"`
	ContractVersion   string `json:"contractVersion"`
	AuthorityBoundary struct {
		Writer                      string `json:"writer"`
		TypeScriptRemainsSoleWriter bool   `json:"typescriptRemainsSoleWriter"`
		GoRole                      string `json:"goRole"`
		GoAuthorityClaim            string `json:"goAuthorityClaim"`
		GoAuthorityEligible         bool   `json:"goAuthorityEligible"`
		PostgresImplemented         bool   `json:"postgresImplemented"`
		HTTPImplemented             bool   `json:"httpImplemented"`
		RuntimeRoutingActivated     bool   `json:"runtimeRoutingActivated"`
	} `json:"authorityBoundary"`
	Dimensions []string `json:"dimensions"`
	Receipts   struct {
		Operations        []string `json:"operations"`
		Statuses          []string `json:"statuses"`
		IdempotencyPrefix string   `json:"idempotencyPrefix"`
	} `json:"receipts"`
	SourceLocks struct {
		AuthorityV2Manifest string `json:"authorityV2ManifestSha256"`
		AuthorityV2Golden   string `json:"authorityV2GoldenSha256"`
		RunnerV1Manifest    string `json:"runnerV1ManifestSha256"`
		RunnerV1Golden      string `json:"runnerV1GoldenSha256"`
	} `json:"sourceLocks"`
	Artifacts map[string]struct {
		Path       string `json:"path"`
		ByteLength int    `json:"byteLength"`
		SHA256     string `json:"sha256"`
	} `json:"artifacts"`
	BundleFiles []string `json:"bundleFiles"`
}

func TestWorkflowBudgetAuthorityGoldenVectors(t *testing.T) {
	golden := loadGolden(t)
	if golden.Schema != "openslack.workflow_budget_authority_golden_vectors.v1" || golden.ContractVersion != ContractVersion || golden.Authority != Authority {
		t.Fatalf("golden identity drifted: %#v", golden)
	}
	for name, vector := range golden.Vectors.Records {
		validated, err := ValidateRecord(vector.Value)
		if err != nil {
			t.Fatalf("record %s: %v", name, err)
		}
		canonical, err := CanonicalJSON(validated)
		if err != nil {
			t.Fatalf("canonical record %s: %v", name, err)
		}
		if canonical != vector.CanonicalBytes || len([]byte(canonical)) != vector.ByteLength || sha256String([]byte(canonical)) != vector.SHA256 {
			t.Fatalf("record %s exact-byte evidence drifted", name)
		}
		decoded, err := DecodeRecordJSON([]byte(vector.CanonicalBytes))
		if err != nil || !exactEqual(decoded, validated) {
			t.Fatalf("record %s exact replay failed: %v", name, err)
		}
	}
	for _, vector := range golden.Vectors.Negative {
		vector := vector
		t.Run("negative/"+vector.ID, func(t *testing.T) {
			if vector.Operation == "" || vector.Input == nil {
				t.Fatal("negative vector is not independently replayable")
			}
			if vector.SchemaArtifact == "" {
				t.Fatal("negative vector does not bind a schema artifact")
			}
			if _, err := BundleFile(vector.SchemaArtifact); err != nil {
				t.Fatalf("negative schema artifact is outside the bundle: %v", err)
			}
			err := replayNegative(vector.Operation, vector.Input)
			var contractError *ContractError
			if !errors.As(err, &contractError) {
				t.Fatalf("expected ContractError, got %T %v", err, err)
			}
			if contractError.Code != vector.Expected.Code || contractError.Path != vector.Expected.Path {
				t.Fatalf("negative parity mismatch: got=%#v want=%#v", contractError, vector.Expected)
			}
		})
	}
	if len(golden.Vectors.Negative) != 28 {
		t.Fatalf("negative inventory drifted: got %d want 28", len(golden.Vectors.Negative))
	}
	for _, vector := range golden.Vectors.Arithmetic.Decimal {
		actual, err := ValidateDecimal(vector.Input, "$")
		if err != nil || actual != vector.Expected {
			t.Fatalf("decimal %q: actual=%q err=%v", vector.Input, actual, err)
		}
	}
	for _, vector := range golden.Vectors.Arithmetic.USDToNanoUSD {
		actual, err := USDToNanoUSD(vector.Input)
		if err != nil || actual != vector.Expected {
			t.Fatalf("USD fold %q: actual=%q err=%v", vector.Input, actual, err)
		}
	}
	for _, vector := range golden.Vectors.Arithmetic.ChargeNanoUSD {
		actual, err := ChargeNanoUSD(vector.Tokens, vector.RateNanoUSDPerToken)
		if err != nil || actual != vector.Expected {
			t.Fatalf("charge fold: actual=%q err=%v", actual, err)
		}
	}
	if _, err := ValidateReservationForDecision(
		golden.Vectors.Records["reservation"].Value,
		golden.Vectors.Records["reserveReserved"].Value,
	); err != nil {
		t.Fatalf("reservation does not bind its reserve decision: %v", err)
	}
	failedSettlement, err := ValidateSettlement(golden.Vectors.Records["failedProviderSettledBeforeRethrow"].Value)
	if err != nil || failedSettlement["status"] != "settled" || failedSettlement["cachePublishAuthorized"] != false {
		t.Fatalf("failed provider usage settlement semantics drifted: %v", err)
	}
	for name, status := range map[string]string{
		"reserveReceipt":                "accepted",
		"providerUnknownReceipt":        "provider_reconciliation_required",
		"databaseReconciliationReceipt": "database_reconciliation_required",
	} {
		receipt, receiptErr := ValidateReceipt(golden.Vectors.Records[name].Value)
		if receiptErr != nil || receipt["status"] != status {
			t.Fatalf("receipt variant %s drifted: %v", name, receiptErr)
		}
	}
	assertBundleAndSourceLocks(t)
}

func TestWorkflowBudgetAuthorityRejectsFramingAndAuthorityDrift(t *testing.T) {
	golden := loadGolden(t)
	account := golden.Vectors.Records["account"]
	if _, err := DecodeRecordJSON([]byte(account.CanonicalBytes + "\n")); !hasCode(err, ErrorHashMismatch) {
		t.Fatalf("noncanonical framing passed: %v", err)
	}
	duplicate := []byte(`{"accountId":"duplicate",` + account.CanonicalBytes[1:])
	if _, err := DecodeRecordJSON(duplicate); !hasCode(err, ErrorInvalid) {
		t.Fatalf("duplicate key passed: %v", err)
	}
	if _, err := BundleFile("../manifest.json"); err == nil {
		t.Fatal("bundle inventory traversal passed")
	}
	if HasDurableAuthority() {
		t.Fatal("E1 Go mirror claimed durable authority")
	}

	drifted := cloneValue(t, account.Value).(map[string]any)
	drifted["authority"] = "workflow-control"
	if _, err := ValidateAccount(drifted); !hasCode(err, ErrorInvalid) {
		t.Fatalf("authority drift passed: %v", err)
	}
	routeDrift := cloneValue(t, account.Value).(map[string]any)
	routeDrift["route"].(map[string]any)["authority"] = "workflow-control"
	if _, err := ValidateAccount(routeDrift); !hasCode(err, ErrorRouteDrift) {
		t.Fatalf("route pair drift passed: %v", err)
	}
	if _, err := ChargeNanoUSD("1", "10.0"); !hasCode(err, ErrorInvalidDecimal) {
		t.Fatalf("noncanonical trailing-zero rate passed: %v", err)
	}

	prepared := golden.Vectors.Records["preparedReserve"].Value
	receipt := golden.Vectors.Records["reserveReceipt"].Value
	if _, err := ValidateReceiptForRequest(receipt, prepared); err != nil {
		t.Fatalf("bound receipt rejected: %v", err)
	}
	var typedNilReconciliation Record
	if _, err := ValidateReceiptForResult(
		receipt,
		prepared,
		golden.Vectors.Records["reserveReserved"].Value,
		golden.Vectors.Records["reserveLedger"].Value,
		typedNilReconciliation,
	); err != nil {
		t.Fatalf("typed nil reconciliation rejected an accepted result: %v", err)
	}
	driftedReceipt := cloneValue(t, receipt).(map[string]any)
	driftedReceipt["serviceBuildHash"] = "6" + driftedReceipt["serviceBuildHash"].(string)[1:]
	if _, err := ValidateReceiptForRequest(driftedReceipt, prepared); !hasCode(err, ErrorIdentityMismatch) {
		t.Fatalf("service build drift passed: %v", err)
	}
	settlementRequest := cloneValue(t, golden.Vectors.Records["preparedSettlement"].Value).(map[string]any)
	preparedBody := settlementRequest["body"].(string)
	var body map[string]any
	decoder := json.NewDecoder(bytes.NewBufferString(preparedBody))
	decoder.UseNumber()
	if err := decoder.Decode(&body); err != nil {
		t.Fatal(err)
	}
	body["expectedModelHash"] = "sha256:" + "0" + body["expectedModelHash"].(string)[8:]
	if _, err := ValidateSettlementRequest(body); !hasCode(err, ErrorInvalid) {
		t.Fatalf("provider/model binding drift passed: %v", err)
	}
	ambiguousReceipt := cloneValue(t, golden.Vectors.Records["providerUnknownReceipt"].Value).(map[string]any)
	ambiguousReceipt["status"] = "reconciliation_required"
	if _, err := ValidateReceipt(ambiguousReceipt); !hasCode(err, ErrorInvalid) {
		t.Fatalf("ambiguous receipt status passed: %v", err)
	}
	databaseReceipt := golden.Vectors.Records["databaseReconciliationReceipt"].Value
	if _, err := ValidateReceiptForResult(
		databaseReceipt,
		golden.Vectors.Records["preparedSettlement"].Value,
		golden.Vectors.Records["settlementSettled"].Value,
		golden.Vectors.Records["settlementLedger"].Value,
		nil,
	); !hasCode(err, ErrorIdentityMismatch) {
		t.Fatalf("database-unknown receipt claimed a durable result: %v", err)
	}
}

func TestWorkflowBudgetAuthorityFolds(t *testing.T) {
	folds := loadGolden(t).Vectors.Folds
	if len(folds) != 8 {
		t.Fatalf("fold inventory drifted: got %d want 8", len(folds))
	}
	for _, name := range []string{"reserve", "reject"} {
		fold := folds[name]
		decision := fold["decision"].(map[string]any)
		actual, err := EvaluateReserve(fold["before"], fold["request"], decision["decidedAt"])
		if err != nil {
			t.Fatalf("reserve fold %s drifted: %v", name, err)
		}
		assertFoldValue(t, name+" decision", actual.Decision, fold["decision"])
		assertFoldValue(t, name+" reservation", actual.Reservation, fold["reservation"])
		assertFoldValue(t, name+" ledger", actual.LedgerEntry, fold["ledgerEntry"])
		assertFoldValue(t, name+" reconciliation", nil, fold["reconciliation"])
		assertFoldValue(t, name+" after", actual.Decision["afterAccount"], fold["after"])
		assertFoldReceipt(t, "reserve", fold, actual.Decision, actual.LedgerEntry, nil)
	}
	for _, name := range []string{"settle", "failedProviderAttempt", "providerOutcomeUnknown", "usageMissing", "usageUntrusted", "usageOverrun"} {
		fold := folds[name]
		settlement := fold["settlement"].(map[string]any)
		actual, err := EvaluateSettlement(fold["before"], fold["reservation"], fold["request"], settlement["committedAt"])
		if err != nil {
			t.Fatalf("settlement fold %s drifted: %v", name, err)
		}
		assertFoldValue(t, name+" settlement", actual.Settlement, fold["settlement"])
		assertFoldValue(t, name+" ledger", actual.LedgerEntry, fold["ledgerEntry"])
		assertFoldValue(t, name+" reconciliation", actual.Reconciliation, fold["reconciliation"])
		assertFoldValue(t, name+" after", actual.Settlement["afterAccount"], fold["after"])
		var reconciliation any
		if actual.Reconciliation != nil {
			reconciliation = actual.Reconciliation
		}
		assertFoldReceipt(t, "settle", fold, actual.Settlement, actual.LedgerEntry, reconciliation)
	}
	if folds["settle"]["settlement"].(map[string]any)["cachePublishAuthorized"] != true {
		t.Fatal("accepted provider outcome did not authorize cache publication")
	}
	if folds["failedProviderAttempt"]["settlement"].(map[string]any)["cachePublishAuthorized"] != false {
		t.Fatal("failed provider outcome authorized cache publication")
	}
}

func assertFoldValue(t *testing.T, label string, actual, expected any) {
	t.Helper()
	if expected == nil {
		value := reflect.ValueOf(actual)
		if !value.IsValid() || (value.Kind() == reflect.Map && value.IsNil()) {
			return
		}
	}
	if !exactEqual(actual, expected) {
		actualJSON, _ := CanonicalJSON(actual)
		expectedJSON, _ := CanonicalJSON(expected)
		t.Fatalf("%s drifted:\nactual: %s\nexpected: %s", label, actualJSON, expectedJSON)
	}
}

func assertFoldReceipt(t *testing.T, operation string, fold map[string]any, record, ledger, reconciliation any) {
	t.Helper()
	prepared, err := PrepareRequest(operation, fold["request"], "qualification-caller")
	if err != nil {
		t.Fatalf("prepare %s fold: %v", operation, err)
	}
	receipt, err := ValidateReceiptForResult(fold["receipt"], prepared, record, ledger, reconciliation)
	if err != nil {
		t.Fatalf("validate %s fold receipt: %v", operation, err)
	}
	if !exactEqual(receipt, fold["receipt"]) || !exactEqual(fold["exactReplay"], fold["receipt"]) {
		t.Fatalf("%s fold receipt or exact replay drifted", operation)
	}
}

func TestPrepareRequestBytesReturnsTheValidatedCanonicalRecord(t *testing.T) {
	request := loadGolden(t).Vectors.Folds["reserve"]["request"]
	prepared, err := PrepareRequest("reserve", request, "qualification-caller")
	if err != nil {
		t.Fatal(err)
	}
	fromBytes, record, err := PrepareRequestBytes("reserve", []byte(prepared.Body), "qualification-caller")
	if err != nil || fromBytes != prepared || !exactEqual(record, request) {
		t.Fatalf("prepared bytes=%#v record=%#v err=%v", fromBytes, record, err)
	}
	if _, _, err := PrepareRequestBytes("reserve", []byte(prepared.Body+"{}\n"), "qualification-caller"); err == nil {
		t.Fatal("prepared request accepted a second JSON value")
	}
}

func replayNegative(operation string, input any) error {
	switch operation {
	case "validate_account", "validateWorkflowBudgetAccount":
		_, err := ValidateAccount(input)
		return err
	case "validate_reserve_request", "validateWorkflowBudgetReserveRequest":
		_, err := ValidateReserveRequest(input)
		return err
	case "validate_provider_usage", "validateWorkflowBudgetProviderUsage":
		_, err := ValidateProviderUsage(input)
		return err
	case "validate_settlement_request", "validateWorkflowBudgetSettlementRequest":
		_, err := ValidateSettlementRequest(input)
		return err
	case "validate_settlement", "validateWorkflowBudgetSettlement":
		_, err := ValidateSettlement(input)
		return err
	case "validate_reserve_decision", "validateWorkflowBudgetReserveDecision":
		_, err := ValidateReserveDecision(input)
		return err
	case "validate_legacy_approval", "validateWorkflowBudgetLegacyApprovalObservation":
		_, err := ValidateLegacyApproval(input)
		return err
	case "validate_reconciliation", "validateWorkflowBudgetReconciliation":
		_, err := ValidateReconciliation(input)
		return err
	case "validate_receipt", "validateWorkflowBudgetReceipt":
		_, err := ValidateReceipt(input)
		return err
	case "validate_prepared_request", "validateWorkflowBudgetPreparedRequest":
		_, err := ValidatePreparedRequest(input)
		return err
	case "validate_reservation_for_decision", "validateWorkflowBudgetReservationForDecision":
		record, err := asRecord(input, "$")
		if err != nil {
			return err
		}
		_, err = ValidateReservationForDecision(record["reservation"], record["decision"])
		return err
	case "validate_receipt_for_prepared_request", "validateWorkflowBudgetReceiptForRequest":
		record, err := asRecord(input, "$")
		if err != nil {
			return err
		}
		_, err = ValidateReceiptForRequest(record["receipt"], record["preparedRequest"])
		return err
	case "evaluate_reserve", "evaluateWorkflowBudgetReserve":
		record, err := asRecord(input, "$")
		if err != nil {
			return err
		}
		_, err = EvaluateReserve(record["account"], record["request"], record["committedAt"])
		return err
	case "evaluate_settlement", "evaluateWorkflowBudgetSettlement":
		record, err := asRecord(input, "$")
		if err != nil {
			return err
		}
		_, err = EvaluateSettlement(record["account"], record["reservation"], record["request"], record["committedAt"])
		return err
	default:
		return failure(ErrorInvalid, "$/operation", "unsupported golden operation")
	}
}

func assertBundleAndSourceLocks(t *testing.T) {
	t.Helper()
	manifestBytes, err := BundleFile("manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest bundleManifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		t.Fatal(err)
	}
	b := manifest.AuthorityBoundary
	if manifest.Schema != "openslack.workflow_budget_authority_contract_manifest.v1" || manifest.ContractVersion != ContractVersion || b.Writer != Writer || !b.TypeScriptRemainsSoleWriter || b.GoRole != GoRole || b.GoAuthorityClaim != GoAuthorityClaim || b.GoAuthorityEligible || b.PostgresImplemented || b.HTTPImplemented || b.RuntimeRoutingActivated || HasDurableAuthority() {
		t.Fatalf("authority ceiling widened: %#v", b)
	}
	if !reflect.DeepEqual(manifest.Dimensions, Dimensions()) || !reflect.DeepEqual(manifest.Receipts.Operations, []string{"reserve", "settle"}) || !reflect.DeepEqual(manifest.Receipts.Statuses, []string{"accepted", "provider_reconciliation_required", "database_reconciliation_required"}) || manifest.Receipts.IdempotencyPrefix != IdempotencyPrefix || !reflect.DeepEqual(manifest.BundleFiles, BundleFiles()) {
		t.Fatal("manifest closed inventories drifted")
	}
	root := repositoryRoot(t)
	sourceRoot := filepath.Join(root, "packages", "workflows", "contracts", "workflow-budget-authority", "v1")
	for _, name := range BundleFiles() {
		embedded, err := BundleFile(name)
		if err != nil {
			t.Fatal(err)
		}
		source, err := os.ReadFile(filepath.Join(sourceRoot, filepath.FromSlash(name)))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(embedded, source) {
			t.Fatalf("embedded mirror differs for %s", name)
		}
		if artifact, ok := manifest.Artifacts[name]; ok && (artifact.Path != name || artifact.ByteLength != len(embedded) || artifact.SHA256 != sha256String(embedded)) {
			t.Fatalf("artifact evidence drifted for %s", name)
		}
	}
	locks := map[string][2]string{
		"authority manifest": {"packages/workflows/contracts/workflow-control-authority/v2/manifest.json", manifest.SourceLocks.AuthorityV2Manifest},
		"authority golden":   {"packages/workflows/contracts/workflow-control-authority/v2/golden-vectors.json", manifest.SourceLocks.AuthorityV2Golden},
		"runner manifest":    {"packages/workflows/contracts/workflow-runner/v1/manifest.json", manifest.SourceLocks.RunnerV1Manifest},
		"runner golden":      {"packages/workflows/contracts/workflow-runner/v1/golden-vectors.json", manifest.SourceLocks.RunnerV1Golden},
	}
	for name, lock := range locks {
		contents, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(lock[0])))
		if err != nil {
			t.Fatal(err)
		}
		if sha256String(contents) != lock[1] {
			t.Fatalf("source lock drifted: %s", name)
		}
	}
}

func loadGolden(t *testing.T) goldenVectors {
	t.Helper()
	contents, err := BundleFile("golden-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(bytes.NewReader(contents))
	decoder.UseNumber()
	var value goldenVectors
	if err := decoder.Decode(&value); err != nil {
		t.Fatal(err)
	}
	return value
}

func cloneValue(t *testing.T, value any) any {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.UseNumber()
	var result any
	if err := decoder.Decode(&result); err != nil {
		t.Fatal(err)
	}
	return result
}

func hasCode(err error, code ErrorCode) bool {
	var contractError *ContractError
	return errors.As(err, &contractError) && contractError.Code == code
}
func sha256String(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}
func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve source path")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
}
