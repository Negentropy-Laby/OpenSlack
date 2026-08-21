package runnerbindingcontract

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"errors"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/strictjson"
)

const (
	BudgetSourceResultSchema   = "openslack.workflow_runner_budget_source_result.v1"
	BudgetDurableReceiptSchema = "openslack.workflow_control_budget_durable_record.v1"
	budgetDurableWriter        = "workflow-control/budget-authority-server"
	budgetDurableMode          = "local-qualification-v1"
	budgetManifestSHA256       = "5ba1027cb0c33bb833cff6a5095934231f42700bc6613e8ec815195ca812e714"
	maxBudgetDurableBytes      = 524_288
)

// ParseBudgetDurableReceiptBytes validates the Go E2 durable envelope and
// proves that the supplied bytes are its one exact canonical representation.
func ParseBudgetDurableReceiptBytes(value any) (Record, error) {
	text, ok := value.(string)
	if !ok || len([]byte(text)) == 0 || len([]byte(text)) > maxBudgetDurableBytes {
		return nil, failure(ErrorLimitExceeded, "$/budgetSourceResult/durableReceiptBytes", "Durable budget receipt bytes exceed their limit.")
	}
	parsed, err := strictjson.Parse([]byte(text), strictjson.Limits{
		MaxBytes: maxBudgetDurableBytes, MaxDepth: MaxJSONDepth, MaxNodes: MaxJSONNodes,
		MaxStringBytes: MaxStringBytes, MaxSafeInteger: MaxSafeInteger,
		NumberPolicy: strictjson.NumberCanonicalSafeInteger,
	})
	if err != nil {
		code := ErrorInvalid
		var strictErr *strictjson.Error
		if errors.As(err, &strictErr) && strictErr.Kind == strictjson.ErrorLimit {
			code = ErrorLimitExceeded
		}
		return nil, failure(code, "$/budgetSourceResult/durableReceiptBytes", "Durable budget receipt bytes are not strict JSON.")
	}
	durable, _, err := validateBudgetDurableReceipt(parsed)
	if err != nil {
		return nil, err
	}
	canonical, err := budgetcontract.CanonicalJSON(durable)
	if err != nil || !bytes.Equal([]byte(canonical), []byte(text)) {
		return nil, failure(ErrorInvalid, "$/budgetSourceResult/durableReceiptBytes", "Durable budget receipt bytes are not exact canonical bytes.")
	}
	return durable, nil
}

// HashBudgetSourceReceipt is the plain SHA-256 of the exact E2 DurableRecord
// bytes consumed by runner v2. It intentionally is not an E1 domain hash.
func HashBudgetSourceReceipt(value any) (string, error) {
	if _, err := ParseBudgetDurableReceiptBytes(value); err != nil {
		return "", err
	}
	text := value.(string)
	digest := sha256.Sum256([]byte(text))
	return hex.EncodeToString(digest[:]), nil
}

// ValidateBudgetSourceResult proves that an accepted E2 receipt envelope,
// reserve decision, and ledger entry all bind the same frozen E1 prepared
// request. Database-unknown receipts cannot satisfy this validator.
func ValidateBudgetSourceResult(value, preparedValue any) (Record, error) {
	result, _, err := validateBudgetSourceResult(value, preparedValue)
	return result, err
}

func validateBudgetDurableReceipt(value any) (Record, budgetcontract.Record, error) {
	record, err := closedRecord(value, []string{
		"schema", "authority", "writer", "authorityMode", "productionAuthority",
		"contractManifestSha256", "authorityBuildHash", "recordKind",
		"operationalProjection", "operationalProjectionHash",
	}, "$/budgetSourceResult/durableReceipt")
	if err != nil {
		return nil, nil, err
	}
	projection, err := budgetcontract.ValidateReceipt(record["operationalProjection"])
	if err != nil {
		return nil, nil, embeddedBudgetFailure(err, "$/budgetSourceResult/durableReceipt/operationalProjection")
	}
	build, err := hashValue(record["authorityBuildHash"], "$/budgetSourceResult/durableReceipt/authorityBuildHash")
	if err != nil {
		return nil, nil, err
	}
	projectionHash, hashErr := budgetcontract.HashValue("receipt", projection)
	production, productionOK := record["productionAuthority"].(bool)
	serviceBuild, _ := projection["serviceBuildHash"].(string)
	if hashErr != nil || !productionOK || production || build != serviceBuild || record["operationalProjectionHash"] != projectionHash {
		return nil, nil, failure(ErrorIdentityMismatch, "$/budgetSourceResult/durableReceipt", "Durable budget receipt envelope does not bind its E1 projection.")
	}
	schema, err := literalString(record["schema"], BudgetDurableReceiptSchema, "$/budgetSourceResult/durableReceipt/schema")
	if err != nil {
		return nil, nil, err
	}
	authority, err := literalString(record["authority"], "workflow-control", "$/budgetSourceResult/durableReceipt/authority")
	if err != nil {
		return nil, nil, err
	}
	writer, err := literalString(record["writer"], budgetDurableWriter, "$/budgetSourceResult/durableReceipt/writer")
	if err != nil {
		return nil, nil, err
	}
	mode, err := literalString(record["authorityMode"], budgetDurableMode, "$/budgetSourceResult/durableReceipt/authorityMode")
	if err != nil {
		return nil, nil, err
	}
	manifest, err := literalString(record["contractManifestSha256"], budgetManifestSHA256, "$/budgetSourceResult/durableReceipt/contractManifestSha256")
	if err != nil {
		return nil, nil, err
	}
	kind, err := literalString(record["recordKind"], "receipt", "$/budgetSourceResult/durableReceipt/recordKind")
	if err != nil {
		return nil, nil, err
	}
	validatedProjectionHash, err := hashValue(record["operationalProjectionHash"], "$/budgetSourceResult/durableReceipt/operationalProjectionHash")
	if err != nil {
		return nil, nil, err
	}
	return Record{
		"schema": schema, "authority": authority, "writer": writer, "authorityMode": mode,
		"productionAuthority": false, "contractManifestSha256": manifest,
		"authorityBuildHash": build, "recordKind": kind,
		"operationalProjection": projection, "operationalProjectionHash": validatedProjectionHash,
	}, projection, nil
}

func validateBudgetSourceResult(value any, preparedValue any) (Record, budgetcontract.Record, error) {
	record, err := closedRecord(value, []string{"schema", "durableReceiptBytes", "decision", "ledgerEntry"}, "$/budgetSourceResult")
	if err != nil {
		return nil, nil, err
	}
	prepared, request, err := budgetcontract.ValidatePreparedRequestRecord(preparedValue)
	if err != nil {
		return nil, nil, embeddedBudgetFailure(err, "$/budgetSourceResult/decision/request")
	}
	if prepared.Operation != "reserve" {
		return nil, nil, failure(ErrorAuthorityPlaneMismatch, "$/budgetSourceResult", "A budget authorization requires an exact reserve result.")
	}
	decision, err := budgetcontract.ValidateReserveDecision(record["decision"])
	if err != nil {
		return nil, nil, embeddedBudgetFailure(err, "$/budgetSourceResult/decision")
	}
	ledger, err := budgetcontract.ValidateLedgerEntry(record["ledgerEntry"])
	if err != nil {
		return nil, nil, embeddedBudgetFailure(err, "$/budgetSourceResult/ledgerEntry")
	}
	durableBytes := record["durableReceiptBytes"]
	durable, err := ParseBudgetDurableReceiptBytes(durableBytes)
	if err != nil {
		return nil, nil, err
	}
	receipt := durable["operationalProjection"].(budgetcontract.Record)
	if _, err := budgetcontract.ValidateReceiptForResult(receipt, prepared, decision, ledger, nil); err != nil {
		return nil, nil, embeddedBudgetFailure(err, "$/budgetSourceResult/receipt")
	}
	decisionRequest := decision["request"].(budgetcontract.Record)
	decisionCanonical, _ := budgetcontract.CanonicalJSON(decisionRequest)
	route, _ := decisionRequest["route"].(budgetcontract.Record)
	acceptedRevision, accepted := receipt["acceptedRunRevision"].(int64)
	committedAt, committed := receipt["committedAt"].(string)
	if receipt["operation"] != "reserve" || receipt["status"] != "accepted" || !accepted || acceptedRevision < 1 ||
		!committed || committedAt == "" || decisionCanonical+"\n" != prepared.Body ||
		route == nil || route["backend"] != "go" || route["authority"] != "workflow-control" ||
		request["route"].(budgetcontract.Record)["backend"] != "go" || request["route"].(budgetcontract.Record)["authority"] != "workflow-control" {
		return nil, nil, failure(ErrorIdentityMismatch, "$/budgetSourceResult", "Budget source result does not prove the exact accepted prepared reserve.")
	}
	schema, err := literalString(record["schema"], BudgetSourceResultSchema, "$/budgetSourceResult/schema")
	if err != nil {
		return nil, nil, err
	}
	return Record{"schema": schema, "durableReceiptBytes": durableBytes, "decision": decision, "ledgerEntry": ledger}, receipt, nil
}
