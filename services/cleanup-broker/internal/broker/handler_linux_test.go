//go:build linux

package broker

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http/httptest"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/config"
	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/ledger"
	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/peer"
	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/permit"
	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/protocol"
	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/source"
)

type fakeRuntime struct{ stopped atomic.Bool }

func (f *fakeRuntime) Check() error {
	if f.stopped.Load() {
		return errors.New("stopped")
	}
	return nil
}
func (f *fakeRuntime) Admit(string, string) error { return f.Check() }
func (f *fakeRuntime) StopAdmission()             { f.stopped.Store(true) }

type fakeSource struct {
	mu     sync.Mutex
	bundle source.Bundle
	calls  int
	fail   bool
	change func(int, *source.Bundle)
}

func (f *fakeSource) Acquire(ctx context.Context, _ string, _ string) (source.Bundle, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	f.calls++
	if f.fail || ctx.Err() != nil {
		return source.Bundle{}, errors.New("source")
	}
	b := copyBundle(f.bundle)
	if f.change != nil {
		f.change(f.calls, &b)
	}
	return b, nil
}

type fakeRunner struct {
	preflights atomic.Int32
	executions atomic.Int32
	preflight  func(context.Context, protocol.Request, source.Bundle) (Preflight, error)
	execute    func(context.Context, Execution, func(context.Context) error) (Outcome, error)
}

func (f *fakeRunner) Preflight(ctx context.Context, r protocol.Request, b source.Bundle) (Preflight, error) {
	f.preflights.Add(1)
	if f.preflight != nil {
		return f.preflight(ctx, r, b)
	}
	return Preflight{Target: b.Permit.Target, State: "CLEANUP_READY", Reason: "CLEANUP_READY"}, nil
}
func (f *fakeRunner) Execute(ctx context.Context, e Execution, admit func(context.Context) error) (Outcome, error) {
	f.executions.Add(1)
	if f.execute != nil {
		return f.execute(ctx, e, admit)
	}
	if err := admit(ctx); err != nil {
		return Outcome{}, err
	}
	return Outcome{State: "DELETED", Reason: "CLEANUP_DELETED", Attempted: true}, nil
}

func fixture(t *testing.T) (*Handler, *fakeSource, *fakeRunner, protocol.Request) {
	t.Helper()
	l, err := ledger.Open(filepath.Join(t.TempDir(), "ledger"))
	if err != nil {
		t.Fatal(err)
	}
	subject := permit.Subject{PrincipalID: "principal:worker", RuntimeUID: "uid-1", RunID: "run-1"}
	r := protocol.Request{Schema: "openslack.cleanup_request.v1", Mode: "execute", AgentID: "worker", PrincipalID: subject.PrincipalID, RuntimeUID: subject.RuntimeUID, RunID: subject.RunID, Repo: "owner/repo", Remote: "qualification", PRNumber: 42, PermitID: "permit-1", OperationID: "op-1"}
	instance := permit.Instance{BrokerID: "broker-1", Generation: "1", BootNonce: strings.Repeat("b", 64)}
	p := permit.Permit{Schema: permit.Schema, ID: r.PermitID, Action: permit.Action, IssuerTrustDomain: "admin", Subject: subject, Target: permit.Target{WorkspaceID: "workspace", Host: "github.com", RepositoryID: "123", Repository: r.Repo, PRNodeID: "PR_1", PRNumber: r.PRNumber, Ref: "refs/heads/topic", ExpectedSHA: strings.Repeat("a", 40)}, TaskRef: "qualification-1", Instance: instance, NotBefore: time.Now().Add(-time.Minute), ExpiresAt: time.Now().Add(time.Hour), MaxUses: 1}
	s := &fakeSource{bundle: source.Bundle{Commit: strings.Repeat("c", 40), Policy: permit.Policy{Schema: permit.PolicySchema, Basis: permit.Basis, Action: permit.Action, IssuerTrustDomain: "admin", ActiveInstance: instance}, Permit: p, Registry: []byte("pinned registry"), SourceHashes: map[string]string{"policy": strings.Repeat("d", 64), "permit": strings.Repeat("e", 64), "registry": strings.Repeat("f", 64)}}}
	runner := &fakeRunner{}
	h := newHandler(dependencies{config: config.Config{BrokerID: "broker-1", WorkspaceID: "workspace", AllowedRemotes: []string{"qualification"}, GitHubApp: config.GitHubApp{Owner: "owner", Repo: "repo"}, Artifacts: config.Artifacts{NodeSHA256: strings.Repeat("a", 64), ExecutorSHA256: strings.Repeat("b", 64), GitSHA256: strings.Repeat("c", 64)}}, bootNonce: instance.BootNonce, ledger: l, runtime: &fakeRuntime{}, source: s, runner: runner, now: time.Now, timeout: time.Second, authenticate: func(_ *net.UnixConn, agent string, claimed permit.Subject) (permit.Subject, error) {
		if agent != r.AgentID || claimed != subject {
			return permit.Subject{}, peer.ErrUnauthorized
		}
		return subject, nil
	}})
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		if err := h.Drain(ctx); err != nil {
			t.Error(err)
		}
		l.Close()
	})
	return h, s, runner, r
}
func call(t *testing.T, h *Handler, r protocol.Request) protocol.Response {
	t.Helper()
	data, _ := json.Marshal(r)
	if r.Mode == "preview" {
		var obj map[string]any
		_ = json.Unmarshal(data, &obj)
		delete(obj, "operationId")
		data, _ = json.Marshal(obj)
	}
	req := httptest.NewRequest("POST", "/v1/cleanup", bytes.NewReader(data))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != 200 {
		t.Fatalf("HTTP %d: %s", w.Code, w.Body.String())
	}
	var result protocol.Response
	if err := json.Unmarshal(w.Body.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	return result
}
func terminal(t *testing.T, h *Handler, r protocol.Request) protocol.Response {
	t.Helper()
	r.Mode = "status"
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		result := call(t, h, r)
		if result.State != "OPERATION_IN_PROGRESS" {
			return result
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("operation did not terminate")
	return protocol.Response{}
}

func TestExecutionReceiptAndReplayWithoutAuthority(t *testing.T) {
	h, s, runner, r := fixture(t)
	if result := call(t, h, r); result.State != "OPERATION_IN_PROGRESS" {
		t.Fatal(result)
	}
	result := terminal(t, h, r)
	if result.State != "DELETED" || result.PermitState != "consumed" || !result.Attempted || result.AuditStatus != "RECORDED" {
		t.Fatal(result)
	}
	s.mu.Lock()
	s.fail = true
	calls := s.calls
	s.mu.Unlock()
	h.StopAdmission()
	if repeat := call(t, h, r); repeat.State != "DELETED" || repeat.Mode != "execute" {
		t.Fatal(repeat)
	}
	status := r
	status.Mode = "status"
	if result := call(t, h, status); result.State != "DELETED" {
		t.Fatal(result)
	}
	s.mu.Lock()
	if s.calls != calls {
		t.Error("replay read authority")
	}
	s.mu.Unlock()
	if runner.executions.Load() != 1 {
		t.Fatal("replayed send")
	}
	record, _, err := h.deps.ledger.Lookup(r.OperationID)
	if err != nil || !record.SendAdmitted {
		t.Fatalf("%+v %v", record, err)
	}
	var intent protocol.Intent
	if json.Unmarshal(record.Intent, &intent) != nil || intent.Request != r || intent.Target != s.bundle.Permit.Target || intent.GovernanceCommit != s.bundle.Commit || len(intent.Artifacts) != 3 {
		t.Fatal("intent incomplete")
	}
}

func TestStatusBindingAndNotFoundNeverReadAuthority(t *testing.T) {
	h, s, runner, r := fixture(t)
	r.Mode = "status"
	if result := call(t, h, r); result.State != "OPERATION_NOT_FOUND" {
		t.Fatal(result)
	}
	r.Mode = "execute"
	call(t, h, r)
	terminal(t, h, r)
	s.mu.Lock()
	calls := s.calls
	s.fail = true
	s.mu.Unlock()
	r.Mode = "status"
	r.Remote = "different"
	if result := call(t, h, r); result.State != "BLOCKED_AUTHORIZATION" {
		t.Fatal(result)
	}
	s.mu.Lock()
	if s.calls != calls {
		t.Error("status read source")
	}
	s.mu.Unlock()
	if runner.executions.Load() != 1 {
		t.Fatal("status ran worker")
	}
}

func TestNoRunnerAndPreviewNeverReserve(t *testing.T) {
	for _, mode := range []string{"preview", "execute"} {
		t.Run(mode, func(t *testing.T) {
			h, s, _, r := fixture(t)
			r.Mode = mode
			h.deps.runner = nil
			if result := call(t, h, r); result.Reason != "TRUSTED_EXECUTOR_NOT_CONNECTED" {
				t.Fatal(result)
			}
			if _, found, _ := h.deps.ledger.Lookup(r.OperationID); found {
				t.Fatal("reserved without executor")
			}
			if s.calls != 0 {
				t.Fatal("source queried without executor")
			}
		})
	}
	h, _, runner, r := fixture(t)
	r.Mode = "preview"
	if result := call(t, h, r); result.State != "CLEANUP_READY" || result.PermitState != "issued" {
		t.Fatal(result)
	}
	if _, found, _ := h.deps.ledger.Lookup(r.OperationID); found || runner.executions.Load() != 0 {
		t.Fatal("preview wrote/spawned")
	}
}

func TestRealPeerContextCannotBeForgedByJSON(t *testing.T) {
	h, s, runner, r := fixture(t)
	bindings, err := peer.NewBindings(1234, nil)
	if err != nil {
		t.Fatal(err)
	}
	h.deps.authenticate = bindings.Authenticate
	if result := call(t, h, r); result.State != "BLOCKED_AUTHORIZATION" || result.Reason != "PEER_UNAUTHORIZED" {
		t.Fatal(result)
	}
	if s.calls != 0 || runner.executions.Load() != 0 {
		t.Fatal("unauthenticated work")
	}
	listener, err := net.ListenUnix("unix", &net.UnixAddr{Name: filepath.Join(t.TempDir(), "peer.sock"), Net: "unix"})
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	client, err := net.DialUnix("unix", nil, listener.Addr().(*net.UnixAddr))
	if err != nil {
		t.Fatal(err)
	}
	defer client.Close()
	server, err := listener.AcceptUnix()
	if err != nil {
		t.Fatal(err)
	}
	defer server.Close()
	ctx := h.ConnContext(context.Background(), server)
	if ctx.Value(connectionKey{}) != server {
		t.Fatal("connection context lost actual socket")
	}
	if _, err := bindings.Authenticate(ctx.Value(connectionKey{}).(*net.UnixConn), r.AgentID, r.Subject()); err == nil {
		t.Fatal("unmapped OS peer accepted")
	}
}

func TestFinalAuthorityChangesDenySendButUnrelatedCommitPasses(t *testing.T) {
	for _, change := range []string{"hash", "revoked", "registry", "commit", "expired"} {
		t.Run(change, func(t *testing.T) {
			h, s, _, r := fixture(t)
			s.change = func(n int, b *source.Bundle) {
				if n < 2 {
					return
				}
				switch change {
				case "hash":
					b.SourceHashes["registry"] = "changed"
				case "revoked":
					b.Permit.Revoked = true
				case "registry":
					b.Registry = []byte("changed")
				case "commit":
					b.Commit = strings.Repeat("d", 40)
				case "expired":
					b.Permit.ExpiresAt = time.Now().Add(-time.Second)
				}
			}
			call(t, h, r)
			result := terminal(t, h, r)
			record, _, _ := h.deps.ledger.Lookup(r.OperationID)
			if change == "commit" {
				if result.State != "DELETED" || !record.SendAdmitted {
					t.Fatal(result)
				}
				var observed struct {
					GovernanceCommit string            `json:"governanceCommit"`
					SourceHashes     map[string]string `json:"sourceHashes"`
					Artifacts        map[string]string `json:"artifacts"`
				}
				if json.Unmarshal(record.SendObservation, &observed) != nil || observed.GovernanceCommit != strings.Repeat("d", 40) || len(observed.SourceHashes) != 3 || !reflect.DeepEqual(observed.Artifacts, h.deps.artifacts) {
					t.Fatal("final authority observation missing")
				}
			} else if result.State != "BLOCKED_AUTHORIZATION" || record.SendAdmitted || result.Attempted {
				t.Fatal(result)
			}
		})
	}
}

func TestTaskViewExpiresDuringPreparationOrSendJournal(t *testing.T) {
	for _, lastCheck := range []int32{1, 2} {
		t.Run(fmt.Sprint(lastCheck), func(t *testing.T) {
			h, _, worker, r := fixture(t)
			var checks, pushes atomic.Int32
			h.deps.checkTaskView = func(target permit.Target, now time.Time) error {
				if target.Repository != r.Repo || now.IsZero() {
					t.Error("target/time missing")
				}
				if checks.Add(1) >= lastCheck {
					return ErrSendDenied
				}
				return nil
			}
			worker.execute = func(ctx context.Context, _ Execution, admit func(context.Context) error) (Outcome, error) {
				if err := admit(ctx); err != nil {
					return Outcome{}, err
				}
				pushes.Add(1)
				return Outcome{State: "DELETED", Reason: "CLEANUP_DELETED", Attempted: true}, nil
			}
			call(t, h, r)
			result := terminal(t, h, r)
			if pushes.Load() != 0 || result.Attempted || result.State != "BLOCKED_AUTHORIZATION" {
				t.Fatalf("expired task view reached send: %+v", result)
			}
			record, _, err := h.deps.ledger.Lookup(r.OperationID)
			if err != nil || record.SendAdmitted != (lastCheck == 2) {
				t.Fatal("send marker order changed")
			}
		})
	}
}

func TestResourceChangeDuringTransportWaitStopsFinalGrant(t *testing.T) {
	for _, change := range []string{"protected", "dependency", "unmerged", "ref-drift", "query-failed", "absent"} {
		t.Run(change, func(t *testing.T) {
			h, _, worker, r := fixture(t)
			var prepared, pushes atomic.Bool
			worker.preflight = func(_ context.Context, _ protocol.Request, b source.Bundle) (Preflight, error) {
				result := Preflight{Target: b.Permit.Target, State: "CLEANUP_READY", Reason: "CLEANUP_READY"}
				if prepared.Load() {
					if change == "query-failed" {
						return Preflight{}, errors.New("unavailable")
					}
					result.State = "BLOCKED"
					if change == "absent" {
						result.State = "ALREADY_ABSENT"
					}
					if change == "ref-drift" {
						result.State = "CLEANUP_READY"
						result.Target.ExpectedSHA = strings.Repeat("f", 40)
					}
				}
				return result, nil
			}
			worker.execute = func(ctx context.Context, _ Execution, admit func(context.Context) error) (Outcome, error) {
				prepared.Store(true)
				if err := admit(ctx); err != nil {
					return Outcome{}, err
				}
				pushes.Store(true)
				return Outcome{State: "DELETED", Attempted: true}, nil
			}
			call(t, h, r)
			result := terminal(t, h, r)
			record, _, _ := h.deps.ledger.Lookup(r.OperationID)
			if pushes.Load() || result.Attempted || record.SendAdmitted || worker.preflights.Load() != 2 {
				t.Fatalf("resource change passed send: %+v", result)
			}
		})
	}
}

func TestDuplicateSendGateAndUntrustedOutcome(t *testing.T) {
	h, _, runner, r := fixture(t)
	runner.execute = func(ctx context.Context, _ Execution, admit func(context.Context) error) (Outcome, error) {
		if err := admit(ctx); err != nil {
			return Outcome{}, err
		}
		if err := admit(ctx); !errors.Is(err, ErrSendDenied) {
			t.Error("second admission passed")
		}
		return Outcome{State: "DELETED", Reason: "CLEANUP_DELETED", Attempted: true}, nil
	}
	call(t, h, r)
	if result := terminal(t, h, r); result.State != "DELETED" {
		t.Fatal(result)
	}
	h2, _, runner2, r2 := fixture(t)
	runner2.execute = func(context.Context, Execution, func(context.Context) error) (Outcome, error) {
		return Outcome{State: "DELETED", Reason: "CLEANUP_DELETED", Attempted: true}, nil
	}
	call(t, h2, r2)
	if result := terminal(t, h2, r2); result.State != "RECONCILIATION_REQUIRED" {
		t.Fatal(result)
	}
}

func TestClientDisconnectAndConcurrentRepeatDoNotCancelOrDuplicate(t *testing.T) {
	h, _, runner, r := fixture(t)
	started := make(chan struct{})
	release := make(chan struct{})
	runner.execute = func(ctx context.Context, _ Execution, admit func(context.Context) error) (Outcome, error) {
		close(started)
		<-release
		if ctx.Err() != nil {
			t.Error("client cancellation leaked")
		}
		if err := admit(ctx); err != nil {
			return Outcome{}, err
		}
		return Outcome{State: "DELETED", Reason: "CLEANUP_DELETED", Attempted: true}, nil
	}
	data, _ := json.Marshal(r)
	ctx, cancel := context.WithCancel(context.Background())
	req := httptest.NewRequest("POST", "/v1/cleanup", bytes.NewReader(data)).WithContext(ctx)
	req.Header.Set("Content-Type", "application/json")
	h.ServeHTTP(httptest.NewRecorder(), req)
	cancel()
	<-started
	if repeat := call(t, h, r); repeat.State != "OPERATION_IN_PROGRESS" {
		t.Fatal(repeat)
	}
	close(release)
	if result := terminal(t, h, r); result.State != "DELETED" {
		t.Fatal(result)
	}
	if runner.executions.Load() != 1 {
		t.Fatal("duplicate execution")
	}
}

func TestExpiredDuringWorkerWaitAndUnknownAfterAdmission(t *testing.T) {
	for _, afterAdmission := range []bool{false, true} {
		t.Run(fmtBool(afterAdmission), func(t *testing.T) {
			h, _, runner, r := fixture(t)
			runner.execute = func(ctx context.Context, _ Execution, admit func(context.Context) error) (Outcome, error) {
				if afterAdmission {
					if err := admit(ctx); err != nil {
						return Outcome{}, err
					}
				} else {
					h.StopAdmission()
					if err := admit(ctx); err == nil {
						t.Error("stopped gate admitted")
					}
				}
				return Outcome{}, errors.New("private worker failure")
			}
			call(t, h, r)
			result := terminal(t, h, r)
			if afterAdmission {
				if result.State != "RECONCILIATION_REQUIRED" || !result.Attempted {
					t.Fatal(result)
				}
			} else if result.State != "BLOCKED_AUTHORIZATION" || result.Attempted {
				t.Fatal(result)
			}
		})
	}
}
func fmtBool(b bool) string {
	if b {
		return "after"
	}
	return "before"
}

func TestConcurrentExecutionReplaysOriginalIntentAcrossMainAdvance(t *testing.T) {
	h, s, runner, r := fixture(t)
	s.change = func(n int, b *source.Bundle) { b.Commit = fmt.Sprintf("%040x", n) }
	ready := make(chan struct{}, 2)
	release := make(chan struct{})
	runner.preflight = func(_ context.Context, _ protocol.Request, b source.Bundle) (Preflight, error) {
		ready <- struct{}{}
		<-release
		return Preflight{Target: b.Permit.Target, State: "CLEANUP_READY", Reason: "CLEANUP_READY"}, nil
	}
	var wg sync.WaitGroup
	results := make(chan protocol.Response, 2)
	for i := 0; i < 2; i++ {
		wg.Add(1)
		go func() { defer wg.Done(); results <- call(t, h, r) }()
	}
	<-ready
	<-ready
	close(release)
	wg.Wait()
	close(results)
	for result := range results {
		if result.State != "OPERATION_IN_PROGRESS" && result.State != "DELETED" {
			t.Fatal(result)
		}
	}
	if result := terminal(t, h, r); result.State != "DELETED" {
		t.Fatal(result)
	}
	if runner.executions.Load() != 1 {
		t.Fatal("duplicate worker")
	}
}

func TestExpiryDuringPreparationDeniesAdmission(t *testing.T) {
	h, s, runner, r := fixture(t)
	var clock atomic.Int64
	clock.Store(time.Now().UnixNano())
	h.deps.now = func() time.Time { return time.Unix(0, clock.Load()) }
	runner.execute = func(ctx context.Context, _ Execution, admit func(context.Context) error) (Outcome, error) {
		clock.Store(s.bundle.Permit.ExpiresAt.UnixNano())
		return Outcome{}, admit(ctx)
	}
	call(t, h, r)
	result := terminal(t, h, r)
	if result.State != "BLOCKED_AUTHORIZATION" || result.Attempted {
		t.Fatal(result)
	}
	record, _, err := h.deps.ledger.Lookup(r.OperationID)
	if err != nil || record.SendAdmitted {
		t.Fatalf("expired send admitted: %+v %v", record, err)
	}
}

func TestRunnerOutcomeAttemptSemantics(t *testing.T) {
	for _, tc := range []struct {
		state     string
		attempted bool
	}{{"DELETED", false}, {"ABSENT_AFTER_ATTEMPT", false}, {"ALREADY_ABSENT", true}, {"BLOCKED_SHA_DRIFT", true}} {
		t.Run(tc.state, func(t *testing.T) {
			h, _, runner, r := fixture(t)
			runner.execute = func(ctx context.Context, _ Execution, admit func(context.Context) error) (Outcome, error) {
				if err := admit(ctx); err != nil {
					return Outcome{}, err
				}
				return Outcome{State: tc.state, Reason: "CLEANUP_RESULT", Attempted: tc.attempted}, nil
			}
			call(t, h, r)
			result := terminal(t, h, r)
			if result.State != "RECONCILIATION_REQUIRED" || !result.Attempted {
				t.Fatal(result)
			}
			if h.deps.runtime.Check() == nil {
				t.Fatal("invalid trusted runner not poisoned")
			}
		})
	}
}

func TestResourcePreflightRejectionPreservesReasonWithoutReservation(t *testing.T) {
	h, _, runner, r := fixture(t)
	runner.preflight = func(_ context.Context, _ protocol.Request, b source.Bundle) (Preflight, error) {
		return Preflight{Target: b.Permit.Target, State: "BLOCKED_BRANCH_RESERVED", Reason: "CLEANUP_BRANCH_PROTECTED"}, nil
	}
	result := call(t, h, r)
	if result.State != "BLOCKED_BRANCH_RESERVED" || result.Reason != "CLEANUP_BRANCH_PROTECTED" {
		t.Fatal(result)
	}
	if _, found, _ := h.deps.ledger.Lookup(r.OperationID); found || runner.executions.Load() != 0 {
		t.Fatal("preflight rejection reserved/executed")
	}
}
