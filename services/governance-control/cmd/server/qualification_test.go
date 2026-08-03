package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"

	governance "github.com/Negentropy-Laby/OpenSlack/services/governance-control"
	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/app"
	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/authoritystore"
	authoritypostgres "github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/authoritystore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/shadowstore"
	shadowpostgres "github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/shadowstore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/testsupport"
)

const qualificationBuildSHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestGS5Qualification(t *testing.T) {
	if os.Getenv("GOVERNANCE_GS5_QUALIFICATION") != "1" {
		t.Skip("GS5 qualification is not enabled")
	}
	pool := testsupport.Open(t)
	repository := shadowpostgres.New(pool)
	service, err := app.New(app.Options{Store: repository, BuildSHA: qualificationBuildSHA})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(service.Handler())
	defer server.Close()
	_, first := testsupport.PendingObservation(t, 1)
	accepted := qualificationRequest(t, server.URL, http.MethodPost, app.RouteObservation, first.IdempotencyKey, first.ExactBody, nil)
	if accepted.status != http.StatusCreated || !strings.Contains(string(accepted.body), `"status":"accepted"`) {
		t.Fatalf("accepted = %d %s", accepted.status, accepted.body)
	}
	duplicate := qualificationRequest(t, server.URL, http.MethodPost, app.RouteObservation, first.IdempotencyKey, first.ExactBody, nil)
	if duplicate.status != http.StatusOK || !strings.Contains(string(duplicate.body), `"status":"duplicate"`) {
		t.Fatalf("duplicate = %d %s", duplicate.status, duplicate.body)
	}
	projection := qualificationRequest(t, server.URL, http.MethodGet, "/v1/shadow/governance/plans/"+testsupport.PlanID+"/projection", "", nil, map[string]string{app.HeaderWorkspaceID: testsupport.WorkspaceID})
	if projection.status != http.StatusOK || !strings.Contains(string(projection.body), `"matchedRecordRevision":1`) {
		t.Fatalf("projection = %d %s", projection.status, projection.body)
	}
	version := qualificationRequest(t, server.URL, http.MethodGet, app.RouteVersion, "", nil, nil)
	if version.status != http.StatusOK || string(version.body) != `{"authorityEnabled":false,"buildSha":"`+qualificationBuildSHA+`","contractVersion":"v2","schema":"openslack.governance_shadow_service_version.v1"}`+"\n" {
		t.Fatalf("version = %d %s", version.status, version.body)
	}
}

func TestGS6Qualification(t *testing.T) {
	if os.Getenv("GOVERNANCE_GS6_QUALIFICATION") != "1" {
		t.Skip("GS6 qualification is not enabled")
	}
	pool := testsupport.Open(t)
	repository := authoritypostgres.New(pool)
	service, err := app.New(app.Options{Store: shadowpostgres.New(pool), BuildSHA: qualificationBuildSHA,
		AuthorityStore: repository, AuthorityEnabled: true, AuthorityWorkspaceID: testsupport.WorkspaceID,
		AuthorityCallerID: "typescript:qoder-mcp", AuthorityRoutingEpoch: 7, AuthorityAcceptNewRecords: true,
		AuthorityDrainEpochs: []int64{6}})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(service.Handler())
	defer server.Close()
	headers := authorityQualificationHeadersForEpoch(7)
	planID := "GPLAN-123e4567-e89b-42d3-a456-426614174001"
	accept := qualifyAuthorityMutation(t, server.URL, headers, authoritystore.OperationAccept,
		"pending-record-validation-and-read-model", 0, 7, planID, "", http.StatusCreated, `"acceptedRevision":1`)
	duplicate := qualificationRequest(t, server.URL, http.MethodPost, app.RouteAuthorityAccept,
		accept.IdempotencyKey, accept.Prepared.ExactBody, headers)
	if duplicate.status != http.StatusOK || !strings.Contains(string(duplicate.body), `"status":"duplicate"`) {
		t.Fatalf("authority duplicate = %d %s", duplicate.status, duplicate.body)
	}
	read := qualificationRequest(t, server.URL, http.MethodGet, "/v1/governance/plans/"+planID, "", nil, headers)
	if read.status != http.StatusOK || !strings.Contains(string(read.body), `"routingEpoch":7`) {
		t.Fatalf("authority read = %d %s", read.status, read.body)
	}
	qualifyAuthorityAudit(t, server.URL, headers, planID, "plan.previewed", "pending", 1, 7)
	claim := qualifyAuthorityMutation(t, server.URL, headers, authoritystore.OperationClaimExecution,
		"executing-record-validation-and-read-model", 1, 7, planID, "", http.StatusCreated, `"acceptedRevision":2`)
	receipt := qualificationRequest(t, server.URL, http.MethodGet, "/v1/governance/receipts/"+claim.IdempotencyKey, "", nil, headers)
	if receipt.status != http.StatusOK || !strings.Contains(string(receipt.body), `"operation":"claim_execution"`) {
		t.Fatalf("authority receipt = %d %s", receipt.status, receipt.body)
	}

	terminalCases := []struct {
		planID, recordID, state string
	}{
		{"GPLAN-123e4567-e89b-42d3-a456-426614174002", "succeeded-record-validation-and-read-model", "succeeded"},
		{"GPLAN-123e4567-e89b-42d3-a456-426614174003", "blocked-record-validation-and-read-model", "blocked"},
		{"GPLAN-123e4567-e89b-42d3-a456-426614174004", "failed-record-validation-and-read-model", "failed"},
	}
	for _, item := range terminalCases {
		qualifyAuthorityMutation(t, server.URL, headers, authoritystore.OperationAccept,
			"pending-record-validation-and-read-model", 0, 7, item.planID, "", http.StatusCreated, `"state":"pending"`)
		qualifyAuthorityAudit(t, server.URL, headers, item.planID, "plan.previewed", "pending", 1, 7)
		qualifyAuthorityMutation(t, server.URL, headers, authoritystore.OperationClaimExecution,
			"executing-record-validation-and-read-model", 1, 7, item.planID, "", http.StatusCreated, `"state":"executing"`)
		qualifyAuthorityAudit(t, server.URL, headers, item.planID, "plan.confirmed", "executing", 2, 7)
		qualifyAuthorityMutation(t, server.URL, headers, authoritystore.OperationCompleteExecution,
			item.recordID, 2, 7, item.planID, "", http.StatusCreated, `"state":"`+item.state+`"`)
	}

	cancelPlan := "GPLAN-123e4567-e89b-42d3-a456-426614174005"
	qualifyAuthorityMutation(t, server.URL, headers, authoritystore.OperationAccept,
		"pending-record-validation-and-read-model", 0, 7, cancelPlan, "", http.StatusCreated, `"state":"pending"`)
	qualifyAuthorityAudit(t, server.URL, headers, cancelPlan, "plan.previewed", "pending", 1, 7)
	qualifyAuthorityMutation(t, server.URL, headers, authoritystore.OperationCancel,
		"cancelled-record-validation-and-read-model", 1, 7, cancelPlan, "", http.StatusCreated, `"state":"cancelled"`)

	expirePlan := "GPLAN-123e4567-e89b-42d3-a456-426614174006"
	qualifyAuthorityMutation(t, server.URL, headers, authoritystore.OperationAccept,
		"pending-record-validation-and-read-model", 0, 7, expirePlan, "", http.StatusCreated, `"state":"pending"`)
	qualifyAuthorityAudit(t, server.URL, headers, expirePlan, "plan.previewed", "pending", 1, 7)
	qualifyAuthorityMutation(t, server.URL, headers, authoritystore.OperationExpire,
		"expired-record-validation-and-read-model", 1, 7, expirePlan, "2026-08-02T06:14:59.999Z", http.StatusConflict, "GOVERNANCE_AUTHORITY_CONFLICT")
	qualifyAuthorityMutation(t, server.URL, headers, authoritystore.OperationExpire,
		"expired-record-validation-and-read-model", 1, 7, expirePlan, "2026-08-02T06:15:00.000Z", http.StatusCreated, `"state":"expired"`)

	reconciliationPlan := "GPLAN-123e4567-e89b-42d3-a456-426614174007"
	qualifyAuthorityMutation(t, server.URL, headers, authoritystore.OperationAccept,
		"pending-record-validation-and-read-model", 0, 7, reconciliationPlan, "", http.StatusCreated, `"state":"pending"`)
	qualifyAuthorityAudit(t, server.URL, headers, reconciliationPlan, "plan.previewed", "pending", 1, 7)
	qualifyAuthorityMutation(t, server.URL, headers, authoritystore.OperationClaimExecution,
		"executing-record-validation-and-read-model", 1, 7, reconciliationPlan, "", http.StatusCreated, `"state":"executing"`)
	qualifyAuthorityAudit(t, server.URL, headers, reconciliationPlan, "plan.confirmed", "executing", 2, 7)
	qualifyAuthorityMutation(t, server.URL, headers, authoritystore.OperationRequireReconciliation,
		"reconciliation_required-record-validation-and-read-model", 2, 7, reconciliationPlan, "", http.StatusCreated, `"state":"reconciliation_required"`)

	driftPlan := "GPLAN-123e4567-e89b-42d3-a456-426614174008"
	qualifyAuthorityMutation(t, server.URL, headers, authoritystore.OperationAccept,
		"pending-record-validation-and-read-model", 0, 7, driftPlan, "", http.StatusCreated, `"state":"pending"`)
	qualifyAuthorityMutation(t, server.URL, authorityQualificationHeadersForEpoch(6), authoritystore.OperationClaimExecution,
		"executing-record-validation-and-read-model", 1, 6, driftPlan, "", http.StatusConflict, "GOVERNANCE_AUTHORITY_CONFLICT")

	drainPlan := "GPLAN-123e4567-e89b-42d3-a456-426614174009"
	_, drainAccept := testsupport.AuthorityRequestForPlan(t, authoritystore.OperationAccept,
		"pending-record-validation-and-read-model", 0, 6, drainPlan, "")
	if persisted, err := repository.Mutate(context.Background(), drainAccept); err != nil || persisted.Status != authoritystore.ReceiptAccepted {
		t.Fatalf("seed drain authority = %+v err=%v", persisted, err)
	}
	drainHeaders := authorityQualificationHeadersForEpoch(6)
	qualifyAuthorityAudit(t, server.URL, drainHeaders, drainPlan, "plan.previewed", "pending", 1, 6)
	drainCancel := qualifyAuthorityMutation(t, server.URL, drainHeaders, authoritystore.OperationCancel,
		"cancelled-record-validation-and-read-model", 1, 6, drainPlan, "", http.StatusCreated, `"state":"cancelled"`)
	drainReceipt := qualificationRequest(t, server.URL, http.MethodGet, "/v1/governance/receipts/"+drainCancel.IdempotencyKey, "", nil, drainHeaders)
	if drainReceipt.status != http.StatusOK || !strings.Contains(string(drainReceipt.body), `"routingEpoch":6`) {
		t.Fatalf("drain receipt = %d %s", drainReceipt.status, drainReceipt.body)
	}
	qualifyAuthorityAudit(t, server.URL, drainHeaders, drainPlan, "plan.cancelled", "cancelled", 2, 6)

	unknownPlan := "GPLAN-123e4567-e89b-42d3-a456-42661417400a"
	unknownRepository := authoritypostgres.NewWithCommitter(pool, func(ctx context.Context, tx pgx.Tx) error {
		if err := tx.Rollback(ctx); err != nil {
			return err
		}
		return errors.New("qualification injected ambiguous commit without durable receipt")
	})
	unknownService, err := app.New(app.Options{Store: shadowpostgres.New(pool), BuildSHA: qualificationBuildSHA,
		AuthorityStore: unknownRepository, AuthorityEnabled: true, AuthorityWorkspaceID: testsupport.WorkspaceID,
		AuthorityCallerID: "typescript:qoder-mcp", AuthorityRoutingEpoch: 7, AuthorityAcceptNewRecords: true})
	if err != nil {
		t.Fatal(err)
	}
	unknownServer := httptest.NewServer(unknownService.Handler())
	defer unknownServer.Close()
	unknown := qualifyAuthorityMutation(t, unknownServer.URL, headers, authoritystore.OperationAccept,
		"pending-record-validation-and-read-model", 0, 7, unknownPlan, "", http.StatusAccepted, `"status":"reconciliation_required"`)
	if strings.Contains(string(unknown.Response.body), `"acceptedRevision"`) || !strings.Contains(string(unknown.Response.body), `"targetRevision":1`) {
		t.Fatalf("unknown commit receipt shape = %d %s", unknown.Response.status, unknown.Response.body)
	}
	unknownReceipt := qualificationRequest(t, unknownServer.URL, http.MethodGet,
		"/v1/governance/receipts/"+unknown.IdempotencyKey, "", nil, headers)
	if unknownReceipt.status != http.StatusOK || !bytes.Equal(unknownReceipt.body, unknown.Response.body) {
		t.Fatalf("persisted unknown receipt = %d %s, initial=%s", unknownReceipt.status, unknownReceipt.body, unknown.Response.body)
	}
	unknownRead := qualificationRequest(t, unknownServer.URL, http.MethodGet, "/v1/governance/plans/"+unknownPlan, "", nil, headers)
	if unknownRead.status != http.StatusNotFound {
		t.Fatalf("unknown commit created authority head = %d %s", unknownRead.status, unknownRead.body)
	}
}

func TestGS6CrossLanguageAuthorityCutover(t *testing.T) {
	if os.Getenv("OPENSLACK_GS6_CROSS_LANGUAGE") != "1" {
		t.Skip("GS6 cross-language qualification is not enabled")
	}
	const workspaceID = "workspace.gs6.cross-language"
	const callerID = "typescript:qoder-mcp"
	const routingEpoch = int64(7)
	pool := testsupport.Open(t)
	repository := authoritypostgres.New(pool)
	service, err := app.New(app.Options{Store: shadowpostgres.New(pool), BuildSHA: qualificationBuildSHA,
		AuthorityStore: repository, AuthorityEnabled: true, AuthorityWorkspaceID: workspaceID,
		AuthorityCallerID: callerID, AuthorityRoutingEpoch: routingEpoch, AuthorityAcceptNewRecords: true})
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(service.Handler())
	defer server.Close()

	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("runtime.Caller failed")
	}
	repositoryRoot := filepath.Clean(filepath.Join(filepath.Dir(filename), "..", "..", "..", ".."))
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	command := exec.CommandContext(ctx, "bun", "scripts/governance-control-contracts/gs6-mcp-client.ts")
	command.Dir = repositoryRoot
	command.Env = append(os.Environ(),
		"OPENSLACK_GS6_AUTHORITY_ORIGIN="+server.URL,
		"OPENSLACK_GS6_AUTHORITY_BUILD_SHA="+qualificationBuildSHA,
		"OPENSLACK_GS6_AUTHORITY_CALLER_ID="+callerID,
		"OPENSLACK_GS6_AUTHORITY_ROUTING_EPOCH="+strconv.FormatInt(routingEpoch, 10),
		"OPENSLACK_GS6_AUTHORITY_WORKSPACE_ID="+workspaceID,
	)
	var stdout, stderr bytes.Buffer
	command.Stdout, command.Stderr = &stdout, &stderr
	if err := command.Run(); err != nil {
		t.Fatalf("GS6 MCP authority client: %v\nstderr:\n%s\nstdout:\n%s", err, stderr.String(), stdout.String())
	}
	if ctx.Err() != nil {
		t.Fatalf("GS6 MCP authority client deadline: %v", ctx.Err())
	}
	receipt := decodeGS6CrossLanguageReceipt(t, stdout.Bytes())
	if receipt.Schema != "openslack.gs6_mcp_authority_qualification.v1" || receipt.Status != "passed" ||
		receipt.WorkspaceID != workspaceID || receipt.PrincipalRef != "gs6-cross-language-agent" ||
		receipt.Route != (gs6QualificationRoute{Backend: authoritystore.Backend, RoutingEpoch: routingEpoch, Authority: authoritystore.Authority}) ||
		receipt.Plan.State != string(governance.StateSucceeded) || receipt.Plan.Revision < 3 ||
		!regexp.MustCompile(`^GPLAN-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`).MatchString(receipt.Plan.PlanID) ||
		!regexp.MustCompile(`^[0-9a-f]{64}$`).MatchString(receipt.Plan.RecordHash) {
		t.Fatalf("GS6 MCP authority receipt identity drift: %+v", receipt)
	}
	wantTools := []string{
		"openslack_get_executive_overview", "openslack_list_work_items", "openslack_get_work_room", "openslack_get_activity",
		"openslack_get_workflow_progress", "openslack_get_pr_readiness", "openslack_list_pending_approvals", "openslack_get_business_outcomes",
		"openslack_get_notification_status", "openslack_list_scenarios", "openslack_query_graph", "openslack_explain_graph",
		"openslack_preview_scenario", "openslack_preview_workflow", "openslack_confirm_plan", "openslack_cancel_plan",
	}
	if receipt.ToolCatalog.Count != len(wantTools) || strings.Join(receipt.ToolCatalog.Names, "\n") != strings.Join(wantTools, "\n") {
		t.Fatalf("GS6 MCP authority tool catalog drift: %+v", receipt.ToolCatalog)
	}
	if receipt.LocalAuthority != (gs6QualificationLocalAuthority{}) ||
		!receipt.Transport.OfficialMCPSDK || !receipt.Transport.ProductionMCPCommands || !receipt.Transport.ProductionComposition ||
		!receipt.Transport.InMemoryMCPTransport || !receipt.Transport.RealGoAuthorityHTTP ||
		receipt.Transport.CallerID != callerID || receipt.Transport.ServiceBuildSHA != qualificationBuildSHA ||
		receipt.EvidenceCeiling.AuthenticatedQoderDesktop || receipt.EvidenceCeiling.QoderVerified ||
		receipt.EvidenceCeiling.RemoteConnector || receipt.EvidenceCeiling.ProductionDeployment {
		t.Fatalf("GS6 MCP authority evidence boundary drift: %+v", receipt)
	}
	read, err := repository.Read(context.Background(), workspaceID, receipt.Plan.PlanID)
	if err != nil || read.Route.RoutingEpoch != routingEpoch || read.RecordHash != receipt.Plan.RecordHash {
		t.Fatalf("GS6 MCP authority durable read = %+v err=%v", read, err)
	}
	record, err := governance.ValidateCanonicalRecordBytes(read.RecordBytes)
	if err != nil {
		t.Fatal(err)
	}
	projection, err := governance.Project(record)
	if err != nil || projection.State != governance.StateSucceeded || projection.Revision != receipt.Plan.Revision ||
		projection.CorrelationID != receipt.Plan.CorrelationID {
		t.Fatalf("GS6 MCP authority terminal projection = %+v err=%v", projection, err)
	}
	statistics, err := repository.Statistics(context.Background())
	if err != nil || statistics.Plans != 1 || statistics.Receipts != 3 ||
		statistics.ReconciliationPending != 0 || statistics.AuditPending != 0 {
		t.Fatalf("GS6 MCP authority durable closure = %+v err=%v", statistics, err)
	}
	for revision := int64(1); revision <= 3; revision++ {
		if _, err := repository.ReadPendingAudit(context.Background(), workspaceID, receipt.Plan.PlanID, revision); !authoritystore.IsCode(err, authoritystore.ErrorNotFound) {
			t.Fatalf("GS6 MCP authority revision %d remained pending: %v", revision, err)
		}
	}
}

type gs6QualificationRoute struct {
	Backend      string `json:"backend"`
	RoutingEpoch int64  `json:"routingEpoch"`
	Authority    string `json:"authority"`
}

type gs6QualificationLocalAuthority struct {
	RecordCountAfterComposition  int `json:"recordCountAfterComposition"`
	RecordCountAfterPreview      int `json:"recordCountAfterPreview"`
	RecordCountAfterConfirm      int `json:"recordCountAfterConfirm"`
	RecordCountAfterTerminalRead int `json:"recordCountAfterTerminalRead"`
}

type gs6CrossLanguageReceipt struct {
	Schema       string `json:"schema"`
	Status       string `json:"status"`
	WorkspaceID  string `json:"workspaceId"`
	PrincipalRef string `json:"principalRef"`
	ToolCatalog  struct {
		Count int      `json:"count"`
		Names []string `json:"names"`
	} `json:"toolCatalog"`
	Plan struct {
		PlanID        string `json:"planId"`
		CorrelationID string `json:"correlationId"`
		State         string `json:"state"`
		Revision      int    `json:"revision"`
		RecordHash    string `json:"recordHash"`
	} `json:"plan"`
	Route          gs6QualificationRoute          `json:"route"`
	LocalAuthority gs6QualificationLocalAuthority `json:"localAuthority"`
	Transport      struct {
		OfficialMCPSDK        bool   `json:"officialMcpSdk"`
		ProductionMCPCommands bool   `json:"productionMcpCommands"`
		ProductionComposition bool   `json:"productionComposition"`
		InMemoryMCPTransport  bool   `json:"inMemoryMcpTransport"`
		RealGoAuthorityHTTP   bool   `json:"realGoAuthorityHttp"`
		CallerID              string `json:"callerId"`
		ServiceBuildSHA       string `json:"serviceBuildSha"`
	} `json:"transport"`
	EvidenceCeiling struct {
		AuthenticatedQoderDesktop bool `json:"authenticatedQoderDesktop"`
		QoderVerified             bool `json:"qoderVerified"`
		RemoteConnector           bool `json:"remoteConnector"`
		ProductionDeployment      bool `json:"productionDeployment"`
	} `json:"evidenceCeiling"`
}

func decodeGS6CrossLanguageReceipt(t testing.TB, stdout []byte) gs6CrossLanguageReceipt {
	t.Helper()
	if len(stdout) == 0 || stdout[len(stdout)-1] != '\n' || bytes.Count(stdout, []byte{'\n'}) != 1 {
		t.Fatalf("GS6 MCP authority stdout must be exactly one JSON line: %q", stdout)
	}
	decoder := json.NewDecoder(bytes.NewReader(stdout))
	decoder.DisallowUnknownFields()
	var receipt gs6CrossLanguageReceipt
	if err := decoder.Decode(&receipt); err != nil {
		t.Fatalf("decode GS6 MCP authority receipt: %v", err)
	}
	if err := decoder.Decode(&struct{}{}); err != io.EOF {
		t.Fatalf("GS6 MCP authority receipt has trailing JSON: %v", err)
	}
	return receipt
}

type authorityQualificationMutation struct {
	Prepared       authoritystore.PreparedRequest
	IdempotencyKey string
	Response       qualificationResponse
}

func qualifyAuthorityMutation(t testing.TB, origin string, headers map[string]string, operation authoritystore.Operation,
	recordID string, expectedRevision, routingEpoch int64, planID, updatedAt string, wantStatus int, wantBody string,
) authorityQualificationMutation {
	t.Helper()
	prepared, input := testsupport.AuthorityRequestForPlan(t, operation, recordID, expectedRevision, routingEpoch, planID, updatedAt)
	response := qualificationRequest(t, origin, http.MethodPost, authoritystore.RequestPath(operation, planID), input.IdempotencyKey, prepared.ExactBody, headers)
	if response.status != wantStatus || !strings.Contains(string(response.body), wantBody) {
		t.Fatalf("authority %s %s = %d %s, want %d containing %s", operation, planID, response.status, response.body, wantStatus, wantBody)
	}
	return authorityQualificationMutation{Prepared: prepared, IdempotencyKey: input.IdempotencyKey, Response: response}
}

func qualifyAuthorityAudit(t testing.TB, origin string, headers map[string]string, planID, eventType string,
	state governance.State, revision, routingEpoch int64,
) {
	t.Helper()
	prepared, input := testsupport.AuthorityAuditForPlan(t, eventType, state, revision, routingEpoch, planID)
	response := qualificationRequest(t, origin, http.MethodPost, authoritystore.AuditRequestPath(planID, revision), input.IdempotencyKey, prepared.ExactBody, headers)
	if response.status != http.StatusCreated || !strings.Contains(string(response.body), `"status":"recorded"`) {
		t.Fatalf("authority audit %s revision %d = %d %s", planID, revision, response.status, response.body)
	}
}

func TestGS6RestartQualification(t *testing.T) {
	phase := os.Getenv("GOVERNANCE_GS6_RESTART_PHASE")
	if phase == "" {
		t.Skip("GS6 restart qualification is not enabled")
	}
	schema := os.Getenv("GOVERNANCE_GS6_RESTART_SCHEMA")
	switch phase {
	case "seed":
		pool := testsupport.OpenPersistentSchema(t, schema, true)
		repository := authoritypostgres.New(pool)
		_, accept := testsupport.AuthorityRequest(t, authoritystore.OperationAccept, "pending-record-validation-and-read-model", 0, 7)
		receipt, err := repository.Mutate(context.Background(), accept)
		if err != nil || receipt.Status != authoritystore.ReceiptAccepted {
			t.Fatalf("GS6 seed = %+v err=%v", receipt, err)
		}
		statistics, err := repository.Statistics(context.Background())
		if err != nil || statistics.Plans != 1 || statistics.Receipts != 1 || statistics.AuditPending != 1 {
			t.Fatalf("GS6 seed statistics = %+v err=%v", statistics, err)
		}
	case "verify":
		pool := testsupport.OpenPersistentSchema(t, schema, false)
		repository := authoritypostgres.New(pool)
		_, accept := testsupport.AuthorityRequest(t, authoritystore.OperationAccept, "pending-record-validation-and-read-model", 0, 7)
		replay, err := repository.Mutate(context.Background(), accept)
		if err != nil || replay.Status != authoritystore.ReceiptDuplicate {
			t.Fatalf("GS6 replay = %+v err=%v", replay, err)
		}
		read, err := repository.Read(context.Background(), testsupport.WorkspaceID, testsupport.PlanID)
		if err != nil || read.RecordHash != replay.RecordHash || read.Route.RoutingEpoch != 7 {
			t.Fatalf("GS6 durable head = %+v err=%v", read, err)
		}
		persisted, err := repository.ReadReceipt(context.Background(), testsupport.WorkspaceID, accept.IdempotencyKey)
		if err != nil || persisted.Status != authoritystore.ReceiptAccepted || persisted.ReceiptID != replay.ReceiptID {
			t.Fatalf("GS6 durable receipt = %+v err=%v", persisted, err)
		}
		statistics, err := repository.Statistics(context.Background())
		if err != nil || statistics.AuditPending != 1 {
			t.Fatalf("GS6 durable audit pending = %+v err=%v", statistics, err)
		}
		_, audit := testsupport.AuthorityAudit(t, "plan.previewed", "pending", 1, 7)
		if recorded, err := repository.RecordAudit(context.Background(), audit); err != nil || recorded.Status != "recorded" {
			t.Fatalf("GS6 durable audit record = %+v err=%v", recorded, err)
		}
		statistics, err = repository.Statistics(context.Background())
		if err != nil || statistics.AuditPending != 0 {
			t.Fatalf("GS6 audit drain = %+v err=%v", statistics, err)
		}
		pool.Close()
		testsupport.DropSchema(t, schema)
	default:
		t.Fatalf("unknown GS6 restart phase %q", phase)
	}
}

func TestGS6ImageSmoke(t *testing.T) {
	origin := strings.TrimRight(os.Getenv("GOVERNANCE_GS6_SMOKE_ORIGIN"), "/")
	if origin == "" {
		t.Skip("GS6 image smoke origin is not configured")
	}
	headers := authorityQualificationHeaders()
	prepared, accept := testsupport.AuthorityRequest(t, authoritystore.OperationAccept, "pending-record-validation-and-read-model", 0, 7)
	accepted := qualificationRequest(t, origin, http.MethodPost, app.RouteAuthorityAccept, accept.IdempotencyKey, prepared.ExactBody, headers)
	if accepted.status != http.StatusCreated || !strings.Contains(string(accepted.body), `"acceptedRevision":1`) {
		t.Fatalf("GS6 image accept = %d %s", accepted.status, accepted.body)
	}
	read := qualificationRequest(t, origin, http.MethodGet, "/v1/governance/plans/"+testsupport.PlanID, "", nil, headers)
	if read.status != http.StatusOK || !strings.Contains(string(read.body), `"schema":"openslack.governance_authority_read.v1"`) {
		t.Fatalf("GS6 image read = %d %s", read.status, read.body)
	}
	receipt := qualificationRequest(t, origin, http.MethodGet, "/v1/governance/receipts/"+accept.IdempotencyKey, "", nil, headers)
	if receipt.status != http.StatusOK || !strings.Contains(string(receipt.body), `"status":"accepted"`) {
		t.Fatalf("GS6 image receipt = %d %s", receipt.status, receipt.body)
	}
	version := qualificationRequest(t, origin, http.MethodGet, app.RouteVersion, "", nil, nil)
	if version.status != http.StatusOK || !strings.Contains(string(version.body), `"authorityEnabled":true`) {
		t.Fatalf("GS6 image version = %d %s", version.status, version.body)
	}
}

func authorityQualificationHeaders() map[string]string {
	return authorityQualificationHeadersForEpoch(7)
}

func authorityQualificationHeadersForEpoch(epoch int64) map[string]string {
	return map[string]string{
		app.HeaderGovernanceCallerID: "typescript:qoder-mcp", app.HeaderGovernanceWorkspaceID: testsupport.WorkspaceID,
		app.HeaderGovernanceRoutingEpoch: strconv.FormatInt(epoch, 10), app.HeaderGovernanceExpectedBuild: qualificationBuildSHA,
	}
}

func TestGS5RestartQualification(t *testing.T) {
	phase := os.Getenv("GOVERNANCE_GS5_RESTART_PHASE")
	if phase == "" {
		t.Skip("GS5 restart qualification is not enabled")
	}
	schema := os.Getenv("GOVERNANCE_GS5_RESTART_SCHEMA")
	switch phase {
	case "seed":
		pool := testsupport.OpenPersistentSchema(t, schema, true)
		repository := shadowpostgres.New(pool)
		_, input := testsupport.PendingObservation(t, 1)
		receipt, err := repository.Observe(context.Background(), input)
		if err != nil || receipt.Status != shadowstore.ReceiptAccepted {
			t.Fatalf("seed = %+v err=%v", receipt, err)
		}
	case "verify":
		pool := testsupport.OpenPersistentSchema(t, schema, false)
		repository := shadowpostgres.New(pool)
		_, input := testsupport.PendingObservation(t, 1)
		receipt, err := repository.Observe(context.Background(), input)
		if err != nil || receipt.Status != shadowstore.ReceiptDuplicate {
			t.Fatalf("replay = %+v err=%v", receipt, err)
		}
		projection, err := repository.Projection(context.Background(), testsupport.WorkspaceID, testsupport.PlanID)
		if err != nil || projection.MatchedRecordRevision != 1 || projection.SourceSequence != 1 {
			t.Fatalf("projection = %+v err=%v", projection, err)
		}
		pool.Close()
		testsupport.DropSchema(t, schema)
	default:
		t.Fatalf("unknown restart phase %q", phase)
	}
}

func TestGS5ImageSmoke(t *testing.T) {
	origin := strings.TrimRight(os.Getenv("GOVERNANCE_GS5_SMOKE_ORIGIN"), "/")
	if origin == "" {
		t.Skip("GS5 image smoke origin is not configured")
	}
	expectedAuthorityEnabled := "false"
	switch value := os.Getenv("GOVERNANCE_GS5_EXPECT_AUTHORITY_ENABLED"); value {
	case "", "false":
	case "true":
		expectedAuthorityEnabled = value
	default:
		t.Fatalf("invalid GOVERNANCE_GS5_EXPECT_AUTHORITY_ENABLED %q", value)
	}
	build := os.Getenv("GOVERNANCE_SERVICE_BUILD_SHA")
	if build == "" {
		build = qualificationBuildSHA
	}
	for path, expected := range map[string]string{
		app.RouteLive:    `{"status":"live"}` + "\n",
		app.RouteReady:   `{"status":"ready"}` + "\n",
		app.RouteVersion: `{"authorityEnabled":` + expectedAuthorityEnabled + `,"buildSha":"` + build + `","contractVersion":"v2","schema":"openslack.governance_shadow_service_version.v1"}` + "\n",
	} {
		response := qualificationRequest(t, origin, http.MethodGet, path, "", nil, nil)
		if response.status != http.StatusOK || string(response.body) != expected {
			t.Fatalf("%s = %d %s", path, response.status, response.body)
		}
	}
}

type qualificationResponse struct {
	status int
	body   []byte
}

func qualificationRequest(t testing.TB, origin, method, path, idempotency string, body []byte, headers map[string]string) qualificationResponse {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, method, origin+path, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if body != nil {
		request.Header.Set("Content-Type", "application/json")
	}
	if idempotency != "" {
		request.Header.Set("Idempotency-Key", idempotency)
	}
	for key, value := range headers {
		request.Header.Set(key, value)
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, app.MaxResponseBodyBytes+1))
	if err != nil {
		t.Fatal(err)
	}
	if len(responseBody) > app.MaxResponseBodyBytes {
		t.Fatal("response exceeds bound")
	}
	return qualificationResponse{status: response.StatusCode, body: responseBody}
}
