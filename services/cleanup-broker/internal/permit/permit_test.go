package permit

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

func fixture() (Permit, Policy, time.Time) {
	now := time.Date(2026, 9, 21, 10, 0, 0, 0, time.UTC)
	i := Instance{"cleanup-broker", "1", strings.Repeat("a", 64)}
	p := Permit{Schema: Schema, ID: "permit-1", Action: Action, IssuerTrustDomain: "openslack",
		Subject: Subject{"agent:cleanup", "runtime-1", "run-1"},
		Target:  Target{"ws-1", "github.com", "123", "example/qualification", "PR_node1", 7, "refs/heads/test-cleanup", strings.Repeat("b", 40)},
		TaskRef: "cleanup-task-1", Instance: i, NotBefore: now.Add(-time.Minute), ExpiresAt: now.Add(time.Minute), MaxUses: 1}
	return p, Policy{PolicySchema, Basis, Action, "openslack", i}, now
}

func TestExactPermitBinding(t *testing.T) {
	p, policy, now := fixture()
	if err := Check(p, policy, p.Subject, p.Target, p.Instance, now); err != nil {
		t.Fatal(err)
	}
	cases := []struct {
		name, code string
		mutate     func(*Permit)
	}{
		{"legacy-action", "PERMIT_INVALID", func(p *Permit) { p.Action = "pr.cleanup_branch" }},
		{"permit-path", "PERMIT_INVALID", func(p *Permit) { p.ID = "permit:1" }},
		{"multi-use", "PERMIT_INVALID", func(p *Permit) { p.MaxUses = 2 }},
		{"revoked", "PERMIT_REVOKED", func(p *Permit) { p.Revoked = true }},
		{"expiry-inclusive", "PERMIT_EXPIRED", func(p *Permit) { p.ExpiresAt = now }},
		{"future", "PERMIT_NOT_YET_VALID", func(p *Permit) { p.NotBefore = now.Add(time.Second) }},
		{"run", "SUBJECT_MISMATCH", func(p *Permit) { p.Subject.RunID = "run-2" }},
		{"runtime", "SUBJECT_MISMATCH", func(p *Permit) { p.Subject.RuntimeUID = "runtime-2" }},
		{"principal", "SUBJECT_MISMATCH", func(p *Permit) { p.Subject.PrincipalID = "agent:other" }},
		{"repo-id", "TARGET_MISMATCH", func(p *Permit) { p.Target.RepositoryID = "124" }},
		{"repo-name", "TARGET_MISMATCH", func(p *Permit) { p.Target.Repository = "example/other" }},
		{"pr-id", "TARGET_MISMATCH", func(p *Permit) { p.Target.PRNodeID = "PR_node2" }},
		{"pr-number", "TARGET_MISMATCH", func(p *Permit) { p.Target.PRNumber = 8 }},
		{"ref", "TARGET_MISMATCH", func(p *Permit) { p.Target.Ref = "refs/heads/other" }},
		{"sha", "TARGET_MISMATCH", func(p *Permit) { p.Target.ExpectedSHA = strings.Repeat("c", 40) }},
		{"boot", "BROKER_NOT_ACTIVATED", func(p *Permit) { p.Instance.BootNonce = strings.Repeat("d", 64) }},
		{"generation", "BROKER_NOT_ACTIVATED", func(p *Permit) { p.Instance.Generation = "2" }},
		{"weak-sha", "PERMIT_INVALID", func(p *Permit) { p.Target.ExpectedSHA = "abcd" }},
		{"zero-sha", "PERMIT_INVALID", func(p *Permit) { p.Target.ExpectedSHA = strings.Repeat("0", 40) }},
		{"alternate-host", "PERMIT_INVALID", func(p *Permit) { p.Target.Host = "example.com" }},
		{"invalid-ref", "PERMIT_INVALID", func(p *Permit) { p.Target.Ref = "refs/heads/a.lock" }},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			q := p
			c.mutate(&q)
			err := Check(q, policy, p.Subject, p.Target, p.Instance, now)
			if err == nil || err.Error() != c.code {
				t.Fatalf("got %v, want %s", err, c.code)
			}
		})
	}
}

func TestPolicyCannotSelectClaimOrActivateDifferentBoot(t *testing.T) {
	p, policy, now := fixture()
	for _, mutate := range []func(*Policy){func(p *Policy) { p.Basis = "permit_and_claim" }, func(p *Policy) { p.Action = "pr.cleanup_branch" }, func(p *Policy) { p.IssuerTrustDomain = "other" }, func(p *Policy) { p.ActiveInstance.Generation = "2" }} {
		q := policy
		mutate(&q)
		if Check(p, q, p.Subject, p.Target, p.Instance, now) == nil {
			t.Fatal("policy mismatch accepted")
		}
	}
}

func TestStrictDecode(t *testing.T) {
	p, _, _ := fixture()
	b, err := json.Marshal(p)
	if err != nil {
		t.Fatal(err)
	}
	var out Permit
	if err := Decode(b, &out); err != nil || out != p {
		t.Fatalf("roundtrip: %v", err)
	}
	s := string(b)
	for name, input := range map[string]string{
		"duplicate":      strings.Replace(s, `"revoked":false`, `"revoked":false,"revoked":true`, 1),
		"unknown":        strings.Replace(s, `"revoked":false`, `"revoked":false,"authorized":true`, 1),
		"missing":        strings.Replace(s, `"revoked":false,`, "", 1),
		"case-folding":   strings.Replace(s, `"revoked"`, `"Revoked"`, 1),
		"null-field":     strings.Replace(s, `"revoked":false`, `"revoked":null`, 1),
		"nested-case":    strings.Replace(s, `"runId"`, `"RunId"`, 1),
		"invalid-utf8":   strings.Replace(s, "test-cleanup", string([]byte{0xff}), 1),
		"high-surrogate": strings.Replace(s, "test-cleanup", `\ud800`, 1),
		"low-surrogate":  strings.Replace(s, "test-cleanup", `\udc00`, 1),
		"null-record":    "null", "trailing": s + "{}", "oversize": strings.Repeat(" ", 65537) + s,
	} {
		t.Run(name, func(t *testing.T) {
			if Decode([]byte(input), &out) == nil {
				t.Fatal("malformed record accepted")
			}
		})
	}
}

func TestUnicodeRefSurvivesStrictDecode(t *testing.T) {
	p, policy, now := fixture()
	p.Target.Ref = "refs/heads/分支-😀"
	b, _ := json.Marshal(p)
	var q Permit
	if err := Decode(b, &q); err != nil || q != p {
		t.Fatalf("valid Unicode: %v", err)
	}
	if err := Check(q, policy, p.Subject, p.Target, p.Instance, now); err != nil {
		t.Fatal(err)
	}
	b = []byte(strings.Replace(string(b), "😀", `\ud83d\ude00`, 1))
	if err := Decode(b, &q); err != nil || q != p {
		t.Fatalf("valid surrogate pair: %v", err)
	}
}

func TestFreshBootDoesNotInheritActivation(t *testing.T) {
	p, policy, now := fixture()
	n1, err := NewBootNonce()
	if err != nil {
		t.Fatal(err)
	}
	n2, err := NewBootNonce()
	if err != nil {
		t.Fatal(err)
	}
	if n1 == n2 || !nonce.MatchString(n1) || !nonce.MatchString(n2) {
		t.Fatal("invalid nonce")
	}
	i := p.Instance
	i.BootNonce = n1
	if Check(p, policy, p.Subject, p.Target, i, now) == nil {
		t.Fatal("old permit activated new process")
	}
}
