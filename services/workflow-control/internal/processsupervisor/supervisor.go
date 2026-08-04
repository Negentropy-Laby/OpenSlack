package processsupervisor

import (
	"context"
	"fmt"
	"io"
	"os/exec"
	"sync"
	"time"
)

const (
	defaultStderrLimit = 64 * 1024
	maximumStderrLimit = 1024 * 1024
	defaultCancelGrace = 5 * time.Second
	defaultKillWait    = 10 * time.Second
	maximumGrace       = 5 * time.Minute
)

// Config is immutable after New. Command is the only launch description;
// Start deliberately accepts no job-provided command, path, argument, or env.
type Config struct {
	Command     Command
	StderrLimit int
	CancelGrace time.Duration
	KillWait    time.Duration
}

// Supervisor launches the one sealed command composed at process startup.
type Supervisor struct {
	command     sealedCommand
	stderrLimit int
	cancelGrace time.Duration
	killWait    time.Duration
}

// New validates and seals every executable input. Artifacts are revalidated
// immediately before every launch.
func New(config Config) (*Supervisor, error) {
	command, err := sealCommand(config.Command)
	if err != nil {
		return nil, err
	}
	stderrLimit := config.StderrLimit
	if stderrLimit == 0 {
		stderrLimit = defaultStderrLimit
	}
	if stderrLimit < 0 || stderrLimit > maximumStderrLimit {
		return nil, fmt.Errorf("stderr limit must be between zero and %d bytes", maximumStderrLimit)
	}
	cancelGrace := config.CancelGrace
	if cancelGrace == 0 {
		cancelGrace = defaultCancelGrace
	}
	killWait := config.KillWait
	if killWait == 0 {
		killWait = defaultKillWait
	}
	if cancelGrace < 0 || cancelGrace > maximumGrace || killWait <= 0 || killWait > maximumGrace {
		return nil, fmt.Errorf("process grace durations are outside the closed bounds")
	}
	return &Supervisor{
		command: command, stderrLimit: stderrLimit,
		cancelGrace: cancelGrace, killWait: killWait,
	}, nil
}

// CommandIdentity returns a non-secret hash binding the exact sealed command,
// entrypoint, hashes, fixed arguments, fixed environment, and working directory.
func (supervisor *Supervisor) CommandIdentity() string { return supervisor.command.identityHash }

// CommandName returns the closed catalog identity, never a filesystem path.
func (supervisor *Supervisor) CommandName() string { return supervisor.command.identity }

// Start directly executes the sealed executable. It never invokes a shell and
// has no per-job launch options by design.
func (supervisor *Supervisor) Start(ctx context.Context) (*Process, error) {
	if ctx == nil {
		return nil, fmt.Errorf("process context is required")
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := supervisor.command.revalidate(); err != nil {
		return nil, err
	}
	command := exec.Command(supervisor.command.executable, supervisor.command.argv()...)
	command.Env = append([]string{}, supervisor.command.environment...)
	command.Dir = supervisor.command.workingDirectory
	prepareCommand(command)
	stdin, err := command.StdinPipe()
	if err != nil {
		return nil, fmt.Errorf("create sealed worker stdin: %w", err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		_ = stdin.Close()
		return nil, fmt.Errorf("create sealed worker stdout: %w", err)
	}
	stderr := newBoundedStderr(supervisor.stderrLimit)
	command.Stderr = stderr
	if err := command.Start(); err != nil {
		_ = stdin.Close()
		_ = stdout.Close()
		return nil, fmt.Errorf("start sealed worker: %w", err)
	}
	tree, err := attachProcessTree(command)
	if err != nil {
		_ = command.Process.Kill()
		_ = command.Wait()
		_ = stdin.Close()
		_ = stdout.Close()
		return nil, fmt.Errorf("attach sealed worker process tree: %w", err)
	}
	process := &Process{
		command: command, tree: tree, stdin: stdin, stdout: stdout, stderr: stderr,
		done: make(chan struct{}), cancelGrace: supervisor.cancelGrace, killWait: supervisor.killWait,
	}
	go process.waitForExit()
	go process.watchContext(ctx)
	return process, nil
}

// Result is the bounded outcome of the supervised process. Err is the exact
// exec wait result; stderr remains diagnostic-only.
type Result struct {
	Err      error
	ExitCode int
	Stderr   StderrSnapshot
}

// Process is one launched process tree.
type Process struct {
	command *exec.Cmd
	tree    *platformProcessTree
	stdin   io.WriteCloser
	stdout  io.ReadCloser
	stderr  *boundedStderr
	done    chan struct{}

	cancelGrace time.Duration
	killWait    time.Duration

	resultMu sync.RWMutex
	result   Result
	stopOnce sync.Once
	stopDone chan struct{}
	stopErr  error
}

func (process *Process) PID() int               { return process.command.Process.Pid }
func (process *Process) Stdin() io.WriteCloser  { return process.stdin }
func (process *Process) Stdout() io.ReadCloser  { return process.stdout }
func (process *Process) Done() <-chan struct{}  { return process.done }
func (process *Process) Stderr() StderrSnapshot { return process.stderr.Snapshot() }

// Wait waits without ever calling exec.Cmd.Wait twice.
func (process *Process) Wait(ctx context.Context) (Result, error) {
	if ctx == nil {
		return Result{}, fmt.Errorf("wait context is required")
	}
	select {
	case <-process.done:
		process.resultMu.RLock()
		defer process.resultMu.RUnlock()
		return process.result, nil
	case <-ctx.Done():
		return Result{}, ctx.Err()
	}
}

// Terminate first requests cooperative process-tree termination, waits for the
// supplied grace period, and then force-kills the complete tree. It is safe to
// call concurrently and is idempotent.
func (process *Process) Terminate(ctx context.Context, grace time.Duration) error {
	if ctx == nil {
		return fmt.Errorf("termination context is required")
	}
	if grace < 0 || grace > maximumGrace {
		return fmt.Errorf("termination grace is outside the closed bounds")
	}
	process.stopOnce.Do(func() {
		process.stopDone = make(chan struct{})
		go func() {
			process.stopErr = process.terminate(ctx, grace)
			close(process.stopDone)
		}()
	})
	if process.stopDone == nil {
		return nil
	}
	select {
	case <-process.stopDone:
		return process.stopErr
	case <-ctx.Done():
		return ctx.Err()
	}
}

// ForceKill immediately terminates the full process tree and waits for the
// bounded configured kill deadline.
func (process *Process) ForceKill(ctx context.Context) error {
	return process.Terminate(ctx, 0)
}

func (process *Process) watchContext(ctx context.Context) {
	select {
	case <-ctx.Done():
		termination, cancel := context.WithTimeout(context.Background(), process.cancelGrace+process.killWait)
		defer cancel()
		_ = process.Terminate(termination, process.cancelGrace)
	case <-process.done:
	}
}

func (process *Process) waitForExit() {
	err := process.command.Wait()
	exitCode := -1
	if process.command.ProcessState != nil {
		exitCode = process.command.ProcessState.ExitCode()
	}
	closeErr := process.tree.close()
	process.resultMu.Lock()
	process.result = Result{Err: joinErrors(err, closeErr), ExitCode: exitCode, Stderr: process.stderr.Snapshot()}
	process.resultMu.Unlock()
	close(process.done)
}

func (process *Process) terminate(ctx context.Context, grace time.Duration) error {
	select {
	case <-process.done:
		return nil
	default:
	}
	graceErr := process.tree.graceful()
	if waitFor(process.done, ctx, grace) {
		return nil
	}
	killErr := process.tree.kill()
	killContext, cancel := context.WithTimeout(context.Background(), process.killWait)
	defer cancel()
	select {
	case <-process.done:
		if killErr != nil {
			return fmt.Errorf("force process-tree termination: %w", killErr)
		}
		return nil
	case <-ctx.Done():
		return fmt.Errorf("process tree did not exit before termination deadline: %w", joinErrors(ctx.Err(), graceErr, killErr))
	case <-killContext.Done():
		return fmt.Errorf("process tree did not exit after force termination: %w", joinErrors(killContext.Err(), graceErr, killErr))
	}
}

func waitFor(done <-chan struct{}, ctx context.Context, duration time.Duration) bool {
	if duration == 0 {
		return false
	}
	timer := time.NewTimer(duration)
	defer timer.Stop()
	select {
	case <-done:
		return true
	case <-ctx.Done():
		return false
	case <-timer.C:
		return false
	}
}
