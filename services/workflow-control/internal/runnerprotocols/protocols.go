// Package runnerprotocols is the immutable registry of runner transports that
// the default-off scheduler may negotiate.
package runnerprotocols

import (
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerprotocol"
)

const (
	V1 = runnerprotocol.ProtocolVersion
	V2 = authoritycontract.ProtocolVersion
)

func IsSupported(value string) bool { return value == V1 || value == V2 }

var capabilities = [...]string{"cancel_ack", "effect_receipts", "lease_heartbeat"}

func Capabilities() []string { return append([]string(nil), capabilities[:]...) }

func CapabilitiesMatch(value []string) bool {
	if len(value) != len(capabilities) {
		return false
	}
	for index, capability := range capabilities {
		if value[index] != capability {
			return false
		}
	}
	return true
}

func Enabled(v2 bool) []string {
	if v2 {
		return []string{V1, V2}
	}
	return []string{V1}
}
