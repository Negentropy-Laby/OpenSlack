//go:build linux

package processsupervisor

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"
)

const parentDeathHelperEnvironment = "OPENSLACK_PROCESS_SUPERVISOR_PARENT_DEATH_HELPER"

func TestLinuxParentDeathHelper(t *testing.T) {
	if os.Getenv(parentDeathHelperEnvironment) != "1" {
		return
	}
	pidFile := os.Getenv("OPENSLACK_PROCESS_SUPERVISOR_PID_FILE")
	supervisor := helperSupervisor(t, "block", pidFile)
	process, err := supervisor.Start(context.Background())
	if err != nil {
		os.Exit(98)
	}
	waitForHelperPIDs(pidFile, 1)
	_, _ = fmt.Fprintln(os.Stdout, process.PID())
	// os.Exit intentionally bypasses defers. Linux Pdeathsig must terminate the
	// sealed worker when this supervisor process disappears.
	os.Exit(0)
}

func TestLinuxParentDeathSignalKillsWorker(t *testing.T) {
	pidFile := filepath.Join(t.TempDir(), "parent-death.pids")
	command := exec.Command(currentTestExecutable(t), "-test.run=^TestLinuxParentDeathHelper$")
	command.Env = replaceNamedEnvironment(os.Environ(), map[string]string{
		parentDeathHelperEnvironment:            "1",
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
	if err != nil {
		t.Fatal(err)
	}
	if err := command.Wait(); err != nil {
		t.Fatal(err)
	}
	var pid int
	if _, err := fmt.Sscanf(strings.TrimSpace(line), "%d", &pid); err != nil || pid <= 0 {
		t.Fatalf("invalid parent-death worker pid %q: %v", line, err)
	}
	t.Cleanup(func() { _ = syscall.Kill(-pid, syscall.SIGKILL) })
	if err := waitProcessGone(pid, 5*time.Second); err != nil {
		t.Fatal("Linux parent-death signal did not terminate worker:", err)
	}
}

func replaceNamedEnvironment(environment []string, replacements map[string]string) []string {
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
