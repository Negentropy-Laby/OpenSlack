package budgetcontract

import "math/big"

func ValidateReserveDecision(value any) (Record, error) {
	root, err := closed(value, withBase("schema", "status", "request", "requestHash", "beforeAccountHash", "afterAccount", "authorization", "insufficientDimensions", "legacyBudgetApprovalAuthority", "decidedAt"), "$")
	if err != nil {
		return nil, err
	}
	status, err := enumString(root["status"], []string{"reserved", "rejected"}, "$/status")
	if err != nil {
		return nil, err
	}
	request, err := ValidateReserveRequest(root["request"])
	if err != nil {
		return nil, err
	}
	after, err := ValidateAccount(root["afterAccount"])
	if err != nil {
		return nil, err
	}
	if err := assertBaseIdentity(after, request); err != nil {
		return nil, err
	}
	if after["accountRevision"].(int64) != request["expectedAccountRevision"].(int64)+1 || after["runRevision"].(int64) != request["expectedRunRevision"].(int64)+1 {
		return nil, failure(ErrorStaleRevision, "$/afterAccount", "Reserve did not advance revisions once.")
	}
	requestHash, err := hash(root["requestHash"], "$/requestHash")
	if err != nil {
		return nil, err
	}
	expectedHash, _ := hashValue("reserve-request", request)
	if requestHash != expectedHash {
		return nil, failure(ErrorHashMismatch, "$/requestHash", "Reserve request hash drifted.")
	}
	authorization, err := quantities(root["authorization"], "$/authorization")
	if err != nil {
		return nil, err
	}
	dimensions, ok := root["insufficientDimensions"].([]any)
	if !ok {
		return nil, failure(ErrorInvalid, "$/insufficientDimensions", "Insufficient dimensions are invalid.")
	}
	allowedOrder := []string{"tokens", "nano_usd", "calls"}
	next := 0
	seen := map[string]bool{}
	for _, raw := range dimensions {
		value, ok := raw.(string)
		if !ok || seen[value] {
			return nil, failure(ErrorInvalid, "$/insufficientDimensions", "Insufficient dimensions are invalid.")
		}
		for next < len(allowedOrder) && allowedOrder[next] != value {
			next++
		}
		if next == len(allowedOrder) {
			return nil, failure(ErrorInvalid, "$/insufficientDimensions", "Insufficient dimensions are invalid.")
		}
		seen[value] = true
		next++
	}
	if status == "reserved" && (!quantitiesEqual(authorization, request["requested"].(Record)) || len(dimensions) != 0) || status == "rejected" && (!quantitiesEqual(authorization, zeroQuantities()) || len(dimensions) == 0) {
		return nil, failure(ErrorInvalid, "$/authorization", "Reserve authorization does not match status.")
	}
	decidedAt, err := canonicalTimestamp(root["decidedAt"], "$/decidedAt")
	if err != nil {
		return nil, err
	}
	if decidedAt != after["updatedAt"] || decidedAt < request["requestedAt"].(string) {
		return nil, failure(ErrorIdentityMismatch, "$/decidedAt", "Reserve decision time is inconsistent.")
	}
	base, err := authorityBase(root)
	if err != nil {
		return nil, err
	}
	result := copyRecord(base)
	result["schema"], err = literalString(root["schema"], SchemaReserveDecision, "$/schema")
	if err != nil {
		return nil, err
	}
	result["status"], result["request"], result["requestHash"] = status, request, requestHash
	result["beforeAccountHash"], err = hash(root["beforeAccountHash"], "$/beforeAccountHash")
	if err != nil {
		return nil, err
	}
	result["afterAccount"], result["authorization"], result["insufficientDimensions"] = after, authorization, dimensions
	result["legacyBudgetApprovalAuthority"], err = boolLiteral(root["legacyBudgetApprovalAuthority"], false, "$/legacyBudgetApprovalAuthority")
	if err != nil {
		return nil, err
	}
	result["decidedAt"] = decidedAt
	if err := assertExact(result, MaxRecordBytes); err != nil {
		return nil, err
	}
	return result, nil
}

func ValidateReservationForDecision(reservationValue, decisionValue any) (Record, error) {
	reservation, err := ValidateReservation(reservationValue)
	if err != nil {
		return nil, err
	}
	decision, err := ValidateReserveDecision(decisionValue)
	if err != nil {
		return nil, err
	}
	request := decision["request"].(Record)
	decisionHash, _ := hashValue("reserve-decision", decision)
	if decision["status"] != "reserved" ||
		assertReservationBinding(reservation, request) != nil ||
		!quantitiesEqual(reservation["reserved"].(Record), decision["authorization"].(Record)) ||
		reservation["reserveDecisionHash"] != decisionHash ||
		reservation["openedAccountRevision"] != decision["afterAccount"].(Record)["accountRevision"] ||
		reservation["openedRunRevision"] != decision["afterAccount"].(Record)["runRevision"] ||
		reservation["openedAt"] != decision["decidedAt"] {
		return nil, failure(ErrorIdentityMismatch, "$/reservation", "Reservation does not bind its reserve decision.")
	}
	return reservation, nil
}

func ValidateSettlement(value any) (Record, error) {
	root, err := closed(value, withBase("schema", "status", "request", "requestHash", "reservation", "reservationHash", "beforeAccountHash", "afterAccount", "released", "reasonCode", "reservationRemainsOpen", "runReconciliationLatched", "providerRetryAuthorized", "cachePublishAuthorized", "legacyBudgetApprovalAuthority", "committedAt"), "$")
	if err != nil {
		return nil, err
	}
	status, err := enumString(root["status"], []string{"settled", "reconciliation_required"}, "$/status")
	if err != nil {
		return nil, err
	}
	request, err := ValidateSettlementRequest(root["request"])
	if err != nil {
		return nil, err
	}
	reservation, err := ValidateReservation(root["reservation"])
	if err != nil {
		return nil, err
	}
	if err := assertReservationBinding(reservation, request); err != nil {
		return nil, err
	}
	after, err := ValidateAccount(root["afterAccount"])
	if err != nil {
		return nil, err
	}
	if err := assertBaseIdentity(after, request); err != nil {
		return nil, err
	}
	if err := assertBaseIdentity(after, reservation); err != nil {
		return nil, err
	}
	if after["accountRevision"].(int64) != request["expectedAccountRevision"].(int64)+1 || after["runRevision"].(int64) != request["expectedRunRevision"].(int64)+1 {
		return nil, failure(ErrorStaleRevision, "$/afterAccount", "Settlement did not advance revisions once.")
	}
	requestHash, err := hash(root["requestHash"], "$/requestHash")
	if err != nil {
		return nil, err
	}
	reservationHash, err := hash(root["reservationHash"], "$/reservationHash")
	if err != nil {
		return nil, err
	}
	expectedRequestHash, _ := hashValue("settlement-request", request)
	expectedReservationHash, _ := hashValue("reservation", reservation)
	if requestHash != expectedRequestHash || reservationHash != expectedReservationHash {
		return nil, failure(ErrorHashMismatch, "$", "Settlement hash binding drifted.")
	}
	var released Record
	var releasedValue any
	if root["released"] != nil {
		released, err = quantities(root["released"], "$/released")
		if err != nil {
			return nil, err
		}
		releasedValue = released
	}
	var reason any
	if root["reasonCode"] != nil {
		reason, err = enumString(root["reasonCode"], []string{"provider_outcome_unknown", "usage_receipt_missing", "usage_receipt_untrusted", "usage_overrun"}, "$/reasonCode")
		if err != nil {
			return nil, err
		}
	}
	reservedAmount := quantitiesBig(reservation["reserved"].(Record))
	providerUsage, _ := request["providerUsage"].(Record)
	var actual *quantityValues
	if request["usageEvidenceStatus"] == "trusted" && providerUsage != nil && providerUsage["status"] == "reported" {
		charge, chargeErr := ChargeNanoUSD(providerUsage["totalTokens"], request["rateNanoUsdPerToken"])
		if chargeErr != nil {
			return nil, chargeErr
		}
		values := quantityValues{decimalBig(providerUsage["totalTokens"]), decimalBig(charge), decimalBig(providerUsage["calls"])}
		actual = &values
	}
	overrun := actual != nil && (actual.tokens.Cmp(reservedAmount.tokens) > 0 || actual.nanoUSD.Cmp(reservedAmount.nanoUSD) > 0 || actual.calls.Cmp(reservedAmount.calls) > 0)
	var expectedReason any
	switch {
	case request["usageEvidenceStatus"] == "missing":
		expectedReason = "usage_receipt_missing"
	case request["usageEvidenceStatus"] == "untrusted":
		expectedReason = "usage_receipt_untrusted"
	case providerUsage != nil && providerUsage["status"] == "unreported":
		expectedReason = "provider_outcome_unknown"
	case overrun:
		expectedReason = "usage_overrun"
	}
	expectedStatus := "reconciliation_required"
	var expectedReleased Record
	if expectedReason == nil {
		expectedStatus = "settled"
		expectedReleased, err = makeQuantities(
			new(big.Int).Sub(new(big.Int).Set(reservedAmount.tokens), actual.tokens),
			new(big.Int).Sub(new(big.Int).Set(reservedAmount.nanoUSD), actual.nanoUSD),
			new(big.Int).Sub(new(big.Int).Set(reservedAmount.calls), actual.calls),
		)
		if err != nil {
			return nil, err
		}
	}
	committedAt, err := canonicalTimestamp(root["committedAt"], "$/committedAt")
	if err != nil {
		return nil, err
	}
	if committedAt != after["updatedAt"] || committedAt < request["requestedAt"].(string) || committedAt < reservation["openedAt"].(string) {
		return nil, failure(ErrorIdentityMismatch, "$/committedAt", "Settlement time is inconsistent.")
	}
	if status != expectedStatus || reason != expectedReason || (expectedReleased == nil) != (released == nil) || expectedReleased != nil && !quantitiesEqual(expectedReleased, released) {
		return nil, failure(ErrorReconciliationRequired, "$/status", "Settlement status fields are inconsistent.")
	}
	open, openOK := root["reservationRemainsOpen"].(bool)
	latched, latchedOK := root["runReconciliationLatched"].(bool)
	publish, publishOK := root["cachePublishAuthorized"].(bool)
	expectedPublish := status == "settled" && providerUsage != nil && providerUsage["outcome"] == "provider_response_accepted"
	if !openOK || !latchedOK || !publishOK || status == "settled" && (released == nil || reason != nil || open || latched || publish != expectedPublish) || status == "reconciliation_required" && (released != nil || reason == nil || !open || !latched || publish) {
		return nil, failure(ErrorReconciliationRequired, "$/status", "Settlement status fields are inconsistent.")
	}
	base, err := authorityBase(root)
	if err != nil {
		return nil, err
	}
	result := copyRecord(base)
	result["schema"], err = literalString(root["schema"], SchemaSettlement, "$/schema")
	if err != nil {
		return nil, err
	}
	result["status"], result["request"], result["requestHash"], result["reservation"], result["reservationHash"] = status, request, requestHash, reservation, reservationHash
	result["beforeAccountHash"], err = hash(root["beforeAccountHash"], "$/beforeAccountHash")
	if err != nil {
		return nil, err
	}
	result["afterAccount"], result["released"], result["reasonCode"] = after, releasedValue, reason
	result["reservationRemainsOpen"], result["runReconciliationLatched"], result["cachePublishAuthorized"] = open, latched, publish
	result["providerRetryAuthorized"], err = boolLiteral(root["providerRetryAuthorized"], false, "$/providerRetryAuthorized")
	if err != nil {
		return nil, err
	}
	result["legacyBudgetApprovalAuthority"], err = boolLiteral(root["legacyBudgetApprovalAuthority"], false, "$/legacyBudgetApprovalAuthority")
	if err != nil {
		return nil, err
	}
	result["committedAt"] = committedAt
	if err := assertExact(result, MaxRecordBytes); err != nil {
		return nil, err
	}
	return result, nil
}

func ValidateLedgerEntry(value any) (Record, error) {
	root, err := closed(value, withBase("schema", "kind", "entryId", "workspaceId", "runId", "accountId", "reservationId", "callId", "accountRevision", "runRevision", "previousAccountHash", "accountHash", "decisionHash", "encumbered", "settled", "released", "providerUsageHash", "reasonCode", "recordedAt"), "$")
	if err != nil {
		return nil, err
	}
	kind, err := enumString(root["kind"], []string{"reserve_reserved", "reserve_rejected", "settlement_settled", "settlement_reconciliation_required"}, "$/kind")
	if err != nil {
		return nil, err
	}
	encumbered, err := quantities(root["encumbered"], "$/encumbered")
	if err != nil {
		return nil, err
	}
	settled, err := quantities(root["settled"], "$/settled")
	if err != nil {
		return nil, err
	}
	released, err := quantities(root["released"], "$/released")
	if err != nil {
		return nil, err
	}
	var usageHash any
	if root["providerUsageHash"] != nil {
		usageHash, err = prefixedHash(root["providerUsageHash"], "$/providerUsageHash")
		if err != nil {
			return nil, err
		}
	}
	var reason any
	if root["reasonCode"] != nil {
		reason, err = enumString(root["reasonCode"], []string{"provider_outcome_unknown", "usage_receipt_missing", "usage_receipt_untrusted", "usage_overrun"}, "$/reasonCode")
		if err != nil {
			return nil, err
		}
	}
	zero := zeroQuantities()
	invalid := kind == "reserve_reserved" && (!quantitiesEqual(settled, zero) || !quantitiesEqual(released, zero) || usageHash != nil || reason != nil) || kind == "reserve_rejected" && (!quantitiesEqual(encumbered, zero) || !quantitiesEqual(settled, zero) || !quantitiesEqual(released, zero) || usageHash != nil || reason != nil) || kind == "settlement_settled" && (!quantitiesEqual(encumbered, zero) || usageHash == nil || reason != nil) || kind == "settlement_reconciliation_required" && (!quantitiesEqual(encumbered, zero) || !quantitiesEqual(settled, zero) || !quantitiesEqual(released, zero) || reason == nil || reason == "usage_receipt_missing" && usageHash != nil || reason != "usage_receipt_missing" && usageHash == nil)
	if invalid {
		return nil, failure(ErrorInvalid, "$/kind", "Ledger quantities do not match kind.")
	}
	base, err := authorityBase(root)
	if err != nil {
		return nil, err
	}
	result := copyRecord(base)
	result["schema"], err = literalString(root["schema"], SchemaLedgerEntry, "$/schema")
	if err != nil {
		return nil, err
	}
	result["kind"] = kind
	for _, key := range []string{"entryId", "workspaceId", "runId", "accountId", "reservationId", "callId"} {
		result[key], err = identifier(root[key], "$/"+key)
		if err != nil {
			return nil, err
		}
	}
	result["accountRevision"], err = safeInteger(root["accountRevision"], "$/accountRevision", 1)
	if err != nil {
		return nil, err
	}
	result["runRevision"], err = safeInteger(root["runRevision"], "$/runRevision", 1)
	if err != nil {
		return nil, err
	}
	for _, key := range []string{"previousAccountHash", "accountHash", "decisionHash"} {
		result[key], err = hash(root[key], "$/"+key)
		if err != nil {
			return nil, err
		}
	}
	result["encumbered"], result["settled"], result["released"], result["providerUsageHash"], result["reasonCode"] = encumbered, settled, released, usageHash, reason
	result["recordedAt"], err = canonicalTimestamp(root["recordedAt"], "$/recordedAt")
	if err != nil {
		return nil, err
	}
	if err := assertExact(result, MaxRecordBytes); err != nil {
		return nil, err
	}
	return result, nil
}

func ValidateReceipt(value any) (Record, error) {
	root, err := closed(value, withBase("schema", "operation", "status", "workspaceId", "runId", "accountId", "reservationId", "callId", "expectedAccountRevision", "acceptedAccountRevision", "expectedRunRevision", "acceptedRunRevision", "idempotencyKey", "requestFingerprint", "requestHash", "recordHash", "ledgerEntryHash", "correlationId", "serviceBuildHash", "committedAt", "reconciliationToken"), "$")
	if err != nil {
		return nil, err
	}
	status, err := enumString(root["status"], []string{"accepted", "provider_reconciliation_required", "database_reconciliation_required"}, "$/status")
	if err != nil {
		return nil, err
	}
	var acceptedAccount, acceptedRun any
	if root["acceptedAccountRevision"] != nil {
		acceptedAccount, err = safeInteger(root["acceptedAccountRevision"], "$/acceptedAccountRevision", 1)
		if err != nil {
			return nil, err
		}
	}
	if root["acceptedRunRevision"] != nil {
		acceptedRun, err = safeInteger(root["acceptedRunRevision"], "$/acceptedRunRevision", 1)
		if err != nil {
			return nil, err
		}
	}
	var recordHash, ledgerHash, committedAt, reconciliation any
	if root["recordHash"] != nil {
		recordHash, err = hash(root["recordHash"], "$/recordHash")
		if err != nil {
			return nil, err
		}
	}
	if root["ledgerEntryHash"] != nil {
		ledgerHash, err = hash(root["ledgerEntryHash"], "$/ledgerEntryHash")
		if err != nil {
			return nil, err
		}
	}
	if root["committedAt"] != nil {
		committedAt, err = canonicalTimestamp(root["committedAt"], "$/committedAt")
		if err != nil {
			return nil, err
		}
	}
	if root["reconciliationToken"] != nil {
		reconciliation, err = identifier(root["reconciliationToken"], "$/reconciliationToken")
		if err != nil {
			return nil, err
		}
	}
	accepted := status != "database_reconciliation_required"
	reconciliationRequired := status != "accepted"
	if accepted && (acceptedAccount == nil || acceptedRun == nil || recordHash == nil || ledgerHash == nil || committedAt == nil || reconciliationRequired && reconciliation == nil || !reconciliationRequired && reconciliation != nil) || !accepted && (acceptedAccount != nil || acceptedRun != nil || recordHash != nil || ledgerHash != nil || committedAt != nil || reconciliation == nil) {
		return nil, failure(ErrorReconciliationRequired, "$/status", "Receipt status fields are inconsistent.")
	}
	expectedAccount, err := safeInteger(root["expectedAccountRevision"], "$/expectedAccountRevision", 0)
	if err != nil {
		return nil, err
	}
	expectedRun, err := safeInteger(root["expectedRunRevision"], "$/expectedRunRevision", 0)
	if err != nil {
		return nil, err
	}
	if accepted && (acceptedAccount.(int64) != expectedAccount+1 || acceptedRun.(int64) != expectedRun+1) {
		return nil, failure(ErrorStaleRevision, "$/acceptedAccountRevision", "Receipt revision is invalid.")
	}
	base, err := authorityBase(root)
	if err != nil {
		return nil, err
	}
	result := copyRecord(base)
	result["schema"], err = literalString(root["schema"], SchemaReceipt, "$/schema")
	if err != nil {
		return nil, err
	}
	result["operation"], err = enumString(root["operation"], []string{"reserve", "settle"}, "$/operation")
	if err != nil {
		return nil, err
	}
	result["status"] = status
	for _, key := range []string{"workspaceId", "runId", "accountId", "reservationId", "callId", "correlationId"} {
		result[key], err = identifier(root[key], "$/"+key)
		if err != nil {
			return nil, err
		}
	}
	result["expectedAccountRevision"], result["acceptedAccountRevision"], result["expectedRunRevision"], result["acceptedRunRevision"] = expectedAccount, acceptedAccount, expectedRun, acceptedRun
	idempotency, err := stringValue(root["idempotencyKey"], "$/idempotencyKey")
	if err != nil || len(idempotency) != len(IdempotencyPrefix)+64 || idempotency[:len(IdempotencyPrefix)] != IdempotencyPrefix || !isLowerHex(idempotency[len(IdempotencyPrefix):]) {
		return nil, failure(ErrorInvalid, "$/idempotencyKey", "$/idempotencyKey is invalid.")
	}
	result["idempotencyKey"] = idempotency
	result["requestFingerprint"], err = prefixedHash(root["requestFingerprint"], "$/requestFingerprint")
	if err != nil {
		return nil, err
	}
	result["requestHash"], err = hash(root["requestHash"], "$/requestHash")
	if err != nil {
		return nil, err
	}
	result["recordHash"], result["ledgerEntryHash"] = recordHash, ledgerHash
	result["serviceBuildHash"], err = hash(root["serviceBuildHash"], "$/serviceBuildHash")
	if err != nil {
		return nil, err
	}
	result["committedAt"], result["reconciliationToken"] = committedAt, reconciliation
	if err := assertExact(result, MaxRecordBytes); err != nil {
		return nil, err
	}
	return result, nil
}

func ValidateReconciliation(value any) (Record, error) {
	root, err := closed(value, withBase("schema", "evidenceType", "reasonCode", "workspaceId", "runId", "accountId", "reservationId", "callId", "sourceRequestHash", "usageReceiptHash", "accountHash", "reservationHash", "reconciliationToken", "accountCountersChanged", "reservationReleaseAuthorized", "providerRetryAuthorized", "cachePublishAuthorized", "runReconciliationLatched", "observedAt"), "$")
	if err != nil {
		return nil, err
	}
	typeValue, err := enumString(root["evidenceType"], []string{"provider_outcome", "database_commit"}, "$/evidenceType")
	if err != nil {
		return nil, err
	}
	providerReasons := []string{"provider_outcome_unknown", "usage_receipt_missing", "usage_receipt_untrusted", "usage_overrun"}
	reasons := providerReasons
	if typeValue == "database_commit" {
		reasons = []string{"database_commit_outcome_unknown"}
	}
	reason, err := enumString(root["reasonCode"], reasons, "$/reasonCode")
	if err != nil {
		return nil, err
	}
	var usageHash any
	if root["usageReceiptHash"] != nil {
		usageHash, err = prefixedHash(root["usageReceiptHash"], "$/usageReceiptHash")
		if err != nil {
			return nil, err
		}
	}
	if typeValue == "database_commit" && usageHash != nil || typeValue == "provider_outcome" && (reason == "usage_receipt_missing" && usageHash != nil || reason != "usage_receipt_missing" && usageHash == nil) {
		return nil, failure(ErrorReconciliationRequired, "$/usageReceiptHash", "Reconciliation domains are mixed.")
	}
	base, err := authorityBase(root)
	if err != nil {
		return nil, err
	}
	result := copyRecord(base)
	result["schema"], err = literalString(root["schema"], SchemaReconciliation, "$/schema")
	if err != nil {
		return nil, err
	}
	result["evidenceType"], result["reasonCode"] = typeValue, reason
	for _, key := range []string{"workspaceId", "runId", "accountId", "reservationId", "callId", "reconciliationToken"} {
		result[key], err = identifier(root[key], "$/"+key)
		if err != nil {
			return nil, err
		}
	}
	for _, key := range []string{"sourceRequestHash", "accountHash", "reservationHash"} {
		result[key], err = hash(root[key], "$/"+key)
		if err != nil {
			return nil, err
		}
	}
	result["usageReceiptHash"] = usageHash
	for _, pair := range []struct {
		key      string
		expected bool
	}{{"accountCountersChanged", false}, {"reservationReleaseAuthorized", false}, {"providerRetryAuthorized", false}, {"cachePublishAuthorized", false}, {"runReconciliationLatched", true}} {
		result[pair.key], err = boolLiteral(root[pair.key], pair.expected, "$/"+pair.key)
		if err != nil {
			return nil, err
		}
	}
	result["observedAt"], err = canonicalTimestamp(root["observedAt"], "$/observedAt")
	if err != nil {
		return nil, err
	}
	if err := assertExact(result, MaxRecordBytes); err != nil {
		return nil, err
	}
	return result, nil
}

func ValidateLegacyApproval(value any) (Record, error) {
	root, err := closed(value, withBase("schema", "workspaceId", "runId", "status", "revision", "semantics", "limitAmendmentAuthority", "reservationAuthority", "settlementAuthority", "observedAt"), "$")
	if err != nil {
		return nil, err
	}
	base, err := authorityBase(root)
	if err != nil {
		return nil, err
	}
	result := copyRecord(base)
	result["schema"], err = literalString(root["schema"], SchemaLegacyApproval, "$/schema")
	if err != nil {
		return nil, err
	}
	for _, key := range []string{"workspaceId", "runId"} {
		result[key], err = identifier(root[key], "$/"+key)
		if err != nil {
			return nil, err
		}
	}
	result["status"], err = enumString(root["status"], []string{"pending", "approved", "rejected", "expired"}, "$/status")
	if err != nil {
		return nil, err
	}
	result["revision"], err = safeInteger(root["revision"], "$/revision", 0)
	if err != nil {
		return nil, err
	}
	result["semantics"], err = literalString(root["semantics"], "run_gate_only", "$/semantics")
	if err != nil {
		return nil, err
	}
	for _, key := range []string{"limitAmendmentAuthority", "reservationAuthority", "settlementAuthority"} {
		result[key], err = boolLiteral(root[key], false, "$/"+key)
		if err != nil {
			return nil, err
		}
	}
	result["observedAt"], err = canonicalTimestamp(root["observedAt"], "$/observedAt")
	if err != nil {
		return nil, err
	}
	if err := assertExact(result, MaxRecordBytes); err != nil {
		return nil, err
	}
	return result, nil
}
