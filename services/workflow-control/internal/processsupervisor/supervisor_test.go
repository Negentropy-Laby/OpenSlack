package processsupervisor

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"
)

const helperEnvironment = "OPENSLACK_PROCESS_SUPERVISOR_HELPER"

func TestProcessSupervisorHelper(t *testing.T) {
	mode := os.Getenv(helperEnvironment)
	if mode == "" {
		return
	}
	if mode == "exit" {
		time.Sleep(200 * time.Millisecond)
		return
	}
	pidFile := os.Getenv("OPENSLACK_PROCESS_SUPERVISOR_PID_FILE")
	if pidFile == "" {
		os.Exit(91)
	}
	ignoreTerminationSignals()
	appendHelperPID(pidFile, os.Getpid())
	switch mode {
	case "parent":
		if line, err := bufio.NewReader(os.Stdin).ReadString('\n'); err != nil || line != "start\n" {
			os.Exit(97)
		}
		startHelperChild(pidFile, "child")
		waitForHelperPIDs(pidFile, 3)
		_, _ = fmt.Fprintln(os.Stdout, "ready")
	case "child":
		startHelperChild(pidFile, "grandchild")
	case "grandchild", "block":
	default:
		os.Exit(92)
	}
	for {
		time.Sleep(time.Second)
	}
}

func TestTerminateKillsChildAndGrandchild(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "process-tree.pids")
	supervisor := helperSupervisor(t, "parent", pidFile)
	process, err := supervisor.Start(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = process.ForceKill(ctx)
	})
	if _, err := fmt.Fprintln(process.Stdin(), "start"); err != nil {
		t.Fatal(err)
	}
	ready := make(chan error, 1)
	go func() {
		line, err := bufio.NewReader(process.Stdout()).ReadString('\n')
		if err == nil && line != "ready\n" {
			err = fmt.Errorf("unexpected helper readiness %q", line)
		}
		ready <- err
	}()
	select {
	case err := <-ready:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("process tree helper did not become ready")
	}
	pids := readHelperPIDs(t, pidFile)
	if len(pids) != 3 {
		t.Fatalf("helper pid inventory = %v", pids)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := process.Terminate(ctx, 50*time.Millisecond); err != nil {
		t.Fatal(err)
	}
	if _, err := process.Wait(ctx); err != nil {
		t.Fatal(err)
	}
	for _, pid := range pids {
		if waitProcessGone(pid, 5*time.Second) != nil {
			t.Errorf("process %d survived process-tree termination", pid)
		}
	}
}

func TestContextCancellationUsesGraceThenForcesExit(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "context-cancel.pids")
	supervisor := helperSupervisor(t, "block", pidFile)
	ctx, cancel := context.WithCancel(context.Background())
	process, err := supervisor.Start(ctx)
	if err != nil {
		t.Fatal(err)
	}
	cancel()
	waitContext, waitCancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer waitCancel()
	if _, err := process.Wait(waitContext); err != nil {
		t.Fatal(err)
	}
	if waitProcessGone(process.PID(), 5*time.Second) != nil {
		t.Fatalf("context-cancelled process %d is still alive", process.PID())
	}
}

func TestStartUsesFixedArgvAndDoesNotInheritEnvironment(t *testing.T) {
	executable := currentTestExecutable(t)
	digest := artifactDigest(t, executable)
	supervisor, err := New(Config{Command: Command{
		Identity: "typescript-v1", ExecutablePath: executable, ExecutableSHA256: digest,
		EntrypointPath: executable, EntrypointSHA256: digest, EntrypointMode: EntrypointExecutable,
		FixedArguments: []string{"-test.run=^TestProcessSupervisorHelper$"},
		Environment:    helperProcessEnvironment(helperEnvironment + "=exit"),
	}, CancelGrace: 10 * time.Millisecond, KillWait: 5 * time.Second})
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("NODE_OPTIONS", "--require=attacker.js")
	process, err := supervisor.Start(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	result, err := process.Wait(t.Context())
	if err != nil || result.Err != nil || result.ExitCode != 0 {
		t.Fatalf("sealed helper result=%+v waitErr=%v", result, err)
	}
}

func helperSupervisor(t *testing.T, mode, pidFile string) *Supervisor {
	t.Helper()
	executable := currentTestExecutable(t)
	digest := artifactDigest(t, executable)
	value, err := New(Config{Command: Command{
		Identity: "typescript-v1", ExecutablePath: executable, ExecutableSHA256: digest,
		EntrypointPath: executable, EntrypointSHA256: digest, EntrypointMode: EntrypointExecutable,
		FixedArguments: []string{"-test.run=^TestProcessSupervisorHelper$"},
		Environment: helperProcessEnvironment(
			helperEnvironment+"="+mode,
			"OPENSLACK_PROCESS_SUPERVISOR_PID_FILE="+pidFile,
		),
	}, CancelGrace: 50 * time.Millisecond, KillWait: 5 * time.Second, StderrLimit: 1024})
	if err != nil {
		t.Fatal(err)
	}
	return value
}

func helperProcessEnvironment(values ...string) []string {
	for _, name := range []string{"SYSTEMROOT", "WINDIR"} {
		if value := os.Getenv(name); value != "" {
			values = append(values, name+"="+value)
		}
	}
	return values
}

func startHelperChild(pidFile, mode string) {
	command := exec.Command(os.Args[0], "-test.run=^TestProcessSupervisorHelper$")
	command.Env = replaceHelperEnvironment(os.Environ(), mode, pidFile)
	command.Stdout = io.Discard
	command.Stderr = io.Discard
	if err := command.Start(); err != nil {
		os.Exit(93)
	}
}

func replaceHelperEnvironment(environment []string, mode, pidFile string) []string {
	result := make([]string, 0, len(environment)+2)
	for _, entry := range environment {
		if strings.HasPrefix(entry, helperEnvironment+"=") || strings.HasPrefix(entry, "OPENSLACK_PROCESS_SUPERVISOR_PID_FILE=") {
			continue
		}
		result = append(result, entry)
	}
	return append(result, helperEnvironment+"="+mode, "OPENSLACK_PROCESS_SUPERVISOR_PID_FILE="+pidFile)
}

func appendHelperPID(path string, pid int) {
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_APPEND|os.O_CREATE, 0o600)
	if err != nil {
		os.Exit(94)
	}
	_, writeErr := fmt.Fprintln(file, pid)
	closeErr := file.Close()
	if writeErr != nil || closeErr != nil {
		os.Exit(95)
	}
}

func waitForHelperPIDs(path string, count int) {
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		body, _ := os.ReadFile(path)
		if len(strings.Fields(string(body))) >= count {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	os.Exit(96)
}

func readHelperPIDs(t *testing.T, path string) []int {
	t.Helper()
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var result []int
	for _, value := range strings.Fields(string(body)) {
		pid, err := strconv.Atoi(value)
		if err != nil {
			t.Fatalf("invalid helper pid %q", value)
		}
		result = append(result, pid)
	}
	return result
}
