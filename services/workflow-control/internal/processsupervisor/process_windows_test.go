//go:build windows

package processsupervisor

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

const windowsStillActive = 259
const windowsJobCloseHelperEnvironment = "OPENSLACK_PROCESS_SUPERVISOR_JOB_CLOSE_HELPER"

func TestWindowsJobCloseHelper(t *testing.T) {
	if os.Getenv(windowsJobCloseHelperEnvironment) != "1" {
		return
	}
	pidFile := os.Getenv("OPENSLACK_PROCESS_SUPERVISOR_PID_FILE")
	supervisor := helperSupervisor(t, "parent", pidFile)
	process, err := supervisor.Start(context.Background())
	if err != nil {
		os.Exit(98)
	}
	if _, err := fmt.Fprintln(process.Stdin(), "start"); err != nil {
		os.Exit(99)
	}
	waitForHelperPIDs(pidFile, 3)
	_, _ = fmt.Fprintln(os.Stdout, "ready")
	// Closing the process tears down the Job Object handle. KILL_ON_JOB_CLOSE
	// must terminate worker, child, and grandchild without taskkill.
	os.Exit(0)
}

func TestWindowsJobCloseKillsWorkerTree(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "job-close.pids")
	command := exec.Command(currentTestExecutable(t), "-test.run=^TestWindowsJobCloseHelper$")
	command.Env = replaceWindowsTestEnvironment(os.Environ(), map[string]string{
		windowsJobCloseHelperEnvironment:        "1",
		"OPENSLACK_PROCESS_SUPERVISOR_PID_FILE": pidFile,
	})
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil || line != "ready\n" {
		t.Fatalf("job-close helper readiness %q: %v", line, err)
	}
	if err := command.Wait(); err != nil {
		t.Fatal(err)
	}
	for _, pid := range readHelperPIDs(t, pidFile) {
		if err := waitProcessGone(pid, 5*time.Second); err != nil {
			t.Errorf("Job Object close left process %d alive: %v", pid, err)
		}
	}
}

func ignoreTerminationSignals() {
	signal.Ignore(os.Interrupt)
}

func waitProcessGone(pid int, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
		if err == windows.ERROR_INVALID_PARAMETER {
			return nil
		}
		if err == nil {
			var code uint32
			queryErr := windows.GetExitCodeProcess(process, &code)
			_ = windows.CloseHandle(process)
			if queryErr == nil && code != windowsStillActive {
				return nil
			}
		}
		time.Sleep(20 * time.Millisecond)
	}
	return fmt.Errorf("process %d remains active", pid)
}

func replaceWindowsTestEnvironment(environment []string, replacements map[string]string) []string {
	result := make([]string, 0, len(environment)+len(replacements))
	for _, entry := range environment {
		name, _, _ := strings.Cut(entry, "=")
		if _, replaced := replacements[name]; !replaced {
			result = append(result, entry)
		}
	}
	for name, value := range replacements {
		result = append(result, name+"="+value)
	}
	return result
}
