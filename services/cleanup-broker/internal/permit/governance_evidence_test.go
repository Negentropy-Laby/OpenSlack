package permit

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// This is a committed, non-secret review-evidence check, not a runtime authority
// reader. Runtime still acquires its three inputs from one fixed main commit and
// independently checks the live peer, resource, task dependencies, and instance.
type evidenceRef struct {
	File   string `json:"file"`
	SHA256 string `json:"sha256"`
}

type scopeEvidence struct {
	Schema                 string      `json:"schema"`
	PermitID               string      `json:"permitId"`
	TaskRef                string      `json:"taskRef"`
	TaskRefSemantics       string      `json:"taskRefSemantics"`
	IssuerTrustDomain      string      `json:"issuerTrustDomain"`
	ProposedGeneration     string      `json:"proposedGeneration"`
	GenerationRationale    string      `json:"generationRationale"`
	InstanceObservation    evidenceRef `json:"instanceObservation"`
	TaskViewObservation    evidenceRef `json:"taskViewObservation"`
	TaskScopeConfirmation  evidenceRef `json:"taskScopeConfirmation"`
	TargetPRObservation    evidenceRef `json:"targetPRObservation"`
	AdministratorSelection evidenceRef `json:"administratorSelection"`
	StateObservation       evidenceRef `json:"stateObservation"`
	PolicySnapshot         evidenceRef `json:"policySnapshot"`
}

type governanceEvidence struct {
	Scope    scopeEvidence
	Policy   Policy
	Instance struct {
		Schema, Result, RealNonce, InstanceSHA256 string
		PID                                       int
		RecordedAt, ExpiresAt                     time.Time
		Instance                                  struct {
			Schema, BrokerID, WorkspaceID, BootNonce, Generation string
			StartedAt                                            time.Time
		}
	}
	TaskView struct {
		Schema, SHA256, ExactBytesUTF8 string
		ObservedAt                     time.Time
	}
	Confirmation struct {
		Schema, TaskViewSHA256, HumanResponse, Provenance string
		ExpiresAt                                         time.Time
		NoExternalAssociatedTasks                         bool
		MergeApproved, DeletionApproved                   bool
	}
	Target struct {
		Schema, Repository, RepositoryID, NodeID, HeadRepositoryID string
		HeadRef, HeadSHA, BaseRef, State                           string
		Number                                                     uint64
		Merged                                                     bool
		ObservedAt                                                 time.Time
	}
	Selection struct {
		Schema, SourceSHA256, ApprovedBy, IssuerTrustDomain string
		ApprovedAt                                          time.Time
	}
	State struct {
		Schema     string
		ObservedAt time.Time
		Files      []struct {
			Path, Mode string
			Bytes      int64
			UID, GID   int
		}
	}
	Contract struct {
		RegistrySHA256 string
		Bindings       struct{ WorkspaceID, Repository, RepositoryID string }
		RuntimeBinding struct {
			AgentID     string `json:"agent_id"`
			PrincipalID string `json:"principal_id"`
			RuntimeUID  string `json:"runtime_uid_claim"`
			RunID       string `json:"run_id"`
		}
		Identities struct {
			Broker struct {
				ID       string
				UID, GID int
			}
		}
		Governance struct{ Repository, RepositoryID, DefaultBranch, IssuerTrustDomain string }
	}
}

func evidenceBytes(t *testing.T, directory string, ref evidenceRef, out any) []byte {
	t.Helper()
	if filepath.Base(ref.File) != ref.File || !strings.HasSuffix(ref.File, ".json") || !nonce.MatchString(ref.SHA256) {
		t.Fatal("invalid committed evidence reference")
	}
	data, err := os.ReadFile(filepath.Join(directory, ref.File))
	if err != nil {
		t.Fatal(err)
	}
	if sum := sha256.Sum256(data); hex.EncodeToString(sum[:]) != ref.SHA256 {
		t.Fatalf("%s evidence digest mismatch", ref.File)
	}
	if err := json.Unmarshal(data, out); err != nil {
		t.Fatal(err)
	}
	return data
}

func loadGovernanceEvidence(t *testing.T) governanceEvidence {
	t.Helper()
	root := repoRoot(t)
	dir := filepath.Join(root, ".openslack/audit/cleanup-qualification/batch2-single-pr-20261018")
	var e governanceEvidence
	data, err := os.ReadFile(filepath.Join(dir, "scope-evidence.json"))
	if err != nil || Decode(data, &e.Scope) != nil {
		t.Fatal("committed scope evidence missing or not a closed record")
	}
	evidenceBytes(t, dir, e.Scope.InstanceObservation, &e.Instance)
	evidenceBytes(t, dir, e.Scope.TaskViewObservation, &e.TaskView)
	evidenceBytes(t, dir, e.Scope.TaskScopeConfirmation, &e.Confirmation)
	evidenceBytes(t, dir, e.Scope.TargetPRObservation, &e.Target)
	evidenceBytes(t, dir, e.Scope.AdministratorSelection, &e.Selection)
	evidenceBytes(t, dir, e.Scope.StateObservation, &e.State)
	if Decode(evidenceBytes(t, dir, e.Scope.PolicySnapshot, &e.Policy), &e.Policy) != nil {
		t.Fatal("original policy snapshot does not satisfy the production contract")
	}
	data, err = os.ReadFile(filepath.Join(root, "packages/pr/src/internal/cleanup-administration-contract.json"))
	if err != nil || json.Unmarshal(data, &e.Contract) != nil {
		t.Fatal("administrator contract missing")
	}
	registry, err := os.ReadFile(filepath.Join(root, ".openslack/agents/registry", e.Contract.RuntimeBinding.AgentID+".yaml"))
	if err != nil {
		t.Fatal(err)
	}
	if sum := sha256.Sum256(registry); hex.EncodeToString(sum[:]) != e.Contract.RegistrySHA256 {
		t.Fatal("reviewed registry bytes changed")
	}
	return e
}

func checkGovernanceEvidence(p Permit, e governanceEvidence) error {
	policy := e.Policy // Historical evidence is checked against its own policy, never a later boot.
	bad := func(s string) error { return fmt.Errorf("committed binding: %s", s) }
	if e.Scope.Schema != "openslack.cleanup_governance_scope_evidence.v1" || p.ID != e.Scope.PermitID ||
		p.TaskRef != e.Scope.TaskRef || e.Scope.TaskRefSemantics != "administrative_audit_correlation_not_live_task_authority" {
		return bad("administrative scope")
	}
	if e.Contract.Governance.Repository != "Negentropy-Laby/OpenSlack" || e.Contract.Governance.RepositoryID != "1239520892" || e.Contract.Governance.DefaultBranch != "main" {
		return bad("fixed authority")
	}
	if e.Selection.Schema != "openslack.cleanup_governance_administrator_selection.v1" || !nonce.MatchString(e.Selection.SourceSHA256) ||
		e.Selection.ApprovedBy != "github:wsman" || e.Selection.ApprovedAt.IsZero() ||
		p.IssuerTrustDomain != e.Selection.IssuerTrustDomain || p.IssuerTrustDomain != e.Contract.Governance.IssuerTrustDomain ||
		p.IssuerTrustDomain != e.Scope.IssuerTrustDomain || policy.IssuerTrustDomain != p.IssuerTrustDomain {
		return bad("selected issuer")
	}
	if p.Subject != (Subject{e.Contract.RuntimeBinding.PrincipalID, e.Contract.RuntimeBinding.RuntimeUID, e.Contract.RuntimeBinding.RunID}) {
		return bad("reviewed subject")
	}
	if e.Instance.Schema != "openslack.cleanup_instance_observation.v1" || e.Instance.Result != "PASS" || e.Instance.PID <= 0 ||
		e.Instance.RecordedAt.IsZero() || !e.Instance.RecordedAt.Before(e.Instance.ExpiresAt) ||
		e.Instance.Instance.Schema != "openslack.cleanup_broker_instance.v1" || e.Instance.RealNonce != e.Instance.Instance.BootNonce ||
		!nonce.MatchString(e.Instance.InstanceSHA256) || p.Instance.BootNonce != e.Instance.RealNonce ||
		p.Instance.BrokerID != e.Instance.Instance.BrokerID || p.Instance.BrokerID != e.Contract.Identities.Broker.ID ||
		e.Instance.Instance.WorkspaceID != e.Contract.Bindings.WorkspaceID || e.Instance.Instance.Generation != "" ||
		e.Scope.ProposedGeneration != "1" || e.Scope.GenerationRationale == "" || p.Instance.Generation != e.Scope.ProposedGeneration || policy.ActiveInstance != p.Instance {
		return bad("observed boot and explicit first activation")
	}
	if e.State.Schema != "openslack.cleanup_governance_state_observation.v1" || e.State.ObservedAt.IsZero() || len(e.State.Files) != 2 {
		return bad("initial state observation")
	}
	for i, name := range []string{"ledger.jsonl", "workers.jsonl"} {
		f := e.State.Files[i]
		if f.Path != "/var/lib/openslack-cleanup/"+name || f.Bytes != 0 || f.Mode != "0600" || f.UID != e.Contract.Identities.Broker.UID || f.GID != e.Contract.Identities.Broker.GID {
			return bad("initial empty history")
		}
	}
	if e.Target.Schema != "openslack.cleanup_target_pr_observation.v1" || e.Target.ObservedAt.IsZero() || e.Target.State != "open" || e.Target.Merged ||
		e.Target.Repository != e.Contract.Bindings.Repository || e.Target.RepositoryID != e.Contract.Bindings.RepositoryID ||
		e.Target.HeadRepositoryID != e.Target.RepositoryID || e.Target.BaseRef != "main" ||
		p.Target != (Target{e.Contract.Bindings.WorkspaceID, "github.com", e.Target.RepositoryID, e.Target.Repository, e.Target.NodeID, e.Target.Number, "refs/heads/" + e.Target.HeadRef, e.Target.HeadSHA}) {
		return bad("observed exact target")
	}
	if e.TaskView.Schema != "openslack.cleanup_task_view_observation.v1" || e.TaskView.ObservedAt.IsZero() ||
		e.Confirmation.Schema != "openslack.cleanup_task_scope_administrator_confirmation.v1" ||
		e.Confirmation.Provenance == "" || e.Confirmation.HumanResponse == "" || !e.Confirmation.NoExternalAssociatedTasks ||
		e.Confirmation.MergeApproved || e.Confirmation.DeletionApproved || e.Confirmation.TaskViewSHA256 != e.TaskView.SHA256 {
		return bad("human task scope provenance")
	}
	if sum := sha256.Sum256([]byte(e.TaskView.ExactBytesUTF8)); hex.EncodeToString(sum[:]) != e.TaskView.SHA256 {
		return bad("actual task-view bytes")
	}
	var view struct {
		Schema       string            `json:"schema"`
		WorkspaceID  string            `json:"workspaceId"`
		Repository   string            `json:"repository"`
		RepositoryID string            `json:"repositoryId"`
		NotBefore    time.Time         `json:"notBefore"`
		ExpiresAt    time.Time         `json:"expiresAt"`
		Tasks        []json.RawMessage `json:"tasks"`
	}
	if err := Decode([]byte(e.TaskView.ExactBytesUTF8), &view); err != nil {
		return bad("task-view decode")
	}
	if view.Schema != "openslack.cleanup_task_view.v1" || view.WorkspaceID != p.Target.WorkspaceID ||
		view.Repository != p.Target.Repository || view.RepositoryID != p.Target.RepositoryID || len(view.Tasks) != 0 ||
		!view.NotBefore.Before(view.ExpiresAt) || !e.Confirmation.ExpiresAt.Equal(view.ExpiresAt) ||
		p.NotBefore.Before(view.NotBefore) || p.NotBefore.Before(e.Instance.Instance.StartedAt) ||
		p.ExpiresAt.After(view.ExpiresAt) || p.ExpiresAt.After(e.Instance.ExpiresAt) {
		return bad("reviewed empty task-view window")
	}
	return nil
}

func TestCommittedCleanupActivationEvidence(t *testing.T) {
	e := loadGovernanceEvidence(t)
	data, err := os.ReadFile(filepath.Join(repoRoot(t), ".openslack/policies/pr-cleanup-grants", e.Scope.PermitID+".json"))
	var p Permit
	if err != nil || Decode(data, &p) != nil {
		t.Fatal("evidenced grant missing or invalid")
	}
	if err := checkGovernanceEvidence(p, e); err != nil {
		t.Fatal(err)
	}
	for name, mutate := range map[string]func(*Permit, *Policy, *governanceEvidence){
		"task-ref-typo": func(p *Permit, _ *Policy, _ *governanceEvidence) { p.TaskRef += "-typo" },
		"paired-issuer-typo": func(p *Permit, policy *Policy, _ *governanceEvidence) {
			p.IssuerTrustDomain = "other"
			policy.IssuerTrustDomain = "other"
		},
		"paired-nonce-typo": func(p *Permit, policy *Policy, _ *governanceEvidence) {
			p.Instance.BootNonce = strings.Repeat("f", 64)
			policy.ActiveInstance = p.Instance
		},
		"generation-guess": func(p *Permit, policy *Policy, _ *governanceEvidence) {
			p.Instance.Generation = "2"
			policy.ActiveInstance = p.Instance
		},
		"subject":                 func(p *Permit, _ *Policy, _ *governanceEvidence) { p.Subject.RunID += "-other" },
		"target":                  func(p *Permit, _ *Policy, _ *governanceEvidence) { p.Target.ExpectedSHA = strings.Repeat("f", 40) },
		"extended-expiry":         func(p *Permit, _ *Policy, _ *governanceEvidence) { p.ExpiresAt = p.ExpiresAt.Add(time.Hour) },
		"backdated-before-boot":   func(p *Permit, _ *Policy, _ *governanceEvidence) { p.NotBefore = time.Time{} },
		"invented-complete-scope": func(_ *Permit, _ *Policy, e *governanceEvidence) { e.Confirmation.NoExternalAssociatedTasks = false },
		"changed-task-view":       func(_ *Permit, _ *Policy, e *governanceEvidence) { e.TaskView.ExactBytesUTF8 += " " },
	} {
		t.Run(name, func(t *testing.T) {
			q, copy := p, e
			policyCopy := copy.Policy
			mutate(&q, &policyCopy, &copy)
			copy.Policy = policyCopy
			if checkGovernanceEvidence(q, copy) == nil {
				t.Fatal("changed binding passed the committed evidence audit")
			}
		})
	}
	current := e.Policy
	current.ActiveInstance.Generation = "2"
	current.ActiveInstance.BootNonce = strings.Repeat("c", 64)
	if err := checkGovernanceEvidence(p, e); err != nil {
		t.Fatalf("retained scope evidence failed after current policy rotation: %v", err)
	}
	if err := Check(p, current, p.Subject, p.Target, current.ActiveInstance, p.NotBefore); err == nil || err.Error() != "BROKER_NOT_ACTIVATED" {
		t.Fatalf("retained evidence reactivated an old grant: %v", err)
	}
}
