package postgres

import (
	"bytes"
	"context"
	"strings"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetstore"
)

func TestBudgetStoreExactReplayPrecedesActiveBuildAndPolicyChecks(t *testing.T) {
	for _, test := range []struct {
		name  string
		drift func(*budgetstore.MutationInput)
	}{
		{name: "qualification policy", drift: func(input *budgetstore.MutationInput) {
			input.Seed.PolicyHash = strings.Repeat("9", 64)
		}},
		{name: "authority build", drift: func(input *budgetstore.MutationInput) {
			input.ServiceBuildHash = strings.Repeat("9", 64)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			pool := openBudgetPostgres(t)
			seedRun(t, pool, 4)
			repository := New(pool)
			input := reserveInput(t, testSeed, 0, 4, "1", "100")
			first, err := repository.Reserve(context.Background(), input)
			if err != nil {
				t.Fatal(err)
			}
			test.drift(&input)
			replay, err := repository.Reserve(context.Background(), input)
			if err != nil || !replay.Replay || replay.ReceiptID != first.ReceiptID ||
				!bytes.Equal(replay.ExactReceiptBytes, first.ExactReceiptBytes) || !bytes.Equal(replay.ExactResponseBytes, first.ExactResponseBytes) {
				t.Fatalf("configuration drift changed exact replay: first=%#v replay=%#v err=%v", first, replay, err)
			}
			statistics, err := repository.Statistics(context.Background())
			if err != nil || statistics.LedgerEntries != 1 || statistics.Receipts != 1 {
				t.Fatalf("configuration-drift replay appended evidence: %#v err=%v", statistics, err)
			}
		})
	}
}

func TestBudgetStoreFreshPolicyDriftConflictsWithoutMutation(t *testing.T) {
	pool := openBudgetPostgres(t)
	seedRun(t, pool, 4)
	input := reserveInput(t, testSeed, 0, 4, "1", "100")
	input.Seed.PolicyHash = strings.Repeat("9", 64)
	if _, err := New(pool).Reserve(context.Background(), input); !budgetstore.IsCode(err, budgetstore.ErrorConflict) {
		t.Fatalf("fresh policy drift err=%v, want %s", err, budgetstore.ErrorConflict)
	}
	statistics, err := New(pool).Statistics(context.Background())
	if err != nil || statistics != (budgetstore.Statistics{}) {
		t.Fatalf("fresh policy drift mutated evidence: %#v err=%v", statistics, err)
	}
}
