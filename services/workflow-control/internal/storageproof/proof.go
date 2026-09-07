// Package storageproof verifies the actual source writer's PostgreSQL lock domain.
// Configuration strings and database UUIDs are not evidence: both survive cloning.
package storageproof

import (
	"context"
	"crypto/rand"
	"encoding/binary"
	"errors"
	"reflect"

	"github.com/jackc/pgx/v5"
)

const Schema = "openslack.workflow_control_storage_proof.v1"

type Challenge struct {
	Key int64 `json:"key"`
	PID int32 `json:"pid"`
}

type Answer struct {
	Schema        string            `json:"schema"`
	Challenge     Challenge         `json:"challenge"`
	DatabaseOID   uint32            `json:"databaseOid"`
	Relations     map[string]uint32 `json:"relations"`
	SchemaVersion int64             `json:"schemaVersion"`
	Writable      bool              `json:"writable"`
	FenceEnabled  bool              `json:"fenceEnabled"`
	LockObserved  bool              `json:"lockObserved"`
}

type Writer interface {
	ProveStorage(context.Context, Challenge) (Answer, error)
}

// ChallengeWriter uses the source Mutate pool; implementations must not use a
// separately configured reader, replica, health connection, or metadata cache.
type ChallengeWriter func(context.Context, Challenge, int64) (Answer, error)

func Hold(ctx context.Context, tx pgx.Tx) (Challenge, error) {
	var seed [8]byte
	if _, err := rand.Read(seed[:]); err != nil {
		return Challenge{}, err
	}
	c := Challenge{Key: int64(binary.BigEndian.Uint64(seed[:]) & 0x7fffffffffffffff)}
	var held bool
	if err := tx.QueryRow(ctx, `SELECT pg_try_advisory_xact_lock($1), pg_backend_pid()`, c.Key).Scan(&held, &c.PID); err != nil {
		return c, err
	}
	if !held {
		return c, errors.New("storage challenge lock is busy")
	}
	return c, nil
}

func Inspect(ctx context.Context, tx pgx.Tx, c Challenge) (Answer, error) {
	a := Answer{Schema: Schema, Challenge: c, Relations: map[string]uint32{}}
	if err := tx.QueryRow(ctx, `SELECT oid, NOT pg_is_in_recovery()
 AND current_setting('default_transaction_read_only')='off'
 AND current_setting('transaction_read_only')='off'
 AND current_setting('transaction_isolation')='read committed'
 AND current_setting('default_transaction_isolation')='read committed'
 AND current_setting('session_replication_role')='origin'
 FROM pg_database WHERE datname=current_database()`).Scan(&a.DatabaseOID, &a.Writable); err != nil {
		return a, err
	}
	for _, name := range []string{"workflow_control_runs", "workflow_control_transition_events", "workflow_control_transition_receipts", "workflow_runner_binding_settlements", "workflow_control_source_fences", "workflow_control_recovery_pauses", "schema_migrations", "workflow_runner_authority_bindings", "workflow_runner_leases", "workflow_runner_jobs", "workflow_control_budget_receipts", "workflow_control_budget_reservations"} {
		var oid *uint32
		if err := tx.QueryRow(ctx, `SELECT to_regclass($1)::oid`, name).Scan(&oid); err != nil {
			return a, err
		}
		if oid == nil {
			return a, nil
		}
		a.Relations[name] = *oid
	}
	if err := tx.QueryRow(ctx, `SELECT version FROM schema_migrations WHERE NOT dirty AND (SELECT count(*) FROM schema_migrations)=1`).Scan(&a.SchemaVersion); err != nil {
		return a, err
	}
	if err := tx.QueryRow(ctx, `SELECT count(*)=5 FROM pg_trigger WHERE NOT tgisinternal AND tgenabled='A' AND
 ((tgrelid='workflow_control_transition_events'::regclass AND tgname='workflow_control_source_event_fence') OR
  (tgrelid='workflow_control_transition_receipts'::regclass AND tgname='workflow_control_source_receipt_fence') OR
  (tgrelid='workflow_control_runs'::regclass AND tgname='workflow_control_recovery_pause_guard') OR
  (tgrelid='workflow_runner_leases'::regclass AND tgname='workflow_runner_recovery_lease_fence') OR
  (tgrelid='workflow_runner_authority_bindings'::regclass AND tgname='workflow_runner_recovery_stage_fence'))`).Scan(&a.FenceEnabled); err != nil {
		return a, err
	}
	// pg_locks is cluster-wide. A matching PID/key in another database is not proof.
	if err := tx.QueryRow(ctx, `SELECT EXISTS (SELECT 1 FROM pg_locks WHERE locktype='advisory'
 AND database=$1 AND pid=$2 AND classid=(($3::bigint >> 32)&4294967295)::oid
 AND objid=($3::bigint&4294967295)::oid AND objsubid=1 AND mode='ExclusiveLock' AND granted)`,
		a.DatabaseOID, c.PID, c.Key).Scan(&a.LockObserved); err != nil {
		return a, err
	}
	return a, nil
}

func SameWriter(local, source Answer) bool {
	return local.Schema == Schema && source.Schema == Schema && local.Challenge == source.Challenge &&
		local.DatabaseOID == source.DatabaseOID && local.DatabaseOID != 0 && len(local.Relations) == 12 &&
		reflect.DeepEqual(local.Relations, source.Relations) && local.SchemaVersion == 10 && source.SchemaVersion == 10 &&
		local.Writable && source.Writable && local.FenceEnabled && source.FenceEnabled && local.LockObserved && source.LockObserved
}
