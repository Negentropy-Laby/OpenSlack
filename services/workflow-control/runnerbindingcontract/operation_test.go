package runnerbindingcontract

import (
	"errors"
	"testing"
)

func TestRunnerHeadDeltaMatrix(t *testing.T) {
	t.Parallel()

	tests := []struct {
		operation  Operation
		revision   int64
		generation int64
	}{
		{OperationCheckpointCommit, 1, 0},
		{OperationEffectAuthorize, 1, 0},
		{OperationEffectComplete, 0, 0},
		{OperationBudgetReserve, 1, 0},
		{OperationBudgetSettle, 1, 0},
		{OperationResumeAdvance, 1, 1},
	}
	for _, test := range tests {
		test := test
		t.Run(string(test.operation), func(t *testing.T) {
			t.Parallel()
			delta, err := RunnerHeadDelta(test.operation)
			if err != nil {
				t.Fatalf("RunnerHeadDelta: %v", err)
			}
			if delta.Revision != test.revision || delta.Generation != test.generation {
				t.Fatalf("unexpected delta: %+v", delta)
			}

			head := Record{
				"expectedGlobalRunRevision": int64(41),
				"acceptedGlobalRunRevision": int64(41) + test.revision,
				"expectedResumeGeneration":  int64(7),
				"acceptedResumeGeneration":  int64(7) + test.generation,
			}
			if _, err := validateRunnerHead(head, test.operation, "$/runnerAuthority"); err != nil {
				t.Fatalf("valid matrix head rejected: %v", err)
			}

			wrongRevision := cloneRecord(head)
			wrongRevision["acceptedGlobalRunRevision"] = int64(41) + (1 - test.revision)
			assertContractCode(t, validateRunnerHeadError(wrongRevision, test.operation), ErrorRevisionConflict)

			wrongGeneration := cloneRecord(head)
			wrongGeneration["acceptedResumeGeneration"] = int64(7) + (1 - test.generation)
			assertContractCode(t, validateRunnerHeadError(wrongGeneration, test.operation), ErrorResumeGenerationConflict)
		})
	}
}

func TestSourceAuthorityRevisionIsNotCoordinatorHead(t *testing.T) {
	t.Parallel()

	for _, operation := range []Operation{
		OperationCheckpointCommit,
		OperationEffectAuthorize,
		OperationEffectComplete,
		OperationResumeAdvance,
	} {
		operation := operation
		t.Run(string(operation), func(t *testing.T) {
			t.Parallel()
			expectedGeneration := int64(7)
			acceptedGeneration := expectedGeneration
			if operation == OperationResumeAdvance {
				acceptedGeneration++
			}
			source := committedSourceRecord(operation, 100, expectedGeneration, acceptedGeneration)
			if _, err := validateSourceAuthority(source, operation, "$/evidence/sourceAuthority"); err != nil {
				t.Fatalf("valid independent source head rejected: %v", err)
			}
			wrongSchema := cloneRecord(source)
			wrongSchema["receiptSchema"] = "openslack.workflow_runner_wrong_authority_receipt.v1"
			assertContractCode(t, validateSourceAuthorityError(wrongSchema, operation), ErrorAuthorityPlaneMismatch)

			// A coordinator/global delta substituted into the source-authority
			// revision is invalid for effect_complete, whose coordinator delta is
			// zero but whose committed source delta is always exactly one.
			if operation == OperationEffectComplete {
				swapped := cloneRecord(source)
				swapped["acceptedRevision"] = swapped["expectedRevision"]
				assertContractCode(t, validateSourceAuthorityError(swapped, operation), ErrorRevisionConflict)
			}

			wrong := cloneRecord(source)
			wrong["acceptedRevision"] = source["expectedRevision"].(int64) + 2
			want := ErrorRevisionConflict
			if operation == OperationResumeAdvance {
				want = ErrorResumeGenerationConflict
			}
			assertContractCode(t, validateSourceAuthorityError(wrong, operation), want)
		})
	}
}

func TestPreparedBudgetSourceReceiptSchemaMustBeNull(t *testing.T) {
	t.Parallel()
	for _, operation := range []Operation{OperationBudgetReserve, OperationBudgetSettle} {
		source := Record{
			"plane":                    "budget_account",
			"evidenceState":            "prepared",
			"expectedRevision":         int64(10),
			"acceptedRevision":         nil,
			"expectedResumeGeneration": int64(3),
			"acceptedResumeGeneration": int64(3),
			"requestHash":              sixtyFour("1"),
			"receiptSchema":            nil,
			"receiptHash":              nil,
			"recordHash":               nil,
			"authorityBuildHash":       sixtyFour("2"),
		}
		if _, err := validateSourceAuthority(source, operation, "$/evidence/sourceAuthority"); err != nil {
			t.Fatalf("%s valid prepared source rejected: %v", operation, err)
		}
	}
}

func TestMissingProviderUsageHashDomain(t *testing.T) {
	t.Parallel()
	got, err := MissingProviderUsageHash(sixtyFour("a"))
	if err != nil {
		t.Fatal(err)
	}
	if got != "sha256:8f7d78fd932810d4ddc7fc6f6d87b4de05221a52294f4e79629be0ce86e0e2ed" {
		t.Fatalf("missing-provider hash drifted: %s", got)
	}
}

func validateRunnerHeadError(value Record, operation Operation) error {
	_, err := validateRunnerHead(value, operation, "$/runnerAuthority")
	return err
}

func validateSourceAuthorityError(value Record, operation Operation) error {
	_, err := validateSourceAuthority(value, operation, "$/evidence/sourceAuthority")
	return err
}

func committedSourceRecord(operation Operation, revision, expectedGeneration, acceptedGeneration int64) Record {
	plane := "effect_v2_sibling"
	if operation == OperationCheckpointCommit {
		plane = "checkpoint_control"
	} else if operation == OperationResumeAdvance {
		plane = "resume_control"
	}
	return Record{
		"plane":                    plane,
		"evidenceState":            "committed",
		"expectedRevision":         revision,
		"acceptedRevision":         revision + 1,
		"expectedResumeGeneration": expectedGeneration,
		"acceptedResumeGeneration": acceptedGeneration,
		"requestHash":              sixtyFour("1"),
		"receiptSchema":            sourceReceiptSchemaForTest(operation),
		"receiptHash":              sixtyFour("2"),
		"recordHash":               sixtyFour("3"),
		"authorityBuildHash":       sixtyFour("4"),
	}
}

func sourceReceiptSchemaForTest(operation Operation) string {
	schema, err := SourceReceiptSchema(operation)
	if err != nil || schema == nil {
		panic("committed operation has no source receipt schema")
	}
	return *schema
}

func cloneRecord(value Record) Record {
	result := make(Record, len(value))
	for key, entry := range value {
		result[key] = entry
	}
	return result
}

func sixtyFour(character string) string {
	value := ""
	for range 64 {
		value += character
	}
	return value
}

func assertContractCode(t *testing.T, err error, want ErrorCode) {
	t.Helper()
	var contractErr *ContractError
	if !errors.As(err, &contractErr) {
		t.Fatalf("expected ContractError, got %v", err)
	}
	if contractErr.Code != want {
		t.Fatalf("code = %s, want %s (error: %v)", contractErr.Code, want, err)
	}
}
