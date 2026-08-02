package governancecontrol_test

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"strings"
	"testing"

	governance "github.com/Negentropy-Laby/OpenSlack/services/governance-control"
	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/authoritystore"
)

type authorityArtifact struct {
	Path       string `json:"path"`
	ByteLength int    `json:"byteLength"`
	SHA256     string `json:"sha256"`
}

func TestGovernanceAuthorityMirrorMatchesTypeScriptContractExactly(t *testing.T) {
	const mirrorRoot = "internal/contractmirror/generated/authority/v1"
	const contractRoot = "../../packages/operator/contracts/governed-plan-authority/v1"
	mirrorManifest, err := os.ReadFile(filepath.Join(mirrorRoot, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	contractManifest, err := os.ReadFile(filepath.Join(contractRoot, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(mirrorManifest, contractManifest) {
		t.Fatal("governance authority manifest mirror is not exact contract bytes")
	}
	var manifest struct {
		Schema    string                       `json:"schema"`
		Authority string                       `json:"authority"`
		Artifacts map[string]authorityArtifact `json:"artifacts"`
	}
	if err := json.Unmarshal(mirrorManifest, &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Schema != "openslack.governance_authority_contract_manifest.v1" ||
		manifest.Authority != authoritystore.Authority || len(manifest.Artifacts) != 7 {
		t.Fatalf("unexpected authority manifest identity: %#v", manifest)
	}
	for name, artifact := range manifest.Artifacts {
		if name != artifact.Path {
			t.Fatalf("artifact key/path drift: %q != %q", name, artifact.Path)
		}
		mirror, err := os.ReadFile(filepath.Join(mirrorRoot, filepath.FromSlash(artifact.Path)))
		if err != nil {
			t.Fatal(err)
		}
		contract, err := os.ReadFile(filepath.Join(contractRoot, filepath.FromSlash(artifact.Path)))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(mirror, contract) || len(mirror) != artifact.ByteLength {
			t.Fatalf("artifact %s is not exact contract bytes", artifact.Path)
		}
		digest := sha256.Sum256(mirror)
		if hex.EncodeToString(digest[:]) != artifact.SHA256 {
			t.Fatalf("artifact %s digest drift", artifact.Path)
		}
	}
}

type authorityGoldenRoute struct {
	Backend      string `json:"backend"`
	RoutingEpoch int64  `json:"routingEpoch"`
	Authority    string `json:"authority"`
}

type authorityGoldenPrepared struct {
	Method             string            `json:"method"`
	Path               string            `json:"path"`
	Headers            map[string]string `json:"headers"`
	ExactBody          string            `json:"exactBody"`
	RequestFingerprint string            `json:"requestFingerprint"`
}

type authorityGoldenSuccessReceipt struct {
	Schema             string               `json:"schema"`
	Operation          string               `json:"operation"`
	Status             string               `json:"status"`
	WorkspaceID        string               `json:"workspaceId"`
	PlanID             string               `json:"planId"`
	ExpectedRevision   int64                `json:"expectedRevision"`
	AcceptedRevision   int64                `json:"acceptedRevision"`
	State              string               `json:"state"`
	Route              authorityGoldenRoute `json:"route"`
	IdempotencyKey     string               `json:"idempotencyKey"`
	RequestFingerprint string               `json:"requestFingerprint"`
	RecordHash         string               `json:"recordHash"`
	CorrelationID      string               `json:"correlationId"`
	CallerID           string               `json:"callerId"`
	ServiceBuildSHA    string               `json:"serviceBuildSha"`
	ExecutionID        string               `json:"executionId,omitempty"`
	Record             json.RawMessage      `json:"record"`
	CommittedAt        string               `json:"committedAt"`
}

type authorityGoldenReconciliationReceipt struct {
	Schema              string               `json:"schema"`
	Operation           string               `json:"operation"`
	Status              string               `json:"status"`
	WorkspaceID         string               `json:"workspaceId"`
	PlanID              string               `json:"planId"`
	ExpectedRevision    int64                `json:"expectedRevision"`
	TargetRevision      int64                `json:"targetRevision"`
	TargetState         string               `json:"targetState"`
	Route               authorityGoldenRoute `json:"route"`
	IdempotencyKey      string               `json:"idempotencyKey"`
	RequestFingerprint  string               `json:"requestFingerprint"`
	RecordHash          string               `json:"recordHash"`
	CorrelationID       string               `json:"correlationId"`
	CallerID            string               `json:"callerId"`
	ServiceBuildSHA     string               `json:"serviceBuildSha"`
	ExecutionID         string               `json:"executionId,omitempty"`
	ReconciliationToken string               `json:"reconciliationToken"`
}

type authorityGoldenVector struct {
	Name                string                                `json:"name"`
	Request             json.RawMessage                       `json:"request"`
	Prepared            authorityGoldenPrepared               `json:"prepared"`
	SuccessReceipt      authorityGoldenSuccessReceipt         `json:"successReceipt"`
	ResponseLostReceipt *authorityGoldenReconciliationReceipt `json:"responseLostReceipt,omitempty"`
}

type authorityPendingAuditGolden struct {
	Name    string `json:"name"`
	Request struct {
		Method  string            `json:"method"`
		Path    string            `json:"path"`
		Headers map[string]string `json:"headers"`
	} `json:"request"`
	Response struct {
		Schema          string               `json:"schema"`
		Status          string               `json:"status"`
		Operation       string               `json:"operation"`
		WorkspaceID     string               `json:"workspaceId"`
		PlanID          string               `json:"planId"`
		Revision        int64                `json:"revision"`
		Route           authorityGoldenRoute `json:"route"`
		RecordHash      string               `json:"recordHash"`
		ServiceBuildSHA string               `json:"serviceBuildSha"`
	} `json:"response"`
}

func TestGovernanceAuthorityGoldenRequestsAndReceiptsMatchGoAlgorithms(t *testing.T) {
	raw, err := os.ReadFile("internal/contractmirror/generated/authority/v1/golden-vectors.json")
	if err != nil {
		t.Fatal(err)
	}
	var vectors struct {
		Schema                        string                        `json:"schema"`
		Authority                     string                        `json:"authority"`
		Generator                     string                        `json:"generator"`
		Vectors                       []authorityGoldenVector       `json:"vectors"`
		PendingAuditRecoveries        []authorityPendingAuditGolden `json:"pendingAuditRecoveries"`
		PendingAuditRecoverySemantics struct {
			Lookup                              []string `json:"lookup"`
			AtMostOnePendingPerPlan             bool     `json:"atMostOnePendingPerPlan"`
			PendingRevisionEqualsCurrentHead    bool     `json:"pendingRevisionEqualsCurrentHead"`
			NextTransitionBlockedWhilePending   bool     `json:"nextTransitionBlockedWhilePending"`
			AuthoritativeRecordLoadedSeparately bool     `json:"authoritativeRecordLoadedSeparately"`
			ResponseHasRecord                   bool     `json:"responseHasRecord"`
			ResponseHasState                    bool     `json:"responseHasState"`
			Query                               string   `json:"query"`
			Body                                string   `json:"body"`
			Absent                              int      `json:"absent"`
			AlreadyRecorded                     int      `json:"alreadyRecorded"`
			RouteEpochMismatch                  int      `json:"routeEpochMismatch"`
			InvalidBindingOrIdentity            int      `json:"invalidBindingOrIdentity"`
			InternalFailure                     int      `json:"internalFailure"`
			Unavailable                         int      `json:"unavailable"`
		} `json:"pendingAuditRecoverySemantics"`
		Boundaries struct {
			ReconciliationToken struct {
				MinimumAccepted string `json:"minimumAccepted"`
				MaximumAccepted string `json:"maximumAccepted"`
				MinimumLength   int    `json:"minimumLength"`
				MaximumLength   int    `json:"maximumLength"`
			} `json:"reconciliationToken"`
		} `json:"boundaries"`
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&vectors); err != nil {
		t.Fatal(err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		t.Fatalf("golden vector trailing JSON: %v", err)
	}
	if vectors.Schema != "openslack.governance_authority_golden_vectors.v1" ||
		vectors.Authority != authoritystore.Authority || vectors.Generator != "@openslack/operator-typescript" || len(vectors.Vectors) != 2 {
		t.Fatalf("golden vector count = %d", len(vectors.Vectors))
	}
	tokenPattern := regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:@/-]*$`)
	boundary := vectors.Boundaries.ReconciliationToken
	if boundary.MinimumLength != 16 || boundary.MaximumLength != 256 ||
		len(boundary.MinimumAccepted) != boundary.MinimumLength || len(boundary.MaximumAccepted) != boundary.MaximumLength ||
		!tokenPattern.MatchString(boundary.MinimumAccepted) || !tokenPattern.MatchString(boundary.MaximumAccepted) {
		t.Fatalf("reconciliation token boundaries are not closed: %+v", boundary)
	}
	for _, vector := range vectors.Vectors {
		headers := vector.Prepared.Headers
		if len(headers) != 6 || headers["Content-Type"] != "application/json" {
			t.Fatalf("%s prepared headers are not closed: %#v", vector.Name, headers)
		}
		prepared, err := authoritystore.PrepareRequest([]byte(vector.Prepared.ExactBody),
			headers["X-OpenSlack-Governance-Caller-ID"], headers["X-OpenSlack-Governance-Workspace-ID"],
			headers["X-OpenSlack-Governance-Routing-Epoch"], headers["X-OpenSlack-Governance-Expected-Build-SHA"])
		if err != nil {
			t.Fatal(err)
		}
		var declaredRequest, exactRequest any
		if err := json.Unmarshal(vector.Request, &declaredRequest); err != nil {
			t.Fatal(err)
		}
		if err := json.Unmarshal([]byte(vector.Prepared.ExactBody), &exactRequest); err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(declaredRequest, exactRequest) {
			t.Fatalf("%s request and exactBody differ", vector.Name)
		}
		if actual := authoritystore.ExpectedIdempotencyKey(prepared.ExactBody); actual != headers["Idempotency-Key"] {
			t.Fatalf("idempotency key = %s, want %s", actual, headers["Idempotency-Key"])
		}
		if actual := authoritystore.RequestFingerprint(vector.Prepared.Method, vector.Prepared.Path, prepared); actual != vector.Prepared.RequestFingerprint {
			t.Fatalf("request fingerprint = %s, want %s", actual, vector.Prepared.RequestFingerprint)
		}
		validateGoldenSuccessReceipt(t, vector, prepared)
		validateGoldenReconciliationReceipt(t, vector, prepared, tokenPattern, boundary.MinimumLength, boundary.MaximumLength)
	}
	semantics := vectors.PendingAuditRecoverySemantics
	if strings.Join(semantics.Lookup, ",") != "workspaceId,planId,revision" || !semantics.AtMostOnePendingPerPlan ||
		!semantics.PendingRevisionEqualsCurrentHead || !semantics.NextTransitionBlockedWhilePending || !semantics.AuthoritativeRecordLoadedSeparately ||
		semantics.ResponseHasRecord || semantics.ResponseHasState || semantics.Query != "forbidden" || semantics.Body != "forbidden" ||
		semantics.Absent != 404 || semantics.AlreadyRecorded != 404 || semantics.RouteEpochMismatch != 409 ||
		semantics.InvalidBindingOrIdentity != 422 || semantics.InternalFailure != 500 || semantics.Unavailable != 503 {
		t.Fatalf("pending audit recovery semantics drift: %+v", semantics)
	}
	if len(vectors.PendingAuditRecoveries) != 2 {
		t.Fatalf("pending audit recovery vector count = %d", len(vectors.PendingAuditRecoveries))
	}
	successByRevision := map[int64]authorityGoldenSuccessReceipt{}
	for _, vector := range vectors.Vectors {
		successByRevision[vector.SuccessReceipt.AcceptedRevision] = vector.SuccessReceipt
	}
	for _, recovery := range vectors.PendingAuditRecoveries {
		response, headers := recovery.Response, recovery.Request.Headers
		success := successByRevision[response.Revision]
		if len(headers) != 4 || recovery.Request.Method != "GET" ||
			recovery.Request.Path != authoritystore.PendingAuditRequestPath(response.PlanID, response.Revision) ||
			response.Schema != authoritystore.PendingAuditSchema || response.Status != "pending" ||
			response.Operation != success.Operation || response.WorkspaceID != headers["X-OpenSlack-Governance-Workspace-ID"] ||
			response.PlanID != success.PlanID || response.RecordHash != success.RecordHash ||
			response.ServiceBuildSHA != headers["X-OpenSlack-Governance-Expected-Build-SHA"] ||
			response.ServiceBuildSHA != success.ServiceBuildSHA || response.Route != success.Route ||
			headers["X-OpenSlack-Governance-Caller-ID"] != success.CallerID ||
			headers["X-OpenSlack-Governance-Routing-Epoch"] != "7" {
			t.Fatalf("%s pending audit recovery does not bind success receipt: %+v", recovery.Name, recovery)
		}
	}
}

func validateGoldenSuccessReceipt(t *testing.T, vector authorityGoldenVector, prepared authoritystore.PreparedRequest) {
	t.Helper()
	receipt := vector.SuccessReceipt
	if receipt.Schema != authoritystore.ReceiptSchema || receipt.Operation != string(prepared.Operation) || receipt.Status != string(authoritystore.ReceiptAccepted) ||
		receipt.WorkspaceID != prepared.WorkspaceID || receipt.PlanID != prepared.PlanID || receipt.ExpectedRevision != prepared.ExpectedRevision ||
		receipt.AcceptedRevision != prepared.TargetRevision || receipt.State != string(prepared.TargetState) ||
		receipt.Route != (authorityGoldenRoute{Backend: prepared.Route.Backend, RoutingEpoch: prepared.Route.RoutingEpoch, Authority: prepared.Route.Authority}) ||
		receipt.IdempotencyKey != vector.Prepared.Headers["Idempotency-Key"] || receipt.RequestFingerprint != vector.Prepared.RequestFingerprint ||
		receipt.RecordHash != prepared.RecordHash || receipt.CorrelationID != prepared.CorrelationID || receipt.CallerID != prepared.CallerID ||
		receipt.ServiceBuildSHA != prepared.ExpectedServiceBuild || receipt.ExecutionID != prepared.ExecutionID {
		t.Fatalf("%s success receipt does not bind the prepared request: %+v", vector.Name, receipt)
	}
	record, err := governance.ValidateRecordJSON(receipt.Record)
	if err != nil {
		t.Fatalf("%s success receipt record: %v", vector.Name, err)
	}
	canonical, err := governance.CanonicalRecordBytes(record)
	if err != nil || !bytes.Equal(canonical, prepared.RecordBytes) {
		t.Fatalf("%s success receipt record differs from prepared record: %v", vector.Name, err)
	}
	if matched, err := regexp.MatchString(`^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$`, receipt.CommittedAt); err != nil || !matched {
		t.Fatalf("%s committedAt is not canonical milliseconds: %q", vector.Name, receipt.CommittedAt)
	}
}

func validateGoldenReconciliationReceipt(t *testing.T, vector authorityGoldenVector, prepared authoritystore.PreparedRequest,
	tokenPattern *regexp.Regexp, minimumLength, maximumLength int,
) {
	t.Helper()
	receipt := vector.ResponseLostReceipt
	if prepared.Operation == authoritystore.OperationAccept {
		if receipt != nil {
			t.Fatalf("%s accept vector invents a response-loss receipt", vector.Name)
		}
		return
	}
	if receipt == nil {
		t.Fatalf("%s transition vector lacks response-loss receipt", vector.Name)
	}
	if receipt.Schema != authoritystore.ReceiptSchema || receipt.Operation != string(prepared.Operation) ||
		receipt.Status != string(authoritystore.ReceiptReconciliationRequired) || receipt.WorkspaceID != prepared.WorkspaceID ||
		receipt.PlanID != prepared.PlanID || receipt.ExpectedRevision != prepared.ExpectedRevision || receipt.TargetRevision != prepared.TargetRevision ||
		receipt.TargetState != string(prepared.TargetState) ||
		receipt.Route != (authorityGoldenRoute{Backend: prepared.Route.Backend, RoutingEpoch: prepared.Route.RoutingEpoch, Authority: prepared.Route.Authority}) ||
		receipt.IdempotencyKey != vector.Prepared.Headers["Idempotency-Key"] || receipt.RequestFingerprint != vector.Prepared.RequestFingerprint ||
		receipt.RecordHash != prepared.RecordHash || receipt.CorrelationID != prepared.CorrelationID || receipt.CallerID != prepared.CallerID ||
		receipt.ServiceBuildSHA != prepared.ExpectedServiceBuild || receipt.ExecutionID != prepared.ExecutionID ||
		len(receipt.ReconciliationToken) < minimumLength || len(receipt.ReconciliationToken) > maximumLength || !tokenPattern.MatchString(receipt.ReconciliationToken) {
		t.Fatalf("%s reconciliation receipt does not bind the prepared request: %+v", vector.Name, receipt)
	}
}
