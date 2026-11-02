package main

import (
	"path/filepath"
	"testing"
	"time"
)

func TestClosedDeploymentArguments(t *testing.T) {
	root := t.TempDir()
	args := []string{"--run-id", "RUN-TEST", "--generation", "owner-1", "--cleanup-ms", "30000", "--", filepath.Join(root, "node.exe"), filepath.Join(root, "peer.js")}
	got, err := parseOptions(args)
	if err != nil || got.cleanup != 30*time.Second || len(got.command) != 2 {
		t.Fatalf("approved arguments rejected: %v", err)
	}
	for _, invalid := range [][]string{append([]string{"--shell", "true"}, args...), append([]string{"--run-id", "RUN-OTHER"}, args...), {"--run-id", "../escape"}, {"--run-id", "RUN-TEST", "--generation", "owner", "--cleanup-ms", "30001", "--", args[len(args)-2], args[len(args)-1]}} {
		if _, err := parseOptions(invalid); err == nil {
			t.Fatal("invalid or duplicate arguments accepted")
		}
	}
}
