package budgetcontract

import "math/big"

func authorityEnvelope() Record {
	return Record{"contractVersion": ContractVersion, "authority": Authority, "writer": Writer, "goRole": GoRole, "goAuthorityClaim": GoAuthorityClaim, "goAuthorityEligible": false}
}

func assertBaseIdentity(left, right Record) error {
	for _, key := range []string{"workspaceId", "runId", "accountId"} {
		if left[key] != right[key] {
			return failure(ErrorIdentityMismatch, "$", "Budget identity drifted.")
		}
	}
	if left["policyHash"] != right["policyHash"] {
		return failure(ErrorPolicyDrift, "$/policyHash", "Budget policy drifted.")
	}
	if !exactEqual(left["route"], right["route"]) {
		return failure(ErrorRouteDrift, "$/route", "Budget route drifted.")
	}
	return nil
}

func assertReservationBinding(reservation, request Record) error {
	for _, key := range []string{
		"workspaceId", "runId", "accountId", "reservationId", "callId",
		"providerAttempt", "expectedProviderHash", "expectedModelHash", "expectedProviderRunHash",
		"policyHash", "rateNanoUsdPerToken",
	} {
		if request[key] != reservation[key] {
			return failure(ErrorIdentityMismatch, "$/reservation", "Reservation drifted.")
		}
	}
	if !exactEqual(request["route"], reservation["route"]) {
		return failure(ErrorIdentityMismatch, "$/reservation", "Reservation drifted.")
	}
	if reserveDecisionHash, present := request["reserveDecisionHash"]; present && reserveDecisionHash != reservation["reserveDecisionHash"] {
		return failure(ErrorIdentityMismatch, "$/reservation", "Reservation drifted.")
	}
	if _, settlement := request["reserveDecisionHash"]; settlement && request["requestedAt"].(string) < reservation["openedAt"].(string) {
		return failure(ErrorIdentityMismatch, "$/requestedAt", "Settlement request predates its durable reservation.")
	}
	return nil
}

func nextAccount(before, reserved, settled Record, committedAt string) (Record, error) {
	next := copyRecord(before)
	next["accountRevision"] = before["accountRevision"].(int64) + 1
	next["runRevision"] = before["runRevision"].(int64) + 1
	next["reserved"], next["settled"], next["updatedAt"] = reserved, settled, committedAt
	return ValidateAccount(next)
}

func EvaluateReserve(accountValue, requestValue, committedAtValue any) (ReserveEvaluation, error) {
	account, err := ValidateAccount(accountValue)
	if err != nil {
		return ReserveEvaluation{}, err
	}
	request, err := ValidateReserveRequest(requestValue)
	if err != nil {
		return ReserveEvaluation{}, err
	}
	committedAt, err := canonicalTimestamp(committedAtValue, "$/committedAt")
	if err != nil {
		return ReserveEvaluation{}, err
	}
	if err := assertBaseIdentity(account, request); err != nil {
		return ReserveEvaluation{}, err
	}
	if request["expectedAccountRevision"] != account["accountRevision"] || request["expectedRunRevision"] != account["runRevision"] {
		return ReserveEvaluation{}, failure(ErrorStaleRevision, "$/expectedAccountRevision", "Reserve revision is stale.")
	}
	current, limit, requested := quantitiesBig(account["reserved"].(Record)), quantitiesBig(account["limit"].(Record)), quantitiesBig(request["requested"].(Record))
	dimensions := []any{}
	if new(big.Int).Add(new(big.Int).Set(current.tokens), requested.tokens).Cmp(limit.tokens) > 0 {
		dimensions = append(dimensions, "tokens")
	}
	if new(big.Int).Add(new(big.Int).Set(current.nanoUSD), requested.nanoUSD).Cmp(limit.nanoUSD) > 0 {
		dimensions = append(dimensions, "nano_usd")
	}
	if new(big.Int).Add(new(big.Int).Set(current.calls), requested.calls).Cmp(limit.calls) > 0 {
		dimensions = append(dimensions, "calls")
	}
	nextReserved := account["reserved"].(Record)
	if len(dimensions) == 0 {
		nextReserved, err = makeQuantities(new(big.Int).Add(current.tokens, requested.tokens), new(big.Int).Add(current.nanoUSD, requested.nanoUSD), new(big.Int).Add(current.calls, requested.calls))
		if err != nil {
			return ReserveEvaluation{}, err
		}
	}
	after, err := nextAccount(account, nextReserved, account["settled"].(Record), committedAt)
	if err != nil {
		return ReserveEvaluation{}, err
	}
	requestHash, _ := hashValue("reserve-request", request)
	beforeHash, _ := hashValue("account", account)
	status := "reserved"
	authorization := request["requested"].(Record)
	if len(dimensions) != 0 {
		status = "rejected"
		authorization = zeroQuantities()
	}
	decisionValue := copyRecord(authorityEnvelope())
	for key, value := range (Record{"schema": SchemaReserveDecision, "status": status, "request": request, "requestHash": requestHash, "beforeAccountHash": beforeHash, "afterAccount": after, "authorization": authorization, "insufficientDimensions": dimensions, "legacyBudgetApprovalAuthority": false, "decidedAt": committedAt}) {
		decisionValue[key] = value
	}
	decision, err := ValidateReserveDecision(decisionValue)
	if err != nil {
		return ReserveEvaluation{}, err
	}
	var reservation Record
	if status == "reserved" {
		decisionHash, _ := hashValue("reserve-decision", decision)
		reservationValue := copyRecord(authorityEnvelope())
		for key, value := range (Record{"schema": SchemaReservation, "workspaceId": request["workspaceId"], "runId": request["runId"], "accountId": request["accountId"], "reservationId": request["reservationId"], "callId": request["callId"], "providerAttempt": request["providerAttempt"], "expectedProviderHash": request["expectedProviderHash"], "expectedModelHash": request["expectedModelHash"], "expectedProviderRunHash": request["expectedProviderRunHash"], "policyHash": request["policyHash"], "route": request["route"], "rateNanoUsdPerToken": request["rateNanoUsdPerToken"], "reserved": request["requested"], "reserveDecisionHash": decisionHash, "openedAccountRevision": after["accountRevision"], "openedRunRevision": after["runRevision"], "openedAt": committedAt}) {
			reservationValue[key] = value
		}
		reservation, err = ValidateReservation(reservationValue)
		if err != nil {
			return ReserveEvaluation{}, err
		}
	}
	kind := "reserve_reserved"
	encumbered := request["requested"].(Record)
	if status == "rejected" {
		kind = "reserve_rejected"
		encumbered = zeroQuantities()
	}
	ledger, err := createLedgerEntry(kind, account, after, request["reservationId"].(string), request["callId"].(string), decision, encumbered, zeroQuantities(), zeroQuantities(), nil, nil, committedAt)
	if err != nil {
		return ReserveEvaluation{}, err
	}
	return ReserveEvaluation{Decision: decision, Reservation: reservation, LedgerEntry: ledger}, nil
}

func EvaluateSettlement(accountValue, reservationValue, requestValue, committedAtValue any) (SettlementEvaluation, error) {
	account, err := ValidateAccount(accountValue)
	if err != nil {
		return SettlementEvaluation{}, err
	}
	reservation, err := ValidateReservation(reservationValue)
	if err != nil {
		return SettlementEvaluation{}, err
	}
	request, err := ValidateSettlementRequest(requestValue)
	if err != nil {
		return SettlementEvaluation{}, err
	}
	committedAt, err := canonicalTimestamp(committedAtValue, "$/committedAt")
	if err != nil {
		return SettlementEvaluation{}, err
	}
	if err := assertBaseIdentity(account, request); err != nil {
		return SettlementEvaluation{}, err
	}
	if err := assertBaseIdentity(account, reservation); err != nil {
		return SettlementEvaluation{}, err
	}
	if err := assertReservationBinding(reservation, request); err != nil {
		return SettlementEvaluation{}, err
	}
	if request["expectedAccountRevision"] != account["accountRevision"] || request["expectedRunRevision"] != account["runRevision"] {
		return SettlementEvaluation{}, failure(ErrorStaleRevision, "$/expectedAccountRevision", "Settlement revision is stale.")
	}
	beforeReserved, reservedAmount := quantitiesBig(account["reserved"].(Record)), quantitiesBig(reservation["reserved"].(Record))
	if beforeReserved.tokens.Cmp(reservedAmount.tokens) < 0 || beforeReserved.nanoUSD.Cmp(reservedAmount.nanoUSD) < 0 || beforeReserved.calls.Cmp(reservedAmount.calls) < 0 {
		return SettlementEvaluation{}, failure(ErrorIdentityMismatch, "$/reservation/reserved", "Reservation is not encumbered.")
	}
	var actual *quantityValues
	usage, _ := request["providerUsage"].(Record)
	if request["usageEvidenceStatus"] == "trusted" && usage != nil && usage["status"] == "reported" {
		charge, chargeErr := ChargeNanoUSD(usage["totalTokens"], request["rateNanoUsdPerToken"])
		if chargeErr != nil {
			return SettlementEvaluation{}, chargeErr
		}
		values := quantityValues{decimalBig(usage["totalTokens"]), decimalBig(charge), decimalBig(usage["calls"])}
		actual = &values
	}
	overrun := actual != nil && (actual.tokens.Cmp(reservedAmount.tokens) > 0 || actual.nanoUSD.Cmp(reservedAmount.nanoUSD) > 0 || actual.calls.Cmp(reservedAmount.calls) > 0)
	var reason any
	switch {
	case request["usageEvidenceStatus"] == "missing":
		reason = "usage_receipt_missing"
	case request["usageEvidenceStatus"] == "untrusted":
		reason = "usage_receipt_untrusted"
	case usage != nil && usage["status"] == "unreported":
		reason = "provider_outcome_unknown"
	case overrun:
		reason = "usage_overrun"
	}
	settled := reason == nil
	nextReserved, nextSettled := account["reserved"].(Record), account["settled"].(Record)
	var released Record
	if settled {
		nextReserved, err = makeQuantities(new(big.Int).Add(new(big.Int).Sub(beforeReserved.tokens, reservedAmount.tokens), actual.tokens), new(big.Int).Add(new(big.Int).Sub(beforeReserved.nanoUSD, reservedAmount.nanoUSD), actual.nanoUSD), new(big.Int).Add(new(big.Int).Sub(beforeReserved.calls, reservedAmount.calls), actual.calls))
		if err != nil {
			return SettlementEvaluation{}, err
		}
		beforeSettled := quantitiesBig(account["settled"].(Record))
		nextSettled, err = makeQuantities(new(big.Int).Add(beforeSettled.tokens, actual.tokens), new(big.Int).Add(beforeSettled.nanoUSD, actual.nanoUSD), new(big.Int).Add(beforeSettled.calls, actual.calls))
		if err != nil {
			return SettlementEvaluation{}, err
		}
		released, err = makeQuantities(new(big.Int).Sub(reservedAmount.tokens, actual.tokens), new(big.Int).Sub(reservedAmount.nanoUSD, actual.nanoUSD), new(big.Int).Sub(reservedAmount.calls, actual.calls))
		if err != nil {
			return SettlementEvaluation{}, err
		}
	}
	after, err := nextAccount(account, nextReserved, nextSettled, committedAt)
	if err != nil {
		return SettlementEvaluation{}, err
	}
	requestHash, _ := hashValue("settlement-request", request)
	reservationHash, _ := hashValue("reservation", reservation)
	beforeHash, _ := hashValue("account", account)
	status := "reconciliation_required"
	if settled {
		status = "settled"
	}
	cachePublishAuthorized := settled && usage != nil && usage["outcome"] == "provider_response_accepted"
	settlementValue := copyRecord(authorityEnvelope())
	for key, value := range (Record{"schema": SchemaSettlement, "status": status, "request": request, "requestHash": requestHash, "reservation": reservation, "reservationHash": reservationHash, "beforeAccountHash": beforeHash, "afterAccount": after, "released": nil, "reasonCode": reason, "reservationRemainsOpen": !settled, "runReconciliationLatched": !settled, "providerRetryAuthorized": false, "cachePublishAuthorized": cachePublishAuthorized, "legacyBudgetApprovalAuthority": false, "committedAt": committedAt}) {
		settlementValue[key] = value
	}
	if released != nil {
		settlementValue["released"] = released
	}
	settlementRecord, err := ValidateSettlement(settlementValue)
	if err != nil {
		return SettlementEvaluation{}, err
	}
	kind := "settlement_reconciliation_required"
	settledAmount, releasedAmount := zeroQuantities(), zeroQuantities()
	if settled {
		kind = "settlement_settled"
		settledAmount, _ = makeQuantities(actual.tokens, actual.nanoUSD, actual.calls)
		releasedAmount = released
	}
	ledger, err := createLedgerEntry(kind, account, after, reservation["reservationId"].(string), reservation["callId"].(string), settlementRecord, zeroQuantities(), settledAmount, releasedAmount, request["usageReceiptHash"], reason, committedAt)
	if err != nil {
		return SettlementEvaluation{}, err
	}
	var reconciliation Record
	if !settled {
		tokenHash, _ := hashValue("provider-reconciliation-token", Record{"reasonCode": reason, "requestHash": requestHash, "usageReceiptHash": request["usageReceiptHash"]})
		accountHash, _ := hashValue("account", after)
		value := copyRecord(authorityEnvelope())
		for key, entry := range (Record{"schema": SchemaReconciliation, "evidenceType": "provider_outcome", "reasonCode": reason, "workspaceId": account["workspaceId"], "runId": account["runId"], "accountId": account["accountId"], "reservationId": reservation["reservationId"], "callId": reservation["callId"], "sourceRequestHash": requestHash, "usageReceiptHash": request["usageReceiptHash"], "accountHash": accountHash, "reservationHash": reservationHash, "reconciliationToken": "WFBUDGETRECON-" + tokenHash, "accountCountersChanged": false, "reservationReleaseAuthorized": false, "providerRetryAuthorized": false, "cachePublishAuthorized": false, "runReconciliationLatched": true, "observedAt": committedAt}) {
			value[key] = entry
		}
		reconciliation, err = ValidateReconciliation(value)
		if err != nil {
			return SettlementEvaluation{}, err
		}
	}
	return SettlementEvaluation{Settlement: settlementRecord, LedgerEntry: ledger, Reconciliation: reconciliation}, nil
}

func createLedgerEntry(kind string, before, after Record, reservationID, callID string, decision Record, encumbered, settled, released Record, usageHash, reason any, recordedAt string) (Record, error) {
	domain := "settlement"
	if decision["schema"] == SchemaReserveDecision {
		domain = "reserve-decision"
	}
	decisionHash, _ := hashValue(domain, decision)
	previousHash, _ := hashValue("account", before)
	accountHash, _ := hashValue("account", after)
	entryIDHash, _ := hashValue("ledger-entry-id", Record{"accountId": after["accountId"], "accountRevision": after["accountRevision"], "decisionHash": decisionHash, "kind": kind, "reservationId": reservationID})
	value := copyRecord(authorityEnvelope())
	for key, entry := range (Record{"schema": SchemaLedgerEntry, "kind": kind, "entryId": "WFBUDGETLEDGER-" + entryIDHash, "workspaceId": after["workspaceId"], "runId": after["runId"], "accountId": after["accountId"], "reservationId": reservationID, "callId": callID, "accountRevision": after["accountRevision"], "runRevision": after["runRevision"], "previousAccountHash": previousHash, "accountHash": accountHash, "decisionHash": decisionHash, "encumbered": encumbered, "settled": settled, "released": released, "providerUsageHash": usageHash, "reasonCode": reason, "recordedAt": recordedAt}) {
		value[key] = entry
	}
	return ValidateLedgerEntry(value)
}
