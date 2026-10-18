package permit

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// The fixed-source reader pins .openslack/policies/pr-cleanup-policy.json and
// .openslack/policies/pr-cleanup-grants/<permitId>.json on governance main at
// runtime. These tests decode the bytes actually committed to the tree, so a
// hand-edit that violates the strict contract fails here instead of surfacing
// as an opaque denial at live admission.

// repoRoot walks up from the test working directory to the repository root.
func repoRoot(t *testing.T) string {
	t.Helper()
	dir, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 10; i++ {
		if _, err := os.Stat(filepath.Join(dir, ".openslack", "policies")); err == nil {
			return dir
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	t.Skip("repository root with .openslack/policies not found (run from a full checkout)")
	return ""
}

func loadCommittedPolicy(t *testing.T) Policy {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(repoRoot(t), ".openslack", "policies", "pr-cleanup-policy.json"))
	if err != nil {
		t.Fatalf("committed policy unreadable (the fixed source reader pins this exact path): %v", err)
	}
	var policy Policy
	if err := Decode(data, &policy); err != nil {
		t.Fatalf("committed policy must decode under the strict contract: %v", err)
	}
	return policy
}

func TestCommittedCleanupPolicy(t *testing.T) {
	policy := loadCommittedPolicy(t)
	if policy.Schema != PolicySchema || policy.Basis != Basis || policy.Action != Action {
		t.Fatalf("committed policy constants drifted: %+v", policy)
	}
	if !id.MatchString(policy.IssuerTrustDomain) {
		t.Fatalf("committed policy issuerTrustDomain is malformed: %q", policy.IssuerTrustDomain)
	}
	if !validInstance(policy.ActiveInstance) {
		t.Fatalf("committed policy activeInstance is malformed: %+v", policy.ActiveInstance)
	}
}

func TestCommittedCleanupPermits(t *testing.T) {
	policy := loadCommittedPolicy(t)
	grantsDir := filepath.Join(repoRoot(t), ".openslack", "policies", "pr-cleanup-grants")
	entries, err := os.ReadDir(grantsDir)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			t.Skip("no committed permit directory yet")
		}
		t.Fatal(err)
	}
	checked := 0
	for _, entry := range entries {
		name := entry.Name()
		if strings.HasPrefix(name, ".") {
			continue
		}
		if entry.IsDir() || !strings.HasSuffix(name, ".json") {
			t.Fatalf("pr-cleanup-grants must hold only permit records, found %s", name)
		}
		permitID := strings.TrimSuffix(name, ".json")
		data, err := os.ReadFile(filepath.Join(grantsDir, name))
		if err != nil {
			t.Fatal(err)
		}
		var p Permit
		if err := Decode(data, &p); err != nil {
			t.Fatalf("%s must decode under the strict contract: %v", name, err)
		}
		// The reader builds the grant path from the requested permit ID and
		// requires the record to carry the same ID, so the two copies written
		// into the tree must agree.
		if p.ID != permitID {
			t.Fatalf("%s carries permitId %q; it must match the file name", name, p.ID)
		}
		// Structural conjuncts of Check that need no live host state. Expired
		// or revoked grants stay valid records, so no wall clock is consulted.
		if p.Schema != Schema || p.Action != Action || p.MaxUses != 1 ||
			!id.MatchString(p.IssuerTrustDomain) || !ValidSubject(p.Subject) || !validTarget(p.Target) ||
			!validInstance(p.Instance) || !id.MatchString(p.TaskRef) ||
			p.NotBefore.IsZero() || p.ExpiresAt.IsZero() || !p.NotBefore.Before(p.ExpiresAt) {
			t.Fatalf("%s violates the permit record contract: %+v", name, p)
		}
		if policy.IssuerTrustDomain != p.IssuerTrustDomain {
			t.Fatalf("%s issuerTrustDomain %q diverges from the committed policy %q", name, p.IssuerTrustDomain, policy.IssuerTrustDomain)
		}
		if policy.ActiveInstance != p.Instance {
			t.Fatalf("%s instance diverges from the committed policy activeInstance: %+v", name, p.Instance)
		}
		checked++
	}
	if checked == 0 {
		t.Skip("no committed permits yet")
	}
}
