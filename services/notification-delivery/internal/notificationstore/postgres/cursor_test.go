package postgres

import (
	"strings"
	"testing"
)

func TestCursorSigner_RoundTrip(t *testing.T) {
	s := newCursorSigner()
	env := cursorEnvelope{
		Op:         "list_dead",
		Scope:      []string{"v1", "v2"},
		Limit:      100,
		SnapshotAt: "2026-07-21T00:00:00Z",
		LastDeadAt: "2026-07-21T00:00:00Z",
		LastID:     "n-1",
	}
	tok, err := s.sign(env)
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	got, err := s.verify(tok)
	if err != nil {
		t.Fatalf("verify: %v", err)
	}
	if got.Op != env.Op || got.Limit != env.Limit || got.LastID != env.LastID {
		t.Fatalf("round trip mismatch: %+v", got)
	}
	if !got.withScope([]string{"v2", "v1"}) {
		t.Fatalf("scope order-insensitive match failed")
	}
	if got.withScope([]string{"v1"}) {
		t.Fatalf("subset scope must not match")
	}
}

func TestCursorSigner_TamperRejected(t *testing.T) {
	s := newCursorSigner()
	tok, err := s.sign(cursorEnvelope{Op: "list_dead", Limit: 100, LastID: "n-1"})
	if err != nil {
		t.Fatalf("sign: %v", err)
	}
	// Flip a character inside the payload portion.
	tampered := tok[:len(tok)-4] + "AAAA"
	if _, err := s.verify(tampered); err == nil {
		t.Fatalf("tampered cursor accepted")
	}
	if _, err := s.verify("not-a-cursor"); err == nil {
		t.Fatalf("garbage cursor accepted")
	}
	// A different signer (process restart) must reject old cursors.
	other := newCursorSigner()
	if _, err := other.verify(tok); err == nil {
		t.Fatalf("cursor signed by another key accepted")
	}
}

func TestCursorSigner_MalformedParts(t *testing.T) {
	s := newCursorSigner()
	if _, err := s.verify(strings.Repeat("A", 16)); err == nil {
		t.Fatalf("single-part cursor accepted")
	}
}
