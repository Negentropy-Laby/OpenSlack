//go:build linux && integration

package runner

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/config"
	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/ledger"
)

type artifactInstallation struct {
	fixtureInstallation
	key   []byte
	proxy string
}

func (f *artifactInstallation) ReadOwnedCredential(config.CredentialName) ([]byte, error) {
	return append([]byte(nil), f.key...), nil
}
func (f *artifactInstallation) LoadExecution() (config.ExecutionInstallation, error) {
	return config.ExecutionInstallation{Network: config.Network{HTTPSProxy: f.proxy}}, nil
}
func (f *artifactInstallation) ReadTaskView() (config.TaskView, error) {
	return config.TaskView{Schema: "openslack.cleanup_task_view.v1", WorkspaceID: "workspace", Repository: "owner/repo", RepositoryID: "1", NotBefore: time.Now().Add(-time.Minute), ExpiresAt: time.Now().Add(time.Minute), Tasks: []config.TaskDependency{}}, nil
}

// Run explicitly with -tags=integration and CLEANUP_EXECUTOR_BUNDLE pointing at
// the freshly built production bundle. The loopback proxy never forwards a byte:
// a CONNECT observation proves parsing and registry authorization reached App
// acquisition, not that any external qualification or deletion succeeded.
func TestActualExecutorArtifactPrivateProtocol(t *testing.T) {
	path := os.Getenv("CLEANUP_EXECUTOR_BUNDLE")
	if !filepath.IsAbs(path) {
		t.Fatal("absolute built bundle path required")
	}
	bytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("actual executor SHA256 %x", sha256.Sum256(bytes))
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	encoded := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	for _, valid := range []bool{false, true} {
		t.Run(map[bool]string{false: "registry-rejected-before-network", true: "execution-preflight-parsed-before-controlled-network-denial"}[valid], func(t *testing.T) {
			var requests atomic.Int32
			proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				if r.Method != "CONNECT" || r.Host != "api.github.com:443" {
					t.Errorf("unexpected network target: %s %s", r.Method, r.Host)
				}
				w.WriteHeader(http.StatusBadGateway)
			}))
			defer proxy.Close()
			dir := t.TempDir()
			os.Chmod(dir, 0700)
			l, err := ledger.Open(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer l.Close()
			r, err := newRunner(&artifactInstallation{key: encoded, proxy: proxy.URL}, l, func() *exec.Cmd {
				c := exec.Command(node, path)
				c.Env = []string{"LANG=C", "PATH=/usr/bin:/bin"}
				return c
			})
			if err != nil {
				t.Fatal(err)
			}
			defer r.Close()
			fixture, _, e := runnerFixture(t, "success")
			_ = fixture
			if valid {
				registry := map[string]any{"schema": "openslack.agent_registry.v2", "agent_id": "agent", "display_name": "Fixture", "employee_type": "ai_agent", "identity": map[string]any{"uid": "uid", "principal_id": "principal", "status": "active"}, "vendor": map[string]any{"provider": "openai", "runtime": "codex"}, "employment": map[string]any{"status": "active", "hired_at": "2026-09-21T00:00:00.000Z"}, "capabilities": map[string]any{"primary": []string{"typescript"}}, "repositories": map[string]any{"workspace_repo": map[string]any{"owner": "owner", "repo": "repo", "default_branch": "main"}}, "permissions": map[string]any{"paths": map[string]any{"allow": []string{}, "deny": []string{}}, "actions": map[string]any{"pr.cleanup_branch_scoped.v1": "allow", "pr.cleanup_branch": "deny"}, "github": map[string]any{"can_create_pr": false, "can_comment": false, "can_approve": false, "can_merge": false}, "max_risk_zone": "yellow"}, "execution": map[string]any{}, "output_contract": map[string]any{"must_create": []string{}, "may_create": []string{}, "must_not_create": []string{}}, "approval_rules": map[string]any{"require_human_approval_for": []string{"merge_to_main"}}}
				e.Bundle.Registry, _ = json.Marshal(registry)
			}
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			_, err = r.Preflight(ctx, e.Request, e.Bundle)
			if err == nil {
				t.Fatal("denied artifact unexpectedly succeeded")
			}
			if valid && requests.Load() == 0 {
				t.Fatal("real TS artifact did not pass structural and registry gates")
			}
			if !valid && requests.Load() != 0 {
				t.Fatal("untrusted registry reached network")
			}
			unfinished, err := l.UnfinishedWorkers()
			if err != nil || len(unfinished) != 0 {
				t.Fatal("actual artifact group not reconciled")
			}
		})
	}
}
