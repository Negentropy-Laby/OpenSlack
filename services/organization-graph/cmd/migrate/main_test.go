package main

import (
	"bytes"
	"errors"
	"log/slog"
	"strings"
	"testing"
)

func TestMigrationDatabaseURLUsesRegisteredPGXV5Scheme(t *testing.T) {
	tests := map[string]string{
		"postgres://user:secret@db/graph":   "pgx5://user:secret@db/graph",
		"postgresql://user:secret@db/graph": "pgx5://user:secret@db/graph",
		"pgx5://user:secret@db/graph":       "pgx5://user:secret@db/graph",
	}
	for input, want := range tests {
		if got := migrationDatabaseURL(input); got != want {
			t.Fatalf("migrationDatabaseURL(%q) = %q, want %q", input, got, want)
		}
	}
}

func TestRequiredSchemaVersionIsOne(t *testing.T) {
	if requiredSchemaVersion != 1 {
		t.Fatalf("requiredSchemaVersion = %d", requiredSchemaVersion)
	}
}

func TestMigrationFailureLoggingNeverIncludesRawCredentialError(t *testing.T) {
	const sentinel = "password-sentinel"
	var output bytes.Buffer
	logger := slog.New(slog.NewJSONHandler(&output, nil))
	_ = errors.New("pgx5://graph:" + sentinel + "@db/graph")
	logFailure(logger, "graph_migration_failed", "MIGRATION_OR_SCHEMA_CHECK_FAILED")
	if strings.Contains(output.String(), sentinel) || strings.Contains(output.String(), "pgx5://") {
		t.Fatalf("log exposed credential-bearing error: %s", output.String())
	}
}
