package budgetstore

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
)

func EncodeMutationResponse(operation string, record *DurableRecord, receipt DurableRecord, reconciliation *DurableRecord) ([]byte, error) {
	value, err := ValidateMutationResponse(MutationResponse{
		Schema: MutationResponseSchema, Operation: operation, Record: record,
		Receipt: receipt, Reconciliation: reconciliation,
	})
	if err != nil {
		return nil, err
	}
	encoded, err := canonicaljson.Encode(mutationResponseData(value))
	if err != nil {
		return nil, Failure(ErrorContentInvalid, "encode budget mutation response", err)
	}
	encoded = append(encoded, '\n')
	if len(encoded) > MaxMutationResponseBytes {
		return nil, Failure(ErrorContentInvalid, "budget mutation response exceeds byte limit", nil)
	}
	return encoded, nil
}

func DecodeMutationResponse(contents []byte) (MutationResponse, error) {
	if len(contents) < 2 || len(contents) > MaxMutationResponseBytes || contents[len(contents)-1] != '\n' {
		return MutationResponse{}, Failure(ErrorIntegrity, "stored budget mutation response framing is invalid", nil)
	}
	decoder := json.NewDecoder(bytes.NewReader(contents[:len(contents)-1]))
	decoder.DisallowUnknownFields()
	decoder.UseNumber()
	var value MutationResponse
	if err := decoder.Decode(&value); err != nil {
		return MutationResponse{}, Failure(ErrorIntegrity, "stored budget mutation response is invalid", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return MutationResponse{}, Failure(ErrorIntegrity, "stored budget mutation response has trailing content", err)
	}
	validated, err := ValidateMutationResponse(value)
	if err != nil {
		return MutationResponse{}, Failure(ErrorIntegrity, "stored budget mutation response is invalid", err)
	}
	canonical, err := canonicaljson.Encode(mutationResponseData(validated))
	if err != nil || !bytes.Equal(append(canonical, '\n'), contents) {
		return MutationResponse{}, Failure(ErrorIntegrity, "stored budget mutation response is not canonical", err)
	}
	return validated, nil
}

func mutationResponseData(value MutationResponse) map[string]any {
	var record, reconciliation any
	if value.Record != nil {
		record = value.Record
	}
	if value.Reconciliation != nil {
		reconciliation = value.Reconciliation
	}
	return map[string]any{
		"schema": value.Schema, "operation": value.Operation, "record": record,
		"receipt": value.Receipt, "reconciliation": reconciliation,
	}
}

func ValidateMutationResponse(value MutationResponse) (MutationResponse, error) {
	if value.Schema != MutationResponseSchema || value.Operation != "reserve" && value.Operation != "settle" {
		return MutationResponse{}, Failure(ErrorContentInvalid, "budget mutation response schema or operation is invalid", nil)
	}
	receiptOuter, err := ValidateDurableRecord(value.Receipt)
	if err != nil || receiptOuter.RecordKind != RecordKindReceipt {
		return MutationResponse{}, Failure(ErrorContentInvalid, "budget mutation response receipt is invalid", err)
	}
	receipt := receiptOuter.OperationalProjection
	if receipt["operation"] != value.Operation {
		return MutationResponse{}, Failure(ErrorContentInvalid, "budget mutation response receipt operation is invalid", nil)
	}
	status, _ := receipt["status"].(string)
	var record budgetcontract.Record
	var recordOuter *DurableRecord
	if value.Record != nil {
		validated, validateErr := ValidateDurableRecord(*value.Record)
		wantKind := RecordKindSettlement
		if value.Operation == "reserve" {
			wantKind = RecordKindReserveDecision
		}
		if validateErr != nil || validated.RecordKind != wantKind || validated.AuthorityBuildHash != receiptOuter.AuthorityBuildHash {
			return MutationResponse{}, Failure(ErrorContentInvalid, "budget mutation response record is invalid", validateErr)
		}
		recordOuter, record = &validated, validated.OperationalProjection
	}
	var reconciliation budgetcontract.Record
	var reconciliationOuter *DurableRecord
	if value.Reconciliation != nil {
		validated, validateErr := ValidateDurableRecord(*value.Reconciliation)
		if validateErr != nil || validated.RecordKind != RecordKindReconciliation || validated.AuthorityBuildHash != receiptOuter.AuthorityBuildHash {
			return MutationResponse{}, Failure(ErrorContentInvalid, "budget mutation response reconciliation is invalid", validateErr)
		}
		reconciliationOuter, reconciliation = &validated, validated.OperationalProjection
	}
	switch status {
	case "accepted":
		if record == nil || reconciliation != nil {
			return MutationResponse{}, Failure(ErrorContentInvalid, "accepted budget response shape is invalid", nil)
		}
	case "provider_reconciliation_required":
		if value.Operation != "settle" || record == nil || reconciliation == nil || reconciliation["evidenceType"] != "provider_outcome" {
			return MutationResponse{}, Failure(ErrorContentInvalid, "provider reconciliation response shape is invalid", nil)
		}
	case "database_reconciliation_required":
		if record != nil || reconciliation == nil || reconciliation["evidenceType"] != "database_commit" {
			return MutationResponse{}, Failure(ErrorContentInvalid, "database reconciliation response shape is invalid", nil)
		}
	default:
		return MutationResponse{}, Failure(ErrorContentInvalid, fmt.Sprintf("unsupported budget receipt status %q", status), nil)
	}
	if record != nil {
		domain := "settlement"
		if value.Operation == "reserve" {
			domain = "reserve-decision"
		}
		recordHash, hashErr := budgetcontract.HashValue(domain, record)
		request := record["request"].(budgetcontract.Record)
		after := record["afterAccount"].(budgetcontract.Record)
		wantStatus := "accepted"
		if value.Operation == "settle" && record["status"] == "reconciliation_required" {
			wantStatus = "provider_reconciliation_required"
		}
		if hashErr != nil || receipt["recordHash"] != recordHash || receipt["status"] != wantStatus ||
			receipt["workspaceId"] != request["workspaceId"] || receipt["runId"] != request["runId"] || receipt["accountId"] != request["accountId"] ||
			receipt["reservationId"] != request["reservationId"] || receipt["callId"] != request["callId"] || receipt["correlationId"] != request["correlationId"] ||
			receipt["expectedAccountRevision"] != request["expectedAccountRevision"] || receipt["expectedRunRevision"] != request["expectedRunRevision"] ||
			receipt["acceptedAccountRevision"] != after["accountRevision"] || receipt["acceptedRunRevision"] != after["runRevision"] ||
			receipt["committedAt"] != after["updatedAt"] || receipt["serviceBuildHash"] != request["route"].(budgetcontract.Record)["authorityBuildHash"] {
			return MutationResponse{}, Failure(ErrorContentInvalid, "budget response receipt does not bind its record", hashErr)
		}
		if reconciliation != nil {
			requestHash, _ := budgetcontract.HashValue("settlement-request", request)
			accountHash, _ := budgetcontract.HashValue("account", after)
			reservationHash, _ := budgetcontract.HashValue("reservation", record["reservation"])
			if reconciliation["reconciliationToken"] != receipt["reconciliationToken"] || reconciliation["workspaceId"] != receipt["workspaceId"] ||
				reconciliation["runId"] != receipt["runId"] || reconciliation["accountId"] != receipt["accountId"] || reconciliation["reservationId"] != receipt["reservationId"] ||
				reconciliation["callId"] != receipt["callId"] || reconciliation["sourceRequestHash"] != requestHash || reconciliation["accountHash"] != accountHash ||
				reconciliation["reservationHash"] != reservationHash || reconciliation["observedAt"] != receipt["committedAt"] {
				return MutationResponse{}, Failure(ErrorContentInvalid, "provider reconciliation does not bind its response", nil)
			}
		}
	} else if reconciliation["reconciliationToken"] != receipt["reconciliationToken"] || reconciliation["workspaceId"] != receipt["workspaceId"] ||
		reconciliation["runId"] != receipt["runId"] || reconciliation["accountId"] != receipt["accountId"] || reconciliation["reservationId"] != receipt["reservationId"] ||
		reconciliation["callId"] != receipt["callId"] || reconciliation["sourceRequestHash"] != receipt["requestHash"] {
		return MutationResponse{}, Failure(ErrorContentInvalid, "database reconciliation does not bind its response", nil)
	}
	return MutationResponse{Schema: MutationResponseSchema, Operation: value.Operation, Record: recordOuter, Receipt: receiptOuter, Reconciliation: reconciliationOuter}, nil
}
