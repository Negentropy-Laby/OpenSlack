//go:build windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

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
				// Invalidate the private Job after its attribute list was accepted.
				// The real CreateProcessW must reject atomic assignment before the
				// suspended process can ever execute the marker program.
				hooks.beforeCreate = func(job windows.Handle) {
					if err := windows.CloseHandle(job); err != nil {
						t.Fatal(err)
					}
				}
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
