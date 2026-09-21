package protocol

import "github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/permit"

// Intent is durable evidence, not executable input recovered after restart.
type Intent struct {
	Schema           string            `json:"schema"`
	Request          Request           `json:"request"`
	Target           permit.Target     `json:"target"`
	Subject          permit.Subject    `json:"subject"`
	Instance         permit.Instance   `json:"instance"`
	GovernanceCommit string            `json:"governanceCommit"`
	SourceHashes     map[string]string `json:"sourceHashes"`
	Artifacts        map[string]string `json:"artifacts"`
}
