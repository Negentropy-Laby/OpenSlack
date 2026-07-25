package postgres

import (
	"errors"
	"testing"

	"github.com/jackc/pgx/v5"

	"rc_wsman/internal/notificationstore"
)

func TestNormalizePageLimitDefaultAndBounds(t *testing.T) {
	for input, want := range map[int]int{0: notificationstore.ListPageDefault, 1: 1, notificationstore.ListPageMax: notificationstore.ListPageMax} {
		got, err := normalizePageLimit(input)
		if err != nil || got != want {
			t.Fatalf("limit %d: got %d, %v", input, got, err)
		}
	}
	for _, input := range []int{-1, notificationstore.ListPageMax + 1} {
		if _, err := normalizePageLimit(input); !notificationstore.IsRejection(err, notificationstore.RejectionInvalidPageLimit) {
			t.Fatalf("limit %d: %v", input, err)
		}
	}
}

func TestCommitFailureTaxonomy(t *testing.T) {
	if err := commitFailure(pgx.ErrTxCommitRollback); !notificationstore.IsRejection(err, notificationstore.RejectionCommitRolledBack) {
		t.Fatalf("rollback: %v", err)
	}
	if err := commitFailure(errors.New("network lost")); !notificationstore.IsRejection(err, notificationstore.RejectionCommitOutcomeUnknown) {
		t.Fatalf("unknown: %v", err)
	}
}
