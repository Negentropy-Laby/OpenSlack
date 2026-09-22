//go:build linux

package config

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/permit"
)

func fixture(t *testing.T) (loadSpec, Config) {
	t.Helper()
	s := loadSpec{root: t.TempDir(), ownerUID: uint32(os.Geteuid()), fileGID: uint32(os.Getegid()), runtimeUID: 21001, runtimeGID: 21001}
	if err := os.Chmod(s.root, 0755); err != nil {
		t.Fatal(err)
	}
	hash := func(b string) string { sum := sha256.Sum256([]byte(b)); return hex.EncodeToString(sum[:]) }
	c := Config{Schema: Schema, BrokerID: "broker-1", WorkspaceID: "workspace-1", UID: s.runtimeUID, GID: s.runtimeGID,
		PeerBindings:   []PeerBinding{{UID: 21002, AgentID: "test-agent", Subject: permit.Subject{PrincipalID: "principal", RuntimeUID: "runtime", RunID: "run"}}},
		AllowedRemotes: []string{"scratch"}, Artifacts: Artifacts{hash("node"), hash("executor"), hash("git"), hash("manifest")},
		CredentialRefs: CredentialRefs{GovernanceCredentialPath, GitHubAppPrivateKeyPath}, GitHubApp: GitHubApp{1, 2, "Example", "scratch"}}
	for path, content := range map[string]string{NodePath: "node", ExecutorPath: "executor", GitPath: "git", GovernanceCredentialPath: "fixture-token-not-a-real-credential", GitHubAppPrivateKeyPath: "fixture-key-not-a-real-credential"} {
		full := fixturePath(s, path)
		if err := os.MkdirAll(filepath.Dir(full), 0755); err != nil {
			t.Fatal(err)
		}
		mode := os.FileMode(0755)
		if path == ExecutorPath {
			mode = 0644
		}
		if path == GovernanceCredentialPath || path == GitHubAppPrivateKeyPath {
			mode = 0640
		}
		if err := os.WriteFile(full, []byte(content), mode); err != nil {
			t.Fatal(err)
		}
	}
	writeConfig(t, s, c)
	return s, c
}

func fixturePath(s loadSpec, path string) string {
	return filepath.Join(s.root, strings.TrimPrefix(path, "/"))
}

func writeConfig(t *testing.T, s loadSpec, c Config) {
	t.Helper()
	data, err := json.Marshal(c)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fixturePath(s, ConfigPath), data, 0640); err != nil {
		t.Fatal(err)
	}
}

func TestFixedConfigOwnedCopyAndPinnedCredentials(t *testing.T) {
	s, c := fixture(t)
	snap, err := load(s)
	if err != nil {
		t.Fatal(err)
	}
	defer snap.Close()
	copy := snap.Config()
	copy.PeerBindings[0].AgentID = "changed"
	copy.AllowedRemotes[0] = "changed"
	if snap.Config().PeerBindings[0].AgentID != c.PeerBindings[0].AgentID || snap.Config().AllowedRemotes[0] != "scratch" {
		t.Fatal("snapshot aliased mutable caller data")
	}
	if err := snap.CheckUnchanged(); err != nil {
		t.Fatal(err)
	}
	if snap.ConfigSHA256() == "" {
		t.Fatal("missing snapshot digest")
	}
	b, err := snap.ReadOwnedCredential(GovernanceCredential)
	if err != nil || !bytes.Equal(b, []byte("fixture-token-not-a-real-credential")) {
		t.Fatalf("credential read failed: %v", err)
	}
	if _, err := snap.ReadOwnedCredential(CredentialName("caller-path")); !errors.Is(err, ErrInvalidConfig) {
		t.Fatal("unknown credential name accepted")
	}
}

func TestClosedSchemaAndIdentityBinding(t *testing.T) {
	mutations := map[string]func(*Config){
		"wrong schema": func(c *Config) { c.Schema = "unknown" }, "root uid": func(c *Config) { c.UID = 0 }, "root gid": func(c *Config) { c.GID = 0 },
		"wrong uid": func(c *Config) { c.UID++ }, "wrong gid": func(c *Config) { c.GID++ },
		"duplicate peer":      func(c *Config) { c.PeerBindings = append(c.PeerBindings, c.PeerBindings[0]) },
		"broker peer":         func(c *Config) { c.PeerBindings[0].UID = c.UID },
		"remote URL":          func(c *Config) { c.AllowedRemotes = []string{"https://github.com/example/repo"} },
		"duplicate remote":    func(c *Config) { c.AllowedRemotes = []string{"scratch", "scratch"} },
		"credential override": func(c *Config) { c.CredentialRefs.Governance = "/tmp/token" },
		"hash mismatch":       func(c *Config) { c.Artifacts.NodeSHA256 = strings.Repeat("a", 64) },
		"weak hash":           func(c *Config) { c.Artifacts.NodeSHA256 = "abcd" },
		"invalid app":         func(c *Config) { c.GitHubApp.AppID = 0 },
	}
	for name, mutation := range mutations {
		t.Run(name, func(t *testing.T) {
			s, c := fixture(t)
			mutation(&c)
			writeConfig(t, s, c)
			snap, err := load(s)
			if err == nil {
				snap.Close()
				t.Fatal("invalid configuration accepted")
			}
		})
	}
	for name, change := range map[string]func([]byte) []byte{
		"unknown":             func(b []byte) []byte { return append([]byte(`{"unknown":true,`), b[1:]...) },
		"duplicate":           func(b []byte) []byte { return append([]byte(`{"uid":21001,`), b[1:]...) },
		"case alias":          func(b []byte) []byte { return bytes.Replace(b, []byte(`"uid":`), []byte(`"UID":`), 1) },
		"missing array field": func(b []byte) []byte { return bytes.Replace(b, []byte(`"agentId":"test-agent",`), nil, 1) },
		"utf8":                func(b []byte) []byte { return bytes.Replace(b, []byte("broker-1"), []byte{0xff}, 1) },
		"surrogate":           func(b []byte) []byte { return bytes.Replace(b, []byte("broker-1"), []byte(`\ud800`), 1) },
	} {
		t.Run(name, func(t *testing.T) {
			s, _ := fixture(t)
			p := fixturePath(s, ConfigPath)
			b, _ := os.ReadFile(p)
			if err := os.WriteFile(p, change(b), 0640); err != nil {
				t.Fatal(err)
			}
			snap, err := load(s)
			if err == nil {
				snap.Close()
				t.Fatal("ambiguous config accepted")
			}
		})
	}
}

func TestUnsafeInstallationRejected(t *testing.T) {
	for name, change := range map[string]func(loadSpec) error{
		"writable config":     func(s loadSpec) error { return os.Chmod(fixturePath(s, ConfigPath), 0660) },
		"writable directory":  func(s loadSpec) error { return os.Chmod(filepath.Dir(fixturePath(s, NodePath)), 0775) },
		"writable artifact":   func(s loadSpec) error { return os.Chmod(fixturePath(s, NodePath), 0775) },
		"non executable node": func(s loadSpec) error { return os.Chmod(fixturePath(s, NodePath), 0644) },
		"world credential":    func(s loadSpec) error { return os.Chmod(fixturePath(s, GovernanceCredentialPath), 0644) },
		"hardlink artifact":   func(s loadSpec) error { return os.Link(fixturePath(s, NodePath), filepath.Join(s.root, "node-link")) },
		"symlink artifact": func(s loadSpec) error {
			p := fixturePath(s, NodePath)
			if err := os.Rename(p, p+".old"); err != nil {
				return err
			}
			return os.Symlink(p+".old", p)
		},
		"symlink directory": func(s loadSpec) error {
			p := filepath.Dir(fixturePath(s, NodePath))
			if err := os.Rename(p, p+".old"); err != nil {
				return err
			}
			return os.Symlink(p+".old", p)
		},
		"missing credential": func(s loadSpec) error { return os.Remove(fixturePath(s, GovernanceCredentialPath)) },
	} {
		t.Run(name, func(t *testing.T) {
			s, _ := fixture(t)
			if err := change(s); err != nil {
				t.Fatal(err)
			}
			snap, err := load(s)
			if err == nil {
				snap.Close()
				t.Fatal("unsafe installation accepted")
			}
		})
	}
}

func TestMutationPoisonsEvenAfterRestoration(t *testing.T) {
	for _, path := range []string{ConfigPath, NodePath, ExecutorPath, GitPath, GovernanceCredentialPath, GitHubAppPrivateKeyPath} {
		t.Run(filepath.Base(path), func(t *testing.T) {
			s, _ := fixture(t)
			snap, err := load(s)
			if err != nil {
				t.Fatal(err)
			}
			defer snap.Close()
			p := fixturePath(s, path)
			b, _ := os.ReadFile(p)
			if err := os.WriteFile(p, append(b, ' '), 0640); err != nil {
				t.Fatal(err)
			}
			if err := snap.CheckUnchanged(); !errors.Is(err, ErrChanged) {
				t.Fatalf("change undetected: %v", err)
			}
			if err := os.WriteFile(p, b, 0640); err != nil {
				t.Fatal(err)
			}
			if err := snap.CheckUnchanged(); !errors.Is(err, ErrChanged) {
				t.Fatalf("poison not sticky: %v", err)
			}
			if _, err := snap.ReadOwnedCredential(GovernanceCredential); !errors.Is(err, ErrChanged) {
				t.Fatalf("poison bypassed: %v", err)
			}
		})
	}
}

func TestReplacementAndClose(t *testing.T) {
	s, _ := fixture(t)
	snap, err := load(s)
	if err != nil {
		t.Fatal(err)
	}
	p := fixturePath(s, ConfigPath)
	b, _ := os.ReadFile(p)
	if err := os.Rename(p, p+".old"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, b, 0640); err != nil {
		t.Fatal(err)
	}
	if err := snap.CheckUnchanged(); !errors.Is(err, ErrChanged) {
		t.Fatalf("same bytes replacement accepted: %v", err)
	}
	if err := snap.Close(); err != nil {
		t.Fatal(err)
	}
	if err := snap.CheckUnchanged(); !errors.Is(err, ErrClosed) {
		t.Fatal(err)
	}
}

func TestOwnerGroupAndRootIdentityRejected(t *testing.T) {
	for _, change := range []func(*loadSpec){
		func(s *loadSpec) { s.ownerUID++ },
		func(s *loadSpec) { s.fileGID++ },
		func(s *loadSpec) { s.runtimeUID = 0 },
		func(s *loadSpec) { s.runtimeGID = 0 },
	} {
		s, _ := fixture(t)
		change(&s)
		if snap, err := load(s); err == nil {
			snap.Close()
			t.Fatal("ownership/identity mismatch accepted")
		}
	}
}

func TestClosedBoundCredentialFDPoisonsReader(t *testing.T) {
	s, _ := fixture(t)
	snap, err := load(s)
	if err != nil {
		t.Fatal(err)
	}
	defer snap.Close()
	if err := snap.files[GovernanceCredentialPath].file.Close(); err != nil {
		t.Fatal(err)
	}
	if b, err := snap.ReadOwnedCredential(GovernanceCredential); !errors.Is(err, ErrChanged) || b != nil {
		t.Fatal("invalid pinned FD bypassed")
	}
	if err := snap.CheckUnchanged(); !errors.Is(err, ErrChanged) {
		t.Fatal("failure not sticky")
	}
}

func TestCredentialMetadataValidatedWithoutStartupRead(t *testing.T) {
	s, _ := fixture(t)
	// Intentionally invalid token/key syntax: configuration must not interpret,
	// copy, hash or validate secret payloads during startup metadata validation.
	snap, err := load(s)
	if err != nil {
		t.Fatal(err)
	}
	defer snap.Close()
	if snap.files[GovernanceCredentialPath].stamp.Size <= 0 {
		t.Fatal("credential metadata missing")
	}
}
