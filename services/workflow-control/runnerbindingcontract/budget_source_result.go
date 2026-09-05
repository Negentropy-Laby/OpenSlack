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

// BudgetDurableReceiptProof exposes only the immutable scalar bindings needed
// by the runner store. It does not turn the Go validator into a budget writer.
type BudgetDurableReceiptProof struct {
	ReceiptHash         string
	Operation           string
	Status              string
	ReservationID       string
	AcceptedRunRevision int64
	AuthorityBuildHash  string
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

// ProveBudgetDurableReceiptBytes validates exact canonical durable bytes once
// and returns the closed scalar projection used by live runner persistence and
// replay validation.
func ProveBudgetDurableReceiptBytes(value any) (BudgetDurableReceiptProof, error) {
	durable, err := parseBudgetDurableReceiptWithSession(value, newBindingValidationSession(nil))
	if err != nil {
		return BudgetDurableReceiptProof{}, err
	}
	operation, operationOK := durable.projection["operation"].(string)
	status, statusOK := durable.projection["status"].(string)
	reservationID, reservationOK := durable.projection["reservationId"].(string)
	acceptedRunRevision, revisionOK := durable.projection["acceptedRunRevision"].(int64)
	authorityBuildHash, buildOK := durable.record["authorityBuildHash"].(string)
	if !operationOK || !statusOK || !reservationOK || !revisionOK || !buildOK {
		return BudgetDurableReceiptProof{}, failure(
			ErrorInvalid,
			"$/budgetSourceResult/durableReceipt/operationalProjection",
			"Validated durable budget receipt lost its closed scalar projection.",
		)
	}
	return BudgetDurableReceiptProof{
		ReceiptHash: durable.hash, Operation: operation, Status: status,
		ReservationID: reservationID, AcceptedRunRevision: acceptedRunRevision,
		AuthorityBuildHash: authorityBuildHash,
	}, nil
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

// ParseBudgetSourceResultBytes proves both the strict canonical outer bytes and
// their contextual binding to the exact E1 prepared request. The terminating
// LF is part of the durable runner-side artifact.
func ParseBudgetSourceResultBytes(input []byte, preparedValue any) (Record, error) {
	if len(input) == 0 || len(input) > MaxFrameBytes || !hasExactlyOneLF(input) {
		return nil, failure(ErrorLimitExceeded, "$", "Budget source result frame size or LF framing is invalid.")
	}
	parsed, err := parseStrictJSON(input[:len(input)-1], MaxFrameBytes, MaxJSONDepth, MaxJSONNodes, MaxStringBytes, MaxSafeInteger)
	if err != nil {
		return nil, failure(ErrorInvalid, "$", "Budget source result bytes are not strict JSON.")
	}
	validated, err := ValidateBudgetSourceResult(parsed, preparedValue)
	if err != nil {
		return nil, err
	}
	canonical, err := budgetcontract.CanonicalJSON(validated)
	if err != nil || !bytes.Equal(append([]byte(canonical), '\n'), input) {
		return nil, failure(ErrorInvalid, "$", "Budget source result bytes are not exact canonical bytes.")
	}
	return validated, nil
}

// ParseBudgetSettlementSourceReceiptBytes validates the exact immutable E2
// durable receipt retained for a budget-settle binding. Settlement has no
// control decision and therefore deliberately does not reuse the reserve-only
// workflow_runner_budget_source_result.v1 outer record.
func ParseBudgetSettlementSourceReceiptBytes(input []byte, preparedValue any) (Record, error) {
	prepared, _, err := validateBudgetPreparedWithSession(preparedValue, newBindingValidationSession(nil))
	if err != nil {
		return nil, embeddedBudgetFailure(err, "$/budgetSettlementSource/preparedRequest")
	}
	if prepared.Operation != "settle" {
		return nil, failure(ErrorAuthorityPlaneMismatch, "$/budgetSettlementSource", "A budget settlement requires an exact settle receipt.")
	}
	durable, err := parseBudgetDurableReceiptWithSession(string(input), newBindingValidationSession(nil))
	if err != nil {
		return nil, err
	}
	receipt, err := budgetcontract.ValidateReceiptForRequest(durable.projection, prepared)
	if err != nil {
		return nil, embeddedBudgetFailure(err, "$/budgetSettlementSource/receipt")
	}
	if receipt["operation"] != "settle" || receipt["status"] != "accepted" || receipt["reconciliationToken"] != nil {
		return nil, failure(ErrorIdentityMismatch, "$/budgetSettlementSource/receipt", "Budget settlement source receipt is not an exact accepted result.")
	}
	return durable.record, nil
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
	manifest, err := enumString(record["contractManifestSha256"], []string{budgetManifestSHA256, budgetcontract.PreviousManifestSHA256}, "$/budgetSourceResult/durableReceipt/contractManifestSha256")
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
	durableBytes := record["durableReceiptBytes"]
	durable, err := parseBudgetDurableReceiptWithSession(durableBytes, session)
	if err != nil {
		return validatedBudgetSourceResult{}, err
	}
	result, err := budgetcontract.ValidateReceiptResult(
		durable.projection,
		prepared,
		record["decision"],
		record["ledgerEntry"],
		nil,
	)
	if err != nil {
		return validatedBudgetSourceResult{}, embeddedBudgetFailure(err, "$/budgetSourceResult/receipt")
	}
	receipt, decision, ledger := result.Receipt, result.Record, result.Ledger
	decisionRequest, decisionRequestOK := asBudgetRecord(decision["request"])
	route, routeOK := asBudgetRecord(decisionRequest["route"])
	acceptedRevision, accepted := receipt["acceptedRunRevision"].(int64)
	committedAt, committed := receipt["committedAt"].(string)
	if !decisionRequestOK || !routeOK ||
		receipt["operation"] != "reserve" || receipt["status"] != "accepted" || !accepted || acceptedRevision < 1 ||
		!committed || committedAt == "" ||
		route["backend"] != "go" || route["authority"] != "workflow-control" {
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
