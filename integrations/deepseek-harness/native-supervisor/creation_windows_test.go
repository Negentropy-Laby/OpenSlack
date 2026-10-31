//go:build windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestWaitOwnsItsDuplicateUntilCancellation(t *testing.T) {
	// A real nonsignalled Windows handle exercises pending-wait lifetime without
	// running a peer or replacing the Windows wait/close implementation.
	event, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	done, cancel, err := startProcessWait(event)
	if err != nil {
		windows.CloseHandle(event)
		t.Fatal(err)
	}
	if err := windows.CloseHandle(event); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		t.Fatalf("closing the original disturbed its independently owned wait: %v", err)
	case <-time.After(50 * time.Millisecond):
	}
	cancel()
	cancel() // cancellation owns no Windows handle and is idempotent
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("cancelled wait invented a process exit receipt")
		}
	case <-time.After(time.Second):
		t.Fatal("owned wait did not observe cancellation")
	}
}

func TestWaitObservesExitBeforeClosingItsDuplicate(t *testing.T) {
	event, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(event)
	done, cancel, err := startProcessWait(event)
	if err != nil {
		t.Fatal(err)
	}
	defer cancel()
	if err := windows.SetEvent(event); err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("real signalled wait did not finish")
	}
}

func TestJobFailuresNeverResumeAnExecutor(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal("the pinned Node toolchain is required for native creation tests")
	}
	for _, mode := range []string{"job-create-failure", "creation-association-failure"} {
		t.Run(mode, func(t *testing.T) {
			root := t.TempDir()
			marker := filepath.Join(root, "must-not-exist")
			script := filepath.Join(root, "must-not-run.mjs")
			if err := os.WriteFile(script, []byte("import {writeFileSync} from 'node:fs'; writeFileSync(process.argv[2], 'unauthorized');"), 0600); err != nil {
				t.Fatal(err)
			}
			config := options{command: []string{node, script, marker}}
			hooks := creationHooks{}
			if mode == "job-create-failure" {
				hooks.createJob = func() (windows.Handle, error) { return 0, windows.ERROR_ACCESS_DENIED }
			} else {
				// Pass an independently invalid association, retaining the real Job's
				// single close owner even when CreateProcessW fails.
				// The real CreateProcessW must reject atomic assignment before the
				// suspended process can ever execute the marker program.
				hooks.associationJob = func(windows.Handle) windows.Handle { return windows.InvalidHandle }
			}
			child, err := createChildWithHooks(config, hooks)
			if child != nil {
				child.close()
				t.Fatal("failed Job setup returned an executor")
			}
			if err == nil {
				t.Fatal("failed Job setup was accepted")
			}
			if _, statErr := os.Stat(marker); !errors.Is(statErr, os.ErrNotExist) {
				t.Fatal("an executor ran before Job ownership was established")
			}
		})
	}
}
