package postgres

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/authoritystore"
	authoritypostgres "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/authoritystore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/budgetstore"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/testsupport"
)

const (
	testWorkspace = "workspace-budget-test"
	testRun       = "run-budget-test"
	testAccount   = "account-budget-test"
	testBuild     = "8888888888888888888888888888888888888888888888888888888888888888"
	testPolicy    = "7777777777777777777777777777777777777777777777777777777777777777"
)

var testSeed = budgetstore.QualificationSeed{
	PolicyHash: testPolicy,
	Limit:      budgetstore.Quantities{Tokens: "1000", NanoUSD: "10000", Calls: "3"},
}

func TestBudgetStoreQualification(t *testing.T) {
	pool := openBudgetPostgres(t)
	seedRun(t, pool, 4)
	repository := New(pool)

	reserve := reserveInput(t, testSeed, 0, 4, "1", "600")
	first, err := repository.Reserve(context.Background(), reserve)
	if err != nil {
		t.Fatalf("reserve: %v", err)
	}
	replay, err := repository.Reserve(context.Background(), reserve)
	if err != nil {
		t.Fatalf("reserve replay: %v", err)
	}
	if first.Status != "reserved" || !replay.Replay || first.ReceiptID != replay.ReceiptID ||
		!bytes.Equal(first.ExactReceiptBytes, replay.ExactReceiptBytes) || !bytes.Equal(first.ExactResponseBytes, replay.ExactResponseBytes) {
		t.Fatalf("reserve exact replay drifted: first=%#v replay=%#v", first, replay)
	}
	account, err := repository.ReadAccount(context.Background(), testWorkspace, testRun)
	if err != nil || recordInt64(account.Value, "accountRevision") != 1 || recordInt64(account.Value, "runRevision") != 5 {
		t.Fatalf("account after reserve=%#v err=%v", account, err)
	}
	reservation, err := repository.ReadReservation(context.Background(), testWorkspace, testRun, "reservation-1")
	if err != nil || reservation.Status != "open" || reservation.TerminalLedgerEntryID != nil || reservation.ClosedAt != nil {
		t.Fatalf("open reservation=%#v err=%v", reservation, err)
	}
	receipt, err := repository.ReadReceipt(context.Background(), testWorkspace, reserve.Prepared.IdempotencyKey)
	if err != nil || !bytes.Equal(receipt.ExactResponseBytes, first.ExactResponseBytes) {
		t.Fatalf("reserve point read=%#v err=%v", receipt, err)
	}

	settle := settlementInput(t, testSeed, first, 1, 5, "trusted", "provider_response_accepted", "100")
	settled, err := repository.Settle(context.Background(), settle)
	if err != nil {
		t.Fatalf("settle: %v", err)
	}
	settleReplay, err := repository.Settle(context.Background(), settle)
	if err != nil || !settleReplay.Replay || !bytes.Equal(settled.ExactResponseBytes, settleReplay.ExactResponseBytes) {
		t.Fatalf("settle replay=%#v err=%v", settleReplay, err)
	}
	if settled.Status != "settled" || settled.Record["cachePublishAuthorized"] != true {
		t.Fatalf("settlement=%#v", settled.Record)
	}
	reservation, err = repository.ReadReservation(context.Background(), testWorkspace, testRun, "reservation-1")
	if err != nil || reservation.Status != "settled" || reservation.TerminalLedgerEntryID == nil || reservation.ClosedAt == nil {
		t.Fatalf("terminal reservation=%#v err=%v", reservation, err)
	}
	assertRunRecord(t, pool, 6, authoritycontract.RunRunning)
	var transitionEvents int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM workflow_control_transition_events WHERE workspace_id=$1 AND run_id=$2`, testWorkspace, testRun).Scan(&transitionEvents); err != nil || transitionEvents != 0 {
		t.Fatalf("budget fold invented authority transition evidence: count=%d err=%v", transitionEvents, err)
	}
	statistics, err := repository.Statistics(context.Background())
	if err != nil || statistics.Accounts != 1 || statistics.Reservations != 1 || statistics.OpenReservations != 0 || statistics.LedgerEntries != 2 || statistics.Receipts != 2 {
		t.Fatalf("statistics=%#v err=%v", statistics, err)
	}
}

func TestBudgetStoreRejectedReserveExactReplay(t *testing.T) {
	pool := openBudgetPostgres(t)
	seedRun(t, pool, 4)
	repository := New(pool)
	input := reserveInput(t, testSeed, 0, 4, "1", "1001")
	first, err := repository.Reserve(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := repository.Reserve(context.Background(), input)
	if err != nil || first.Status != "rejected" || !replay.Replay || !bytes.Equal(first.ExactResponseBytes, replay.ExactResponseBytes) {
		t.Fatalf("rejected replay first=%#v replay=%#v err=%v", first, replay, err)
	}
	if _, err := repository.ReadReservation(context.Background(), testWorkspace, testRun, "reservation-1"); !budgetstore.IsCode(err, budgetstore.ErrorNotFound) {
		t.Fatalf("rejected reserve created reservation: %v", err)
	}
	statistics, _ := repository.Statistics(context.Background())
	if statistics.LedgerEntries != 1 || statistics.Receipts != 1 {
		t.Fatalf("rejected reserve was not durable: %#v", statistics)
	}
}

func TestBudgetStorePreviousManifestReadReplayAndSettlement(t *testing.T) {
	pool := openBudgetPostgres(t)
	seedRun(t, pool, 4)
	repository := New(pool)
	ctx := context.Background()
	reserve := reserveInput(t, testSeed, 0, 4, "1", "600")
	first, err := repository.Reserve(ctx, reserve)
	if err != nil {
		t.Fatal(err)
	}
	// Seed a second isolated schema with the prior release's envelopes. Keep the
	// source rows immutable and every database constraint active during the import.
	var sourceSchema string
	if err := pool.QueryRow(ctx, "SELECT current_schema()").Scan(&sourceSchema); err != nil {
		t.Fatal(err)
	}
	upgradedPool := openBudgetPostgres(t)
	seedRun(t, upgradedPool, 5)
	for _, table := range []string{"workflow_control_budget_accounts", "workflow_control_budget_reservations", "workflow_control_budget_ledger", "workflow_control_budget_receipts"} {
		rows, err := pool.Query(ctx, `SELECT column_name FROM information_schema.columns WHERE table_schema=$1 AND table_name=$2 ORDER BY ordinal_position`, sourceSchema, table)
		if err != nil {
			t.Fatal(err)
		}
		var columns, projections []string
		for rows.Next() {
			var name string
			if err := rows.Scan(&name); err != nil {
				t.Fatal(err)
			}
			column := pgx.Identifier{name}.Sanitize()
			columns = append(columns, column)
			if strings.HasSuffix(name, "_bytes") {
				projections = append(projections, fmt.Sprintf("convert_to(replace(convert_from(%s,'UTF8'),$1,$2),'UTF8')", column))
			} else {
				projections = append(projections, column)
			}
		}
		rows.Close()
		if err := rows.Err(); err != nil {
			t.Fatal(err)
		}
		if len(columns) == 0 {
			t.Fatal("historical table is missing")
		}
		query := fmt.Sprintf("INSERT INTO %s (%s) SELECT %s FROM %s", pgx.Identifier{table}.Sanitize(), strings.Join(columns, ","), strings.Join(projections, ","), pgx.Identifier{sourceSchema, table}.Sanitize())
		if _, err := upgradedPool.Exec(ctx, query, budgetstore.ContractManifestSHA256, budgetcontract.PreviousManifestSHA256); err != nil {
			t.Fatal(err)
		}
	}
	repository = New(upgradedPool)
	previousResponse := bytes.ReplaceAll(first.ExactResponseBytes, []byte(budgetstore.ContractManifestSHA256), []byte(budgetcontract.PreviousManifestSHA256))
	previousReceipt := bytes.ReplaceAll(first.ExactReceiptBytes, []byte(budgetstore.ContractManifestSHA256), []byte(budgetcontract.PreviousManifestSHA256))
	account, err := repository.ReadAccount(ctx, testWorkspace, testRun)
	if err != nil || account.Durable.ContractManifestSHA256 != budgetcontract.PreviousManifestSHA256 {
		t.Fatalf("previous account read: %v", err)
	}
	if _, err := repository.RebuildAccount(ctx, testWorkspace, testRun); err != nil {
		t.Fatalf("previous ledger rebuild: %v", err)
	}
	if _, err := repository.ReadReservation(ctx, testWorkspace, testRun, "reservation-1"); err != nil {
		t.Fatal(err)
	}
	pointRead, err := repository.ReadReceipt(ctx, testWorkspace, reserve.Prepared.IdempotencyKey)
	if err != nil || !bytes.Equal(pointRead.ExactResponseBytes, previousResponse) || !bytes.Equal(pointRead.ExactReceiptBytes, previousReceipt) {
		t.Fatalf("previous point read rewrote bytes: %v", err)
	}
	replay, err := repository.Reserve(ctx, reserve)
	if err != nil || !replay.Replay || !bytes.Equal(replay.ExactResponseBytes, previousResponse) {
		t.Fatalf("previous exact replay: %v", err)
	}
	settle := settlementInput(t, testSeed, replay, 1, 5, "trusted", "provider_response_accepted", "100")
	settled, err := repository.Settle(ctx, settle)
	if err != nil || settled.Status != "settled" || settled.DurableReceipt.ContractManifestSHA256 != budgetstore.ContractManifestSHA256 {
		t.Fatalf("new settlement after old records: %v", err)
	}
	if _, err := repository.RebuildAccount(ctx, testWorkspace, testRun); err != nil {
		t.Fatalf("mixed manifest ledger rebuild: %v", err)
	}
	pointRead, err = repository.ReadReceipt(ctx, testWorkspace, reserve.Prepared.IdempotencyKey)
	if err != nil || !bytes.Equal(pointRead.ExactResponseBytes, previousResponse) {
		t.Fatalf("new write altered old receipt: %v", err)
	}
}

func TestBudgetStoreConcurrentNoOverspend(t *testing.T) {
	for _, test := range []struct {
		name             string
		limit            budgetstore.Quantities
		expectedRejected int
	}{
		{name: "tokens only", limit: budgetstore.Quantities{Tokens: "10", NanoUSD: "1000000", Calls: "3"}, expectedRejected: 2},
		{name: "nano usd only", limit: budgetstore.Quantities{Tokens: "100", NanoUSD: "100", Calls: "3"}, expectedRejected: 2},
		{name: "calls only", limit: budgetstore.Quantities{Tokens: "100", NanoUSD: "1000", Calls: "2"}, expectedRejected: 1},
		{name: "combined", limit: budgetstore.Quantities{Tokens: "10", NanoUSD: "100", Calls: "2"}, expectedRejected: 2},
	} {
		t.Run(test.name, func(t *testing.T) {
			pool := openBudgetPostgres(t)
			seed := budgetstore.QualificationSeed{PolicyHash: testPolicy, Limit: test.limit}
			seedRun(t, pool, 4)
			repository := New(pool)
			var wait sync.WaitGroup
			errorsSeen := make(chan error, 3)
			for index := 1; index <= 3; index++ {
				index := index
				wait.Add(1)
				go func() {
					defer wait.Done()
					for attempt := 0; attempt < 10; attempt++ {
						accountRevision, runRevision := int64(0), int64(4)
						if account, err := repository.ReadAccount(context.Background(), testWorkspace, testRun); err == nil {
							accountRevision, runRevision = recordInt64(account.Value, "accountRevision"), recordInt64(account.Value, "runRevision")
						} else if !budgetstore.IsCode(err, budgetstore.ErrorNotFound) {
							errorsSeen <- err
							return
						}
						input := reserveInput(t, seed, accountRevision, runRevision, strconv.Itoa(index), "6")
						if _, err := repository.Reserve(context.Background(), input); err == nil {
							return
						} else if !budgetstore.IsCode(err, budgetstore.ErrorConflict) && !budgetstore.IsCode(err, budgetstore.ErrorIdempotencyConflict) {
							errorsSeen <- err
							return
						}
					}
					errorsSeen <- errors.New("concurrent reserve did not converge")
				}()
			}
			wait.Wait()
			close(errorsSeen)
			for err := range errorsSeen {
				t.Fatal(err)
			}
			account, err := repository.ReadAccount(context.Background(), testWorkspace, testRun)
			if err != nil {
				t.Fatal(err)
			}
			reserved := account.Value["reserved"].(budgetcontract.Record)
			if decimalInt64(reserved["tokens"]) > decimalInt64(test.limit.Tokens) ||
				decimalInt64(reserved["nanoUsd"]) > decimalInt64(test.limit.NanoUSD) ||
				decimalInt64(reserved["calls"]) > decimalInt64(test.limit.Calls) {
				t.Fatalf("concurrent reserve overspent 3D limit: %#v", account.Value)
			}
			var decisions, rejected int
			if err := pool.QueryRow(context.Background(), `SELECT count(*), count(*) FILTER (WHERE kind='reserve_rejected') FROM workflow_control_budget_ledger`).Scan(&decisions, &rejected); err != nil || decisions != 3 || rejected != test.expectedRejected {
				t.Fatalf("decisions=%d rejected=%d err=%v", decisions, rejected, err)
			}
		})
	}
}

func TestBudgetStoreFingerprintAndSemanticConflicts(t *testing.T) {
	t.Run("same key fingerprint", func(t *testing.T) {
		pool := openBudgetPostgres(t)
		seedRun(t, pool, 4)
		repository := New(pool)
		input := reserveInput(t, testSeed, 0, 4, "1", "100")
		result, err := repository.Reserve(context.Background(), input)
		if err != nil {
			t.Fatal(err)
		}
		driftedReceipt := budgetcontract.Record{}
		for key, value := range result.Receipt {
			driftedReceipt[key] = value
		}
		driftedReceipt["requestFingerprint"] = "sha256:" + strings.Repeat("f", 64)
		driftedReceiptOuter, err := budgetstore.NewDurableRecord(budgetstore.RecordKindReceipt, driftedReceipt, testBuild)
		if err != nil {
			t.Fatal(err)
		}
		exactReceipt, err := budgetstore.EncodeDurableRecord(driftedReceiptOuter)
		if err != nil {
			t.Fatal(err)
		}
		exactResponse, err := budgetstore.EncodeMutationResponse("reserve", result.DurableRecord, driftedReceiptOuter, nil)
		if err != nil {
			t.Fatal(err)
		}
		tamper(t, pool,
			`ALTER TABLE workflow_control_budget_receipts DISABLE TRIGGER workflow_control_budget_receipts_immutable`,
			`UPDATE workflow_control_budget_receipts SET request_fingerprint=decode(repeat('ff',32),'hex'),exact_receipt_bytes=$2,exact_response_bytes=$3 WHERE idempotency_key=$1`,
			`ALTER TABLE workflow_control_budget_receipts ENABLE TRIGGER workflow_control_budget_receipts_immutable`, input.Prepared.IdempotencyKey, exactReceipt, exactResponse)
		if _, err := repository.Reserve(context.Background(), input); !budgetstore.IsCode(err, budgetstore.ErrorIdempotencyConflict) {
			t.Fatalf("fingerprint conflict=%v", err)
		}
	})
	t.Run("new key rejected semantic duplicate", func(t *testing.T) {
		pool := openBudgetPostgres(t)
		seedRun(t, pool, 4)
		repository := New(pool)
		first := reserveInput(t, testSeed, 0, 4, "1", "1001")
		if _, err := repository.Reserve(context.Background(), first); err != nil {
			t.Fatal(err)
		}
		second := reserveInput(t, testSeed, 1, 5, "1", "1001")
		request := decodePrepared(t, second.Prepared)
		request["correlationId"] = "correlation-semantic-duplicate"
		second.Prepared = prepare(t, "reserve", request)
		if _, err := repository.Reserve(context.Background(), second); !budgetstore.IsCode(err, budgetstore.ErrorConflict) {
			t.Fatalf("semantic duplicate=%v", err)
		}
	})
}

func TestBudgetStoreSuccessfulAndFailedUsageSettlement(t *testing.T) {
	for _, test := range []struct {
		name, outcome string
		cache         bool
	}{
		{name: "success", outcome: "provider_response_accepted", cache: true},
		{name: "failed attempt", outcome: "provider_attempt_failed", cache: false},
	} {
		t.Run(test.name, func(t *testing.T) {
			pool := openBudgetPostgres(t)
			seedRun(t, pool, 4)
			repository := New(pool)
			reserved, err := repository.Reserve(context.Background(), reserveInput(t, testSeed, 0, 4, "1", "600"))
			if err != nil {
				t.Fatal(err)
			}
			settled, err := repository.Settle(context.Background(), settlementInput(t, testSeed, reserved, 1, 5, "trusted", test.outcome, "100"))
			if err != nil || settled.Status != "settled" || settled.Record["cachePublishAuthorized"] != test.cache {
				t.Fatalf("settled=%#v err=%v", settled, err)
			}
		})
	}
}

func TestBudgetStoreCacheHitHasZeroMutation(t *testing.T) {
	pool := openBudgetPostgres(t)
	seedRun(t, pool, 4)
	repository := New(pool)
	before, _ := repository.Statistics(context.Background())
	if _, err := budgetcontract.PrepareRequest("cache", budgetcontract.Record{}, "qualification-caller"); err == nil {
		t.Fatal("closed E1 contract unexpectedly exposed a cache mutation operation")
	}
	after, _ := repository.Statistics(context.Background())
	if before != after {
		t.Fatalf("rejected cache operation mutated budget evidence: before=%#v after=%#v", before, after)
	}
}

func TestBudgetStoreRejectsNonzeroResumeGeneration(t *testing.T) {
	pool := openBudgetPostgres(t)
	seedRunWithGeneration(t, pool, 4, 1)
	if _, err := New(pool).Reserve(context.Background(), reserveInput(t, testSeed, 0, 4, "1", "100")); !budgetstore.IsCode(err, budgetstore.ErrorConflict) {
		t.Fatalf("non-zero resume generation entered the E2 qualification authority: %v", err)
	}
	statistics, err := New(pool).Statistics(context.Background())
	if err != nil || statistics != (budgetstore.Statistics{}) {
		t.Fatalf("resume-generation refusal mutated budget evidence: %#v err=%v", statistics, err)
	}
	assertRunRecord(t, pool, 4, authoritycontract.RunRunning)
}

func TestBudgetStoreRouteEpochAndBuildDriftConflictWithoutMutation(t *testing.T) {
	for _, test := range []struct {
		name   string
		mutate func(budgetcontract.Record, *budgetstore.MutationInput)
	}{
		{name: "routing epoch", mutate: func(request budgetcontract.Record, _ *budgetstore.MutationInput) {
			request["route"].(budgetcontract.Record)["routingEpoch"] = int64(2)
		}},
		{name: "build", mutate: func(request budgetcontract.Record, input *budgetstore.MutationInput) {
			request["route"].(budgetcontract.Record)["authorityBuildHash"] = strings.Repeat("9", 64)
			input.ServiceBuildHash = strings.Repeat("9", 64)
		}},
	} {
		t.Run(test.name, func(t *testing.T) {
			pool := openBudgetPostgres(t)
			seedRun(t, pool, 4)
			input := reserveInput(t, testSeed, 0, 4, "1", "100")
			request := decodePrepared(t, input.Prepared)
			test.mutate(request, &input)
			input.Prepared = prepare(t, "reserve", request)
			if _, err := New(pool).Reserve(context.Background(), input); !budgetstore.IsCode(err, budgetstore.ErrorConflict) {
				t.Fatalf("route drift err=%v, want %s", err, budgetstore.ErrorConflict)
			}
			statistics, err := New(pool).Statistics(context.Background())
			if err != nil || statistics != (budgetstore.Statistics{}) {
				t.Fatalf("route drift mutated budget evidence: %#v err=%v", statistics, err)
			}
			assertRunRecord(t, pool, 4, authoritycontract.RunRunning)
		})
	}
}

func TestBudgetStoreResponseLossRecovery(t *testing.T) {
	pool := openBudgetPostgres(t)
	seedRun(t, pool, 4)
	repository := NewWithCommitter(pool, func(ctx context.Context, tx pgx.Tx) error {
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return errors.New("response lost after commit")
	})
	input := reserveInput(t, testSeed, 0, 4, "1", "100")
	result, err := repository.Reserve(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	replay, err := New(pool).Reserve(context.Background(), input)
	if err != nil || !replay.Replay || result.ReceiptID != replay.ReceiptID || !bytes.Equal(result.ExactResponseBytes, replay.ExactResponseBytes) {
		t.Fatalf("response loss result=%#v replay=%#v err=%v", result, replay, err)
	}
}

func TestBudgetStoreDatabaseReconciliationResponseLossReplaysLatchedRun(t *testing.T) {
	pool := openBudgetPostgres(t)
	seedRun(t, pool, 4)
	rollbackUnknown := func(ctx context.Context, tx pgx.Tx) error {
		if err := tx.Rollback(ctx); err != nil {
			return err
		}
		return errors.New("database outcome unavailable")
	}
	commitThenLoseResponse := func(ctx context.Context, tx pgx.Tx) error {
		if err := tx.Commit(ctx); err != nil {
			return err
		}
		return errors.New("database reconciliation response lost")
	}
	input := reserveInput(t, testSeed, 0, 4, "1", "100")
	result, err := NewWithCommitters(pool, rollbackUnknown, commitThenLoseResponse).Reserve(context.Background(), input)
	if err != nil || result.Status != "database_reconciliation_required" {
		t.Fatalf("database reconciliation response-loss result=%#v err=%v", result, err)
	}
	replay, err := New(pool).Reserve(context.Background(), input)
	if err != nil || !replay.Replay || replay.ReceiptID != result.ReceiptID ||
		!bytes.Equal(replay.ExactReceiptBytes, result.ExactReceiptBytes) || !bytes.Equal(replay.ExactResponseBytes, result.ExactResponseBytes) {
		t.Fatalf("database reconciliation exact replay=%#v err=%v", replay, err)
	}
	assertRunRecord(t, pool, 5, authoritycontract.RunReconciliationRequired)
}

func TestBudgetStoreDatabaseReconciliationRejectsRunDriftWithoutLatch(t *testing.T) {
	pool := openBudgetPostgres(t)
	seedRun(t, pool, 4)
	input := reserveInput(t, testSeed, 0, 4, "1", "100")
	repository := NewWithCommitter(pool, func(ctx context.Context, tx pgx.Tx) error {
		if err := tx.Rollback(ctx); err != nil {
			return err
		}
		transition := authorityTransitionInput(t, 4, authoritycontract.RunRunning, authoritycontract.RunCompleted)
		if _, err := authoritypostgres.New(pool).Mutate(context.Background(), transition); err != nil {
			return err
		}
		return errors.New("database outcome unavailable after run drift")
	})
	result, err := repository.Reserve(context.Background(), input)
	if !budgetstore.IsCode(err, budgetstore.ErrorCommitUnknown) || result.Receipt != nil {
		t.Fatalf("run-drift reconciliation result=%#v err=%v", result, err)
	}
	statistics, statsErr := New(pool).Statistics(context.Background())
	if statsErr != nil || statistics != (budgetstore.Statistics{}) {
		t.Fatalf("run-drift reconciliation left budget evidence: %#v err=%v", statistics, statsErr)
	}
	assertRunRecord(t, pool, 5, authoritycontract.RunCompleted)
}

func TestBudgetStoreProviderAndDatabaseUnknownAreSeparate(t *testing.T) {
	t.Run("provider unknown advances and latches run", func(t *testing.T) {
		pool := openBudgetPostgres(t)
		seedRun(t, pool, 4)
		repository := New(pool)
		reserved, err := repository.Reserve(context.Background(), reserveInput(t, testSeed, 0, 4, "1", "100"))
		if err != nil {
			t.Fatal(err)
		}
		result, err := repository.Settle(context.Background(), settlementInput(t, testSeed, reserved, 1, 5, "missing", "", "0"))
		if err != nil || result.Status != "reconciliation_required" || result.Reconciliation["evidenceType"] != "provider_outcome" {
			t.Fatalf("provider reconciliation=%#v err=%v", result, err)
		}
		replay, err := repository.Settle(context.Background(), settlementInput(t, testSeed, reserved, 1, 5, "missing", "", "0"))
		if err != nil || !replay.Replay || result.ReceiptID != replay.ReceiptID || !bytes.Equal(result.ExactReceiptBytes, replay.ExactReceiptBytes) || !bytes.Equal(result.ExactResponseBytes, replay.ExactResponseBytes) {
			t.Fatalf("provider reconciliation replay=%#v err=%v", replay, err)
		}
		reservation, err := repository.ReadReservation(context.Background(), testWorkspace, testRun, "reservation-1")
		if err != nil || reservation.Status != "open" || reservation.TerminalLedgerEntryID != nil || reservation.ClosedAt != nil {
			t.Fatalf("provider reconciliation closed its unresolved reservation: %#v err=%v", reservation, err)
		}
		statistics, err := repository.Statistics(context.Background())
		if err != nil || statistics.OpenReservations != 1 || statistics.ProviderReconciliations != 1 {
			t.Fatalf("provider reconciliation statistics drifted: %#v err=%v", statistics, err)
		}
		if _, err := repository.Settle(context.Background(), settlementInput(t, testSeed, reserved, 1, 6, "missing", "", "0")); !budgetstore.IsCode(err, budgetstore.ErrorConflict) {
			t.Fatalf("latched run admitted another settlement: %v", err)
		}
		assertRunRecord(t, pool, 6, authoritycontract.RunReconciliationRequired)
	})
	t.Run("database unknown preserves absent mutation", func(t *testing.T) {
		pool := openBudgetPostgres(t)
		seedRun(t, pool, 4)
		repository := NewWithCommitter(pool, func(ctx context.Context, tx pgx.Tx) error {
			if err := tx.Rollback(ctx); err != nil {
				return err
			}
			return errors.New("database outcome unavailable")
		})
		input := reserveInput(t, testSeed, 0, 4, "1", "100")
		result, err := repository.Reserve(context.Background(), input)
		if err != nil || result.Status != "database_reconciliation_required" || result.Record != nil || result.LedgerEntry != nil || result.Reconciliation["evidenceType"] != "database_commit" {
			t.Fatalf("database reconciliation=%#v err=%v", result, err)
		}
		statistics, _ := New(pool).Statistics(context.Background())
		if statistics.Accounts != 0 || statistics.LedgerEntries != 0 || statistics.OpenDatabaseReconciliations != 1 || statistics.ProviderReconciliations != 0 {
			t.Fatalf("database unknown crossed mutation boundary: %#v", statistics)
		}
		assertRunRecord(t, pool, 5, authoritycontract.RunReconciliationRequired)
		blocked := reserveInput(t, testSeed, 0, 5, "2", "100")
		if _, err := New(pool).Reserve(context.Background(), blocked); !budgetstore.IsCode(err, budgetstore.ErrorReconciliation) {
			t.Fatalf("open database reconciliation did not gate run: %v", err)
		}
		// The request itself must remain contract-valid so the open budget
		// reconciliation gate, rather than transition validation, is the reason
		// authority refuses it. Its stale expected state is intentionally never
		// reached because the shared gate is checked first.
		transition := authorityTransitionInput(t, 5, authoritycontract.RunRunning, authoritycontract.RunCompleted)
		if _, err := authoritypostgres.New(pool).Mutate(context.Background(), transition); !authoritystore.IsCode(err, authoritystore.ErrorConflict) {
			t.Fatalf("open budget database reconciliation did not gate the shared run authority: %v", err)
		}
		assertRunRecord(t, pool, 5, authoritycontract.RunReconciliationRequired)
	})
}

func TestBudgetStoreDoubleUnknownFailsClosed(t *testing.T) {
	pool := openBudgetPostgres(t)
	seedRun(t, pool, 4)
	rollbackUnknown := func(ctx context.Context, tx pgx.Tx) error {
		if err := tx.Rollback(ctx); err != nil {
			return err
		}
		return errors.New("commit outcome unavailable")
	}
	result, err := NewWithCommitters(pool, rollbackUnknown, rollbackUnknown).Reserve(context.Background(), reserveInput(t, testSeed, 0, 4, "1", "100"))
	if !budgetstore.IsCode(err, budgetstore.ErrorCommitUnknown) || result.Receipt != nil {
		t.Fatalf("double unknown result=%#v err=%v", result, err)
	}
	statistics, _ := New(pool).Statistics(context.Background())
	if statistics.Accounts != 0 || statistics.LedgerEntries != 0 || statistics.Receipts != 0 || statistics.OpenDatabaseReconciliations != 0 {
		t.Fatalf("double unknown left unproven durable evidence: %#v", statistics)
	}
	assertRunRecord(t, pool, 4, authoritycontract.RunRunning)
}

func TestBudgetStoreSettledReservationCannotSettleTwice(t *testing.T) {
	pool := openBudgetPostgres(t)
	seedRun(t, pool, 4)
	repository := New(pool)
	reserved, err := repository.Reserve(context.Background(), reserveInput(t, testSeed, 0, 4, "1", "100"))
	if err != nil {
		t.Fatal(err)
	}
	settle := settlementInput(t, testSeed, reserved, 1, 5, "trusted", "provider_response_accepted", "50")
	if _, err := repository.Settle(context.Background(), settle); err != nil {
		t.Fatal(err)
	}
	request := decodePrepared(t, settle.Prepared)
	request["expectedAccountRevision"], request["expectedRunRevision"], request["correlationId"] = int64(2), int64(6), "correlation-second-settlement"
	second := budgetstore.MutationInput{Prepared: prepare(t, "settle", request), ServiceBuildHash: testBuild, Seed: testSeed}
	if _, err := repository.Settle(context.Background(), second); !budgetstore.IsCode(err, budgetstore.ErrorConflict) {
		t.Fatalf("second settlement err=%v", err)
	}
	var ledgerCount int
	if err := pool.QueryRow(context.Background(), `SELECT count(*) FROM workflow_control_budget_ledger`).Scan(&ledgerCount); err != nil || ledgerCount != 2 {
		t.Fatalf("second settlement ledger count=%d err=%v", ledgerCount, err)
	}
}

func TestBudgetStoreRestartRebuild(t *testing.T) {
	pool := openBudgetPostgres(t)
	seedRun(t, pool, 4)
	input := reserveInput(t, testSeed, 0, 4, "1", "100")
	first, err := New(pool).Reserve(context.Background(), input)
	if err != nil {
		t.Fatal(err)
	}
	restarted, err := pgxpool.NewWithConfig(context.Background(), pool.Config().Copy())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(restarted.Close)
	repository := New(restarted)
	account, err := repository.ReadAccount(context.Background(), testWorkspace, testRun)
	if err != nil {
		t.Fatal(err)
	}
	rebuilt, err := repository.RebuildAccount(context.Background(), testWorkspace, testRun)
	if err != nil || rebuilt.RecordHash != account.RecordHash || !bytes.Equal(rebuilt.ExactBytes, account.ExactBytes) {
		t.Fatalf("restart ledger fold=%#v account=%#v err=%v", rebuilt, account, err)
	}
	receipt, err := repository.ReadReceipt(context.Background(), testWorkspace, input.Prepared.IdempotencyKey)
	if err != nil || !bytes.Equal(receipt.ExactResponseBytes, first.ExactResponseBytes) {
		t.Fatalf("restart receipt=%#v err=%v", receipt, err)
	}
	var lastHash []byte
	if err := restarted.QueryRow(context.Background(), `SELECT account_hash FROM workflow_control_budget_ledger ORDER BY run_revision DESC LIMIT 1`).Scan(&lastHash); err != nil || account.RecordHash != hex.EncodeToString(lastHash) {
		t.Fatalf("ledger rebuild hash=%x account=%s err=%v", lastHash, account.RecordHash, err)
	}
}

func TestBudgetStoreRebuildCoversClosedLedgerKinds(t *testing.T) {
	tests := []struct {
		name string
		run  func(testing.TB, *Repository)
	}{
		{
			name: "reserve reserved",
			run: func(t testing.TB, repository *Repository) {
				if _, err := repository.Reserve(context.Background(), reserveInput(t, testSeed, 0, 4, "1", "100")); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "reserve rejected",
			run: func(t testing.TB, repository *Repository) {
				if _, err := repository.Reserve(context.Background(), reserveInput(t, testSeed, 0, 4, "1", "1001")); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "settlement settled",
			run: func(t testing.TB, repository *Repository) {
				reserved, err := repository.Reserve(context.Background(), reserveInput(t, testSeed, 0, 4, "1", "100"))
				if err != nil {
					t.Fatal(err)
				}
				if _, err := repository.Settle(context.Background(), settlementInput(t, testSeed, reserved, 1, 5, "trusted", "provider_response_accepted", "50")); err != nil {
					t.Fatal(err)
				}
			},
		},
		{
			name: "settlement reconciliation required",
			run: func(t testing.TB, repository *Repository) {
				reserved, err := repository.Reserve(context.Background(), reserveInput(t, testSeed, 0, 4, "1", "100"))
				if err != nil {
					t.Fatal(err)
				}
				if _, err := repository.Settle(context.Background(), settlementInput(t, testSeed, reserved, 1, 5, "missing", "", "0")); err != nil {
					t.Fatal(err)
				}
			},
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			pool := openBudgetPostgres(t)
			seedRun(t, pool, 4)
			repository := New(pool)
			test.run(t, repository)
			head, err := repository.ReadAccount(context.Background(), testWorkspace, testRun)
			if err != nil {
				t.Fatal(err)
			}
			rebuilt, err := repository.RebuildAccount(context.Background(), testWorkspace, testRun)
			if err != nil || rebuilt.RecordHash != head.RecordHash || !bytes.Equal(rebuilt.ExactBytes, head.ExactBytes) {
				t.Fatalf("rebuild=%#v head=%#v err=%v", rebuilt, head, err)
			}
		})
	}
}

func TestBudgetStoreRebuildFailsClosedOnAnchorAndLedgerDrift(t *testing.T) {
	t.Run("genesis exact bytes", func(t *testing.T) {
		pool := openBudgetPostgres(t)
		seedRun(t, pool, 4)
		repository := New(pool)
		if _, err := repository.Reserve(context.Background(), reserveInput(t, testSeed, 0, 4, "1", "100")); err != nil {
			t.Fatal(err)
		}
		tamper(t, pool,
			`ALTER TABLE workflow_control_budget_accounts DISABLE TRIGGER workflow_control_budget_accounts_transition`,
			`UPDATE workflow_control_budget_accounts SET canonical_genesis_account_bytes=canonical_genesis_account_bytes || decode('20','hex') WHERE workspace_id=$1 AND run_id=$2`,
			`ALTER TABLE workflow_control_budget_accounts ENABLE TRIGGER workflow_control_budget_accounts_transition`, testWorkspace, testRun)
		if _, err := repository.RebuildAccount(context.Background(), testWorkspace, testRun); !budgetstore.IsCode(err, budgetstore.ErrorIntegrity) {
			t.Fatalf("corrupt genesis bytes err=%v", err)
		}
	})
	t.Run("genesis hash", func(t *testing.T) {
		pool := openBudgetPostgres(t)
		seedRun(t, pool, 4)
		repository := New(pool)
		if _, err := repository.Reserve(context.Background(), reserveInput(t, testSeed, 0, 4, "1", "100")); err != nil {
			t.Fatal(err)
		}
		tamper(t, pool,
			`ALTER TABLE workflow_control_budget_accounts DISABLE TRIGGER workflow_control_budget_accounts_transition`,
			`UPDATE workflow_control_budget_accounts SET genesis_account_hash=decode(repeat('1',64),'hex') WHERE workspace_id=$1 AND run_id=$2`,
			`ALTER TABLE workflow_control_budget_accounts ENABLE TRIGGER workflow_control_budget_accounts_transition`, testWorkspace, testRun)
		if _, err := repository.RebuildAccount(context.Background(), testWorkspace, testRun); !budgetstore.IsCode(err, budgetstore.ErrorIntegrity) {
			t.Fatalf("corrupt genesis hash err=%v", err)
		}
	})
	t.Run("ledger gap", func(t *testing.T) {
		pool := openBudgetPostgres(t)
		seedRun(t, pool, 4)
		repository := New(pool)
		if _, err := repository.Reserve(context.Background(), reserveInput(t, testSeed, 0, 4, "1", "100")); err != nil {
			t.Fatal(err)
		}
		if _, err := repository.Reserve(context.Background(), reserveInput(t, testSeed, 1, 5, "2", "100")); err != nil {
			t.Fatal(err)
		}
		tamper(t, pool,
			`ALTER TABLE workflow_control_budget_ledger DISABLE TRIGGER workflow_control_budget_ledger_immutable`,
			`DELETE FROM workflow_control_budget_ledger WHERE workspace_id=$1 AND run_id=$2 AND account_revision=1`,
			`ALTER TABLE workflow_control_budget_ledger ENABLE TRIGGER workflow_control_budget_ledger_immutable`, testWorkspace, testRun)
		if _, err := repository.RebuildAccount(context.Background(), testWorkspace, testRun); !budgetstore.IsCode(err, budgetstore.ErrorIntegrity) {
			t.Fatalf("ledger gap err=%v", err)
		}
	})
	t.Run("ledger order", func(t *testing.T) {
		pool := openBudgetPostgres(t)
		seedRun(t, pool, 4)
		repository := New(pool)
		if _, err := repository.Reserve(context.Background(), reserveInput(t, testSeed, 0, 4, "1", "100")); err != nil {
			t.Fatal(err)
		}
		if _, err := repository.Reserve(context.Background(), reserveInput(t, testSeed, 1, 5, "2", "100")); err != nil {
			t.Fatal(err)
		}
		tamper(t, pool,
			`ALTER TABLE workflow_control_budget_ledger DISABLE TRIGGER workflow_control_budget_ledger_immutable`,
			`UPDATE workflow_control_budget_ledger SET account_revision=3,run_revision=7 WHERE workspace_id=$1 AND run_id=$2 AND account_revision=1`,
			`ALTER TABLE workflow_control_budget_ledger ENABLE TRIGGER workflow_control_budget_ledger_immutable`, testWorkspace, testRun)
		if _, err := repository.RebuildAccount(context.Background(), testWorkspace, testRun); !budgetstore.IsCode(err, budgetstore.ErrorIntegrity) {
			t.Fatalf("ledger order err=%v", err)
		}
	})
	t.Run("ledger hash chain", func(t *testing.T) {
		pool := openBudgetPostgres(t)
		seedRun(t, pool, 4)
		repository := New(pool)
		if _, err := repository.Reserve(context.Background(), reserveInput(t, testSeed, 0, 4, "1", "100")); err != nil {
			t.Fatal(err)
		}
		tamper(t, pool,
			`ALTER TABLE workflow_control_budget_ledger DISABLE TRIGGER workflow_control_budget_ledger_immutable`,
			`UPDATE workflow_control_budget_ledger SET previous_account_hash=decode(repeat('2',64),'hex') WHERE workspace_id=$1 AND run_id=$2`,
			`ALTER TABLE workflow_control_budget_ledger ENABLE TRIGGER workflow_control_budget_ledger_immutable`, testWorkspace, testRun)
		if _, err := repository.RebuildAccount(context.Background(), testWorkspace, testRun); !budgetstore.IsCode(err, budgetstore.ErrorIntegrity) {
			t.Fatalf("ledger chain err=%v", err)
		}
	})
	t.Run("ledger provider attempt receipt binding", func(t *testing.T) {
		pool := openBudgetPostgres(t)
		seedRun(t, pool, 4)
		repository := New(pool)
		if _, err := repository.Reserve(context.Background(), reserveInput(t, testSeed, 0, 4, "1", "100")); err != nil {
			t.Fatal(err)
		}
		tamper(t, pool,
			`ALTER TABLE workflow_control_budget_ledger DISABLE TRIGGER workflow_control_budget_ledger_immutable`,
			`UPDATE workflow_control_budget_ledger SET provider_attempt=2 WHERE workspace_id=$1 AND run_id=$2`,
			`ALTER TABLE workflow_control_budget_ledger ENABLE TRIGGER workflow_control_budget_ledger_immutable`, testWorkspace, testRun)
		if _, err := repository.RebuildAccount(context.Background(), testWorkspace, testRun); !budgetstore.IsCode(err, budgetstore.ErrorIntegrity) {
			t.Fatalf("ledger provider attempt drift err=%v", err)
		}
	})
}

func TestBudgetStoreGenesisAnchorIsImmutable(t *testing.T) {
	pool := openBudgetPostgres(t)
	seedRun(t, pool, 4)
	repository := New(pool)
	if _, err := repository.Reserve(context.Background(), reserveInput(t, testSeed, 0, 4, "1", "100")); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `UPDATE workflow_control_budget_accounts SET genesis_account_hash=decode(repeat('1',64),'hex') WHERE workspace_id=$1 AND run_id=$2`, testWorkspace, testRun); err == nil {
		t.Fatal("revision-zero genesis account hash was mutable")
	}
	if _, err := pool.Exec(context.Background(), `UPDATE workflow_control_budget_accounts SET canonical_genesis_account_bytes=canonical_genesis_account_bytes || decode('20','hex') WHERE workspace_id=$1 AND run_id=$2`, testWorkspace, testRun); err == nil {
		t.Fatal("revision-zero genesis account DurableRecord was mutable")
	}
	if _, err := repository.RebuildAccount(context.Background(), testWorkspace, testRun); err != nil {
		t.Fatalf("failed immutable updates changed genesis evidence: %v", err)
	}
}

func TestBudgetStoreKnownReceiptRequiresSafeAcceptedRevisions(t *testing.T) {
	for _, test := range []struct {
		name       string
		assignment string
	}{
		{name: "account revision present", assignment: "accepted_account_revision=NULL"},
		{name: "run revision present", assignment: "accepted_run_revision=NULL"},
		{name: "account revision safe", assignment: "accepted_account_revision=9007199254740992"},
		{name: "run revision safe", assignment: "accepted_run_revision=9007199254740992"},
	} {
		t.Run(test.name, func(t *testing.T) {
			pool := openBudgetPostgres(t)
			seedRun(t, pool, 4)
			input := reserveInput(t, testSeed, 0, 4, "1", "100")
			if _, err := New(pool).Reserve(context.Background(), input); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(context.Background(), `ALTER TABLE workflow_control_budget_receipts DISABLE TRIGGER workflow_control_budget_receipts_immutable`); err != nil {
				t.Fatal(err)
			}
			_, updateErr := pool.Exec(context.Background(), `UPDATE workflow_control_budget_receipts SET `+test.assignment+` WHERE idempotency_key=$1`, input.Prepared.IdempotencyKey)
			if _, err := pool.Exec(context.Background(), `ALTER TABLE workflow_control_budget_receipts ENABLE TRIGGER workflow_control_budget_receipts_immutable`); err != nil {
				t.Fatal(err)
			}
			if updateErr == nil {
				t.Fatal("receipt accepted an absent or unsafe accepted revision")
			}
		})
	}
}

func TestBudgetStoreReservationCloseTimeBindsTerminalLedger(t *testing.T) {
	pool := openBudgetPostgres(t)
	seedRun(t, pool, 4)
	repository := New(pool)
	reserved, err := repository.Reserve(context.Background(), reserveInput(t, testSeed, 0, 4, "1", "100"))
	if err != nil {
		t.Fatal(err)
	}
	if _, err := repository.Settle(context.Background(), settlementInput(t, testSeed, reserved, 1, 5, "trusted", "provider_response_accepted", "50")); err != nil {
		t.Fatal(err)
	}
	tamper(t, pool,
		`ALTER TABLE workflow_control_budget_reservations DISABLE TRIGGER workflow_control_budget_reservations_transition`,
		`UPDATE workflow_control_budget_reservations SET closed_at=closed_at + interval '1 millisecond' WHERE workspace_id=$1 AND run_id=$2 AND reservation_id='reservation-1'`,
		`ALTER TABLE workflow_control_budget_reservations ENABLE TRIGGER workflow_control_budget_reservations_transition`, testWorkspace, testRun)
	if _, err := repository.ReadReservation(context.Background(), testWorkspace, testRun, "reservation-1"); !budgetstore.IsCode(err, budgetstore.ErrorIntegrity) {
		t.Fatalf("reservation close time drift err=%v", err)
	}
}

func TestBudgetStoreRebuildQueryCountIsIndependentOfLedgerLength(t *testing.T) {
	measure := func(entries int) int64 {
		tracer := &queryCountTracer{}
		pool := testsupport.OpenPostgresWithTracer(t, tracer)
		seedRun(t, pool, 4)
		repository := New(pool)
		for index := 1; index <= entries; index++ {
			if _, err := repository.Reserve(context.Background(), reserveInput(t, testSeed, int64(index-1), int64(index+3), strconv.Itoa(index), "100")); err != nil {
				t.Fatal(err)
			}
		}
		tracer.count.Store(0)
		if _, err := repository.RebuildAccount(context.Background(), testWorkspace, testRun); err != nil {
			t.Fatal(err)
		}
		return tracer.count.Load()
	}
	one := measure(1)
	three := measure(3)
	if one == 0 || three != one {
		t.Fatalf("rebuild query count grew with ledger length: one=%d three=%d", one, three)
	}
}

func TestBudgetStoreMigrationIndexesMatchPointReadAndRebuildAccess(t *testing.T) {
	pool := openBudgetPostgres(t)
	rows, err := pool.Query(context.Background(), `
SELECT indexname,indexdef
FROM pg_indexes
WHERE schemaname=current_schema()
  AND tablename IN ('workflow_control_budget_ledger','workflow_control_budget_receipts')`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	indexes := map[string]string{}
	for rows.Next() {
		var name, definition string
		if err := rows.Scan(&name, &definition); err != nil {
			t.Fatal(err)
		}
		indexes[name] = definition
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if _, exists := indexes["workflow_control_budget_ledger_run_idx"]; exists {
		t.Fatal("redundant workflow budget ledger run index is still present")
	}
	if definition := indexes["workflow_control_budget_ledger_hash_key"]; !strings.Contains(definition, "UNIQUE") || !strings.Contains(definition, "(ledger_hash)") {
		t.Fatalf("ledger hash point-read index=%q", definition)
	}
	if definition := indexes["workflow_control_budget_receipts_ledger_binding_idx"]; !strings.Contains(definition, "UNIQUE") ||
		!strings.Contains(definition, "(workspace_id, run_id, ledger_entry_hash)") || !strings.Contains(definition, "ledger_entry_hash IS NOT NULL") {
		t.Fatalf("receipt ledger binding index=%q", definition)
	}
}

func TestBudgetStoreReservationTerminalShapeIsClosed(t *testing.T) {
	for _, test := range []struct {
		name       string
		assignment string
	}{
		{name: "closed time without ledger", assignment: "status='settled',closed_at=opened_at"},
		{name: "ledger without closed time", assignment: "status='settled',terminal_ledger_entry_id=(SELECT entry_id FROM workflow_control_budget_ledger WHERE workflow_control_budget_ledger.workspace_id=workflow_control_budget_reservations.workspace_id AND workflow_control_budget_ledger.run_id=workflow_control_budget_reservations.run_id LIMIT 1)"},
	} {
		t.Run(test.name, func(t *testing.T) {
			pool := openBudgetPostgres(t)
			seedRun(t, pool, 4)
			if _, err := New(pool).Reserve(context.Background(), reserveInput(t, testSeed, 0, 4, "1", "100")); err != nil {
				t.Fatal(err)
			}
			if _, err := pool.Exec(context.Background(), `ALTER TABLE workflow_control_budget_reservations DISABLE TRIGGER workflow_control_budget_reservations_transition`); err != nil {
				t.Fatal(err)
			}
			_, updateErr := pool.Exec(context.Background(), `UPDATE workflow_control_budget_reservations SET `+test.assignment+` WHERE workspace_id=$1 AND run_id=$2 AND reservation_id='reservation-1'`, testWorkspace, testRun)
			if _, err := pool.Exec(context.Background(), `ALTER TABLE workflow_control_budget_reservations ENABLE TRIGGER workflow_control_budget_reservations_transition`); err != nil {
				t.Fatal(err)
			}
			if updateErr == nil {
				t.Fatal("reservation accepted a partial terminal shape")
			}
		})
	}
}

func TestBudgetStoreInt64RoundingAndOverflow(t *testing.T) {
	if charge, err := budgetcontract.ChargeNanoUSD("9223372036854775807", "0.000000001"); err != nil || charge != "9223372037" {
		t.Fatalf("exact ceil rounding charge=%q err=%v", charge, err)
	}
	if _, err := budgetcontract.ChargeNanoUSD("9223372036854775807", "2"); err == nil {
		t.Fatal("int64 charge overflow was accepted")
	}
	if err := budgetstore.ValidateQualificationSeed(budgetstore.QualificationSeed{PolicyHash: testPolicy, Limit: budgetstore.Quantities{Tokens: "9223372036854775808", NanoUSD: "1", Calls: "1"}}); err == nil {
		t.Fatal("overflowing qualification seed was accepted")
	}
}

func TestBudgetStoreAccountRunRevisionDriftIsAConflict(t *testing.T) {
	pool := openBudgetPostgres(t)
	seedRun(t, pool, 4)
	repository := New(pool)
	if _, err := repository.Reserve(context.Background(), reserveInput(t, testSeed, 0, 4, "1", "100")); err != nil {
		t.Fatal(err)
	}
	rewriteRunRevision(t, pool, 6)
	if _, err := repository.Reserve(context.Background(), reserveInput(t, testSeed, 1, 6, "2", "100")); !budgetstore.IsCode(err, budgetstore.ErrorConflict) || budgetstore.IsCode(err, budgetstore.ErrorIntegrity) {
		t.Fatalf("account/run revision drift err=%v, want conflict", err)
	}
	assertRunRecord(t, pool, 6, authoritycontract.RunRunning)
}

func TestBudgetStoreImmutableAccountBindingDriftIsIntegrityFailure(t *testing.T) {
	pool := openBudgetPostgres(t)
	seedRun(t, pool, 4)
	repository := New(pool)
	if _, err := repository.Reserve(context.Background(), reserveInput(t, testSeed, 0, 4, "1", "100")); err != nil {
		t.Fatal(err)
	}
	account, err := repository.ReadAccount(context.Background(), testWorkspace, testRun)
	if err != nil {
		t.Fatal(err)
	}
	account.Value["policyHash"] = strings.Repeat("9", 64)
	_, exact, hash, err := exactDurableRecord(budgetstore.RecordKindAccount, account.Value, testBuild)
	if err != nil {
		t.Fatal(err)
	}
	tamper(t, pool,
		`ALTER TABLE workflow_control_budget_accounts DISABLE TRIGGER workflow_control_budget_accounts_transition`,
		`UPDATE workflow_control_budget_accounts SET policy_hash=$1,account_hash=$2,canonical_account_bytes=$3 WHERE workspace_id=$4 AND run_id=$5`,
		`ALTER TABLE workflow_control_budget_accounts ENABLE TRIGGER workflow_control_budget_accounts_transition`,
		mustDecodeHash(strings.Repeat("9", 64)), mustDecodeHash(hash), exact, testWorkspace, testRun)
	if _, err := repository.Reserve(context.Background(), reserveInput(t, testSeed, 1, 5, "2", "100")); !budgetstore.IsCode(err, budgetstore.ErrorIntegrity) {
		t.Fatalf("immutable account binding drift err=%v, want integrity", err)
	}
}

func TestBudgetStoreIntegrityFailure(t *testing.T) {
	t.Run("receipt exact response", func(t *testing.T) {
		pool := openBudgetPostgres(t)
		seedRun(t, pool, 4)
		repository := New(pool)
		input := reserveInput(t, testSeed, 0, 4, "1", "100")
		if _, err := repository.Reserve(context.Background(), input); err != nil {
			t.Fatal(err)
		}
		tamper(t, pool,
			`ALTER TABLE workflow_control_budget_receipts DISABLE TRIGGER workflow_control_budget_receipts_immutable`,
			`UPDATE workflow_control_budget_receipts SET exact_response_bytes=exact_response_bytes || decode('20','hex') WHERE idempotency_key=$1`,
			`ALTER TABLE workflow_control_budget_receipts ENABLE TRIGGER workflow_control_budget_receipts_immutable`, input.Prepared.IdempotencyKey)
		if _, err := repository.ReadReceipt(context.Background(), testWorkspace, input.Prepared.IdempotencyKey); !budgetstore.IsCode(err, budgetstore.ErrorIntegrity) || budgetstore.IsCode(err, budgetstore.ErrorDatabase) {
			t.Fatalf("corrupt receipt err=%v", err)
		}
		if _, err := repository.Reserve(context.Background(), input); !budgetstore.IsCode(err, budgetstore.ErrorIntegrity) {
			t.Fatalf("corrupt replay err=%v", err)
		}
	})
	t.Run("account exact bytes", func(t *testing.T) {
		pool := openBudgetPostgres(t)
		seedRun(t, pool, 4)
		repository := New(pool)
		if _, err := repository.Reserve(context.Background(), reserveInput(t, testSeed, 0, 4, "1", "100")); err != nil {
			t.Fatal(err)
		}
		tamper(t, pool,
			`ALTER TABLE workflow_control_budget_accounts DISABLE TRIGGER workflow_control_budget_accounts_transition`,
			`UPDATE workflow_control_budget_accounts SET canonical_account_bytes=canonical_account_bytes || decode('20','hex') WHERE workspace_id=$1 AND run_id=$2`,
			`ALTER TABLE workflow_control_budget_accounts ENABLE TRIGGER workflow_control_budget_accounts_transition`, testWorkspace, testRun)
		if _, err := repository.ReadAccount(context.Background(), testWorkspace, testRun); !budgetstore.IsCode(err, budgetstore.ErrorIntegrity) {
			t.Fatalf("corrupt account err=%v", err)
		}
	})
	t.Run("reservation exact bytes", func(t *testing.T) {
		pool := openBudgetPostgres(t)
		seedRun(t, pool, 4)
		repository := New(pool)
		if _, err := repository.Reserve(context.Background(), reserveInput(t, testSeed, 0, 4, "1", "100")); err != nil {
			t.Fatal(err)
		}
		tamper(t, pool,
			`ALTER TABLE workflow_control_budget_reservations DISABLE TRIGGER workflow_control_budget_reservations_transition`,
			`UPDATE workflow_control_budget_reservations SET canonical_reservation_bytes=canonical_reservation_bytes || decode('20','hex') WHERE workspace_id=$1 AND run_id=$2`,
			`ALTER TABLE workflow_control_budget_reservations ENABLE TRIGGER workflow_control_budget_reservations_transition`, testWorkspace, testRun)
		if _, err := repository.ReadReservation(context.Background(), testWorkspace, testRun, "reservation-1"); !budgetstore.IsCode(err, budgetstore.ErrorIntegrity) {
			t.Fatalf("corrupt reservation err=%v", err)
		}
	})
	t.Run("ledger exact bytes", func(t *testing.T) {
		pool := openBudgetPostgres(t)
		seedRun(t, pool, 4)
		repository := New(pool)
		input := reserveInput(t, testSeed, 0, 4, "1", "100")
		if _, err := repository.Reserve(context.Background(), input); err != nil {
			t.Fatal(err)
		}
		tamper(t, pool,
			`ALTER TABLE workflow_control_budget_ledger DISABLE TRIGGER workflow_control_budget_ledger_immutable`,
			`UPDATE workflow_control_budget_ledger SET canonical_ledger_bytes=canonical_ledger_bytes || decode('20','hex')`,
			`ALTER TABLE workflow_control_budget_ledger ENABLE TRIGGER workflow_control_budget_ledger_immutable`)
		if _, err := repository.ReadReceipt(context.Background(), testWorkspace, input.Prepared.IdempotencyKey); !budgetstore.IsCode(err, budgetstore.ErrorIntegrity) {
			t.Fatalf("corrupt ledger err=%v", err)
		}
	})
	t.Run("ledger outer build", func(t *testing.T) {
		pool := openBudgetPostgres(t)
		seedRun(t, pool, 4)
		repository := New(pool)
		input := reserveInput(t, testSeed, 0, 4, "1", "100")
		if _, err := repository.Reserve(context.Background(), input); err != nil {
			t.Fatal(err)
		}
		var exact []byte
		if err := pool.QueryRow(context.Background(), `SELECT canonical_ledger_bytes FROM workflow_control_budget_ledger`).Scan(&exact); err != nil {
			t.Fatal(err)
		}
		outer, err := budgetstore.DecodeDurableRecord(exact)
		if err != nil {
			t.Fatal(err)
		}
		outer.AuthorityBuildHash = "7" + outer.AuthorityBuildHash[1:]
		drifted, err := budgetstore.EncodeDurableRecord(outer)
		if err != nil {
			t.Fatal(err)
		}
		tamper(t, pool,
			`ALTER TABLE workflow_control_budget_ledger DISABLE TRIGGER workflow_control_budget_ledger_immutable`,
			`UPDATE workflow_control_budget_ledger SET canonical_ledger_bytes=$1`,
			`ALTER TABLE workflow_control_budget_ledger ENABLE TRIGGER workflow_control_budget_ledger_immutable`, drifted)
		if _, err := repository.ReadReceipt(context.Background(), testWorkspace, input.Prepared.IdempotencyKey); !budgetstore.IsCode(err, budgetstore.ErrorIntegrity) {
			t.Fatalf("ledger outer build drift err=%v", err)
		}
	})
	t.Run("ledger scalar binding", func(t *testing.T) {
		pool := openBudgetPostgres(t)
		seedRun(t, pool, 4)
		repository := New(pool)
		input := reserveInput(t, testSeed, 0, 4, "1", "100")
		if _, err := repository.Reserve(context.Background(), input); err != nil {
			t.Fatal(err)
		}
		tamper(t, pool,
			`ALTER TABLE workflow_control_budget_ledger DISABLE TRIGGER workflow_control_budget_ledger_immutable`,
			`UPDATE workflow_control_budget_ledger SET provider_attempt=2`,
			`ALTER TABLE workflow_control_budget_ledger ENABLE TRIGGER workflow_control_budget_ledger_immutable`)
		if _, err := repository.ReadReceipt(context.Background(), testWorkspace, input.Prepared.IdempotencyKey); !budgetstore.IsCode(err, budgetstore.ErrorIntegrity) {
			t.Fatalf("ledger scalar drift err=%v", err)
		}
	})
	t.Run("reconciliation exact bytes", func(t *testing.T) {
		pool := openBudgetPostgres(t)
		seedRun(t, pool, 4)
		repository := New(pool)
		reserved, err := repository.Reserve(context.Background(), reserveInput(t, testSeed, 0, 4, "1", "100"))
		if err != nil {
			t.Fatal(err)
		}
		settle := settlementInput(t, testSeed, reserved, 1, 5, "missing", "", "0")
		if _, err := repository.Settle(context.Background(), settle); err != nil {
			t.Fatal(err)
		}
		tamper(t, pool,
			`ALTER TABLE workflow_control_budget_reconciliations DISABLE TRIGGER workflow_control_budget_reconciliations_immutable`,
			`UPDATE workflow_control_budget_reconciliations SET exact_reconciliation_bytes=exact_reconciliation_bytes || decode('20','hex')`,
			`ALTER TABLE workflow_control_budget_reconciliations ENABLE TRIGGER workflow_control_budget_reconciliations_immutable`)
		if _, err := repository.ReadReceipt(context.Background(), testWorkspace, settle.Prepared.IdempotencyKey); !budgetstore.IsCode(err, budgetstore.ErrorIntegrity) {
			t.Fatalf("corrupt reconciliation err=%v", err)
		}
	})
	t.Run("reconciliation outer build", func(t *testing.T) {
		pool := openBudgetPostgres(t)
		seedRun(t, pool, 4)
		repository := New(pool)
		reserved, err := repository.Reserve(context.Background(), reserveInput(t, testSeed, 0, 4, "1", "100"))
		if err != nil {
			t.Fatal(err)
		}
		settle := settlementInput(t, testSeed, reserved, 1, 5, "missing", "", "0")
		if _, err := repository.Settle(context.Background(), settle); err != nil {
			t.Fatal(err)
		}
		var exact []byte
		if err := pool.QueryRow(context.Background(), `SELECT exact_reconciliation_bytes FROM workflow_control_budget_reconciliations`).Scan(&exact); err != nil {
			t.Fatal(err)
		}
		outer, err := budgetstore.DecodeDurableRecord(exact)
		if err != nil {
			t.Fatal(err)
		}
		outer.AuthorityBuildHash = "7" + outer.AuthorityBuildHash[1:]
		drifted, err := budgetstore.EncodeDurableRecord(outer)
		if err != nil {
			t.Fatal(err)
		}
		tamper(t, pool,
			`ALTER TABLE workflow_control_budget_reconciliations DISABLE TRIGGER workflow_control_budget_reconciliations_immutable`,
			`UPDATE workflow_control_budget_reconciliations SET exact_reconciliation_bytes=$1`,
			`ALTER TABLE workflow_control_budget_reconciliations ENABLE TRIGGER workflow_control_budget_reconciliations_immutable`, drifted)
		if _, err := repository.ReadReceipt(context.Background(), testWorkspace, settle.Prepared.IdempotencyKey); !budgetstore.IsCode(err, budgetstore.ErrorIntegrity) {
			t.Fatalf("reconciliation outer build drift err=%v", err)
		}
	})
	t.Run("reconciliation scalar binding", func(t *testing.T) {
		pool := openBudgetPostgres(t)
		seedRun(t, pool, 4)
		repository := New(pool)
		reserved, err := repository.Reserve(context.Background(), reserveInput(t, testSeed, 0, 4, "1", "100"))
		if err != nil {
			t.Fatal(err)
		}
		settle := settlementInput(t, testSeed, reserved, 1, 5, "missing", "", "0")
		if _, err := repository.Settle(context.Background(), settle); err != nil {
			t.Fatal(err)
		}
		tamper(t, pool,
			`ALTER TABLE workflow_control_budget_reconciliations DISABLE TRIGGER workflow_control_budget_reconciliations_immutable`,
			`UPDATE workflow_control_budget_reconciliations SET reason_code='usage_receipt_untrusted'`,
			`ALTER TABLE workflow_control_budget_reconciliations ENABLE TRIGGER workflow_control_budget_reconciliations_immutable`)
		if _, err := repository.ReadReceipt(context.Background(), testWorkspace, settle.Prepared.IdempotencyKey); !budgetstore.IsCode(err, budgetstore.ErrorIntegrity) {
			t.Fatalf("reconciliation scalar drift err=%v", err)
		}
	})
	t.Run("run exact record", func(t *testing.T) {
		pool := openBudgetPostgres(t)
		seedRun(t, pool, 4)
		tamper(t, pool,
			`ALTER TABLE workflow_control_runs DISABLE TRIGGER workflow_control_runs_transition`,
			`UPDATE workflow_control_runs SET canonical_record_bytes=canonical_record_bytes || decode('20','hex') WHERE workspace_id=$1 AND run_id=$2`,
			`ALTER TABLE workflow_control_runs ENABLE TRIGGER workflow_control_runs_transition`, testWorkspace, testRun)
		if _, err := New(pool).Reserve(context.Background(), reserveInput(t, testSeed, 0, 4, "1", "100")); !budgetstore.IsCode(err, budgetstore.ErrorIntegrity) {
			t.Fatalf("corrupt run err=%v", err)
		}
	})
	t.Run("run trailing JSON value", func(t *testing.T) {
		pool := openBudgetPostgres(t)
		seedRun(t, pool, 4)
		var exact []byte
		if err := pool.QueryRow(context.Background(), `SELECT canonical_record_bytes FROM workflow_control_runs WHERE workspace_id=$1 AND run_id=$2`, testWorkspace, testRun).Scan(&exact); err != nil {
			t.Fatal(err)
		}
		exact = append(exact, []byte("{}\n")...)
		digest := sha256.Sum256(exact)
		tamper(t, pool,
			`ALTER TABLE workflow_control_runs DISABLE TRIGGER workflow_control_runs_transition`,
			`UPDATE workflow_control_runs SET record_hash=$1,canonical_record_bytes=$2 WHERE workspace_id=$3 AND run_id=$4`,
			`ALTER TABLE workflow_control_runs ENABLE TRIGGER workflow_control_runs_transition`, digest[:], exact, testWorkspace, testRun)
		if _, err := New(pool).Reserve(context.Background(), reserveInput(t, testSeed, 0, 4, "1", "100")); !budgetstore.IsCode(err, budgetstore.ErrorIntegrity) || !strings.Contains(err.Error(), "trailing content") {
			t.Fatalf("run trailing JSON err=%v", err)
		}
	})
}

func TestBudgetStoreLegacyApprovalCannotReserve(t *testing.T) {
	legacy := authorityEnvelope()
	for key, value := range (budgetcontract.Record{
		"schema": budgetcontract.SchemaLegacyApproval, "workspaceId": testWorkspace, "runId": testRun,
		"status": "approved", "revision": int64(1), "semantics": "run_gate_only",
		"limitAmendmentAuthority": false, "reservationAuthority": false, "settlementAuthority": false,
		"observedAt": "2026-08-14T00:00:00.000Z",
	}) {
		legacy[key] = value
	}
	validated, err := budgetcontract.ValidateLegacyApproval(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := budgetcontract.PrepareRequest("reserve", validated, "qualification-caller"); err == nil {
		t.Fatal("legacy run approval became reserve authority")
	}
}

func openBudgetPostgres(t testing.TB) *pgxpool.Pool {
	t.Helper()
	return testsupport.OpenPostgres(t)
}

func seedRun(t testing.TB, pool *pgxpool.Pool, revision int64) {
	t.Helper()
	seedRunWithGeneration(t, pool, revision, 0)
}

func seedRunWithGeneration(t testing.TB, pool *pgxpool.Pool, revision, resumeGeneration int64) {
	t.Helper()
	record := authoritystore.RunRecord{
		Schema: authoritystore.RunRecordSchema, WorkspaceID: testWorkspace, RunID: testRun,
		WorkflowID: "workflow-budget-qualification", WorkflowVersion: "v1",
		WorkflowSourceHash: strings.Repeat("a", 64), ManifestHash: strings.Repeat("b", 64), InputHash: strings.Repeat("c", 64),
		Route: authoritystore.Route{Backend: budgetstore.Backend, Authority: budgetstore.Authority, RoutingEpoch: 1, AuthorityBuildHash: testBuild},
		State: authoritycontract.RunRunning, Revision: revision, ResumeGeneration: resumeGeneration,
	}
	exact, err := canonicaljson.Encode(record)
	if err != nil {
		t.Fatal(err)
	}
	exact = append(exact, '\n')
	digest := sha256.Sum256(exact)
	if _, err := pool.Exec(context.Background(), `
INSERT INTO workflow_control_authority_epochs (workspace_id,routing_epoch,backend,authority,authority_build_hash)
VALUES ($1,1,'go','workflow-control',$2);
INSERT INTO workflow_control_runs (
 workspace_id,run_id,workflow_id,workflow_version,workflow_source_hash,manifest_hash,input_hash,
 backend,authority,routing_epoch,authority_build_hash,state,revision,resume_generation,record_hash,canonical_record_bytes
) VALUES ($1,$3,$4,$5,$6,$7,$8,'go','workflow-control',1,$2,'running',$9,$10,$11,$12)`,
		testWorkspace, mustDecodeHash(testBuild), testRun, record.WorkflowID, record.WorkflowVersion,
		mustDecodeHash(record.WorkflowSourceHash), mustDecodeHash(record.ManifestHash), mustDecodeHash(record.InputHash), revision, resumeGeneration, digest[:], exact,
	); err != nil {
		t.Fatal(err)
	}
}

func authorityTransitionInput(t testing.TB, revision int64, from, to authoritystore.RunState) authoritystore.MutateInput {
	t.Helper()
	route := authoritystore.Route{Backend: budgetstore.Backend, Authority: budgetstore.Authority, RoutingEpoch: 1, AuthorityBuildHash: testBuild}
	envelope := authoritystore.RequestEnvelope{
		Schema: authoritystore.TransitionSchema, Operation: authoritystore.OperationTransition,
		WorkspaceID: testWorkspace, RunID: testRun,
		Expected: authoritystore.ExpectedBinding{Revision: revision, State: &from, ResumeGeneration: 0},
		Route:    route,
		Record: authoritystore.RunRecord{
			Schema: authoritystore.RunRecordSchema, WorkspaceID: testWorkspace, RunID: testRun,
			WorkflowID: "workflow-budget-qualification", WorkflowVersion: "v1",
			WorkflowSourceHash: strings.Repeat("a", 64), ManifestHash: strings.Repeat("b", 64), InputHash: strings.Repeat("c", 64),
			Route: route, State: to, Revision: revision + 1, ResumeGeneration: 0,
		},
		CorrelationID: "budget-cross-authority-gate",
	}
	body, err := canonicaljson.Encode(envelope)
	if err != nil {
		t.Fatal(err)
	}
	body = append(body, '\n')
	prepared, err := authoritystore.PrepareRequest(body, "qualification-caller", testWorkspace, "1", testBuild)
	if err != nil {
		t.Fatal(err)
	}
	path := authoritystore.RequestPath(authoritystore.OperationTransition, testRun)
	return authoritystore.MutateInput{
		Prepared: prepared, IdempotencyKey: authoritystore.ExpectedIdempotencyKey(body),
		RequestFingerprint: authoritystore.RequestFingerprint("POST", path, prepared), ServiceBuildHash: testBuild,
	}
}

func reserveInput(t testing.TB, seed budgetstore.QualificationSeed, accountRevision, runRevision int64, occurrence, tokens string) budgetstore.MutationInput {
	t.Helper()
	nanoUSD, err := budgetcontract.ChargeNanoUSD(tokens, "10")
	if err != nil {
		t.Fatal(err)
	}
	request := authorityEnvelope()
	for key, value := range (budgetcontract.Record{
		"schema": budgetcontract.SchemaReserveRequest, "workspaceId": testWorkspace, "runId": testRun, "accountId": testAccount,
		"reservationId": "reservation-" + occurrence, "callId": "call-" + occurrence, "providerAttempt": occurrence,
		"expectedProviderHash": "sha256:" + strings.Repeat("d", 64), "expectedModelHash": "sha256:" + strings.Repeat("e", 64),
		"expectedProviderRunHash": "sha256:" + strings.Repeat("f", 64), "correlationId": "correlation-" + occurrence,
		"policyHash": seed.PolicyHash, "route": budgetcontract.Record{"backend": budgetstore.Backend, "authority": budgetstore.Authority, "routingEpoch": int64(1), "authorityBuildHash": testBuild},
		"expectedAccountRevision": accountRevision, "expectedRunRevision": runRevision, "rateNanoUsdPerToken": "10",
		"requested": budgetcontract.Record{"tokens": tokens, "nanoUsd": nanoUSD, "calls": "1"}, "requestedAt": "2026-08-14T00:00:01.000Z",
	}) {
		request[key] = value
	}
	return budgetstore.MutationInput{Prepared: prepare(t, "reserve", request), ServiceBuildHash: testBuild, Seed: seed}
}

func settlementInput(t testing.TB, seed budgetstore.QualificationSeed, reserve budgetstore.MutationResult, accountRevision, runRevision int64, evidenceStatus, outcome, tokens string) budgetstore.MutationInput {
	t.Helper()
	reservation := reserve.Record["request"].(budgetcontract.Record)
	request := authorityEnvelope()
	for key, value := range (budgetcontract.Record{
		"schema": budgetcontract.SchemaSettlementRequest, "workspaceId": reservation["workspaceId"], "runId": reservation["runId"], "accountId": reservation["accountId"],
		"reservationId": reservation["reservationId"], "callId": reservation["callId"], "providerAttempt": reservation["providerAttempt"],
		"expectedProviderHash": reservation["expectedProviderHash"], "expectedModelHash": reservation["expectedModelHash"], "expectedProviderRunHash": reservation["expectedProviderRunHash"],
		"correlationId": reservation["correlationId"], "policyHash": reservation["policyHash"], "route": reservation["route"],
		"expectedAccountRevision": accountRevision, "expectedRunRevision": runRevision, "rateNanoUsdPerToken": reservation["rateNanoUsdPerToken"],
		"usageEvidenceStatus": evidenceStatus, "usageReceiptHash": nil, "providerUsage": nil, "requestedAt": reserve.Receipt["committedAt"],
	}) {
		request[key] = value
	}
	decisionHash, _ := budgetcontract.HashValue("reserve-decision", reserve.Record)
	request["reserveDecisionHash"] = decisionHash
	if evidenceStatus == "trusted" {
		usage := providerUsage(t, reservation, outcome, tokens)
		request["providerUsage"], request["usageReceiptHash"] = usage, usage["receiptHash"]
	}
	if evidenceStatus == "untrusted" {
		request["usageReceiptHash"] = "sha256:" + strings.Repeat("4", 64)
	}
	return budgetstore.MutationInput{Prepared: prepare(t, "settle", request), ServiceBuildHash: testBuild, Seed: seed}
}

func providerUsage(t testing.TB, binding budgetcontract.Record, outcome, tokens string) budgetcontract.Record {
	t.Helper()
	inputTokens, outputTokens := tokens, "0"
	unsigned := budgetcontract.Record{
		"schema": budgetcontract.SchemaProviderUsage, "providerHash": binding["expectedProviderHash"], "modelHash": binding["expectedModelHash"],
		"runHash": binding["expectedProviderRunHash"], "attempt": binding["providerAttempt"], "calls": "1", "status": "reported",
		"inputTokens": inputTokens, "outputTokens": outputTokens, "totalTokens": tokens, "outcome": outcome,
		"requestHash": "sha256:" + strings.Repeat("1", 64), "outcomeHash": "sha256:" + strings.Repeat("2", 64),
	}
	canonical, err := budgetcontract.CanonicalJSON(unsigned)
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256([]byte("openslack.provider-usage-receipt.v1\x00" + canonical))
	unsigned["receiptHash"] = "sha256:" + hex.EncodeToString(digest[:])
	validated, err := budgetcontract.ValidateProviderUsage(unsigned)
	if err != nil {
		t.Fatal(err)
	}
	return validated
}

func prepare(t testing.TB, operation string, request budgetcontract.Record) budgetcontract.PreparedRequest {
	t.Helper()
	prepared, err := budgetcontract.PrepareRequest(operation, request, "qualification-caller")
	if err != nil {
		t.Fatal(err)
	}
	return prepared
}

func decodePrepared(t testing.TB, prepared budgetcontract.PreparedRequest) budgetcontract.Record {
	t.Helper()
	value, err := budgetcontract.ParseBytes([]byte(strings.TrimSuffix(prepared.Body, "\n")))
	if err != nil {
		t.Fatal(err)
	}
	return value.(budgetcontract.Record)
}

func assertRunRecord(t testing.TB, pool *pgxpool.Pool, revision int64, state authoritycontract.RunState) {
	t.Helper()
	var scalarRevision int64
	var scalarState string
	var rawHash, exact []byte
	if err := pool.QueryRow(context.Background(), `SELECT revision,state,record_hash,canonical_record_bytes FROM workflow_control_runs WHERE workspace_id=$1 AND run_id=$2`, testWorkspace, testRun).Scan(&scalarRevision, &scalarState, &rawHash, &exact); err != nil {
		t.Fatal(err)
	}
	var record authoritystore.RunRecord
	if err := strictJSON(exact, &record); err != nil {
		t.Fatal(err)
	}
	canonical, err := canonicaljson.Encode(record)
	if err != nil || !bytes.Equal(append(canonical, '\n'), exact) {
		t.Fatalf("run record is not exact canonical+LF: %v", err)
	}
	digest := sha256.Sum256(exact)
	if !bytes.Equal(rawHash, digest[:]) || scalarRevision != revision || record.Revision != revision || scalarState != string(state) || record.State != state || record.Schema != authoritystore.RunRecordSchema {
		t.Fatalf("run record scalar/exact mismatch: scalar=(%d,%s) record=%#v", scalarRevision, scalarState, record)
	}
}

func rewriteRunRevision(t testing.TB, pool *pgxpool.Pool, revision int64) {
	t.Helper()
	var exact []byte
	if err := pool.QueryRow(context.Background(), `SELECT canonical_record_bytes FROM workflow_control_runs WHERE workspace_id=$1 AND run_id=$2`, testWorkspace, testRun).Scan(&exact); err != nil {
		t.Fatal(err)
	}
	var record authoritystore.RunRecord
	if err := strictJSON(exact, &record); err != nil {
		t.Fatal(err)
	}
	record.Revision = revision
	canonical, err := canonicaljson.Encode(record)
	if err != nil {
		t.Fatal(err)
	}
	canonical = append(canonical, '\n')
	digest := sha256.Sum256(canonical)
	tamper(t, pool,
		`ALTER TABLE workflow_control_runs DISABLE TRIGGER workflow_control_runs_transition`,
		`UPDATE workflow_control_runs SET revision=$1,record_hash=$2,canonical_record_bytes=$3 WHERE workspace_id=$4 AND run_id=$5`,
		`ALTER TABLE workflow_control_runs ENABLE TRIGGER workflow_control_runs_transition`, revision, digest[:], canonical, testWorkspace, testRun)
}

type queryCountTracer struct{ count atomic.Int64 }

func (tracer *queryCountTracer) TraceQueryStart(ctx context.Context, _ *pgx.Conn, _ pgx.TraceQueryStartData) context.Context {
	tracer.count.Add(1)
	return ctx
}

func (*queryCountTracer) TraceQueryEnd(context.Context, *pgx.Conn, pgx.TraceQueryEndData) {}

func strictJSON(exact []byte, destination any) error {
	if len(exact) == 0 || exact[len(exact)-1] != '\n' {
		return errors.New("missing canonical LF")
	}
	decoder := jsonNewDecoder(bytes.NewReader(exact))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(destination); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("trailing JSON content")
	}
	return nil
}

func tamper(t testing.TB, pool *pgxpool.Pool, disable, update, enable string, arguments ...any) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), disable); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), update, arguments...); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), enable); err != nil {
		t.Fatal(err)
	}
}

// jsonNewDecoder is a seam only to keep strict JSON framing next to the
// run-record exact-byte assertion without widening production APIs.
var jsonNewDecoder = json.NewDecoder
