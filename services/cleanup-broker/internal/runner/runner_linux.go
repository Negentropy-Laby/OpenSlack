//go:build linux

// Package runner owns fixed installed workers. A worker cannot start authority
// work until its process group is durably recorded under the broker ledger lock.
package runner

import (
	"bufio"
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/broker"
	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/config"
	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/ledger"
	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/permit"
	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/protocol"
	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/source"
)

var ErrWorker = errors.New("BROKER_WORKER_FAILED")
var ErrRecovery = errors.New("BROKER_WORKER_RECOVERY_REQUIRED")

type installation interface {
	Config() config.Config
	CheckUnchanged() error
	ReadOwnedCredential(config.CredentialName) ([]byte, error)
	ReadTaskView() (config.TaskView, error)
	LoadExecution() (config.ExecutionInstallation, error)
}
type ProcessRunner struct {
	mu                sync.Mutex
	snapshot          installation
	ledger            *ledger.Ledger
	cfg               config.Config
	command           func() *exec.Cmd
	bootID            string
	network           config.Network
	active            map[string]context.CancelFunc
	stopped, poisoned bool
	wg                sync.WaitGroup
}

func New(s *config.Snapshot, l *ledger.Ledger) (*ProcessRunner, error) {
	if s == nil || l == nil {
		return nil, ErrWorker
	}
	return newRunner(s, l, func() *exec.Cmd {
		c := exec.Command(config.NodePath, config.ExecutorPath)
		c.Dir = config.StatePath
		c.Env = []string{"PATH=/usr/lib/openslack-cleanup", "LANG=C", "LC_ALL=C", "TZ=UTC", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null", "GIT_TERMINAL_PROMPT=0"}
		return c
	})
}
func newRunner(s installation, l *ledger.Ledger, command func() *exec.Cmd) (*ProcessRunner, error) {
	if s.CheckUnchanged() != nil {
		return nil, ErrWorker
	}
	installed, err := s.LoadExecution()
	if err != nil {
		return nil, ErrWorker
	}
	if _, err = s.ReadTaskView(); err != nil {
		return nil, ErrWorker
	}
	boot, err := kernelBoot()
	if err != nil {
		return nil, err
	}
	r := &ProcessRunner{snapshot: s, ledger: l, cfg: s.Config(), command: command, bootID: boot, active: map[string]context.CancelFunc{}}
	r.network = installed.Network
	if err = r.CheckRecovery(); err != nil {
		return nil, err
	}
	return r, nil
}

func kernelBoot() (string, error) {
	var fs syscall.Statfs_t
	if syscall.Statfs("/proc", &fs) != nil || fs.Type != 0x9fa0 {
		return "", ErrRecovery
	}
	b, e := os.ReadFile("/proc/sys/kernel/random/boot_id")
	s := strings.TrimSpace(string(b))
	if e != nil || len(s) != 36 {
		return "", ErrRecovery
	}
	return s, nil
}
func processIdentity(pid int) (uint64, error) {
	b, e := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if e != nil {
		return 0, ErrWorker
	}
	end := strings.LastIndexByte(string(b), ')')
	if end < 0 {
		return 0, ErrWorker
	}
	f := strings.Fields(string(b[end+1:]))
	if len(f) < 20 {
		return 0, ErrWorker
	}
	pg, e := strconv.Atoi(f[2])
	if e != nil || pg != pid {
		return 0, ErrWorker
	}
	ticks, e := strconv.ParseUint(f[19], 10, 64)
	if e != nil || ticks == 0 {
		return 0, ErrWorker
	}
	return ticks, nil
}
func groupAbsent(pgid int) bool { return pgid > 1 && errors.Is(syscall.Kill(-pgid, 0), syscall.ESRCH) }

// CheckRecovery never signals a historical PID: it may have been reused. Only
// another kernel boot or absence of the complete group permits reconciliation.
func (r *ProcessRunner) CheckRecovery() error {
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.poisoned {
		return ErrRecovery
	}
	records, e := r.ledger.UnfinishedWorkers()
	if e != nil {
		r.poisoned = true
		return ErrRecovery
	}
	for _, w := range records {
		if _, ok := r.active[w.WorkerID]; ok {
			continue
		}
		if w.KernelBootID == r.bootID && !groupAbsent(w.PGID) {
			r.poisoned = true
			return ErrRecovery
		}
		if r.ledger.FinishWorker(w.WorkerID) != nil {
			r.poisoned = true
			return ErrRecovery
		}
	}
	return nil
}
func (r *ProcessRunner) Drain(ctx context.Context) error {
	r.mu.Lock()
	r.stopped = true
	for _, cancel := range r.active {
		cancel()
	}
	r.mu.Unlock()
	done := make(chan struct{})
	go func() { r.wg.Wait(); close(done) }()
	select {
	case <-done:
		return r.CheckRecovery()
	case <-ctx.Done():
		return ErrRecovery
	}
}
func (r *ProcessRunner) Close() error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	return r.Drain(ctx)
}

type binding struct {
	WorkerID      string          `json:"workerId"`
	OperationID   string          `json:"operationId"`
	RequestDigest string          `json:"requestDigest"`
	Target        permit.Target   `json:"target"`
	Instance      permit.Instance `json:"instance"`
}
type bootstrap struct {
	Schema   string           `json:"schema"`
	Type     string           `json:"type"`
	Binding  binding          `json:"binding"`
	Mode     string           `json:"mode"`
	Request  protocol.Request `json:"request"`
	Registry string           `json:"registry"`
	TaskView config.TaskView  `json:"taskView"`
	Network  config.Network   `json:"network"`
	App      struct {
		AppID          uint64 `json:"appId"`
		InstallationID uint64 `json:"installationId"`
		PrivateKey     string `json:"privateKey"`
	} `json:"app"`
	DeadlineMs int64 `json:"deadlineMs"`
}
type message struct {
	Schema string `json:"schema"`
	binding
	Type      string `json:"type"`
	State     string `json:"state,omitempty"`
	Reason    string `json:"reason,omitempty"`
	Attempted bool   `json:"attempted,omitempty"`
}

func decodeMessage(b []byte) (message, error) {
	var discriminator struct {
		Type string `json:"type"`
	}
	if json.Unmarshal(b, &discriminator) != nil {
		return message{}, ErrWorker
	}
	m := message{Type: discriminator.Type}
	switch m.Type {
	case "admit":
		var v struct {
			Schema        string          `json:"schema"`
			WorkerID      string          `json:"workerId"`
			OperationID   string          `json:"operationId"`
			RequestDigest string          `json:"requestDigest"`
			Target        permit.Target   `json:"target"`
			Instance      permit.Instance `json:"instance"`
			Type          string          `json:"type"`
		}
		if permit.Decode(b, &v) != nil {
			return m, ErrWorker
		}
		m.Schema = v.Schema
		m.binding = binding{v.WorkerID, v.OperationID, v.RequestDigest, v.Target, v.Instance}
	case "result":
		var v struct {
			Schema        string          `json:"schema"`
			WorkerID      string          `json:"workerId"`
			OperationID   string          `json:"operationId"`
			RequestDigest string          `json:"requestDigest"`
			Target        permit.Target   `json:"target"`
			Instance      permit.Instance `json:"instance"`
			Type          string          `json:"type"`
			State         string          `json:"state"`
			Reason        string          `json:"reason"`
			Attempted     bool            `json:"attempted"`
		}
		if permit.Decode(b, &v) != nil {
			return m, ErrWorker
		}
		m.State = v.State
		m.Reason = v.Reason
		m.Attempted = v.Attempted
		m.Schema = v.Schema
		m.binding = binding{v.WorkerID, v.OperationID, v.RequestDigest, v.Target, v.Instance}
	default:
		return m, ErrWorker
	}
	if m.Schema != "openslack.cleanup_executor_control.v1" {
		return m, ErrWorker
	}
	return m, nil
}
func (r *ProcessRunner) Preflight(ctx context.Context, q protocol.Request, b source.Bundle) (broker.Preflight, error) {
	// Preflight is its own read-only invocation, even when preparing an execute
	// request. Never forward execute mode or its operation identity into preview.
	q.Mode = "preview"
	q.OperationID = ""
	m, e := r.run(ctx, "preflight", broker.Execution{Request: q, Bundle: b, Target: b.Permit.Target, Instance: b.Permit.Instance}, nil)
	return broker.Preflight{Target: m.Target, State: m.State, Reason: m.Reason}, e
}
func (r *ProcessRunner) Execute(ctx context.Context, e broker.Execution, admit func(context.Context) error) (broker.Outcome, error) {
	m, err := r.run(ctx, "execute", e, admit)
	return broker.Outcome{State: m.State, Reason: m.Reason, Attempted: m.Attempted}, err
}
func (r *ProcessRunner) run(parent context.Context, mode string, e broker.Execution, admit func(context.Context) error) (result message, retErr error) {
	if r.CheckRecovery() != nil {
		return result, ErrRecovery
	}
	ctx, cancel := context.WithTimeout(parent, 60*time.Second)
	defer cancel()
	id, err := permit.NewBootNonce()
	if err != nil {
		return result, ErrWorker
	}
	r.mu.Lock()
	if r.stopped || r.poisoned {
		r.mu.Unlock()
		return result, ErrRecovery
	}
	r.active[id] = cancel
	r.wg.Add(1)
	r.mu.Unlock()
	defer func() { r.mu.Lock(); delete(r.active, id); r.mu.Unlock(); r.wg.Done() }()
	if r.snapshot.CheckUnchanged() != nil {
		return result, ErrWorker
	}
	// Marshal before spawning, owning all mutable caller buffers/maps synchronously.
	secret, err := r.snapshot.ReadOwnedCredential(config.GitHubAppPrivateKeyCredential)
	if err != nil {
		return result, ErrWorker
	}
	taskView, err := r.snapshot.ReadTaskView()
	if err != nil {
		clear(secret)
		return result, ErrWorker
	}
	bound := binding{id, e.Request.OperationID, e.Request.Digest(), e.Target, e.Instance}
	b := bootstrap{Schema: "openslack.cleanup_executor_bootstrap.v1", Type: "start", Binding: bound, Mode: mode, Request: e.Request, Registry: string(e.Bundle.Registry), TaskView: taskView}
	b.Network = r.network
	if mode == "preflight" {
		b.Mode = "preview"
	}
	b.App.AppID = r.cfg.GitHubApp.AppID
	b.App.InstallationID = r.cfg.GitHubApp.InstallationID
	b.App.PrivateKey = string(secret)
	deadline, _ := ctx.Deadline()
	b.DeadlineMs = deadline.UnixMilli()
	payload, err := json.Marshal(b)
	clear(secret)
	b.App.PrivateKey = ""
	if err != nil || len(payload)+1 > 256*1024 {
		clear(payload)
		return result, ErrWorker
	}
	defer clear(payload)
	childIn, parentOut, err := os.Pipe()
	if err != nil {
		return result, ErrWorker
	}
	defer childIn.Close()
	defer parentOut.Close()
	parentIn, childOut, err := os.Pipe()
	if err != nil {
		return result, ErrWorker
	}
	defer parentIn.Close()
	defer childOut.Close()
	cmd := r.command()
	cmd.ExtraFiles = []*os.File{childIn, childOut}
	cmd.Stdout = io.Discard
	cmd.Stderr = io.Discard
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true, Pdeathsig: syscall.SIGKILL}
	cmd.WaitDelay = time.Second
	if ctx.Err() != nil || r.snapshot.CheckUnchanged() != nil || cmd.Start() != nil {
		return result, ErrWorker
	}
	childIn.Close()
	childOut.Close()
	pid := cmd.Process.Pid
	registered := false
	defer func() {
		// Signal while the unreaped group leader still pins its PID. Never reap first.
		syscall.Kill(-pid, syscall.SIGKILL)
		_ = cmd.Wait()
		until := time.Now().Add(2 * time.Second)
		for !groupAbsent(pid) && time.Now().Before(until) {
			time.Sleep(10 * time.Millisecond)
		}
		if !groupAbsent(pid) || registered && r.ledger.FinishWorker(id) != nil {
			r.mu.Lock()
			r.poisoned = true
			r.mu.Unlock()
			retErr = ErrRecovery
		}
	}()
	ticks, err := processIdentity(pid)
	if err != nil {
		return result, ErrWorker
	}
	subjectBytes, _ := json.Marshal([]string{e.Request.AgentID, e.Request.PrincipalID, e.Request.RuntimeUID, e.Request.RunID})
	subjectDigest := fmt.Sprintf("%x", sha256.Sum256(subjectBytes))
	evidence := ledger.WorkerEvidence{WorkerID: id, Mode: mode, PermitID: e.Request.PermitID, OperationID: e.Request.OperationID, RequestDigest: e.Request.Digest(), SubjectDigest: subjectDigest, BrokerID: e.Instance.BrokerID, Generation: e.Instance.Generation, BrokerBootNonce: e.Instance.BootNonce, PID: pid, PGID: pid, KernelBootID: r.bootID, StartTicks: ticks}
	if r.ledger.RegisterWorker(evidence) != nil {
		return result, ErrWorker
	}
	registered = true
	frames := make(chan []byte)
	readDone := make(chan struct{})
	defer close(readDone)
	go func() {
		defer close(frames)
		sc := bufio.NewScanner(parentIn)
		sc.Buffer(make([]byte, 1024), 16*1024+1)
		sc.Split(func(data []byte, atEOF bool) (int, []byte, error) {
			if i := bytes.IndexByte(data, '\n'); i >= 0 {
				if i+1 > 16*1024 {
					return 0, nil, ErrWorker
				}
				return i + 1, data[:i], nil
			}
			if atEOF && len(data) > 0 {
				return 0, nil, ErrWorker
			}
			return 0, nil, nil
		})
		for sc.Scan() {
			line := append([]byte(nil), sc.Bytes()...)
			if len(line) > 16*1024 {
				return
			}
			select {
			case frames <- line:
			case <-readDone:
				return
			}
		}
	}()
	stop := context.AfterFunc(ctx, func() { parentIn.Close(); parentOut.Close() })
	defer stop()
	receive := func() (message, error) {
		select {
		case <-ctx.Done():
			return message{}, ErrWorker
		case raw, ok := <-frames:
			if !ok {
				return message{}, ErrWorker
			}
			return decodeMessage(raw)
		}
	}
	send := func(raw []byte) error {
		if ctx.Err() != nil {
			return ErrWorker
		}
		parentOut.SetWriteDeadline(deadline)
		_, err := parentOut.Write(append(raw, '\n'))
		if err != nil {
			return ErrWorker
		}
		return nil
	}
	if r.snapshot.CheckUnchanged() != nil || send(payload) != nil {
		return result, ErrWorker
	}
	clear(payload)
	admitted := false
	for {
		m, err := receive()
		if err != nil {
			return result, ErrWorker
		}
		if m.binding != bound {
			return result, ErrWorker
		}
		switch m.Type {
		case "admit":
			if mode != "execute" || admitted || admit == nil {
				return result, ErrWorker
			}
			admitted = true
			if r.snapshot.CheckUnchanged() != nil || admit(ctx) != nil || ctx.Err() != nil {
				raw, _ := json.Marshal(struct {
					Schema string `json:"schema"`
					Type   string `json:"type"`
					binding
					Reason string `json:"reason"`
				}{"openslack.cleanup_executor_control.v1", "rejected", bound, "FINAL_SEND_DENIED"})
				_ = send(raw)
				return result, ErrWorker
			}
			raw, _ := json.Marshal(struct {
				Schema string `json:"schema"`
				Type   string `json:"type"`
				binding
			}{"openslack.cleanup_executor_control.v1", "admitted", bound})
			if send(raw) != nil {
				return result, ErrWorker
			}
		case "result":
			if m.Attempted && !admitted {
				return result, ErrWorker
			}
			return m, nil
		default:
			return result, ErrWorker
		}
	}
}
