//go:build aix || darwin || dragonfly || freebsd || linux || netbsd || openbsd || solaris

package processsupervisor

import (
	"fmt"
	"os"
	"os/signal"
	"runtime"
	"strings"
	"syscall"
	"time"
)

func ignoreTerminationSignals() {
	signal.Ignore(syscall.SIGINT, syscall.SIGTERM)
}

func waitProcessGone(pid int, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if runtime.GOOS == "linux" {
			if body, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid)); os.IsNotExist(err) {
				return nil
			} else if err == nil {
				fields := strings.Fields(string(body))
				if len(fields) >= 3 && fields[2] == "Z" {
					return nil
				}
			}
		}
		err := syscall.Kill(pid, 0)
		if err == syscall.ESRCH {
			return nil
		}
		time.Sleep(20 * time.Millisecond)
	}
	return fmt.Errorf("process %d remains visible", pid)
}
