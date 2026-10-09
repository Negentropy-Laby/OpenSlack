//go:build linux

package runner

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"os"
	"os/exec"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/broker"
	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/config"
	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/ledger"
	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/permit"
	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/protocol"
	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/source"
)

type fixtureInstallation struct{ changed bool }

func (f *fixtureInstallation) Config() config.Config {
	return config.Config{WorkspaceID: "workspace", GitHubApp: config.GitHubApp{AppID: 1, InstallationID: 2}}
}
func (f *fixtureInstallation) CheckUnchanged() error {
	if f.changed {
		return errors.New("changed")
	}
	return nil
}
func (f *fixtureInstallation) ReadOwnedCredential(config.CredentialName) ([]byte, error) {
	return []byte("fixture-not-a-key"), nil
}
func (f *fixtureInstallation) ReadTaskView() (config.TaskView, error) {
	return config.TaskView{Schema: "openslack.cleanup_task_view.v1", Tasks: []config.TaskDependency{}}, nil
}
func (f *fixtureInstallation) LoadExecution() (config.ExecutionInstallation, error) {
	return config.ExecutionInstallation{}, nil
}

// A real independently scheduled child, using only private FDs. No network,
// credentials or external repository is involved in this executable fixture.
func TestWorkerProcess(t *testing.T) {
	behavior := os.Getenv("CLEANUP_WORKER_FIXTURE")
	if behavior == "" {
		return
	}
	in := os.NewFile(3, "private-in")
	out := os.NewFile(4, "private-out")
	sc := bufio.NewScanner(in)
	sc.Buffer(make([]byte, 4096), 256*1024)
	if !sc.Scan() {
		os.Exit(21)
	}
	var b bootstrap
	if json.Unmarshal(sc.Bytes(), &b) != nil || b.Type != "start" {
		os.Exit(22)
	}
	if b.Request.Mode != b.Mode || b.Mode == "preview" && (b.Request.OperationID != "" || b.Binding.OperationID != "") || b.Binding.RequestDigest != b.Request.Digest() {
		os.Exit(27)
	}
	// Durable evidence must precede the first byte that releases startup.
	records, err := os.ReadFile(os.Getenv("CLEANUP_WORKER_JOURNAL"))
	if err != nil || !strings.Contains(string(records), b.Binding.WorkerID) {
		os.Exit(23)
	}
	if strings.Contains(strings.Join(os.Args, " "), "fixture-not-a-key") || os.Getenv("GITHUB_TOKEN") != "" {
		os.Exit(24)
	}
	if behavior == "hang" {
		for {
			time.Sleep(time.Second)
		}
	}
	if behavior == "oversize" {
		out.Write([]byte(strings.Repeat("x", 17000) + "\n"))
		for {
			time.Sleep(time.Second)
		}
	}
	emit := func(m message) { raw, _ := json.Marshal(m); out.Write(append(raw, '\n')) }
	m := message{Schema: "openslack.cleanup_executor_control.v1", binding: b.Binding, Type: "result", State: "CLEANUP_READY", Reason: "READY"}
	if behavior == "wrong-binding" {
		m.RequestDigest = strings.Repeat("b", 64)
	}
	if b.Mode == "execute" {
		admitRaw, _ := json.Marshal(struct {
			Schema string `json:"schema"`
			Type   string `json:"type"`
			binding
		}{m.Schema, "admit", b.Binding})
		out.Write(append(admitRaw, '\n'))
		if !sc.Scan() {
			os.Exit(25)
		}
		if !strings.Contains(sc.Text(), `"type":"admitted"`) {
			os.Exit(26)
		}
		if behavior == "duplicate-admit" {
			out.Write(append(admitRaw, '\n'))
			for {
				time.Sleep(time.Second)
			}
		}
		m.State = "DELETED"
		m.Reason = "DELETED"
		m.Attempted = true
	}
	// Explicit false is required by the control contract, unlike message's omit.
	raw, _ := json.Marshal(struct {
		Schema string `json:"schema"`
		Type   string `json:"type"`
		binding
		State     string `json:"state"`
		Reason    string `json:"reason"`
		Attempted bool   `json:"attempted"`
	}{m.Schema, m.Type, m.binding, m.State, m.Reason, m.Attempted})
	_ = emit
	out.Write(append(raw, '\n'))
	for {
		time.Sleep(time.Second)
	}
}
func runnerFixture(t *testing.T, behavior string) (*ProcessRunner, *ledger.Ledger, broker.Execution) {
	t.Helper()
	dir := t.TempDir()
	os.Chmod(dir, 0700)
	l, err := ledger.Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	r, err := newRunner(&fixtureInstallation{}, l, func() *exec.Cmd {
		c := exec.Command(os.Args[0], "-test.run=^TestWorkerProcess$")
		c.Env = []string{"CLEANUP_WORKER_FIXTURE=" + behavior, "CLEANUP_WORKER_JOURNAL=" + dir + "/workers.jsonl"}
		return c
	})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if err := r.Close(); err != nil {
			t.Errorf("close: %v", err)
		}
		l.Close()
	})
	instance := permit.Instance{BrokerID: "broker", Generation: "1", BootNonce: strings.Repeat("a", 64)}
	target := permit.Target{WorkspaceID: "workspace", Host: "github.com", RepositoryID: "1", Repository: "owner/repo", PRNodeID: "node", PRNumber: 1, Ref: "refs/heads/test", ExpectedSHA: strings.Repeat("a", 40)}
	q := protocol.Request{Schema: "openslack.cleanup_request.v1", Mode: "execute", AgentID: "agent", PrincipalID: "principal", RuntimeUID: "uid", RunID: "run", Repo: "owner/repo", Remote: "origin", PRNumber: 1, PermitID: "permit", OperationID: "operation"}
	return r, l, broker.Execution{Request: q, Target: target, Instance: instance, Bundle: source.Bundle{Permit: permit.Permit{Target: target, Instance: instance}, Registry: []byte("registry")}}
}
func TestRealWorkerPrivatePipeAndDurableBarrier(t *testing.T) {
	r, l, e := runnerFixture(t, "success")
	q := e.Request
	q.Mode = "preview"
	q.OperationID = ""
	p, err := r.Preflight(context.Background(), q, e.Bundle)
	if err != nil || p.State != "CLEANUP_READY" || p.Target != e.Target {
		t.Fatalf("preview: %+v %v", p, err)
	}
	calls := 0
	o, err := r.Execute(context.Background(), e, func(context.Context) error { calls++; return nil })
	if err != nil || o.State != "DELETED" || !o.Attempted || calls != 1 {
		t.Fatalf("execute: %+v %v calls=%d", o, err, calls)
	}
	unfinished, err := l.UnfinishedWorkers()
	if err != nil || len(unfinished) != 0 {
		t.Fatalf("workers remain: %v %v", unfinished, err)
	}
}

func TestExecuteRequestPreflightIsIndependentPreview(t *testing.T) {
	r, _, e := runnerFixture(t, "success")
	p, err := r.Preflight(context.Background(), e.Request, e.Bundle)
	if err != nil || p.State != "CLEANUP_READY" {
		t.Fatalf("execute preflight rejected: %+v %v", p, err)
	}
	if e.Request.Mode != "execute" || e.Request.OperationID != "operation" {
		t.Fatal("caller execution mutated")
	}
}
func TestRealWorkerFailuresAreKilledAndReaped(t *testing.T) {
	for _, behavior := range []string{"hang", "oversize", "wrong-binding", "duplicate-admit"} {
		t.Run(behavior, func(t *testing.T) {
			r, l, e := runnerFixture(t, behavior)
			ctx, cancel := context.WithTimeout(context.Background(), 400*time.Millisecond)
			defer cancel()
			calls := 0
			_, err := r.Execute(ctx, e, func(context.Context) error { calls++; return nil })
			if err == nil {
				t.Fatal("accepted bad worker")
			}
			if calls > 1 {
				t.Fatal("admitted twice")
			}
			records, err := l.UnfinishedWorkers()
			if err != nil || len(records) != 0 {
				t.Fatalf("unreaped: %v %v", records, err)
			}
		})
	}
}
func TestDeniedAdmissionAndStoppedRunner(t *testing.T) {
	r, _, e := runnerFixture(t, "success")
	calls := 0
	_, err := r.Execute(context.Background(), e, func(context.Context) error { calls++; return errors.New("deny") })
	if err == nil || calls != 1 {
		t.Fatal("denial ignored")
	}
	if r.Close() != nil {
		t.Fatal("close")
	}
	if _, err = r.Execute(context.Background(), e, nil); err == nil {
		t.Fatal("closed runner started")
	}
}
func TestRecoveryDoesNotKillExistingHistoricalGroup(t *testing.T) {
	r, l, e := runnerFixture(t, "success")
	c := exec.Command("/bin/sleep", "30")
	c.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	if err := c.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { syscall.Kill(-c.Process.Pid, syscall.SIGKILL); c.Wait() }()
	ticks, err := processIdentity(c.Process.Pid)
	if err != nil {
		t.Fatal(err)
	}
	w := ledger.WorkerEvidence{WorkerID: "historical", Mode: "execute", PermitID: "permit", OperationID: "operation", RequestDigest: e.Request.Digest(), SubjectDigest: strings.Repeat("a", 64), BrokerID: e.Instance.BrokerID, Generation: e.Instance.Generation, BrokerBootNonce: e.Instance.BootNonce, PID: c.Process.Pid, PGID: c.Process.Pid, KernelBootID: r.bootID, StartTicks: ticks}
	if err = l.RegisterWorker(w); err != nil {
		t.Fatal(err)
	}
	if r.CheckRecovery() == nil || groupAbsent(c.Process.Pid) {
		t.Fatal("historical group accepted or signaled")
	}
	// Sticky failure is intentional; cleanup must retain the outstanding record.
	r.mu.Lock()
	r.poisoned = false
	r.mu.Unlock()
	syscall.Kill(-c.Process.Pid, syscall.SIGKILL)
	c.Wait()
	if r.CheckRecovery() != nil {
		t.Fatal("absent group not reconciled")
	}
}
