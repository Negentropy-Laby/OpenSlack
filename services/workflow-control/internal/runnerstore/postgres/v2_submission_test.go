package postgres

import (
	"bytes"
	"fmt"
	"strings"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/runnerstore"
)

type fixedV2ReceiptRow struct{ values []any }

func (row fixedV2ReceiptRow) Scan(destinations ...any) error {
	if len(destinations) != len(row.values) {
		return fmt.Errorf("destination count %d, want %d", len(destinations), len(row.values))
	}
	for index, destination := range destinations {
		switch target := destination.(type) {
		case *[]byte:
			*target = append([]byte(nil), row.values[index].([]byte)...)
		case *string:
			*target = row.values[index].(string)
		case **string:
			if row.values[index] == nil {
				*target = nil
			} else {
				value := row.values[index].(string)
				*target = &value
			}
		default:
			return fmt.Errorf("unsupported destination %T", destination)
		}
	}
	return nil
}

func TestReadV2JobReceiptRejectsCanonicalCrossSplice(t *testing.T) {
	input := v2JobInput(t, "receipt-binding", "ts-local", "typescript")
	receipt := runnerstore.V2JobReceipt{
		Schema: runnerstore.V2JobReceiptSchema, Status: runnerstore.ReceiptAccepted,
		WorkspaceID: input.Prepared.Spec.WorkspaceID, JobID: input.Prepared.Spec.JobID,
		WorkflowRunID: input.Prepared.Spec.WorkflowRunID, State: runnerstore.JobQueued, Revision: 1,
		JobSpecHash: input.Prepared.JobSpecHash, IdempotencyKey: input.IdempotencyKey,
		RequestFingerprint: input.RequestFingerprint, CommittedAt: "2026-08-15T00:00:00.000Z",
	}
	body, err := canonicaljson.Encode(receipt)
	if err != nil {
		t.Fatal(err)
	}
	body = append(body, '\n')
	fingerprint, err := decodeFingerprint(input.RequestFingerprint)
	if err != nil {
		t.Fatal(err)
	}
	rowValues := []any{fingerprint, body, receipt.WorkspaceID, receipt.JobID, receipt.IdempotencyKey,
		receipt.JobSpecHash, receipt.WorkflowRunID, string(receipt.Status), nil}
	read, storedFingerprint, err := readV2JobReceipt(fixedV2ReceiptRow{values: rowValues})
	if err != nil || !bytes.Equal(storedFingerprint, fingerprint) || !read.Replay || !bytes.Equal(read.ExactBytes, body) {
		t.Fatalf("valid stored receipt rejected: %+v %x %v", read, storedFingerprint, err)
	}
	for name, mutate := range map[string]func([]any){
		"workspace":       func(values []any) { values[2] = "workspace.splice" },
		"job":             func(values []any) { values[3] = "job.splice" },
		"idempotency key": func(values []any) { values[4] = runnerstore.V2JobKeyPrefix + strings.Repeat("f", 64) },
		"job spec hash":   func(values []any) { values[5] = strings.Repeat("f", 64) },
		"workflow run":    func(values []any) { values[6] = "run.splice" },
		"status":          func(values []any) { values[7] = string(runnerstore.ReceiptReconciliationRequired) },
		"reconciliation":  func(values []any) { values[8] = "reconciliation.splice" },
	} {
		t.Run(name, func(t *testing.T) {
			values := append([]any(nil), rowValues...)
			mutate(values)
			if _, _, err := readV2JobReceipt(fixedV2ReceiptRow{values: values}); !runnerstore.IsCode(err, runnerstore.ErrorHashMismatch) {
				t.Fatalf("cross-spliced durable binding accepted: %v", err)
			}
		})
	}
}
