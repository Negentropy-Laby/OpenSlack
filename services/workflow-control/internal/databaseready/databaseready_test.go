package databaseready

import (
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

type fakeDatabase struct {
	pingErr        error
	count, version int64
	dirty          bool
	rowErr         error
}

func (database fakeDatabase) Ping(context.Context) error { return database.pingErr }
func (database fakeDatabase) QueryRow(context.Context, string, ...any) pgx.Row {
	return fakeRow{database: database}
}

type fakeRow struct{ database fakeDatabase }

func (row fakeRow) Scan(destinations ...any) error {
	if row.database.rowErr != nil {
		return row.database.rowErr
	}
	*destinations[0].(*int64) = row.database.count
	*destinations[1].(*int64) = row.database.version
	*destinations[2].(*bool) = row.database.dirty
	return nil
}

func TestRequireCleanSchemaAcceptsOneCleanVersionInRange(t *testing.T) {
	database := fakeDatabase{count: 1, version: 3}
	if err := RequireCleanSchema(context.Background(), database, Range{Minimum: 2, Maximum: 4}); err != nil {
		t.Fatal(err)
	}
}

func TestRequireCleanSchemaRejectsInvalidDatabaseStates(t *testing.T) {
	tests := []struct {
		name     string
		database fakeDatabase
	}{
		{name: "missing", database: fakeDatabase{}},
		{name: "multiple", database: fakeDatabase{count: 2, version: 4}},
		{name: "dirty", database: fakeDatabase{count: 1, version: 4, dirty: true}},
		{name: "below", database: fakeDatabase{count: 1, version: 1}},
		{name: "above", database: fakeDatabase{count: 1, version: 5}},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			if err := RequireCleanSchema(context.Background(), test.database, Range{Minimum: 2, Maximum: 4}); err == nil {
				t.Fatal("invalid database state was accepted")
			}
		})
	}
}

func TestRequireCleanSchemaPreservesDatabaseFailuresAndRejectsBadRanges(t *testing.T) {
	if err := RequireCleanSchema(context.Background(), fakeDatabase{pingErr: errors.New("offline")}, Range{Minimum: 1, Maximum: 4}); err == nil || !strings.Contains(err.Error(), "database ping") {
		t.Fatalf("ping error=%v", err)
	}
	if err := RequireCleanSchema(context.Background(), fakeDatabase{rowErr: errors.New("broken")}, Range{Minimum: 1, Maximum: 4}); err == nil || !strings.Contains(err.Error(), "read schema_migrations") {
		t.Fatalf("row error=%v", err)
	}
	for _, supported := range []Range{{}, {Minimum: 4, Maximum: 3}} {
		if err := RequireCleanSchema(context.Background(), fakeDatabase{}, supported); err == nil {
			t.Fatalf("invalid range accepted: %+v", supported)
		}
	}
}

func TestSchemaProfilesShareOneCurrentVersionWithoutRaisingCheckpointMinimum(t *testing.T) {
	profiles := []struct {
		name string
		got  Range
		want Range
	}{
		{name: "shadow", got: ShadowProfile, want: Range{Minimum: 1, Maximum: 5}},
		{name: "runner", got: RunnerRange(false, false), want: Range{Minimum: 2, Maximum: 5}},
		{name: "authority", got: AuthorityProfile, want: Range{Minimum: 3, Maximum: 5}},
		{name: "checkpoint", got: RunnerRange(true, false), want: Range{Minimum: 4, Maximum: 5}},
		{name: "effect", got: RunnerRange(true, true), want: Range{Minimum: 5, Maximum: 5}},
	}
	if CurrentSchemaVersion != 5 {
		t.Fatalf("current schema version = %d", CurrentSchemaVersion)
	}
	for _, profile := range profiles {
		t.Run(profile.name, func(t *testing.T) {
			if profile.got != profile.want {
				t.Fatalf("profile = %+v, want %+v", profile.got, profile.want)
			}
		})
	}
}
