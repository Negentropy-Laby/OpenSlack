package runnerbindingcontract

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
)

const (
	RuntimeAdmissionSchema            = "openslack.workflow_runner_v2_runtime_admission.v1"
	RuntimeAdmissionReceiptSchema     = "openslack.workflow_runner_v2_runtime_admission_receipt.v1"
	RuntimeAdmissionKeyPrefix         = "openslack.workflow-runner-v2-runtime-admission.v1."
	RuntimeAdmissionIDDomain          = "openslack.workflow-runner-v2-runtime-admission.idempotency.v1\x00"
	RuntimeAdmissionFingerprintDomain = "openslack.workflow-runner-v2-runtime-admission.fingerprint.v1\x00"
)

var runtimeAdmissionFields = []string{
	"schema", "workspaceId", "jobId", "workflowRunId", "attemptId", "leaseId",
	"fencingToken", "jobSpecHash", "disposition",
}

var runtimeAdmissionReceiptFields = []string{
	"schema", "status", "workspaceId", "jobId", "workflowRunId", "attemptId", "leaseId",
	"fencingToken", "jobSpecHash", "disposition", "idempotencyKey", "requestFingerprint", "committedAt",
}

type PreparedRuntimeAdmission struct {
	Value              Record
	ExactBytes         []byte
	IdempotencyKey     string
	RequestFingerprint string
}

func ValidateRuntimeAdmission(value any) (Record, error) {
	record, err := closedRecord(value, runtimeAdmissionFields, "$")
	if err != nil {
		return nil, err
	}
	result := Record{"schema": RuntimeAdmissionSchema}
	if record["schema"] != RuntimeAdmissionSchema {
		return nil, failure(ErrorInvalid, "$/schema", "Runtime admission schema is invalid.")
	}
	for _, field := range []string{"workspaceId", "jobId", "workflowRunId", "attemptId", "leaseId"} {
		result[field], err = identifier(record[field], "$/"+field)
		if err != nil {
			return nil, err
		}
	}
	result["fencingToken"], err = integerValue(record["fencingToken"], "$/fencingToken", 1)
	if err != nil {
		return nil, err
	}
	result["jobSpecHash"], err = hashValue(record["jobSpecHash"], "$/jobSpecHash")
	if err != nil {
		return nil, err
	}
	disposition, ok := record["disposition"].(string)
	if !ok || disposition != "initial" && disposition != "resume" {
		return nil, failure(ErrorInvalid, "$/disposition", "Runtime admission disposition is invalid.")
	}
	result["disposition"] = disposition
	return result, nil
}

func PrepareRuntimeAdmission(value any) (PreparedRuntimeAdmission, error) {
	validated, err := ValidateRuntimeAdmission(value)
	if err != nil {
		return PreparedRuntimeAdmission{}, err
	}
	body, err := canonicalLF(validated)
	if err != nil {
		return PreparedRuntimeAdmission{}, err
	}
	keyHash := sha256.Sum256(append([]byte(RuntimeAdmissionIDDomain), body...))
	fingerprintHash := sha256.Sum256(append([]byte(RuntimeAdmissionFingerprintDomain), body...))
	return PreparedRuntimeAdmission{
		Value: validated, ExactBytes: body,
		IdempotencyKey:     RuntimeAdmissionKeyPrefix + hex.EncodeToString(keyHash[:]),
		RequestFingerprint: "sha256:" + hex.EncodeToString(fingerprintHash[:]),
	}, nil
}

func ParseRuntimeAdmissionBytes(input []byte) (PreparedRuntimeAdmission, error) {
	if len(input) < 2 || len(input) > MaxReceiptBytes || !hasExactlyOneLF(input) {
		return PreparedRuntimeAdmission{}, failure(ErrorInvalid, "$", "Runtime admission framing is invalid.")
	}
	parsed, err := parseStrictJSON(input[:len(input)-1], MaxReceiptBytes, MaxJSONDepth, MaxJSONNodes, MaxStringBytes, MaxSafeInteger)
	if err != nil {
		return PreparedRuntimeAdmission{}, failure(ErrorInvalid, "$", "Runtime admission JSON is invalid.")
	}
	prepared, err := PrepareRuntimeAdmission(parsed)
	if err != nil {
		return PreparedRuntimeAdmission{}, err
	}
	if !bytes.Equal(prepared.ExactBytes, input) {
		return PreparedRuntimeAdmission{}, failure(ErrorHashMismatch, "$", "Runtime admission is not exact canonical LF bytes.")
	}
	return prepared, nil
}

func ValidateRuntimeAdmissionReceipt(value any, prepared PreparedRuntimeAdmission) (Record, error) {
	record, err := closedRecord(value, runtimeAdmissionReceiptFields, "$")
	if err != nil {
		return nil, err
	}
	result := Record{"schema": RuntimeAdmissionReceiptSchema, "status": "accepted"}
	if record["schema"] != RuntimeAdmissionReceiptSchema || record["status"] != "accepted" {
		return nil, failure(ErrorInvalid, "$", "Runtime admission receipt identity is invalid.")
	}
	for _, field := range runtimeAdmissionFields[1:] {
		if record[field] != prepared.Value[field] {
			return nil, failure(ErrorIdentityMismatch, "$/"+field, "Runtime admission receipt is cross-spliced.")
		}
		result[field] = prepared.Value[field]
	}
	if record["idempotencyKey"] != prepared.IdempotencyKey || record["requestFingerprint"] != prepared.RequestFingerprint {
		return nil, failure(ErrorIdentityMismatch, "$/idempotencyKey", "Runtime admission receipt request identity is invalid.")
	}
	result["idempotencyKey"] = prepared.IdempotencyKey
	result["requestFingerprint"] = prepared.RequestFingerprint
	result["committedAt"], err = timestampValue(record["committedAt"], "$/committedAt")
	if err != nil {
		return nil, err
	}
	return result, nil
}

func ParseRuntimeAdmissionReceiptBytes(input []byte, prepared PreparedRuntimeAdmission) (Record, error) {
	if len(input) < 2 || len(input) > MaxReceiptBytes || !hasExactlyOneLF(input) {
		return nil, failure(ErrorInvalid, "$", "Runtime admission receipt framing is invalid.")
	}
	parsed, err := parseStrictJSON(input[:len(input)-1], MaxReceiptBytes, MaxJSONDepth, MaxJSONNodes, MaxStringBytes, MaxSafeInteger)
	if err != nil {
		return nil, failure(ErrorInvalid, "$", "Runtime admission receipt JSON is invalid.")
	}
	receipt, err := ValidateRuntimeAdmissionReceipt(parsed, prepared)
	if err != nil {
		return nil, err
	}
	canonical, err := canonicalLF(receipt)
	if err != nil || !bytes.Equal(canonical, input) {
		return nil, failure(ErrorHashMismatch, "$", "Runtime admission receipt is not exact canonical LF bytes.")
	}
	return receipt, nil
}
