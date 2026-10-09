//go:build linux

package peer

import (
	"net"
	"os"
	"path/filepath"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/permit"
)

func TestMappingBindsExactRunAndOwnsInput(t *testing.T) {
	s := permit.Subject{PrincipalID: "agent:cleanup", RuntimeUID: "runtime-1", RunID: "run-1"}
	entries := []Binding{{UID: 1001, AgentID: "cleanup", Subject: s}}
	b, err := NewBindings(1002, entries)
	if err != nil {
		t.Fatal(err)
	}
	entries[0].Subject.RunID = "changed"
	if got, err := b.match(1001, "cleanup", s); err != nil || got != s {
		t.Fatalf("%v %v", got, err)
	}
	changed := s
	changed.RunID = "run-2"
	for _, c := range []struct {
		uid     uint32
		agent   string
		subject permit.Subject
	}{
		{0, "cleanup", s}, {1002, "cleanup", s}, {1003, "cleanup", s}, {1001, "other", s}, {1001, "cleanup", changed},
	} {
		if _, err := b.match(c.uid, c.agent, c.subject); err == nil {
			t.Fatal("unauthorized mapping accepted")
		}
	}
}

func TestRejectsSharedOrPrivilegedIdentity(t *testing.T) {
	s := permit.Subject{PrincipalID: "agent:cleanup", RuntimeUID: "runtime-1", RunID: "run-1"}
	for _, entries := range [][]Binding{
		{{UID: 0, AgentID: "cleanup", Subject: s}}, {{UID: 1002, AgentID: "cleanup", Subject: s}},
		{{UID: 1001, AgentID: "cleanup", Subject: s}, {UID: 1001, AgentID: "other", Subject: s}},
		{{UID: 1001, AgentID: "cleanup", Subject: s}, {UID: 1003, AgentID: "cleanup", Subject: s}},
	} {
		if _, err := NewBindings(1002, entries); err == nil {
			t.Fatal("unsafe mapping accepted")
		}
	}
}

func TestRealUnixPeerCannotClaimAnotherUID(t *testing.T) {
	path := filepath.Join(t.TempDir(), "peer.sock")
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	client, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: path, Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	server, err := listener.AcceptUnix()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	s := permit.Subject{PrincipalID: "agent:cleanup", RuntimeUID: "runtime-1", RunID: "run-1"}
	// A mapping for a UID different from this test process must not authenticate
	// it, even when every caller-supplied identity field matches the mapping.
	uid := uint32(os.Getuid()) + 10000
	b, err := NewBindings(uid+1, []Binding{{UID: uid, AgentID: "cleanup", Subject: s}})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.Authenticate(server, "cleanup", s); err == nil {
		t.Fatal("claimed identity replaced kernel peer")
	}
	// The broker's own UID is denied regardless of request identity.
	b, err = NewBindings(uint32(os.Getuid()), nil)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := b.Authenticate(server, "cleanup", s); err == nil {
		t.Fatal("broker peer accepted")
	}
}
