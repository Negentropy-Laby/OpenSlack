//go:build linux

// Package peer obtains the principal from kernel-supplied Unix socket peer
// credentials. A request's identity fields can only narrow this mapping.
package peer

import (
	"errors"
	"net"
	"syscall"

	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/permit"
)

var ErrUnauthorized = errors.New("PEER_UNAUTHORIZED")

type Binding struct {
	UID     uint32
	AgentID string
	Subject permit.Subject
}

// Bindings is an owned copy of the administrator mapping. There is exactly one
// run per OS UID. Sharing a UID between runs cannot provide run isolation.
type Bindings struct {
	brokerUID uint32
	byUID     map[uint32]Binding
}

func NewBindings(brokerUID uint32, entries []Binding) (*Bindings, error) {
	b := &Bindings{brokerUID: brokerUID, byUID: make(map[uint32]Binding)}
	seen := map[permit.Subject]bool{}
	for _, e := range entries {
		if e.UID == 0 || e.UID == brokerUID || e.AgentID == "" || len(e.AgentID) > 128 || !permit.ValidSubject(e.Subject) {
			return nil, ErrUnauthorized
		}
		if _, exists := b.byUID[e.UID]; exists || seen[e.Subject] {
			return nil, ErrUnauthorized
		}
		b.byUID[e.UID] = e
		seen[e.Subject] = true
	}
	return b, nil
}

// Authenticate reads SO_PEERCRED on the connected Unix stream, not a header,
// JSON UID, environment variable, socket filename or caller-supplied PID.
func (b *Bindings) Authenticate(conn *net.UnixConn, agentID string, claimed permit.Subject) (permit.Subject, error) {
	if b == nil || conn == nil {
		return permit.Subject{}, ErrUnauthorized
	}
	raw, err := conn.SyscallConn()
	if err != nil {
		return permit.Subject{}, ErrUnauthorized
	}
	var cred *syscall.Ucred
	var socketErr error
	if err = raw.Control(func(fd uintptr) {
		cred, socketErr = syscall.GetsockoptUcred(int(fd), syscall.SOL_SOCKET, syscall.SO_PEERCRED)
	}); err != nil || socketErr != nil || cred == nil {
		return permit.Subject{}, ErrUnauthorized
	}
	return b.match(cred.Uid, agentID, claimed)
}

func (b *Bindings) match(uid uint32, agentID string, claimed permit.Subject) (permit.Subject, error) {
	entry, ok := b.byUID[uid]
	if uid == 0 || uid == b.brokerUID || !ok || entry.AgentID != agentID || entry.Subject != claimed {
		return permit.Subject{}, ErrUnauthorized
	}
	return entry.Subject, nil
}
