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
)

type validatedBudgetSourceResult struct {
	record  Record
	receipt budgetcontract.Record
	request budgetcontract.Record
	durable validatedBudgetDurable
}

func validateBudgetPreparedWithSession(value any, session *bindingValidationSession) (budgetcontract.PreparedRequest, budgetcontract.Record, error) {
	if prepared, ok := value.(budgetcontract.PreparedRequest); ok && session != nil {
		if cached, found := session.budgetPrepared[prepared.RequestHash]; found && cached.prepared == prepared {
			return cached.prepared, cached.request, nil
		}
	}
	if preparedRecord, ok := value.(Record); ok {
		value = map[string]any(preparedRecord)
	}
	if session != nil && session.onValidate != nil {
		session.onValidate("budget_prepared_parse")
	}
	prepared, request, err := budgetcontract.ValidatePreparedRequestRecord(value)
	if err != nil {
		return budgetcontract.PreparedRequest{}, nil, err
	}
	if session != nil {
		session.budgetPrepared[prepared.RequestHash] = validatedBudgetPrepared{prepared: prepared, request: request}
	}
	return prepared, request, nil
}

func parseBudgetDurableReceiptWithSession(value any, session *bindingValidationSession) (validatedBudgetDurable, error) {
	text, ok := value.(string)
	if !ok || len([]byte(text)) == 0 || len([]byte(text)) > MaxStringBytes {
		return validatedBudgetDurable{}, failure(ErrorLimitExceeded, "$/budgetSourceResult/durableReceiptBytes", "Durable budget receipt bytes exceed their limit.")
	}
	if session != nil {
		if cached, found := session.budgetDurable[text]; found {
			return cached, nil
		}
		if session.onValidate != nil {
			session.onValidate("budget_durable_parse")
		}
	}
	input := []byte(text)
	parsed, err := parseStrictJSON(input, MaxStringBytes, MaxJSONDepth, MaxJSONNodes, MaxStringBytes, MaxSafeInteger)
	if err != nil {
		code := ErrorInvalid
		var strictErr *strictjson.Error
		if errors.As(err, &strictErr) && strictErr.Kind == strictjson.ErrorLimit {
			code = ErrorLimitExceeded
		}
		return validatedBudgetDurable{}, failure(code, "$/budgetSourceResult/durableReceiptBytes", "Durable budget receipt bytes are not strict JSON.")
	}
	durable, projection, err := validateBudgetDurableReceipt(parsed)
	if err != nil {
		return validatedBudgetDurable{}, err
	}
	canonical, err := budgetcontract.CanonicalJSON(durable)
	if err != nil || !bytes.Equal([]byte(canonical), input) {
		return validatedBudgetDurable{}, failure(ErrorInvalid, "$/budgetSourceResult/durableReceiptBytes", "Durable budget receipt bytes are not exact canonical bytes.")
	}
	digest := sha256.Sum256(input)
	result := validatedBudgetDurable{
		record: durable, projection: projection, bytes: append([]byte(nil), input...), hash: hex.EncodeToString(digest[:]),
	}
	if session != nil {
		session.budgetDurable[text] = result
	}
	return result, nil
}

// ParseBudgetDurableReceiptBytes validates the Go E2 durable envelope and
// proves that the supplied bytes are its one exact canonical representation.
func ParseBudgetDurableReceiptBytes(value any) (Record, error) {
	durable, err := parseBudgetDurableReceiptWithSession(value, newBindingValidationSession(nil))
	return durable.record, err
}

// HashBudgetSourceReceipt is the plain SHA-256 of the exact E2 DurableRecord
// bytes consumed by runner v2. It intentionally is not an E1 domain hash.
func HashBudgetSourceReceipt(value any) (string, error) {
	durable, err := parseBudgetDurableReceiptWithSession(value, newBindingValidationSession(nil))
	return durable.hash, err
}

// ValidateBudgetSourceResult proves that an accepted E2 receipt envelope,
// reserve decision, and ledger entry all bind the same frozen E1 prepared
// request. Database-unknown receipts cannot satisfy this validator.
func ValidateBudgetSourceResult(value, preparedValue any) (Record, error) {
	session := newBindingValidationSession(nil)
	prepared, request, err := validateBudgetPreparedWithSession(preparedValue, session)
	if err != nil {
		return nil, embeddedBudgetFailure(err, "$/budgetSourceResult/decision/request")
	}
	result, err := validateBudgetSourceResultForPrepared(value, prepared, request, session)
	if err != nil {
		return nil, err
	}
	return result.record, nil
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

func validateBudgetSourceResultForPrepared(
	value any,
	prepared budgetcontract.PreparedRequest,
	request budgetcontract.Record,
	session *bindingValidationSession,
) (validatedBudgetSourceResult, error) {
	record, err := closedRecord(value, []string{"schema", "durableReceiptBytes", "decision", "ledgerEntry"}, "$/budgetSourceResult")
	if err != nil {
		return validatedBudgetSourceResult{}, err
	}
	if prepared.Operation != "reserve" {
		return validatedBudgetSourceResult{}, failure(ErrorAuthorityPlaneMismatch, "$/budgetSourceResult", "A budget authorization requires an exact reserve result.")
	}
	decision, err := budgetcontract.ValidateReserveDecision(record["decision"])
	if err != nil {
		return validatedBudgetSourceResult{}, embeddedBudgetFailure(err, "$/budgetSourceResult/decision")
	}
	ledger, err := budgetcontract.ValidateLedgerEntry(record["ledgerEntry"])
	if err != nil {
		return validatedBudgetSourceResult{}, embeddedBudgetFailure(err, "$/budgetSourceResult/ledgerEntry")
	}
	durableBytes := record["durableReceiptBytes"]
	durable, err := parseBudgetDurableReceiptWithSession(durableBytes, session)
	if err != nil {
		return validatedBudgetSourceResult{}, err
	}
	decisionRequest, decisionRequestOK := asBudgetRecord(decision["request"])
	decisionCanonical, canonicalErr := budgetcontract.CanonicalJSON(decisionRequest)
	if !decisionRequestOK || canonicalErr != nil || decisionCanonical+"\n" != prepared.Body {
		return validatedBudgetSourceResult{}, failure(ErrorIdentityMismatch, "$/budgetSourceResult", "Budget source result does not prove the exact accepted prepared reserve.")
	}
	receipt := durable.projection
	if _, err := budgetcontract.ValidateReceiptForResult(receipt, prepared, decision, ledger, nil); err != nil {
		return validatedBudgetSourceResult{}, embeddedBudgetFailure(err, "$/budgetSourceResult/receipt")
	}
	route, routeOK := asBudgetRecord(decisionRequest["route"])
	requestRoute, requestRouteOK := asBudgetRecord(request["route"])
	acceptedRevision, accepted := receipt["acceptedRunRevision"].(int64)
	committedAt, committed := receipt["committedAt"].(string)
	if !routeOK || !requestRouteOK ||
		receipt["operation"] != "reserve" || receipt["status"] != "accepted" || !accepted || acceptedRevision < 1 ||
		!committed || committedAt == "" ||
		route["backend"] != "go" || route["authority"] != "workflow-control" ||
		requestRoute["backend"] != "go" || requestRoute["authority"] != "workflow-control" {
		return validatedBudgetSourceResult{}, failure(ErrorIdentityMismatch, "$/budgetSourceResult", "Budget source result does not prove the exact accepted prepared reserve.")
	}
	schema, err := literalString(record["schema"], BudgetSourceResultSchema, "$/budgetSourceResult/schema")
	if err != nil {
		return validatedBudgetSourceResult{}, err
	}
	return validatedBudgetSourceResult{
		record:  Record{"schema": schema, "durableReceiptBytes": durableBytes, "decision": decision, "ledgerEntry": ledger},
		receipt: receipt,
		request: request,
		durable: durable,
	}, nil
}

func asBudgetRecord(value any) (budgetcontract.Record, bool) {
	switch current := value.(type) {
	case budgetcontract.Record:
		return current, current != nil
	case Record:
		return budgetcontract.Record(current), current != nil
	case map[string]any:
		return budgetcontract.Record(current), current != nil
	default:
		return nil, false
	}
}
