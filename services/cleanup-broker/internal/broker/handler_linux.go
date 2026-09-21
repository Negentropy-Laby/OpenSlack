//go:build linux

// Package broker joins peer authentication, fixed-source authority, durable
// spending and a trusted runner. Neither caller JSON nor a successful preview
// is an execution capability.
package broker

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"reflect"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/config"
	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/ledger"
	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/lifecycle"
	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/peer"
	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/permit"
	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/protocol"
	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/source"
)

var ErrUnavailable = errors.New("BROKER_UNAVAILABLE")
var ErrSendDenied = errors.New("BROKER_SEND_DENIED")
var safeCode = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,127}$`)

// RequestTimeout bounds authority lookup and preparation, including work that
// can continue independently after the initial operation receipt is returned.
const RequestTimeout = 60 * time.Second

type Preflight struct {
	Target permit.Target
	State  string
	Reason string
}
type Outcome struct {
	State, Reason string
	Attempted     bool
}
type Execution struct {
	Request  protocol.Request
	Bundle   source.Bundle
	Target   permit.Target
	Instance permit.Instance
}

// Runner is an internal trusted process adapter, not a client-supplied callback.
// Preflight must validate the pinned registry and live resource identity.
// Execute must recheck resource gates, prepare auth/transport, then use admit
// immediately before sending. The production adapter owns the private worker
// handshake; ordinary caller data must never provide its implementation.
type Runner interface {
	Preflight(context.Context, protocol.Request, source.Bundle) (Preflight, error)
	Execute(context.Context, Execution, func(context.Context) error) (Outcome, error)
}
type authority interface {
	Acquire(context.Context, string, string) (source.Bundle, error)
}
type runtimeGate interface {
	Check() error
	Admit(string, string) error
	StopAdmission()
}
type dependencies struct {
	config        config.Config
	artifacts     map[string]string
	checkTaskView func(permit.Target, time.Time) error
	bootNonce     string
	ledger        *ledger.Ledger
	runtime       runtimeGate
	source        authority
	runner        Runner
	authenticate  func(*net.UnixConn, string, permit.Subject) (permit.Subject, error)
	now           func() time.Time
	timeout       time.Duration
}
type connectionKey struct{}
type Handler struct {
	deps     dependencies
	mu       sync.Mutex
	inflight map[string]bool
	wg       sync.WaitGroup
	stopped  bool
}

// New accepts only already-pinned installation objects and a fixed-source reader.
// A nil runner is a fail-closed status-only installation, never an executable one.
func New(snapshot *config.Snapshot, runtime *lifecycle.Runtime, reader *source.Reader, runner Runner) (*Handler, error) {
	if snapshot == nil || runtime == nil || runtime.Ledger == nil || (runner != nil && snapshot.CheckUnchanged() != nil) {
		return nil, ErrUnavailable
	}
	c := snapshot.Config()
	entries := make([]peer.Binding, len(c.PeerBindings))
	for i, p := range c.PeerBindings {
		entries[i] = peer.Binding{UID: p.UID, AgentID: p.AgentID, Subject: p.Subject}
	}
	bindings, err := peer.NewBindings(c.UID, entries)
	if err != nil {
		return nil, ErrUnavailable
	}
	checkTaskView := func(target permit.Target, now time.Time) error {
		view, err := snapshot.ReadTaskView()
		if err != nil || view.WorkspaceID != target.WorkspaceID || view.Repository != target.Repository || view.RepositoryID != target.RepositoryID || now.Before(view.NotBefore) || !now.Before(view.ExpiresAt) {
			return ErrSendDenied
		}
		return nil
	}
	return newHandler(dependencies{config: c, artifacts: snapshot.EvidenceHashes(), checkTaskView: checkTaskView, bootNonce: runtime.BootNonce, ledger: runtime.Ledger, runtime: runtime, source: reader, runner: runner, authenticate: bindings.Authenticate, now: time.Now, timeout: RequestTimeout}), nil
}
func newHandler(d dependencies) *Handler {
	if d.artifacts == nil {
		d.artifacts = map[string]string{"node": d.config.Artifacts.NodeSHA256, "executor": d.config.Artifacts.ExecutorSHA256, "git": d.config.Artifacts.GitSHA256}
	}
	return &Handler{deps: d, inflight: map[string]bool{}}
}

// ConnContext must be installed on the HTTP server. Only its actual Unix
// connection enters authentication; headers and JSON never supply peer IDs.
func (h *Handler) ConnContext(ctx context.Context, conn net.Conn) context.Context {
	if unix, ok := conn.(*net.UnixConn); ok {
		return context.WithValue(ctx, connectionKey{}, unix)
	}
	return ctx
}
func (h *Handler) StopAdmission() {
	h.mu.Lock()
	h.stopped = true
	h.mu.Unlock()
	h.deps.runtime.StopAdmission()
}
func (h *Handler) Drain(ctx context.Context) error {
	h.StopAdmission()
	done := make(chan struct{})
	go func() { h.wg.Wait(); close(done) }()
	select {
	case <-done:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

func subjectKey(r protocol.Request) string {
	b, _ := json.Marshal([]string{r.AgentID, r.PrincipalID, r.RuntimeUID, r.RunID})
	return fmt.Sprintf("%x", sha256.Sum256(b))
}
func (h *Handler) write(w http.ResponseWriter, r protocol.Response) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	_ = json.NewEncoder(w).Encode(r)
}
func denied(r protocol.Request, reason string) protocol.Response {
	return protocol.Reply(r, "BLOCKED_BROKER", reason)
}

func (h *Handler) ServeHTTP(w http.ResponseWriter, request *http.Request) {
	if request.Method != http.MethodPost || request.URL.Path != "/v1/cleanup" || request.URL.RawQuery != "" {
		http.Error(w, "BROKER_REQUEST_INVALID", http.StatusBadRequest)
		return
	}
	if request.Header.Get("Content-Type") != "application/json" || request.Header.Get("Content-Encoding") != "" {
		http.Error(w, "BROKER_REQUEST_INVALID", http.StatusBadRequest)
		return
	}
	data, err := io.ReadAll(io.LimitReader(request.Body, protocol.MaxMessage+1))
	if err != nil {
		http.Error(w, "BROKER_REQUEST_INVALID", http.StatusBadRequest)
		return
	}
	r, err := protocol.Decode(data)
	if err != nil {
		http.Error(w, "BROKER_REQUEST_INVALID", http.StatusBadRequest)
		return
	}
	conn, _ := request.Context().Value(connectionKey{}).(*net.UnixConn)
	subject, err := h.deps.authenticate(conn, r.AgentID, r.Subject())
	if err != nil || subject != r.Subject() {
		h.write(w, protocol.Reply(r, "BLOCKED_AUTHORIZATION", "PEER_UNAUTHORIZED"))
		return
	}
	// Lookup authenticates original request semantics before any authority read.
	if r.Mode != "preview" {
		if result, found := h.lookup(r); found {
			h.write(w, result)
			return
		}
		if r.Mode == "status" {
			h.write(w, protocol.Reply(r, "OPERATION_NOT_FOUND", "OPERATION_NOT_FOUND"))
			return
		}
	}
	h.mu.Lock()
	stopped := h.stopped
	h.mu.Unlock()
	if stopped || h.deps.runtime.Check() != nil {
		h.write(w, denied(r, "BROKER_ADMISSION_STOPPED"))
		return
	}
	if h.deps.runner == nil {
		h.write(w, denied(r, "TRUSTED_EXECUTOR_NOT_CONNECTED"))
		return
	}
	if h.deps.source == nil {
		h.write(w, denied(r, "GOVERNANCE_EVIDENCE_UNAVAILABLE"))
		return
	}
	if !slices.Contains(h.deps.config.AllowedRemotes, r.Remote) || !strings.EqualFold(r.Repo, h.deps.config.GitHubApp.Owner+"/"+h.deps.config.GitHubApp.Repo) {
		h.write(w, protocol.Reply(r, "BLOCKED_AUTHORIZATION", "TARGET_NOT_CONFIGURED"))
		return
	}
	deadline := h.deps.now().Add(h.deps.timeout)
	ctx, cancel := context.WithDeadline(request.Context(), deadline)
	defer cancel()
	bundle, err := h.deps.source.Acquire(ctx, r.PermitID, r.AgentID)
	if err != nil {
		h.write(w, denied(r, "GOVERNANCE_EVIDENCE_UNAVAILABLE"))
		return
	}
	instance := permit.Instance{BrokerID: h.deps.config.BrokerID, Generation: bundle.Policy.ActiveInstance.Generation, BootNonce: h.deps.bootNonce}
	if bundle.Permit.ID != r.PermitID || bundle.Permit.Target.WorkspaceID != h.deps.config.WorkspaceID || bundle.Permit.Target.Repository != r.Repo || bundle.Permit.Target.PRNumber != r.PRNumber || permit.Check(bundle.Permit, bundle.Policy, subject, bundle.Permit.Target, instance, h.deps.now()) != nil || h.deps.runtime.Admit(instance.Generation, instance.BootNonce) != nil {
		h.write(w, protocol.Reply(r, "BLOCKED_AUTHORIZATION", "PERMIT_AUTHORIZATION_FAILED"))
		return
	}
	preflight, err := h.deps.runner.Preflight(ctx, r, copyBundle(bundle))
	if err != nil || !safeCode.MatchString(preflight.Reason) || preflight.Target != bundle.Permit.Target {
		h.write(w, denied(r, "PREFLIGHT_EVIDENCE_UNAVAILABLE"))
		return
	}
	if preflight.State != "CLEANUP_READY" && preflight.State != "ALREADY_ABSENT" {
		if slices.Contains([]string{"BLOCKED_NOT_MERGED", "BLOCKED_BASE_BRANCH", "BLOCKED_FORK", "BLOCKED_BRANCH_RESERVED", "BLOCKED_DEPENDENCY", "BLOCKED_SHA_DRIFT", "BLOCKED_EVIDENCE", "BLOCKED_AUTHORIZATION", "BLOCKED_AUDIT"}, preflight.State) {
			h.write(w, protocol.Reply(r, preflight.State, preflight.Reason))
		} else {
			h.write(w, protocol.Reply(r, "BLOCKED_EVIDENCE", "PREFLIGHT_REJECTED"))
		}
		return
	}
	if ctx.Err() != nil || permit.Check(bundle.Permit, bundle.Policy, subject, preflight.Target, instance, h.deps.now()) != nil {
		h.write(w, protocol.Reply(r, "BLOCKED_AUTHORIZATION", "PERMIT_AUTHORIZATION_FAILED"))
		return
	}
	if r.Mode == "preview" {
		result := protocol.Reply(r, preflight.State, preflight.Reason)
		result.PermitState = "issued"
		h.write(w, result)
		return
	}
	intent := protocol.Intent{Schema: "openslack.cleanup_intent.v1", Request: r, Target: preflight.Target, Subject: subject, Instance: instance, GovernanceCommit: bundle.Commit, SourceHashes: copyBundle(bundle).SourceHashes, Artifacts: h.deps.artifacts}
	intentBytes, err := json.Marshal(intent)
	if err != nil {
		h.write(w, denied(r, "INTENT_INVALID"))
		return
	}
	h.mu.Lock()
	if h.stopped || ctx.Err() != nil || h.deps.runtime.Check() != nil {
		h.mu.Unlock()
		h.write(w, denied(r, "BROKER_ADMISSION_STOPPED"))
		return
	}
	// Another request may have completed preflight and reserved while this
	// request was observing newer authority. Replay the original operation;
	// never compare its durable intent against a newly acquired commit.
	if _, found, lookupErr := h.deps.ledger.Lookup(r.OperationID); found || lookupErr != nil {
		h.mu.Unlock()
		result, _ := h.lookup(r)
		h.write(w, result)
		return
	}
	reservation, err := h.deps.ledger.Reserve(r.PermitID, r.OperationID, r.Digest(), subjectKey(r), intentBytes)
	if err != nil {
		h.mu.Unlock()
		if !errors.Is(err, ledger.ErrConflict) && !errors.Is(err, ledger.ErrInvalid) {
			h.StopAdmission()
		}
		h.write(w, denied(r, "RESERVATION_FAILED"))
		return
	}
	if !reservation.Fresh {
		h.mu.Unlock()
		result, _ := h.lookup(r)
		h.write(w, result)
		return
	}
	h.inflight[r.OperationID] = true
	h.wg.Add(1)
	h.mu.Unlock()
	if bundle.Permit.ExpiresAt.Before(deadline) {
		deadline = bundle.Permit.ExpiresAt
	}
	// The execution owns its lifetime once reservation is durable. Client
	// disconnect cannot cancel it or cause another attempt to be admitted.
	go h.execute(r, bundle, preflight, instance, deadline)
	result := protocol.Reply(r, "OPERATION_IN_PROGRESS", "OPERATION_IN_PROGRESS")
	result.PermitState = "reserved"
	result.AuditStatus = "RECORDED"
	h.write(w, result)
}

func (h *Handler) lookup(r protocol.Request) (protocol.Response, bool) {
	record, found, err := h.deps.ledger.Lookup(r.OperationID)
	if err != nil {
		return denied(r, "LEDGER_UNAVAILABLE"), true
	}
	if !found {
		return protocol.Response{}, false
	}
	if record.PermitID != r.PermitID || record.Subject != subjectKey(r) || record.RequestDigest != r.Digest() {
		return protocol.Reply(r, "BLOCKED_AUTHORIZATION", "OPERATION_BINDING_MISMATCH"), true
	}
	if record.State == ledger.Reserved {
		h.mu.Lock()
		running := h.inflight[r.OperationID]
		h.mu.Unlock()
		state := "RECONCILIATION_REQUIRED"
		if running {
			state = "OPERATION_IN_PROGRESS"
		}
		result := protocol.Reply(r, state, state)
		result.PermitState = "reserved"
		result.Attempted = record.SendAdmitted
		result.AuditStatus = "RECORDED"
		return result, true
	}
	var result protocol.Response
	if json.Unmarshal(record.Receipt, &result) != nil || result.PermitID != r.PermitID || result.OperationID != r.OperationID {
		return denied(r, "RECEIPT_INVALID"), true
	}
	result.Mode = r.Mode
	return result, true
}

func copyBundle(b source.Bundle) source.Bundle {
	b.Registry = append([]byte(nil), b.Registry...)
	hashes := map[string]string{}
	for k, v := range b.SourceHashes {
		hashes[k] = v
	}
	b.SourceHashes = hashes
	return b
}

func (h *Handler) execute(r protocol.Request, bundle source.Bundle, preflight Preflight, instance permit.Instance, deadline time.Time) {
	defer h.wg.Done()
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	defer cancel()
	var gate sync.Mutex
	gateUsed, admitted, gateClosed := false, false, false
	outcome := Outcome{State: "RECONCILIATION_REQUIRED", Reason: "EXECUTION_RESULT_UNKNOWN"}
	defer func() {
		panicked := recover() != nil
		gate.Lock()
		gateClosed = true
		gate.Unlock()
		if panicked {
			outcome = Outcome{State: "RECONCILIATION_REQUIRED", Reason: "EXECUTION_RESULT_UNKNOWN", Attempted: admitted}
		}
		if !safeCode.MatchString(outcome.Reason) {
			outcome = Outcome{State: "RECONCILIATION_REQUIRED", Reason: "EXECUTION_RESULT_INVALID", Attempted: admitted}
		}
		state := ledger.Consumed
		if outcome.State == "RECONCILIATION_REQUIRED" || outcome.State == "ABSENT_AFTER_ATTEMPT" {
			state = ledger.ReconciliationRequired
		}
		result := protocol.Reply(r, outcome.State, outcome.Reason)
		result.Attempted = outcome.Attempted
		result.PermitState = string(state)
		result.AuditStatus = "RECORDED"
		receipt, err := json.Marshal(result)
		if err == nil {
			_, err = h.deps.ledger.Finish(r.OperationID, state, receipt)
		}
		if err != nil {
			h.StopAdmission()
		}
		h.mu.Lock()
		delete(h.inflight, r.OperationID)
		h.mu.Unlock()
	}()
	if preflight.State == "ALREADY_ABSENT" {
		outcome = Outcome{State: "ALREADY_ABSENT", Reason: "CLEANUP_REF_ABSENT"}
		return
	}
	admit := func(sendCtx context.Context) error {
		gate.Lock()
		defer gate.Unlock()
		if gateUsed || gateClosed {
			return ErrSendDenied
		}
		gateUsed = true
		if ctx.Err() != nil || sendCtx.Err() != nil || h.deps.runtime.Check() != nil {
			return ErrSendDenied
		}
		// The sending worker is blocked in the private transport after its
		// token/access/ref preparation. A separate non-sending preview now
		// repeats the real PRMS resource checks before authorizing that push.
		// It has no reservation/grant capability and cannot recursively send.
		latest, err := h.deps.runner.Preflight(ctx, r, copyBundle(bundle))
		if err != nil || latest.State != "CLEANUP_READY" || latest.Target != preflight.Target {
			return ErrSendDenied
		}
		fresh, err := h.deps.source.Acquire(ctx, r.PermitID, r.AgentID)
		if err != nil || !reflect.DeepEqual(fresh.SourceHashes, bundle.SourceHashes) || fresh.Permit != bundle.Permit || fresh.Policy != bundle.Policy || !reflect.DeepEqual(fresh.Registry, bundle.Registry) {
			return ErrSendDenied
		}
		if permit.Check(fresh.Permit, fresh.Policy, r.Subject(), preflight.Target, instance, h.deps.now()) != nil || h.deps.runtime.Admit(instance.Generation, instance.BootNonce) != nil {
			return ErrSendDenied
		}
		if h.deps.checkTaskView != nil && h.deps.checkTaskView(preflight.Target, h.deps.now()) != nil {
			return ErrSendDenied
		}
		observation, err := json.Marshal(struct {
			Schema           string            `json:"schema"`
			GovernanceCommit string            `json:"governanceCommit"`
			SourceHashes     map[string]string `json:"sourceHashes"`
			Artifacts        map[string]string `json:"artifacts"`
		}{"openslack.cleanup_send_observation.v2", fresh.Commit, fresh.SourceHashes, h.deps.artifacts})
		if err != nil {
			return ErrSendDenied
		}
		marked, err := h.deps.ledger.MarkSendAdmitted(r.OperationID, r.Digest(), observation)
		if err != nil || !marked.Fresh {
			if err != nil {
				h.StopAdmission()
			}
			return ErrSendDenied
		}
		if ctx.Err() != nil || sendCtx.Err() != nil || h.deps.runtime.Check() != nil || permit.Check(fresh.Permit, fresh.Policy, r.Subject(), preflight.Target, instance, h.deps.now()) != nil {
			return ErrSendDenied
		}
		if h.deps.checkTaskView != nil && h.deps.checkTaskView(preflight.Target, h.deps.now()) != nil {
			return ErrSendDenied
		}
		admitted = true
		return nil
	}
	returned, err := h.deps.runner.Execute(ctx, Execution{Request: r, Bundle: copyBundle(bundle), Target: preflight.Target, Instance: instance}, admit)
	gate.Lock()
	gateClosed = true
	gate.Unlock()
	if err != nil {
		if !admitted {
			outcome = Outcome{State: "BLOCKED_AUTHORIZATION", Reason: "FINAL_SEND_DENIED"}
		} else {
			outcome = Outcome{State: "RECONCILIATION_REQUIRED", Reason: "EXECUTION_RESULT_UNKNOWN", Attempted: true}
		}
		return
	}
	if returned.Attempted && !admitted || slices.Contains([]string{"DELETED", "ABSENT_AFTER_ATTEMPT"}, returned.State) && (!admitted || !returned.Attempted) || (returned.State == "ALREADY_ABSENT" || strings.HasPrefix(returned.State, "BLOCKED_")) && returned.Attempted {
		h.StopAdmission()
		outcome = Outcome{State: "RECONCILIATION_REQUIRED", Reason: "TRUSTED_RUNNER_PROTOCOL_INVALID", Attempted: admitted}
		return
	}
	if !slices.Contains([]string{"DELETED", "ALREADY_ABSENT", "ABSENT_AFTER_ATTEMPT", "RECONCILIATION_REQUIRED", "FAILED", "BLOCKED_EVIDENCE", "BLOCKED_AUTHORIZATION", "BLOCKED_SHA_DRIFT", "BLOCKED_BRANCH_RESERVED", "BLOCKED_DEPENDENCY", "BLOCKED_AUDIT"}, returned.State) {
		outcome = Outcome{State: "RECONCILIATION_REQUIRED", Reason: "TRUSTED_RUNNER_PROTOCOL_INVALID", Attempted: admitted}
		return
	}
	outcome = returned
}
