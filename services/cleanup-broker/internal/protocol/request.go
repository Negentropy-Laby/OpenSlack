// Package protocol defines the bounded, closed client wire contract. Identity
// in a request is a claim to compare with SO_PEERCRED, never authentication.
package protocol

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"regexp"
	"strconv"

	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/permit"
)

const MaxMessage = 16 << 10

var ErrRequest = errors.New("BROKER_REQUEST_INVALID")
var agentIdentifier = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$`)
var recordID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
var repository = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}/[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$`)
var remoteName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$`)

type Request struct {
	Schema      string `json:"schema"`
	Mode        string `json:"mode"`
	AgentID     string `json:"agentId"`
	PrincipalID string `json:"principalId"`
	RuntimeUID  string `json:"runtimeUid"`
	RunID       string `json:"runId"`
	Repo        string `json:"repo"`
	Remote      string `json:"remote"`
	PRNumber    uint64 `json:"prNumber"`
	PermitID    string `json:"permitId"`
	OperationID string `json:"operationId"`
}

func (r Request) Subject() permit.Subject {
	return permit.Subject{PrincipalID: r.PrincipalID, RuntimeUID: r.RuntimeUID, RunID: r.RunID}
}

func Decode(data []byte) (Request, error) {
	var r Request
	if len(data) > MaxMessage {
		return r, ErrRequest
	}
	// The strict permit decoder checks duplicate/unknown keys and Unicode. Its
	// required-field rule is applied to separate preview and operation shapes.
	var shape struct {
		Schema      string `json:"schema"`
		Mode        string `json:"mode"`
		AgentID     string `json:"agentId"`
		PrincipalID string `json:"principalId"`
		RuntimeUID  string `json:"runtimeUid"`
		RunID       string `json:"runId"`
		Repo        string `json:"repo"`
		Remote      string `json:"remote"`
		PRNumber    uint64 `json:"prNumber"`
		PermitID    string `json:"permitId"`
	}
	var probe struct {
		Mode string `json:"mode"`
	}
	if json.Unmarshal(data, &probe) != nil {
		return r, ErrRequest
	}
	if probe.Mode == "preview" {
		if permit.Decode(data, &shape) != nil {
			return r, ErrRequest
		}
		if json.Unmarshal(data, &r) != nil {
			return r, ErrRequest
		}
	} else if permit.Decode(data, &r) != nil {
		return r, ErrRequest
	}
	if r.Schema != "openslack.cleanup_request.v1" || !agentIdentifier.MatchString(r.AgentID) || !permit.ValidSubject(r.Subject()) || !repository.MatchString(r.Repo) || !remoteName.MatchString(r.Remote) || !recordID.MatchString(r.PermitID) || r.PRNumber == 0 || r.PRNumber > 9007199254740991 {
		return Request{}, ErrRequest
	}
	if r.Mode != "preview" && r.Mode != "execute" && r.Mode != "status" {
		return Request{}, ErrRequest
	}
	if r.Mode != "preview" && !agentIdentifier.MatchString(r.OperationID) {
		return Request{}, ErrRequest
	}
	return r, nil
}

// Digest encodes only ASCII validated request fields, in a fixed JSON array.
// status addresses the original execution semantics, not a different request.
// Authentication must have matched Subject before this digest is used.
func (r Request) Digest() string {
	data, _ := json.Marshal([]string{"openslack.cleanup_execution_digest.v1", r.AgentID, r.PrincipalID, r.RuntimeUID, r.RunID, r.Repo, r.Remote, strconv.FormatUint(r.PRNumber, 10), r.PermitID, r.OperationID})
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

type Response struct {
	Schema           string `json:"schema"`
	Mode             string `json:"mode"`
	PermitID         string `json:"permitId"`
	OperationID      string `json:"operationId,omitempty"`
	PermitState      string `json:"permitState"`
	ClaimRequirement string `json:"claimRequirement"`
	ClaimStatus      string `json:"claimStatus"`
	State            string `json:"state"`
	Attempted        bool   `json:"attempted"`
	AuditStatus      string `json:"auditStatus"`
	Reason           string `json:"reason"`
}

func Reply(r Request, state, reason string) Response {
	return Response{Schema: "openslack.cleanup_response.v1", Mode: r.Mode, PermitID: r.PermitID, OperationID: r.OperationID, PermitState: "unknown", ClaimRequirement: "not_required", ClaimStatus: "not_evaluated", State: state, AuditStatus: "NOT_REQUIRED", Reason: reason}
}
