package budgetcontract

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"math/big"
	"regexp"
	"strconv"
	"time"
)

var (
	identifierPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$`)
	timestampPattern  = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)
	decimalPattern    = regexp.MustCompile(`^(?:0|[1-9][0-9]*)$`)
	ratePattern       = regexp.MustCompile(`^(?:0|[1-9][0-9]*)(?:\.([0-9]+))?$`)
	maxInt64Value, _  = new(big.Int).SetString(MaxInt64Decimal, 10)
)

var baseFields = []string{"contractVersion", "authority", "writer", "goRole", "goAuthorityClaim", "goAuthorityEligible"}

func asRecord(value any, path string) (Record, error) {
	switch value := value.(type) {
	case Record:
		return value, nil
	case map[string]any:
		return Record(value), nil
	default:
		return nil, failure(ErrorInvalid, path, path+" must be a data object.")
	}
}

func closed(value any, fields []string, path string) (Record, error) {
	record, err := asRecord(value, path)
	if err != nil {
		return nil, err
	}
	allowed := make(map[string]struct{}, len(fields))
	for _, field := range fields {
		allowed[field] = struct{}{}
	}
	for key := range record {
		if _, ok := allowed[key]; !ok {
			return nil, failure(ErrorUnknownField, path+"/"+key, "Unknown field.")
		}
	}
	for _, field := range fields {
		if _, ok := record[field]; !ok {
			return nil, failure(ErrorInvalid, path+"/"+field, "Missing field "+field+".")
		}
	}
	return record, nil
}

func withBase(fields ...string) []string {
	result := make([]string, 0, len(baseFields)+len(fields))
	result = append(result, fields[0])
	result = append(result, baseFields...)
	result = append(result, fields[1:]...)
	return result
}

func stringValue(value any, path string) (string, error) {
	result, ok := value.(string)
	if !ok {
		return "", failure(ErrorInvalid, path, path+" is invalid.")
	}
	return result, nil
}

func literalString(value any, expected, path string) (string, error) {
	result, err := stringValue(value, path)
	if err != nil || result != expected {
		return "", failure(ErrorInvalid, path, path+" is invalid.")
	}
	return result, nil
}

func enumString(value any, values []string, path string) (string, error) {
	result, err := stringValue(value, path)
	if err == nil {
		for _, candidate := range values {
			if result == candidate {
				return result, nil
			}
		}
	}
	return "", failure(ErrorInvalid, path, path+" is outside the closed vocabulary.")
}

func identifier(value any, path string) (string, error) {
	result, err := stringValue(value, path)
	if err != nil || len([]byte(result)) > MaxIdentifierBytes || !identifierPattern.MatchString(result) {
		return "", failure(ErrorInvalid, path, path+" is invalid.")
	}
	return result, nil
}

func hash(value any, path string) (string, error) {
	result, err := stringValue(value, path)
	if err != nil || len(result) != 64 || !isLowerHex(result) {
		return "", failure(ErrorInvalid, path, path+" is invalid.")
	}
	return result, nil
}

func prefixedHash(value any, path string) (string, error) {
	result, err := stringValue(value, path)
	if err != nil || !prefixedSHA(result) {
		return "", failure(ErrorInvalid, path, path+" is invalid.")
	}
	return result, nil
}

func canonicalTimestamp(value any, path string) (string, error) {
	result, err := stringValue(value, path)
	if err != nil || len(result) != 24 || !timestampPattern.MatchString(result) {
		return "", failure(ErrorInvalid, path, path+" is invalid.")
	}
	parsed, parseErr := time.Parse("2006-01-02T15:04:05.000Z", result)
	if parseErr != nil || parsed.UTC().Format("2006-01-02T15:04:05.000Z") != result {
		return "", failure(ErrorInvalid, path, "Timestamp is not canonical.")
	}
	return result, nil
}

func safeInteger(value any, path string, minimum int64) (int64, error) {
	var result int64
	switch value := value.(type) {
	case json.Number:
		parsed, err := strconv.ParseInt(value.String(), 10, 64)
		if err != nil || value.String() != strconv.FormatInt(parsed, 10) {
			return 0, failure(ErrorInvalid, path, path+" must be a safe integer.")
		}
		result = parsed
	case float64:
		result = int64(value)
		if float64(result) != value {
			return 0, failure(ErrorInvalid, path, path+" must be a safe integer.")
		}
	case int:
		result = int64(value)
	case int64:
		result = value
	default:
		return 0, failure(ErrorInvalid, path, path+" must be a safe integer.")
	}
	if result < minimum || result > MaxSafeInteger {
		return 0, failure(ErrorInvalid, path, path+" must be a safe integer.")
	}
	return result, nil
}

func boolLiteral(value any, expected bool, path string) (bool, error) {
	result, ok := value.(bool)
	if !ok || result != expected {
		return false, failure(ErrorInvalid, path, path+" is invalid.")
	}
	return result, nil
}

func authorityBase(record Record) (Record, error) {
	contractVersion, err := literalString(record["contractVersion"], ContractVersion, "$/contractVersion")
	if err != nil {
		return nil, err
	}
	authority, err := literalString(record["authority"], Authority, "$/authority")
	if err != nil {
		return nil, err
	}
	writer, err := literalString(record["writer"], Writer, "$/writer")
	if err != nil {
		return nil, err
	}
	goRole, err := literalString(record["goRole"], GoRole, "$/goRole")
	if err != nil {
		return nil, err
	}
	claim, err := literalString(record["goAuthorityClaim"], GoAuthorityClaim, "$/goAuthorityClaim")
	if err != nil {
		return nil, err
	}
	eligible, err := boolLiteral(record["goAuthorityEligible"], false, "$/goAuthorityEligible")
	if err != nil {
		return nil, err
	}
	return Record{"contractVersion": contractVersion, "authority": authority, "writer": writer, "goRole": goRole, "goAuthorityClaim": claim, "goAuthorityEligible": eligible}, nil
}

func ValidateDecimal(value any, path string) (string, error) {
	result, ok := value.(string)
	if !ok || len([]byte(result)) > MaxDecimalBytes || !decimalPattern.MatchString(result) {
		return "", failure(ErrorInvalidDecimal, path, path+" must be a canonical non-negative decimal integer.")
	}
	parsed, _ := new(big.Int).SetString(result, 10)
	if parsed.Cmp(maxInt64Value) > 0 {
		return "", failure(ErrorDecimalOverflow, path, path+" exceeds int64.")
	}
	return result, nil
}

func quantities(value any, path string) (Record, error) {
	record, err := closed(value, []string{"tokens", "nanoUsd", "calls"}, path)
	if err != nil {
		return nil, err
	}
	result := Record{}
	for _, key := range []string{"tokens", "nanoUsd", "calls"} {
		result[key], err = ValidateDecimal(record[key], path+"/"+key)
		if err != nil {
			return nil, err
		}
	}
	return result, nil
}

func route(value any, path string) (Record, error) {
	record, err := closed(value, []string{"backend", "authority", "routingEpoch", "authorityBuildHash"}, path)
	if err != nil {
		return nil, err
	}
	backend, err := enumString(record["backend"], []string{"ts-local", "go"}, path+"/backend")
	if err != nil {
		return nil, err
	}
	authority, err := enumString(record["authority"], []string{"typescript", "workflow-control"}, path+"/authority")
	if err != nil {
		return nil, err
	}
	if (backend == "ts-local") != (authority == "typescript") {
		return nil, failure(ErrorRouteDrift, path, "Backend and authority are inconsistent.")
	}
	epoch, err := safeInteger(record["routingEpoch"], path+"/routingEpoch", 1)
	if err != nil {
		return nil, err
	}
	buildHash, err := hash(record["authorityBuildHash"], path+"/authorityBuildHash")
	if err != nil {
		return nil, err
	}
	return Record{"backend": backend, "authority": authority, "routingEpoch": epoch, "authorityBuildHash": buildHash}, nil
}

func ValidateRecord(value any) (Record, error) {
	record, err := asRecord(value, "$")
	if err != nil {
		return nil, err
	}
	schema, _ := record["schema"].(string)
	switch schema {
	case SchemaAccount:
		return ValidateAccount(value)
	case SchemaReserveRequest:
		return ValidateReserveRequest(value)
	case SchemaReserveDecision:
		return ValidateReserveDecision(value)
	case SchemaReservation:
		return ValidateReservation(value)
	case SchemaProviderUsage:
		return ValidateProviderUsage(value)
	case SchemaSettlementRequest:
		return ValidateSettlementRequest(value)
	case SchemaSettlement:
		return ValidateSettlement(value)
	case SchemaLedgerEntry:
		return ValidateLedgerEntry(value)
	case SchemaReceipt:
		return ValidateReceipt(value)
	case SchemaPreparedRequest:
		prepared, prepareErr := ValidatePreparedRequest(value)
		if prepareErr != nil {
			return nil, prepareErr
		}
		return Record{
			"schema": prepared.Schema, "operation": prepared.Operation,
			"method": prepared.Method, "path": prepared.Path,
			"callerId": prepared.CallerID, "body": prepared.Body,
			"requestHash": prepared.RequestHash, "idempotencyKey": prepared.IdempotencyKey,
			"requestFingerprint": prepared.RequestFingerprint,
		}, nil
	case SchemaReconciliation:
		return ValidateReconciliation(value)
	case SchemaLegacyApproval:
		return ValidateLegacyApproval(value)
	default:
		return nil, failure(ErrorInvalid, "$/schema", "$/schema is invalid.")
	}
}

func ValidateRecordBytes(contents []byte) (Record, error) {
	value, err := parseBytes(contents, MaxRecordBytes)
	if err != nil {
		return nil, err
	}
	validated, err := ValidateRecord(value)
	if err != nil {
		return nil, err
	}
	canonical, err := CanonicalJSON(validated)
	if err != nil {
		return nil, err
	}
	if canonical != string(contents) {
		return nil, failure(ErrorHashMismatch, "$", "Budget authority record is not canonical.")
	}
	return validated, nil
}

func DecodeRecordJSON(contents []byte) (Record, error) { return ValidateRecordBytes(contents) }

func ValidateAccount(value any) (Record, error) {
	root, err := closed(value, withBase("schema", "workspaceId", "runId", "accountId", "policyHash", "route", "accountRevision", "runRevision", "limit", "reserved", "settled", "updatedAt"), "$")
	if err != nil {
		return nil, err
	}
	limit, err := quantities(root["limit"], "$/limit")
	if err != nil {
		return nil, err
	}
	reserved, err := quantities(root["reserved"], "$/reserved")
	if err != nil {
		return nil, err
	}
	settled, err := quantities(root["settled"], "$/settled")
	if err != nil {
		return nil, err
	}
	for _, key := range []string{"tokens", "nanoUsd", "calls"} {
		l := decimalBig(limit[key])
		r := decimalBig(reserved[key])
		s := decimalBig(settled[key])
		if s.Cmp(r) > 0 || r.Cmp(l) > 0 {
			return nil, failure(ErrorInvalid, "$/reserved/"+key, "Account must satisfy settled <= reserved <= limit.")
		}
	}
	base, err := authorityBase(root)
	if err != nil {
		return nil, err
	}
	result := copyRecord(base)
	result["schema"], err = literalString(root["schema"], SchemaAccount, "$/schema")
	if err != nil {
		return nil, err
	}
	for _, key := range []string{"workspaceId", "runId", "accountId"} {
		result[key], err = identifier(root[key], "$/"+key)
		if err != nil {
			return nil, err
		}
	}
	result["policyHash"], err = hash(root["policyHash"], "$/policyHash")
	if err != nil {
		return nil, err
	}
	result["route"], err = route(root["route"], "$/route")
	if err != nil {
		return nil, err
	}
	result["accountRevision"], err = safeInteger(root["accountRevision"], "$/accountRevision", 0)
	if err != nil {
		return nil, err
	}
	result["runRevision"], err = safeInteger(root["runRevision"], "$/runRevision", 0)
	if err != nil {
		return nil, err
	}
	result["limit"], result["reserved"], result["settled"] = limit, reserved, settled
	result["updatedAt"], err = canonicalTimestamp(root["updatedAt"], "$/updatedAt")
	if err != nil {
		return nil, err
	}
	if err := assertExact(result, MaxAccountBytes); err != nil {
		return nil, err
	}
	return result, nil
}

func ValidateReserveRequest(value any) (Record, error) {
	root, err := closed(value, withBase("schema", "workspaceId", "runId", "accountId", "reservationId", "callId", "providerAttempt", "expectedProviderHash", "expectedModelHash", "expectedProviderRunHash", "correlationId", "policyHash", "route", "expectedAccountRevision", "expectedRunRevision", "rateNanoUsdPerToken", "requested", "requestedAt"), "$")
	if err != nil {
		return nil, err
	}
	requested, err := quantities(root["requested"], "$/requested")
	if err != nil {
		return nil, err
	}
	if requested["calls"] != "1" {
		return nil, failure(ErrorInvalid, "$/requested/calls", "Each reserve requests one call.")
	}
	rateValue, err := validateRate(root["rateNanoUsdPerToken"], "$/rateNanoUsdPerToken")
	if err != nil {
		return nil, err
	}
	charge, err := ChargeNanoUSD(requested["tokens"], rateValue)
	if err != nil {
		return nil, err
	}
	if requested["nanoUsd"] != charge {
		return nil, failure(ErrorPolicyDrift, "$/requested/nanoUsd", "Requested nanoUsd must equal the exact token-rate fold.")
	}
	base, err := authorityBase(root)
	if err != nil {
		return nil, err
	}
	result := copyRecord(base)
	result["schema"], err = literalString(root["schema"], SchemaReserveRequest, "$/schema")
	if err != nil {
		return nil, err
	}
	for _, key := range []string{"workspaceId", "runId", "accountId", "reservationId", "callId", "correlationId"} {
		result[key], err = identifier(root[key], "$/"+key)
		if err != nil {
			return nil, err
		}
	}
	result["providerAttempt"], err = positiveDecimal(root["providerAttempt"], "$/providerAttempt")
	if err != nil {
		return nil, err
	}
	for _, key := range []string{"expectedProviderHash", "expectedModelHash", "expectedProviderRunHash"} {
		result[key], err = prefixedHash(root[key], "$/"+key)
		if err != nil {
			return nil, err
		}
	}
	result["policyHash"], err = hash(root["policyHash"], "$/policyHash")
	if err != nil {
		return nil, err
	}
	result["route"], err = route(root["route"], "$/route")
	if err != nil {
		return nil, err
	}
	result["expectedAccountRevision"], err = safeInteger(root["expectedAccountRevision"], "$/expectedAccountRevision", 0)
	if err != nil {
		return nil, err
	}
	result["expectedRunRevision"], err = safeInteger(root["expectedRunRevision"], "$/expectedRunRevision", 0)
	if err != nil {
		return nil, err
	}
	result["rateNanoUsdPerToken"], result["requested"] = rateValue, requested
	result["requestedAt"], err = canonicalTimestamp(root["requestedAt"], "$/requestedAt")
	if err != nil {
		return nil, err
	}
	if err := assertExact(result, MaxRecordBytes); err != nil {
		return nil, err
	}
	return result, nil
}

func ValidateReservation(value any) (Record, error) {
	root, err := closed(value, withBase("schema", "workspaceId", "runId", "accountId", "reservationId", "callId", "providerAttempt", "expectedProviderHash", "expectedModelHash", "expectedProviderRunHash", "policyHash", "route", "rateNanoUsdPerToken", "reserved", "reserveDecisionHash", "openedAccountRevision", "openedRunRevision", "openedAt"), "$")
	if err != nil {
		return nil, err
	}
	reserved, err := quantities(root["reserved"], "$/reserved")
	if err != nil {
		return nil, err
	}
	if reserved["calls"] != "1" {
		return nil, failure(ErrorInvalid, "$/reserved/calls", "A reservation owns one call.")
	}
	rateValue, err := validateRate(root["rateNanoUsdPerToken"], "$/rateNanoUsdPerToken")
	if err != nil {
		return nil, err
	}
	charge, err := ChargeNanoUSD(reserved["tokens"], rateValue)
	if err != nil {
		return nil, err
	}
	if reserved["nanoUsd"] != charge {
		return nil, failure(ErrorPolicyDrift, "$/reserved/nanoUsd", "Reservation rate binding drifted.")
	}
	base, err := authorityBase(root)
	if err != nil {
		return nil, err
	}
	result := copyRecord(base)
	result["schema"], err = literalString(root["schema"], SchemaReservation, "$/schema")
	if err != nil {
		return nil, err
	}
	for _, key := range []string{"workspaceId", "runId", "accountId", "reservationId", "callId"} {
		result[key], err = identifier(root[key], "$/"+key)
		if err != nil {
			return nil, err
		}
	}
	result["providerAttempt"], err = positiveDecimal(root["providerAttempt"], "$/providerAttempt")
	if err != nil {
		return nil, err
	}
	for _, key := range []string{"expectedProviderHash", "expectedModelHash", "expectedProviderRunHash"} {
		result[key], err = prefixedHash(root[key], "$/"+key)
		if err != nil {
			return nil, err
		}
	}
	result["policyHash"], err = hash(root["policyHash"], "$/policyHash")
	if err != nil {
		return nil, err
	}
	result["route"], err = route(root["route"], "$/route")
	if err != nil {
		return nil, err
	}
	result["rateNanoUsdPerToken"], result["reserved"] = rateValue, reserved
	result["reserveDecisionHash"], err = hash(root["reserveDecisionHash"], "$/reserveDecisionHash")
	if err != nil {
		return nil, err
	}
	result["openedAccountRevision"], err = safeInteger(root["openedAccountRevision"], "$/openedAccountRevision", 1)
	if err != nil {
		return nil, err
	}
	result["openedRunRevision"], err = safeInteger(root["openedRunRevision"], "$/openedRunRevision", 1)
	if err != nil {
		return nil, err
	}
	result["openedAt"], err = canonicalTimestamp(root["openedAt"], "$/openedAt")
	if err != nil {
		return nil, err
	}
	if err := assertExact(result, MaxRecordBytes); err != nil {
		return nil, err
	}
	return result, nil
}

func ValidateProviderUsage(value any) (Record, error) {
	fields := []string{"schema", "providerHash", "modelHash", "runHash", "attempt", "calls", "status", "inputTokens", "outputTokens", "totalTokens", "outcome", "requestHash", "outcomeHash", "receiptHash"}
	root, err := closed(value, fields, "$")
	if err != nil {
		return nil, err
	}
	status, err := enumString(root["status"], []string{"reported", "unreported"}, "$/status")
	if err != nil {
		return nil, err
	}
	var tokens = make(map[string]any)
	for _, key := range []string{"inputTokens", "outputTokens", "totalTokens"} {
		if root[key] == nil {
			tokens[key] = nil
		} else {
			tokens[key], err = ValidateDecimal(root[key], "$/"+key)
			if err != nil {
				return nil, err
			}
		}
	}
	if status == "reported" && tokens["totalTokens"] == nil || status == "unreported" && (tokens["inputTokens"] != nil || tokens["outputTokens"] != nil || tokens["totalTokens"] != nil) {
		return nil, failure(ErrorInvalid, "$/status", "Provider usage evidence is inconsistent.")
	}
	if tokens["inputTokens"] != nil && tokens["outputTokens"] != nil {
		sum := new(big.Int).Add(decimalBig(tokens["inputTokens"]), decimalBig(tokens["outputTokens"]))
		if sum.Cmp(decimalBig(tokens["totalTokens"])) != 0 {
			return nil, failure(ErrorInvalid, "$/status", "Provider usage evidence is inconsistent.")
		}
	}
	unsigned := Record{}
	unsigned["schema"], err = literalString(root["schema"], SchemaProviderUsage, "$/schema")
	if err != nil {
		return nil, err
	}
	for _, key := range []string{"providerHash", "modelHash", "runHash", "requestHash", "outcomeHash"} {
		unsigned[key], err = prefixedHash(root[key], "$/"+key)
		if err != nil {
			return nil, err
		}
	}
	unsigned["attempt"], err = positiveDecimal(root["attempt"], "$/attempt")
	if err != nil {
		return nil, err
	}
	unsigned["calls"], err = literalString(root["calls"], "1", "$/calls")
	if err != nil {
		return nil, err
	}
	unsigned["status"], unsigned["inputTokens"], unsigned["outputTokens"], unsigned["totalTokens"] = status, tokens["inputTokens"], tokens["outputTokens"], tokens["totalTokens"]
	unsigned["outcome"], err = enumString(root["outcome"], []string{"provider_response_accepted", "provider_attempt_failed"}, "$/outcome")
	if err != nil {
		return nil, err
	}
	receiptHash, err := prefixedHash(root["receiptHash"], "$/receiptHash")
	if err != nil {
		return nil, err
	}
	canonical, _ := CanonicalJSON(unsigned)
	digest := sha256.Sum256([]byte("openslack.provider-usage-receipt.v1\x00" + canonical))
	expected := "sha256:" + hex.EncodeToString(digest[:])
	if receiptHash != expected {
		return nil, failure(ErrorHashMismatch, "$/receiptHash", "Provider usage receipt hash drifted.")
	}
	result := copyRecord(unsigned)
	result["receiptHash"] = receiptHash
	if err := assertExact(result, MaxRecordBytes); err != nil {
		return nil, err
	}
	return result, nil
}

func ValidateSettlementRequest(value any) (Record, error) {
	root, err := closed(value, withBase("schema", "workspaceId", "runId", "accountId", "reservationId", "callId", "providerAttempt", "expectedProviderHash", "expectedModelHash", "expectedProviderRunHash", "correlationId", "policyHash", "route", "expectedAccountRevision", "expectedRunRevision", "reserveDecisionHash", "usageEvidenceStatus", "usageReceiptHash", "providerUsage", "rateNanoUsdPerToken", "requestedAt"), "$")
	if err != nil {
		return nil, err
	}
	status, err := enumString(root["usageEvidenceStatus"], []string{"trusted", "missing", "untrusted"}, "$/usageEvidenceStatus")
	if err != nil {
		return nil, err
	}
	var usage Record
	var usageValue any
	if root["providerUsage"] != nil {
		usage, err = ValidateProviderUsage(root["providerUsage"])
		if err != nil {
			return nil, err
		}
		usageValue = usage
	}
	var usageHash any
	if root["usageReceiptHash"] != nil {
		usageHash, err = prefixedHash(root["usageReceiptHash"], "$/usageReceiptHash")
		if err != nil {
			return nil, err
		}
	}
	attempt, err := positiveDecimal(root["providerAttempt"], "$/providerAttempt")
	if err != nil {
		return nil, err
	}
	expectedProviderHash, err := prefixedHash(root["expectedProviderHash"], "$/expectedProviderHash")
	if err != nil {
		return nil, err
	}
	expectedModelHash, err := prefixedHash(root["expectedModelHash"], "$/expectedModelHash")
	if err != nil {
		return nil, err
	}
	expectedProviderRunHash, err := prefixedHash(root["expectedProviderRunHash"], "$/expectedProviderRunHash")
	if err != nil {
		return nil, err
	}
	if status == "trusted" && (usage == nil || usageHash != usage["receiptHash"] || attempt != usage["attempt"] || expectedProviderHash != usage["providerHash"] || expectedModelHash != usage["modelHash"] || expectedProviderRunHash != usage["runHash"]) || status == "missing" && (usage != nil || usageHash != nil) || status == "untrusted" && (usage != nil || usageHash == nil) {
		return nil, failure(ErrorInvalid, "$/usageEvidenceStatus", "Usage evidence status and receipt binding are inconsistent.")
	}
	base, err := authorityBase(root)
	if err != nil {
		return nil, err
	}
	result := copyRecord(base)
	result["schema"], err = literalString(root["schema"], SchemaSettlementRequest, "$/schema")
	if err != nil {
		return nil, err
	}
	for _, key := range []string{"workspaceId", "runId", "accountId", "reservationId", "callId", "correlationId"} {
		result[key], err = identifier(root[key], "$/"+key)
		if err != nil {
			return nil, err
		}
	}
	result["providerAttempt"], result["usageEvidenceStatus"], result["usageReceiptHash"], result["providerUsage"] = attempt, status, usageHash, usageValue
	result["expectedProviderHash"], result["expectedModelHash"], result["expectedProviderRunHash"] = expectedProviderHash, expectedModelHash, expectedProviderRunHash
	result["policyHash"], err = hash(root["policyHash"], "$/policyHash")
	if err != nil {
		return nil, err
	}
	result["route"], err = route(root["route"], "$/route")
	if err != nil {
		return nil, err
	}
	result["expectedAccountRevision"], err = safeInteger(root["expectedAccountRevision"], "$/expectedAccountRevision", 0)
	if err != nil {
		return nil, err
	}
	result["expectedRunRevision"], err = safeInteger(root["expectedRunRevision"], "$/expectedRunRevision", 0)
	if err != nil {
		return nil, err
	}
	result["reserveDecisionHash"], err = hash(root["reserveDecisionHash"], "$/reserveDecisionHash")
	if err != nil {
		return nil, err
	}
	result["rateNanoUsdPerToken"], err = validateRate(root["rateNanoUsdPerToken"], "$/rateNanoUsdPerToken")
	if err != nil {
		return nil, err
	}
	result["requestedAt"], err = canonicalTimestamp(root["requestedAt"], "$/requestedAt")
	if err != nil {
		return nil, err
	}
	if err := assertExact(result, MaxRecordBytes); err != nil {
		return nil, err
	}
	return result, nil
}

func copyRecord(source Record) Record {
	result := make(Record, len(source))
	for key, value := range source {
		result[key] = value
	}
	return result
}
func decimalBig(value any) *big.Int {
	result, _ := new(big.Int).SetString(value.(string), 10)
	return result
}
func positiveDecimal(value any, path string) (string, error) {
	result, err := ValidateDecimal(value, path)
	if err != nil {
		return "", err
	}
	if result == "0" {
		return "", failure(ErrorInvalid, path, "Provider attempt must be positive.")
	}
	return result, nil
}
func assertExact(value any, maxBytes int) error {
	canonical, err := CanonicalJSON(value)
	if err != nil {
		return err
	}
	if len([]byte(canonical))+1 > maxBytes {
		return failure(ErrorLimitExceeded, "$", "Record exceeds byte limit.")
	}
	return nil
}
