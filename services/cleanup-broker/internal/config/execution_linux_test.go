//go:build linux

package config

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func executionDigest(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func writeExecutionJSON(t *testing.T, s loadSpec, path string, value any, mode os.FileMode) []byte {
	t.Helper()
	b, e := json.Marshal(value)
	if e != nil {
		t.Fatal(e)
	}
	full := fixturePath(s, path)
	if e = os.MkdirAll(filepath.Dir(full), 0755); e != nil {
		t.Fatal(e)
	}
	if e = os.WriteFile(full, b, mode); e != nil {
		t.Fatal(e)
	}
	return b
}
func executionFixture(t *testing.T) (loadSpec, Config, ExecutionInstallation, TaskView) {
	t.Helper()
	s, c := fixture(t)
	m := ExecutionInstallation{Schema: "openslack.cleanup_installation.v1", Network: Network{HTTPSProxy: "http://127.0.0.1:8080", NoProxy: "localhost"}}
	for _, path := range []string{NodePath, ExecutorPath, GitPath, ShellPath, GitCorePath + "/git-remote-https"} {
		if path == ShellPath || strings.HasPrefix(path, GitCorePath+"/") {
			full := fixturePath(s, path)
			if e := os.MkdirAll(filepath.Dir(full), 0755); e != nil {
				t.Fatal(e)
			}
			if e := os.WriteFile(full, []byte("synthetic executable"), 0755); e != nil {
				t.Fatal(e)
			}
		}
		b, e := os.ReadFile(fixturePath(s, path))
		if e != nil {
			t.Fatal(e)
		}
		m.Files = append(m.Files, InstalledFile{path, executionDigest(b)})
	}
	v := TaskView{Schema: "openslack.cleanup_task_view.v1", WorkspaceID: c.WorkspaceID, Repository: "Example/scratch", RepositoryID: "123", NotBefore: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), ExpiresAt: time.Date(2027, 1, 1, 0, 0, 0, 0, time.UTC), Tasks: []TaskDependency{{"TASK-1", 42, "claimed"}}}
	c.Artifacts.InstallManifestSHA256 = executionDigest(writeExecutionJSON(t, s, InstallManifestPath, m, 0644))
	writeConfig(t, s, c)
	writeExecutionJSON(t, s, TaskViewPath, v, 0640)
	return s, c, m, v
}
func TestExecutionInstallationTaskViewAndOwnedEvidence(t *testing.T) {
	s, c, _, _ := executionFixture(t)
	snap, e := load(s)
	if e != nil {
		t.Fatal(e)
	}
	defer snap.Close()
	m, e := snap.LoadExecution()
	if e != nil {
		t.Fatal(e)
	}
	hashes := snap.EvidenceHashes()
	if hashes["installation"] != c.Artifacts.InstallManifestSHA256 || hashes["taskView"] == "" || hashes[ShellPath] == "" {
		t.Fatal("missing bound evidence")
	}
	hashes["taskView"] = "forged"
	m.Files[0].SHA256 = "forged"
	if snap.EvidenceHashes()["taskView"] == "forged" || snap.EvidenceHashes()[NodePath] == "forged" {
		t.Fatal("caller owns snapshot evidence")
	}
	v, e := snap.ReadTaskView()
	if e != nil || v.Tasks[0].State != "claimed" {
		t.Fatalf("task view: %v", e)
	}
	v.Tasks[0].State = "released"
	again, e := snap.ReadTaskView()
	if e != nil || again.Tasks[0].State != "claimed" {
		t.Fatal("task view aliases caller")
	}
}
func TestExecutionRejectsManifestAndArtifacts(t *testing.T) {
	for _, name := range []string{"unbound manifest", "missing required", "wrong file hash", "duplicate file", "relative path", "unknown field", "symlink shell", "hardlink shell", "writable shell", "nonexecutable shell", "unsafe network"} {
		t.Run(name, func(t *testing.T) {
			s, c, m, _ := executionFixture(t)
			switch name {
			case "missing required":
				m.Files = m.Files[:4]
			case "wrong file hash":
				m.Files[3].SHA256 = strings.Repeat("a", 64)
			case "duplicate file":
				m.Files = append(m.Files, m.Files[0])
			case "relative path":
				m.Files[3].Path = "usr/lib/sh"
			case "unsafe network":
				m.Network.HTTPSProxy = "http://user:pass@host"
			case "symlink shell":
				p := fixturePath(s, ShellPath)
				if e := os.Rename(p, p+".saved"); e != nil {
					t.Fatal(e)
				}
				if e := os.Symlink(p+".saved", p); e != nil {
					t.Fatal(e)
				}
			case "hardlink shell":
				p := fixturePath(s, ShellPath)
				if e := os.Link(p, p+".other"); e != nil {
					t.Fatal(e)
				}
			case "writable shell":
				if e := os.Chmod(fixturePath(s, ShellPath), 0777); e != nil {
					t.Fatal(e)
				}
			case "nonexecutable shell":
				if e := os.Chmod(fixturePath(s, ShellPath), 0644); e != nil {
					t.Fatal(e)
				}
			}
			b := writeExecutionJSON(t, s, InstallManifestPath, m, 0644)
			if name == "unknown field" {
				b = append([]byte(`{"extra":true,`), b[1:]...)
				if e := os.WriteFile(fixturePath(s, InstallManifestPath), b, 0644); e != nil {
					t.Fatal(e)
				}
			}
			if name != "unbound manifest" {
				c.Artifacts.InstallManifestSHA256 = executionDigest(b)
			} else {
				c.Artifacts.InstallManifestSHA256 = strings.Repeat("a", 64)
			}
			writeConfig(t, s, c)
			snap, e := load(s)
			if e != nil {
				t.Fatal(e)
			}
			defer snap.Close()
			if _, e = snap.LoadExecution(); e == nil {
				t.Fatal("unsafe installation accepted")
			}
		})
	}
}
func TestExecutionPinnedChangesFailClosed(t *testing.T) {
	for _, path := range []string{InstallManifestPath, TaskViewPath, ShellPath, GitCorePath + "/git-remote-https"} {
		t.Run(path, func(t *testing.T) {
			s, _, _, _ := executionFixture(t)
			snap, e := load(s)
			if e != nil {
				t.Fatal(e)
			}
			defer snap.Close()
			if _, e = snap.LoadExecution(); e != nil {
				t.Fatal(e)
			}
			if e = os.WriteFile(fixturePath(s, path), []byte("changed"), 0644); e != nil {
				t.Fatal(e)
			}
			if _, e = snap.ReadTaskView(); e == nil {
				t.Fatal("changed installation accepted")
			}
			if e = snap.CheckUnchanged(); e == nil {
				t.Fatal("missing sticky poison")
			}
		})
	}
}
func TestTaskViewRejectsMalformedBinding(t *testing.T) {
	mutations := map[string]func(*TaskView){"workspace": func(v *TaskView) { v.WorkspaceID = "other" }, "repository": func(v *TaskView) { v.Repository = "Example/other" }, "repository id": func(v *TaskView) { v.RepositoryID = "0123" }, "state": func(v *TaskView) { v.Tasks[0].State = "done" }, "duplicate": func(v *TaskView) { v.Tasks = append(v.Tasks, v.Tasks[0]) }, "weak issue": func(v *TaskView) { v.Tasks[0].IssueNumber = 0 }, "window": func(v *TaskView) { v.ExpiresAt = v.NotBefore }}
	for name, mutate := range mutations {
		t.Run(name, func(t *testing.T) {
			s, _, _, v := executionFixture(t)
			mutate(&v)
			writeExecutionJSON(t, s, TaskViewPath, v, 0640)
			snap, e := load(s)
			if e != nil {
				t.Fatal(e)
			}
			defer snap.Close()
			if _, e = snap.LoadExecution(); e != nil {
				t.Fatal(e)
			}
			if _, e = snap.ReadTaskView(); e == nil {
				t.Fatal("invalid task view accepted")
			}
		})
	}
}
func TestTaskViewTimeAndRepositoryIDRequireRequestLevelChecks(t *testing.T) {
	// This component checks shape, not a request clock or Permit repository ID.
	// Resource preflight and final-send MUST reject this expired but well-formed view.
	s, _, _, v := executionFixture(t)
	v.NotBefore = time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	v.ExpiresAt = v.NotBefore.Add(time.Hour)
	writeExecutionJSON(t, s, TaskViewPath, v, 0640)
	snap, e := load(s)
	if e != nil {
		t.Fatal(e)
	}
	defer snap.Close()
	if _, e = snap.LoadExecution(); e != nil {
		t.Fatal(e)
	}
	got, e := snap.ReadTaskView()
	if e != nil || !got.ExpiresAt.Before(time.Now()) {
		t.Fatalf("request-level responsibility changed: %v", e)
	}
}
func TestExecutionNetworkStrictOrigins(t *testing.T) {
	for _, p := range []string{"http://host", "https://host/", "http://127.0.0.1:8080"} {
		if !validNetwork(Network{HTTPSProxy: p}) {
			t.Fatalf("valid origin rejected: %s", p)
		}
	}
	for _, p := range []string{"http://u:p@host", "http://host?", "http://host#", "http://host/path", "http://host\n", "ftp://host", "http://host:99999"} {
		if validNetwork(Network{HTTPSProxy: p}) {
			t.Fatalf("invalid origin accepted: %q", p)
		}
	}
	if validNetwork(Network{NoProxy: "host\tother"}) {
		t.Fatal("control character accepted")
	}
}

func TestTaskViewRequiresOwnedRegularPrivateFile(t *testing.T) {
	for _, kind := range []string{"missing", "symlink", "permissions", "unknown field"} {
		t.Run(kind, func(t *testing.T) {
			s, _, _, _ := executionFixture(t)
			path := fixturePath(s, TaskViewPath)
			switch kind {
			case "missing":
				if e := os.Remove(path); e != nil {
					t.Fatal(e)
				}
			case "symlink":
				if e := os.Rename(path, path+".saved"); e != nil {
					t.Fatal(e)
				}
				if e := os.Symlink(path+".saved", path); e != nil {
					t.Fatal(e)
				}
			case "permissions":
				if e := os.Chmod(path, 0644); e != nil {
					t.Fatal(e)
				}
			case "unknown field":
				b, e := os.ReadFile(path)
				if e != nil {
					t.Fatal(e)
				}
				b = append([]byte(`{"canDelete":true,`), b[1:]...)
				if e := os.WriteFile(path, b, 0640); e != nil {
					t.Fatal(e)
				}
			}
			snap, e := load(s)
			if e != nil {
				t.Fatal(e)
			}
			defer snap.Close()
			_, e = snap.LoadExecution()
			if kind == "unknown field" {
				if e != nil {
					t.Fatal(e)
				}
				_, e = snap.ReadTaskView()
			}
			if e == nil {
				t.Fatal("unsafe task view accepted")
			}
		})
	}
}
