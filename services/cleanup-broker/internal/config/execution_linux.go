//go:build linux

package config

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/permit"
)

const (
	InstallManifestPath = "/usr/lib/openslack-cleanup/install-manifest.json"
	TaskViewPath        = "/etc/openslack-cleanup/task-dependencies.json"
	ShellPath           = "/usr/lib/openslack-cleanup/sh"
	GitCorePath         = "/usr/lib/openslack-cleanup/git-core"
)

type InstalledFile struct {
	Path   string `json:"path"`
	SHA256 string `json:"sha256"`
}
type Network struct {
	HTTPSProxy string `json:"httpsProxy"`
	NoProxy    string `json:"noProxy"`
}
type ExecutionInstallation struct {
	Schema  string          `json:"schema"`
	Files   []InstalledFile `json:"files"`
	Network Network         `json:"network"`
}
type TaskDependency struct {
	TaskID      string `json:"taskId"`
	IssueNumber uint64 `json:"issueNumber"`
	State       string `json:"state"`
}
type TaskView struct {
	Schema       string           `json:"schema"`
	WorkspaceID  string           `json:"workspaceId"`
	Repository   string           `json:"repository"`
	RepositoryID string           `json:"repositoryId"`
	NotBefore    time.Time        `json:"notBefore"`
	ExpiresAt    time.Time        `json:"expiresAt"`
	Tasks        []TaskDependency `json:"tasks"`
}

// LoadExecution adds administrator-owned installation evidence to this boot's
// immutable snapshot. There is no caller-selected manifest or refresh operation.
// Failure disables execution; callers may retain authenticated history service.
func (s *Snapshot) LoadExecution() (ExecutionInstallation, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var result ExecutionInstallation
	if s.checkUnchanged() != nil {
		return result, ErrChanged
	}
	f, err := s.pinAdditional(InstallManifestPath, false, false, 256<<10)
	if err != nil {
		return result, err
	}
	b, err := readStable(f)
	if err != nil || permit.Decode(b, &result) != nil || result.Schema != "openslack.cleanup_installation.v1" || len(result.Files) < 5 || len(result.Files) > 256 {
		return ExecutionInstallation{}, ErrInvalidConfig
	}
	manifestHash := sha256.Sum256(b)
	if hex.EncodeToString(manifestHash[:]) != s.config.Artifacts.InstallManifestSHA256 {
		return ExecutionInstallation{}, ErrUnsafeInstallation
	}
	if !validNetwork(result.Network) {
		return ExecutionInstallation{}, ErrInvalidConfig
	}
	var raw struct {
		Files []json.RawMessage `json:"files"`
	}
	if json.Unmarshal(b, &raw) != nil {
		return ExecutionInstallation{}, ErrInvalidConfig
	}
	seen := map[string]bool{}
	for i, entry := range result.Files {
		var exact InstalledFile
		if permit.Decode(raw.Files[i], &exact) != nil || !sha256Pattern.MatchString(entry.SHA256) || filepath.Clean(entry.Path) != entry.Path || seen[entry.Path] || !strings.HasPrefix(entry.Path, "/usr/lib/") || strings.ContainsAny(entry.Path, "\x00\r\n") {
			return ExecutionInstallation{}, ErrInvalidConfig
		}
		seen[entry.Path] = true
		pf, e := s.pinAdditional(entry.Path, false, entry.Path == ShellPath || strings.HasPrefix(entry.Path, GitCorePath+"/"), 512<<20)
		if e != nil {
			return ExecutionInstallation{}, e
		}
		h := sha256.New()
		n, e := io.Copy(h, io.NewSectionReader(pf.file, 0, pf.stamp.Size))
		if e != nil || n != pf.stamp.Size || !sameFD(pf) || hex.EncodeToString(h.Sum(nil)) != entry.SHA256 {
			return ExecutionInstallation{}, ErrUnsafeInstallation
		}
	}
	for _, required := range []string{NodePath, ExecutorPath, GitPath, ShellPath, GitCorePath + "/git-remote-https"} {
		if !seen[required] {
			return ExecutionInstallation{}, ErrInvalidConfig
		}
	}
	tf, err := s.pinAdditional(TaskViewPath, true, false, 256<<10)
	if err != nil {
		return ExecutionInstallation{}, err
	}
	tb, err := readStable(tf)
	if err != nil {
		return ExecutionInstallation{}, err
	}
	taskHash := sha256.Sum256(tb)
	s.executionHashes = map[string]string{"installation": hex.EncodeToString(manifestHash[:]), "taskView": hex.EncodeToString(taskHash[:]), "configuration": s.configHash}
	for _, file := range result.Files {
		s.executionHashes[file.Path] = file.SHA256
	}
	if s.checkUnchanged() != nil {
		return ExecutionInstallation{}, ErrChanged
	}
	return result, nil
}

func validNetwork(n Network) bool {
	if len(n.NoProxy) > 2048 {
		return false
	}
	for _, c := range n.NoProxy {
		if c < 32 || c > 126 {
			return false
		}
	}
	if n.HTTPSProxy == "" {
		return true
	}
	u, e := url.Parse(n.HTTPSProxy)
	if e != nil {
		return false
	}
	if port := u.Port(); port != "" {
		number, err := strconv.Atoi(port)
		if err != nil || number > 65535 {
			return false
		}
	}
	return e == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Hostname() != "" && u.User == nil && (n.HTTPSProxy == u.Scheme+"://"+u.Host || n.HTTPSProxy == u.Scheme+"://"+u.Host+"/") && len(n.HTTPSProxy) <= 2048
}

func (s *Snapshot) pinAdditional(path string, private, executable bool, limit int64) (*pinnedFile, error) {
	if f := s.files[path]; f != nil {
		return f, nil
	}
	f, e := s.openPinned(path, private, executable, limit)
	if e != nil {
		return nil, e
	}
	s.files[path] = f
	return f, nil
}

// ReadTaskView uses pinned administrator data, never the temporary Git directory.
// Its validity window must be checked at each resource preflight/final check.
func (s *Snapshot) ReadTaskView() (TaskView, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	var v TaskView
	if s.checkUnchanged() != nil {
		return v, ErrChanged
	}
	f := s.files[TaskViewPath]
	if f == nil {
		return v, ErrInvalidConfig
	}
	b, e := readStable(f)
	if e != nil || permit.Decode(b, &v) != nil || v.Schema != "openslack.cleanup_task_view.v1" || v.WorkspaceID != s.config.WorkspaceID || v.Repository != s.config.GitHubApp.Owner+"/"+s.config.GitHubApp.Repo || !positiveDecimal(v.RepositoryID) || !v.NotBefore.Before(v.ExpiresAt) || len(v.Tasks) > 4096 {
		return TaskView{}, ErrInvalidConfig
	}
	var raw struct {
		Tasks []json.RawMessage `json:"tasks"`
	}
	if json.Unmarshal(b, &raw) != nil {
		return TaskView{}, ErrInvalidConfig
	}
	seen := map[string]bool{}
	for i, t := range v.Tasks {
		var exact TaskDependency
		if permit.Decode(raw.Tasks[i], &exact) != nil || !id.MatchString(t.TaskID) || t.IssueNumber == 0 || t.IssueNumber > 9007199254740991 || seen[t.TaskID] {
			return TaskView{}, ErrInvalidConfig
		}
		seen[t.TaskID] = true
		switch t.State {
		case "pending", "claimed", "in-progress", "completed", "released":
		default:
			return TaskView{}, ErrInvalidConfig
		}
	}
	if s.checkUnchanged() != nil {
		return TaskView{}, ErrChanged
	}
	return v, nil
}
func positiveDecimal(s string) bool {
	if len(s) == 0 || len(s) > 39 || s[0] == '0' {
		return false
	}
	for _, c := range s {
		if c < '0' || c > '9' {
			return false
		}
	}
	return true
}

func (s *Snapshot) EvidenceHashes() map[string]string {
	s.mu.Lock()
	defer s.mu.Unlock()
	m := map[string]string{"node": s.config.Artifacts.NodeSHA256, "executor": s.config.Artifacts.ExecutorSHA256, "git": s.config.Artifacts.GitSHA256, "installation": s.config.Artifacts.InstallManifestSHA256, "configuration": s.configHash}
	for k, v := range s.executionHashes {
		m[k] = v
	}
	return m
}
