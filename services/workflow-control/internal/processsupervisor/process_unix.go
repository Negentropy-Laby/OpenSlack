//go:build aix || darwin || dragonfly || freebsd || netbsd || openbsd || solaris

package processsupervisor

import (
	"errors"
	"os/exec"
	"sync"
	"syscall"
)

type platformProcessTree struct {
	pid    int
	mu     sync.Mutex
	closed bool
}

func prepareCommand(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
}

func attachProcessTree(command *exec.Cmd) (*platformProcessTree, error) {
	return &platformProcessTree{pid: command.Process.Pid}, nil
}

func (tree *platformProcessTree) graceful() error { return tree.signal(syscall.SIGTERM) }
func (tree *platformProcessTree) kill() error     { return tree.signal(syscall.SIGKILL) }
func (tree *platformProcessTree) close() error {
	tree.mu.Lock()
	defer tree.mu.Unlock()
	tree.closed = true
	return nil
}

func (tree *platformProcessTree) signal(signal syscall.Signal) error {
	tree.mu.Lock()
	defer tree.mu.Unlock()
	if tree.closed || tree.pid <= 0 {
		return nil
	}
	err := syscall.Kill(-tree.pid, signal)
	if errors.Is(err, syscall.ESRCH) {
		return nil
	}
	return err
}
