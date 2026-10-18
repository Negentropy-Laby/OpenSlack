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
	t.Fatal("repository root with .openslack/policies not found (run from a full checkout)")
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
	// Audit today's activation independently of historical evidence snapshots.
	// Retained old grants need not equal it, but the selected instance/issuer
	// must have a structurally valid committed grant rather than a paired typo
	// in an otherwise unreferenced policy. Runtime still enforces time/revocation.
	entries, err := os.ReadDir(filepath.Join(repoRoot(t), ".openslack/policies/pr-cleanup-grants"))
	if err != nil {
		t.Fatal(err)
	}
	matched := false
	for _, entry := range entries {
		data, err := os.ReadFile(filepath.Join(repoRoot(t), ".openslack/policies/pr-cleanup-grants", entry.Name()))
		var p Permit
		if err != nil || Decode(data, &p) != nil || validateCommittedRecord(p, strings.TrimSuffix(entry.Name(), ".json")) != nil {
			t.Fatal("current policy audit found an invalid committed grant")
		}
		matched = matched || (p.Instance == policy.ActiveInstance && p.IssuerTrustDomain == policy.IssuerTrustDomain)
	}
	if !matched {
		t.Fatal("current policy does not select any structurally valid committed grant")
	}
}

func TestCommittedCleanupPermits(t *testing.T) {
	grantsDir := filepath.Join(repoRoot(t), ".openslack", "policies", "pr-cleanup-grants")
	entries, err := os.ReadDir(grantsDir)
	if err != nil {
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
		if err := validateCommittedRecord(p, permitID); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		// Retained expired/consumed/revoked grants are historical data, not
		// active grants. A new policy must not force their boot or issuer to
		// be rewritten. The independently evidenced grant below is cross-bound
		// to the current policy; runtime Check still rejects an old instance.
		checked++
	}
	if checked == 0 {
		t.Fatal("no committed permits found")
	}
}

func validateCommittedRecord(p Permit, permitID string) error {
	if p.ID != permitID {
		return errors.New("permitId must match the file name")
	}
	// Invoke the production validator at this record's own lower time bound,
	// with its own instance. This validates historical structure without
	// extending its runtime authority or rewriting revoked/expired history.
	q := p
	q.Revoked = false
	policy := Policy{PolicySchema, Basis, Action, p.IssuerTrustDomain, p.Instance}
	return Check(q, policy, p.Subject, p.Target, p.Instance, p.NotBefore)
}

func TestHistoricalGrantSurvivesPolicyRotationWithoutExecutionRights(t *testing.T) {
	p, policy, now := fixture()
	policy.ActiveInstance.Generation = "2"
	policy.ActiveInstance.BootNonce = strings.Repeat("c", 64)
	if err := validateCommittedRecord(p, p.ID); err != nil {
		t.Fatalf("retained history must remain valid record data: %v", err)
	}
	if err := Check(p, policy, p.Subject, p.Target, policy.ActiveInstance, now); err == nil || err.Error() != "BROKER_NOT_ACTIVATED" {
		t.Fatalf("old grant regained authority after rotation: %v", err)
	}
	p.Revoked = true
	if err := validateCommittedRecord(p, p.ID); err != nil {
		t.Fatalf("revoked record cannot be retained: %v", err)
	}
}
