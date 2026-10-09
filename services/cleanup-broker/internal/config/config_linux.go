//go:build linux

// Package config loads the administrator installation from fixed Linux paths.
// Caller checkouts, arguments and environment variables cannot select authority,
// executables, configuration or credential files. The broker must run as its
// dedicated, non-root OS identity; private test fixtures do not prove isolation.
package config

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"regexp"
	"strings"
	"sync"
	"syscall"

	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/permit"
)

const (
	Schema                   = "openslack.cleanup_broker_config.v2"
	ConfigPath               = "/etc/openslack-cleanup/broker.json"
	SocketPath               = "/run/openslack-cleanup/broker.sock"
	StatePath                = "/var/lib/openslack-cleanup"
	NodePath                 = "/usr/lib/openslack-cleanup/node"
	ExecutorPath             = "/usr/lib/openslack-cleanup/executor.mjs"
	GitPath                  = "/usr/lib/openslack-cleanup/git"
	GovernanceCredentialPath = "/etc/openslack-cleanup/credentials/governance"
	GitHubAppPrivateKeyPath  = "/etc/openslack-cleanup/credentials/github-app-private-key"
	maxSmallFile             = 65536
)

var (
	ErrInvalidConfig      = errors.New("BROKER_CONFIG_INVALID")
	ErrUnsafeInstallation = errors.New("BROKER_INSTALLATION_UNSAFE")
	ErrChanged            = errors.New("BROKER_INSTALLATION_CHANGED_RESTART_REQUIRED")
	ErrClosed             = errors.New("BROKER_CONFIG_CLOSED")
	id                    = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`)
	name                  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$`)
	sha256Pattern         = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

type PeerBinding struct {
	UID     uint32         `json:"uid"`
	AgentID string         `json:"agentId"`
	Subject permit.Subject `json:"subject"`
}

type Artifacts struct {
	NodeSHA256            string `json:"nodeSHA256"`
	ExecutorSHA256        string `json:"executorSHA256"`
	GitSHA256             string `json:"gitSHA256"`
	InstallManifestSHA256 string `json:"installManifestSHA256"`
}

type CredentialRefs struct {
	Governance          string `json:"governance"`
	GitHubAppPrivateKey string `json:"githubAppPrivateKey"`
}

type GitHubApp struct {
	AppID          uint64 `json:"appId"`
	InstallationID uint64 `json:"installationId"`
	Owner          string `json:"owner"`
	Repo           string `json:"repo"`
}

type Config struct {
	Schema         string         `json:"schema"`
	BrokerID       string         `json:"brokerId"`
	WorkspaceID    string         `json:"workspaceId"`
	UID            uint32         `json:"uid"`
	GID            uint32         `json:"gid"`
	PeerBindings   []PeerBinding  `json:"peerBindings"`
	AllowedRemotes []string       `json:"allowedRemotes"`
	Artifacts      Artifacts      `json:"artifacts"`
	CredentialRefs CredentialRefs `json:"credentialRefs"`
	GitHubApp      GitHubApp      `json:"githubApp"`
}

type CredentialName string

const (
	GovernanceCredential          CredentialName = "governance"
	GitHubAppPrivateKeyCredential CredentialName = "githubAppPrivateKey"
)

// Only load's package-private fixture seam can replace the virtual root or OS
// identity. No environment variable, CLI flag or exported options exposes it.
type loadSpec struct {
	root       string
	ownerUID   uint32
	fileGID    uint32
	runtimeUID uint32
	runtimeGID uint32
}

type pinnedFile struct {
	path       string
	file       *os.File
	stamp      syscall.Stat_t
	private    bool
	executable bool
	limit      int64
}

type Snapshot struct {
	mu              sync.Mutex
	spec            loadSpec
	config          Config
	configHash      string
	files           map[string]*pinnedFile
	changed         bool
	closed          bool
	executionHashes map[string]string
}

// Load refuses root, a root primary group, and mismatched configured identity.
// Supplementary groups and agent nonmembership in the broker credential group
// must be independently checked by the administrator's OS isolation gate.
func Load() (*Snapshot, error) {
	if os.Getuid() != os.Geteuid() || os.Getgid() != os.Getegid() {
		return nil, ErrUnsafeInstallation
	}
	groups, err := os.Getgroups()
	if err != nil {
		return nil, ErrUnsafeInstallation
	}
	for _, group := range groups {
		if group == 0 {
			return nil, ErrUnsafeInstallation
		}
	}
	return load(loadSpec{root: "/", ownerUID: 0, fileGID: uint32(os.Getegid()), runtimeUID: uint32(os.Geteuid()), runtimeGID: uint32(os.Getegid())})
}

func load(spec loadSpec) (_ *Snapshot, err error) {
	if spec.runtimeUID == 0 || spec.runtimeGID == 0 {
		return nil, ErrUnsafeInstallation
	}
	s := &Snapshot{spec: spec, files: make(map[string]*pinnedFile)}
	defer func() {
		if err != nil {
			_ = s.Close()
		}
	}()
	f, err := s.openPinned(ConfigPath, true, false, maxSmallFile)
	if err != nil {
		return nil, err
	}
	s.files[ConfigPath] = f
	raw, err := readStable(f)
	if err != nil {
		return nil, err
	}
	if err = decode(raw, &s.config, spec); err != nil {
		return nil, err
	}
	hash := sha256.Sum256(raw)
	s.configHash = hex.EncodeToString(hash[:])
	artifacts := []struct {
		path, hash string
		executable bool
		limit      int64
	}{
		{NodePath, s.config.Artifacts.NodeSHA256, true, 512 << 20},
		{ExecutorPath, s.config.Artifacts.ExecutorSHA256, false, 16 << 20},
		{GitPath, s.config.Artifacts.GitSHA256, true, 128 << 20},
	}
	for _, a := range artifacts {
		f, err := s.openPinned(a.path, false, a.executable, a.limit)
		if err != nil {
			return nil, err
		}
		s.files[a.path] = f
		h := sha256.New()
		n, err := io.Copy(h, io.NewSectionReader(f.file, 0, f.stamp.Size))
		if err != nil || n != f.stamp.Size || !sameFD(f) || hex.EncodeToString(h.Sum(nil)) != a.hash {
			return nil, ErrUnsafeInstallation
		}
	}
	// These are opened and metadata-validated only, not read or hashed at startup.
	for _, path := range []string{GovernanceCredentialPath, GitHubAppPrivateKeyPath} {
		f, err := s.openPinned(path, true, false, maxSmallFile)
		if err != nil {
			return nil, err
		}
		s.files[path] = f
	}
	if err := s.checkUnchanged(); err != nil {
		return nil, err
	}
	return s, nil
}

func decode(raw []byte, c *Config, spec loadSpec) error {
	if permit.Decode(raw, c) != nil {
		return ErrInvalidConfig
	}
	// permit.Decode validates exact struct fields; validate each array element
	// too, so missing/case-aliased fields in peer objects cannot be defaulted.
	var top map[string]json.RawMessage
	if json.Unmarshal(raw, &top) != nil {
		return ErrInvalidConfig
	}
	var peers []json.RawMessage
	if json.Unmarshal(top["peerBindings"], &peers) != nil {
		return ErrInvalidConfig
	}
	for _, rawPeer := range peers {
		var p PeerBinding
		if permit.Decode(rawPeer, &p) != nil {
			return ErrInvalidConfig
		}
	}
	if c.Schema != Schema || !id.MatchString(c.BrokerID) || !id.MatchString(c.WorkspaceID) ||
		c.UID == 0 || c.GID == 0 || c.UID != spec.runtimeUID || c.GID != spec.runtimeGID ||
		len(c.PeerBindings) == 0 || len(c.PeerBindings) > 64 || len(c.AllowedRemotes) == 0 || len(c.AllowedRemotes) > 32 ||
		!sha256Pattern.MatchString(c.Artifacts.NodeSHA256) || !sha256Pattern.MatchString(c.Artifacts.ExecutorSHA256) || !sha256Pattern.MatchString(c.Artifacts.GitSHA256) || !sha256Pattern.MatchString(c.Artifacts.InstallManifestSHA256) ||
		c.CredentialRefs.Governance != GovernanceCredentialPath || c.CredentialRefs.GitHubAppPrivateKey != GitHubAppPrivateKeyPath ||
		c.GitHubApp.AppID == 0 || c.GitHubApp.AppID > 9007199254740991 || c.GitHubApp.InstallationID == 0 || c.GitHubApp.InstallationID > 9007199254740991 ||
		!name.MatchString(c.GitHubApp.Owner) || !name.MatchString(c.GitHubApp.Repo) {
		return ErrInvalidConfig
	}
	seenUID := map[uint32]bool{}
	seenSubject := map[permit.Subject]bool{}
	for _, p := range c.PeerBindings {
		if p.UID == 0 || p.UID == c.UID || !id.MatchString(p.AgentID) || !permit.ValidSubject(p.Subject) || seenUID[p.UID] || seenSubject[p.Subject] {
			return ErrInvalidConfig
		}
		seenUID[p.UID] = true
		seenSubject[p.Subject] = true
	}
	seenRemote := map[string]bool{}
	for _, remote := range c.AllowedRemotes {
		if !name.MatchString(remote) || strings.Contains(remote, "..") || strings.HasSuffix(remote, ".") || seenRemote[remote] {
			return ErrInvalidConfig
		}
		seenRemote[remote] = true
	}
	return nil
}

func sameStamp(a, b syscall.Stat_t) bool {
	return a.Dev == b.Dev && a.Ino == b.Ino && a.Mode == b.Mode && a.Uid == b.Uid && a.Gid == b.Gid && a.Nlink == b.Nlink && a.Size == b.Size && a.Mtim == b.Mtim && a.Ctim == b.Ctim
}

func sameFD(f *pinnedFile) bool {
	var current syscall.Stat_t
	return syscall.Fstat(int(f.file.Fd()), &current) == nil && sameStamp(f.stamp, current)
}

func readStable(f *pinnedFile) ([]byte, error) {
	if !sameFD(f) {
		return nil, ErrChanged
	}
	b := make([]byte, f.stamp.Size)
	n, err := f.file.ReadAt(b, 0)
	if err != nil || n != len(b) || !sameFD(f) {
		clear(b)
		return nil, ErrChanged
	}
	return b, nil
}

func (s *Snapshot) openPinned(path string, private, executable bool, limit int64) (*pinnedFile, error) {
	// Base paths are fixed constants. Execution dependencies are restricted to
	// canonical /usr/lib paths in the hash-bound administrator install manifest.
	parts := strings.Split(strings.TrimPrefix(path, "/"), "/")
	fd, err := syscall.Open(s.spec.root, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, ErrUnsafeInstallation
	}
	for i, part := range parts {
		var st syscall.Stat_t
		if syscall.Fstat(fd, &st) != nil || !s.safeDirectory(st) {
			syscall.Close(fd)
			return nil, ErrUnsafeInstallation
		}
		flags := syscall.O_RDONLY | syscall.O_NOFOLLOW | syscall.O_CLOEXEC | syscall.O_NONBLOCK
		if i < len(parts)-1 {
			flags |= syscall.O_DIRECTORY
		}
		next, e := syscall.Openat(fd, part, flags, 0)
		syscall.Close(fd)
		if e != nil {
			return nil, ErrUnsafeInstallation
		}
		fd = next
	}
	f := os.NewFile(uintptr(fd), path)
	var st syscall.Stat_t
	if syscall.Fstat(fd, &st) != nil || st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Nlink != 1 || st.Uid != s.spec.ownerUID ||
		st.Mode&07022 != 0 || st.Size <= 0 || st.Size > limit {
		f.Close()
		return nil, ErrUnsafeInstallation
	}
	if private && (st.Mode&07777 != 0640 || st.Gid != s.spec.fileGID) {
		f.Close()
		return nil, ErrUnsafeInstallation
	}
	needed := uint32(4)
	if executable {
		needed |= 1
	}
	if s.effectiveMode(st)&needed != needed {
		f.Close()
		return nil, ErrUnsafeInstallation
	}
	return &pinnedFile{path: path, file: f, stamp: st, private: private, executable: executable, limit: limit}, nil
}

func (s *Snapshot) effectiveMode(st syscall.Stat_t) uint32 {
	if st.Uid == s.spec.runtimeUID {
		return (st.Mode >> 6) & 7
	}
	if st.Gid == s.spec.fileGID {
		return (st.Mode >> 3) & 7
	}
	return st.Mode & 7
}

func (s *Snapshot) safeDirectory(st syscall.Stat_t) bool {
	return st.Mode&syscall.S_IFMT == syscall.S_IFDIR && st.Uid == s.spec.ownerUID && st.Mode&07022 == 0 && s.effectiveMode(st)&1 == 1
}

func (s *Snapshot) Config() Config {
	s.mu.Lock()
	defer s.mu.Unlock()
	c := s.config
	c.PeerBindings = append([]PeerBinding(nil), c.PeerBindings...)
	c.AllowedRemotes = append([]string(nil), c.AllowedRemotes...)
	return c
}

func (s *Snapshot) ConfigSHA256() string { s.mu.Lock(); defer s.mu.Unlock(); return s.configHash }

// CheckUnchanged compares the bound descriptor and a fresh no-follow path walk.
// Any failure is sticky for this process, even if old bytes are later restored.
func (s *Snapshot) CheckUnchanged() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.checkUnchanged()
}

func (s *Snapshot) checkUnchanged() error {
	if s.closed {
		return ErrClosed
	}
	if s.changed {
		return ErrChanged
	}
	for _, f := range s.files {
		if !sameFD(f) {
			s.changed = true
			return ErrChanged
		}
		now, err := s.openPinned(f.path, f.private, f.executable, f.limit)
		if err != nil {
			s.changed = true
			return ErrChanged
		}
		match := sameStamp(f.stamp, now.stamp) && sameFD(f)
		now.file.Close()
		if !match {
			s.changed = true
			return ErrChanged
		}
	}
	return nil
}

// ReadOwnedCredential is for broker internals, never a client response. It reads
// only a descriptor pinned at startup. The caller owns and must not log the bytes.
func (s *Snapshot) ReadOwnedCredential(name CredentialName) ([]byte, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.checkUnchanged(); err != nil {
		return nil, err
	}
	var path string
	switch name {
	case GovernanceCredential:
		path = GovernanceCredentialPath
	case GitHubAppPrivateKeyCredential:
		path = GitHubAppPrivateKeyPath
	default:
		return nil, ErrInvalidConfig
	}
	b, err := readStable(s.files[path])
	if err != nil {
		s.changed = true
		return nil, ErrChanged
	}
	if err := s.checkUnchanged(); err != nil {
		clear(b)
		return nil, err
	}
	return b, nil
}

func (s *Snapshot) Close() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil
	}
	s.closed = true
	var errs []error
	for _, f := range s.files {
		errs = append(errs, f.file.Close())
	}
	return errors.Join(errs...)
}
