package main

import (
	"bytes"
	"context"
	"errors"
	"strings"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/config"
	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/openslackbootstrap"
)

func testDependencies(execute func(context.Context, *config.OpenSlackBootstrapConfig, string, []string) (openslackbootstrap.Result, error)) commandDependencies {
	return commandDependencies{
		loadConfig: func() (*config.OpenSlackBootstrapConfig, error) {
			return &config.OpenSlackBootstrapConfig{
				DatabaseURL:  "postgres://credential-user:credential-password@fixture.invalid/db",
				ActivePepper: config.Pepper{ID: "fixture", Value: []byte("raw-pepper-marker")},
			}, nil
		},
		execute: execute,
	}
}

func TestRunSuccessPrintsNoRawCredentialMaterial(t *testing.T) {
	const callerRaw = "caller-key-id.caller-raw-secret"
	const auditorRaw = "auditor-key-id.auditor-raw-secret"
	var stdout, stderr bytes.Buffer
	exitCode := run(t.Context(), []string{
		"--output", "/secure/fixture.json", "--vendor-id", "fixture-slack", "--vendor-id", "fixture-webhook",
	}, &stdout, &stderr, testDependencies(func(_ context.Context, cfg *config.OpenSlackBootstrapConfig, output string, vendors []string) (openslackbootstrap.Result, error) {
		if output != "/secure/fixture.json" || len(vendors) != 2 || string(cfg.ActivePepper.Value) != "raw-pepper-marker" {
			t.Fatal("command inputs were not passed to bootstrap")
		}
		_ = callerRaw
		_ = auditorRaw
		return openslackbootstrap.Result{OutputPath: output, CallerKeyID: "caller-key-id", AuditorKeyID: "auditor-key-id"}, nil
	}))
	if exitCode != 0 || stderr.Len() != 0 || !strings.Contains(stdout.String(), "bootstrap committed") {
		t.Fatalf("exit=%d stdout=%q stderr=%q", exitCode, stdout.String(), stderr.String())
	}
	combined := stdout.String() + stderr.String()
	for _, secret := range []string{callerRaw, auditorRaw, "caller-raw-secret", "auditor-raw-secret", "raw-pepper-marker", "credential-password"} {
		if strings.Contains(combined, secret) {
			t.Fatalf("command output leaked %q", secret)
		}
	}
}

func TestRunCommitUnknownPrintsOnlyConvergenceIDs(t *testing.T) {
	var stdout, stderr bytes.Buffer
	exitCode := run(t.Context(), []string{
		"--output", "/secure/fixture.json", "--vendor-id", "fixture-slack", "--vendor-id", "fixture-webhook",
	}, &stdout, &stderr, testDependencies(func(_ context.Context, _ *config.OpenSlackBootstrapConfig, output string, _ []string) (openslackbootstrap.Result, error) {
		return openslackbootstrap.Result{OutputPath: output, CallerKeyID: "caller-key-id", AuditorKeyID: "auditor-key-id"},
			openslackbootstrap.PersistenceError{Kind: openslackbootstrap.FailureCommitUnknown, Code: "commit_outcome_unknown", Err: errors.New("raw-db-error")}
	}))
	if exitCode != 1 || stdout.Len() != 0 || !strings.Contains(stderr.String(), "commit_outcome_unknown") ||
		!strings.Contains(stderr.String(), "caller-key-id") || !strings.Contains(stderr.String(), "auditor-key-id") || strings.Contains(stderr.String(), "raw-db-error") {
		t.Fatalf("exit=%d stdout=%q stderr=%q", exitCode, stdout.String(), stderr.String())
	}
}

func TestRunKnownPersistenceErrorDoesNotReflectUnderlyingError(t *testing.T) {
	var stdout, stderr bytes.Buffer
	exitCode := run(t.Context(), []string{
		"--output", "/secure/fixture.json", "--vendor-id", "fixture-slack", "--vendor-id", "fixture-webhook",
	}, &stdout, &stderr, testDependencies(func(_ context.Context, _ *config.OpenSlackBootstrapConfig, _ string, _ []string) (openslackbootstrap.Result, error) {
		return openslackbootstrap.Result{}, openslackbootstrap.PersistenceError{
			Kind: openslackbootstrap.FailureKnownRollback, Code: "caller_insert_failed", Err: errors.New("raw-key-marker database detail"),
		}
	}))
	if exitCode != 1 || stdout.Len() != 0 || !strings.Contains(stderr.String(), "caller_insert_failed") || strings.Contains(stderr.String(), "raw-key-marker") {
		t.Fatalf("exit=%d stdout=%q stderr=%q", exitCode, stdout.String(), stderr.String())
	}
}

func TestRunRejectsArgumentAndConfigErrorsWithoutExecution(t *testing.T) {
	var calls int
	dependencies := testDependencies(func(context.Context, *config.OpenSlackBootstrapConfig, string, []string) (openslackbootstrap.Result, error) {
		calls++
		return openslackbootstrap.Result{}, nil
	})
	for _, args := range [][]string{
		{},
		{"--output", "keys.json", "--vendor-id", "fixture-one"},
		{"--output", "keys.json", "--vendor-id", "fixture-one", "--vendor-id", "fixture-one"},
	} {
		var stdout, stderr bytes.Buffer
		if exit := run(t.Context(), args, &stdout, &stderr, dependencies); exit != 2 {
			t.Fatalf("args %v exit=%d, want 2", args, exit)
		}
	}
	if calls != 0 {
		t.Fatalf("execute called %d times for invalid arguments", calls)
	}

	dependencies.loadConfig = func() (*config.OpenSlackBootstrapConfig, error) {
		return nil, errors.New("missing required env API_KEY_PEPPER_ACTIVE")
	}
	var stdout, stderr bytes.Buffer
	if exit := run(t.Context(), []string{"--output", "keys.json", "--vendor-id", "fixture-one", "--vendor-id", "fixture-two"}, &stdout, &stderr, dependencies); exit != 1 {
		t.Fatalf("config error exit=%d", exit)
	}
	if calls != 0 {
		t.Fatal("execute called after configuration failure")
	}
}
