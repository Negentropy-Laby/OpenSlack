//go:build linux && integration

package runner

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/config"
	"github.com/Negentropy-Laby/OpenSlack/services/cleanup-broker/internal/ledger"
)

type mappedInstallation struct{ artifactInstallation }

func (f *mappedInstallation) ReadTaskView() (config.TaskView, error) {
	v, _ := f.artifactInstallation.ReadTaskView()
	v.Repository = "example/qualification"
	v.RepositoryID = "123"
	return v, nil
}

// This builds an explicitly TEST ONLY artifact with synthetic GitHub resources
// and fixed-command mapping into a real isolated bare Git repository. It tests
// cross-language/process integration, not authenticated GitHub qualification.
func TestRealRunnerFixtureExecutorAndBareGit(t *testing.T) {
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("source location unavailable")
	}
	root := filepath.Clean(filepath.Join(filepath.Dir(filename), "../../../.."))
	artifact := filepath.Join(t.TempDir(), "test-only-executor.mjs")
	build := exec.Command("bun", "scripts/cleanup-broker/build-test-fixture.ts", artifact)
	build.Dir = root
	if out, err := build.CombinedOutput(); err != nil {
		t.Fatalf("test-only build: %v %s", err, out)
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Fatal(err)
	}
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	privateKey := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(key)})
	for _, scenario := range []string{"preview", "execute", "deny", "unknown"} {
		t.Run(scenario, func(t *testing.T) {
			area := t.TempDir()
			bare := filepath.Join(area, "remote.git")
			work := filepath.Join(area, "work")
			log := filepath.Join(area, "actions.log")
			git := func(args ...string) string {
				t.Helper()
				cmd := exec.Command("git", args...)
				cmd.Dir = area
				cmd.Env = []string{"PATH=/usr/bin:/bin", "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL=/dev/null"}
				out, err := cmd.CombinedOutput()
				if err != nil {
					t.Fatalf("fixture git: %v %s", err, out)
				}
				return strings.TrimSpace(string(out))
			}
			git("init", "--bare", "--initial-branch=main", bare)
			git("clone", bare, work)
			git("-C", work, "-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "commit", "--allow-empty", "-m", "fixture")
			sha := git("-C", work, "rev-parse", "HEAD")
			git("-C", work, "push", "origin", "HEAD:refs/heads/main", "HEAD:refs/heads/fixture")
			if err = os.WriteFile(log, nil, 0600); err != nil {
				t.Fatal(err)
			}
			ledgerDir := filepath.Join(area, "ledger")
			if err = os.Mkdir(ledgerDir, 0700); err != nil {
				t.Fatal(err)
			}
			l, err := ledger.Open(ledgerDir)
			if err != nil {
				t.Fatal(err)
			}
			defer l.Close()
			r, err := newRunner(&mappedInstallation{artifactInstallation{key: privateKey}}, l, func() *exec.Cmd {
				c := exec.Command(node, artifact)
				c.Env = []string{"LANG=C", "PATH=/usr/bin:/bin", "CLEANUP_FIXTURE_BARE=" + bare, "CLEANUP_FIXTURE_WORK=" + work, "CLEANUP_FIXTURE_LOG=" + log, "CLEANUP_FIXTURE_SHA=" + sha}
				if scenario == "unknown" {
					c.Env = append(c.Env, "CLEANUP_FIXTURE_UNKNOWN=1")
				}
				return c
			})
			if err != nil {
				t.Fatal(err)
			}
			defer r.Close()
			_, _, e := runnerFixture(t, "success")
			e.Request.Repo = "example/qualification"
			e.Request.Remote = "qualification"
			e.Target.Repository = "example/qualification"
			e.Target.RepositoryID = "123"
			e.Target.PRNodeID = "PR_test"
			e.Target.Ref = "refs/heads/fixture"
			e.Target.ExpectedSHA = sha
			e.Bundle.Permit.Target = e.Target
			registry := `{"schema":"openslack.agent_registry.v2","agent_id":"agent","display_name":"Fixture","employee_type":"ai_agent","identity":{"uid":"uid","principal_id":"principal","status":"active"},"vendor":{"provider":"openai","runtime":"codex"},"employment":{"status":"active","hired_at":"2026-09-21T00:00:00.000Z"},"capabilities":{"primary":["typescript"]},"repositories":{"workspace_repo":{"owner":"example","repo":"qualification","default_branch":"main"}},"permissions":{"paths":{"allow":[],"deny":[]},"actions":{"pr.cleanup_branch_scoped.v1":"allow","pr.cleanup_branch":"deny"},"github":{"can_create_pr":false,"can_comment":false,"can_approve":false,"can_merge":false},"max_risk_zone":"yellow"},"execution":{},"output_contract":{"must_create":[],"may_create":[],"must_not_create":[]},"approval_rules":{"require_human_approval_for":["merge_to_main"]}}`
			if !json.Valid([]byte(registry)) {
				t.Fatal("invalid test registry")
			}
			e.Bundle.Registry = []byte(registry)
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			p, err := r.Preflight(ctx, e.Request, e.Bundle)
			if err != nil || p.State != "CLEANUP_READY" {
				t.Fatalf("actual fixture preview: %+v %v", p, err)
			}
			countPush := func() int {
				bytes, err := os.ReadFile(log)
				if err != nil {
					t.Fatal(err)
				}
				return strings.Count(string(bytes), "push\n")
			}
			if countPush() != 0 {
				t.Fatal("preview pushed")
			}
			if got := git("--git-dir", bare, "rev-parse", "refs/heads/fixture"); got != sha {
				t.Fatal("preview changed ref")
			}
			if scenario != "preview" {
				calls := 0
				outcome, err := r.Execute(ctx, e, func(context.Context) error {
					calls++
					if scenario == "deny" {
						return errors.New("test denial")
					}
					return nil
				})
				if calls != 1 {
					t.Fatalf("admission count %d", calls)
				}
				switch scenario {
				case "execute":
					if err != nil || outcome.State != "DELETED" || !outcome.Attempted {
						t.Fatalf("execute %+v %v", outcome, err)
					}
				case "deny":
					if err == nil {
						t.Fatal("denial accepted")
					}
				case "unknown":
					if err != nil || outcome.State != "ABSENT_AFTER_ATTEMPT" || !outcome.Attempted {
						t.Fatalf("unknown mislabeled: %+v %v", outcome, err)
					}
				}
				expectedPush := 1
				if scenario == "deny" {
					expectedPush = 0
				}
				if got := countPush(); got != expectedPush {
					t.Fatalf("push count %d want %d", got, expectedPush)
				}
				refs := git("--git-dir", bare, "for-each-ref", "--format=%(refname)", "refs/heads/fixture")
				if scenario == "deny" && refs != "refs/heads/fixture" || scenario != "deny" && refs != "" {
					t.Fatalf("unexpected final ref %q", refs)
				}
				// No follow-up Execute is issued after an unknown result; wait for any
				// unsolicited retry while checking that the managed group is already gone.
				if scenario == "unknown" {
					time.Sleep(100 * time.Millisecond)
					if countPush() != 1 {
						t.Fatal("unknown result retried")
					}
				}
			}
			records, err := l.UnfinishedWorkers()
			if err != nil || len(records) != 0 {
				t.Fatalf("worker group residue: %+v %v", records, err)
			}
			journal, err := os.ReadFile(filepath.Join(ledgerDir, "workers.jsonl"))
			if err != nil {
				t.Fatal(err)
			}
			lines := strings.Split(strings.TrimSpace(string(journal)), "\n")
			wantRecords := 4
			if scenario == "preview" {
				wantRecords = 2
			}
			if len(lines) != wantRecords {
				t.Fatalf("worker journal records %d want %d", len(lines), wantRecords)
			}
			var previous ledger.WorkerEvidence
			for i, line := range lines {
				var record struct {
					Schema   string                `json:"schema"`
					Evidence ledger.WorkerEvidence `json:"evidence"`
					Finished bool                  `json:"finished"`
				}
				if err := json.Unmarshal([]byte(line), &record); err != nil {
					t.Fatal(err)
				}
				if record.Schema != "openslack.cleanup_worker_ledger.v1" || record.Finished != (i%2 == 1) {
					t.Fatalf("invalid worker lifecycle record %d", i)
				}
				if i%2 == 1 && record.Evidence != previous {
					t.Fatalf("worker finish lost startup binding at %d", i)
				}
				if record.Evidence.PID <= 1 || record.Evidence.PGID != record.Evidence.PID || record.Evidence.StartTicks == 0 || record.Evidence.RequestDigest == "" {
					t.Fatalf("missing process/request binding at %d", i)
				}
				if i < 2 && (record.Evidence.Mode != "preflight" || record.Evidence.OperationID != "") || i >= 2 && (record.Evidence.Mode != "execute" || record.Evidence.OperationID != e.Request.OperationID) {
					t.Fatalf("wrong operation binding at %d", i)
				}
				previous = record.Evidence
			}
		})
	}
}
