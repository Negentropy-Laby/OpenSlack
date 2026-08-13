package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/effectshadowapp"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/effectshadowstore"
	effectpostgres "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/effectshadowstore/postgres"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/testsupport"
)

const gs9dBuildSHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func TestGS9DQualification(t *testing.T) {
	if os.Getenv("WORKFLOW_CONTROL_GS9D_QUALIFICATION") != "1" {
		t.Skip("GS9-D PostgreSQL qualification is not enabled")
	}
	pool := testsupport.OpenPostgres(t)
	repository := effectpostgres.New(pool)
	service, token := gs9dService(t, repository)
	created := gs9dInput(t, "approvalCreated")
	accepted := gs9dHandlerRequest(t, service.Handler(), http.MethodPost, effectshadowstore.Route, created.Prepared.ExactBody, token)
	replay := gs9dHandlerRequest(t, service.Handler(), http.MethodPost, effectshadowstore.Route, created.Prepared.ExactBody, token)
	decision := gs9dHandlerRequest(t, service.Handler(), http.MethodPost, effectshadowstore.Route, gs9dInput(t, "approvalDecided").Prepared.ExactBody, token)
	audit := gs9dHandlerRequest(t, service.Handler(), http.MethodPost, effectshadowstore.Route, gs9dInput(t, "auditRecorded").Prepared.ExactBody, token)
	o := created.Prepared.Envelope.Observation
	headPath := "/v1/shadow/workflow-control/runs/" + o.RunID + "/occurrences/" + o.OccurrenceID + "/approvals/" + o.ApprovalID + "/head"
	head := gs9dHandlerRequest(t, service.Handler(), http.MethodGet, headPath, nil, token)
	outbox := gs9dHandlerRequest(t, service.Handler(), http.MethodGet, effectshadowstore.OutboxRoute+"?limit=100", nil, token)
	metrics := gs9dHandlerRequest(t, service.Handler(), http.MethodGet, "/metrics", nil, token)
	if accepted.Code != http.StatusCreated || replay.Code != http.StatusOK || replay.Header().Get("Idempotency-Replayed") != "true" || !bytes.Equal(accepted.Body.Bytes(), replay.Body.Bytes()) || decision.Code != http.StatusCreated || audit.Code != http.StatusCreated || head.Code != http.StatusOK || !strings.Contains(head.Body.String(), `"lastSourceSequence":3`) || !strings.Contains(head.Body.String(), `"mismatchLatched":false`) || outbox.Code != http.StatusOK || !strings.Contains(outbox.Body.String(), `"count":2`) || !strings.Contains(outbox.Body.String(), `"eventType":"effect_decision_observed"`) || !strings.Contains(outbox.Body.String(), `"eventType":"effect_audit_recorded"`) || metrics.Code != http.StatusOK || !strings.Contains(metrics.Body.String(), "workflow_effect_shadow_outbox_pending 2") {
		t.Fatalf("GS9-D qualification drift: accepted=%d replay=%d decision=%d audit=%d head=%d outbox=%d metrics=%d", accepted.Code, replay.Code, decision.Code, audit.Code, head.Code, outbox.Code, metrics.Code)
	}
}

func TestGS9DRestartQualification(t *testing.T) {
	phase := os.Getenv("WORKFLOW_CONTROL_GS9D_RESTART_PHASE")
	if phase == "" {
		t.Skip("GS9-D restart qualification is not enabled")
	}
	schema := os.Getenv("WORKFLOW_CONTROL_GS9D_RESTART_SCHEMA")
	input := gs9dInput(t, "approvalCreated")
	switch phase {
	case "seed":
		pool := testsupport.OpenPersistentSchema(t, schema, true)
		if _, err := effectpostgres.New(pool).Observe(context.Background(), input); err != nil {
			t.Fatal(err)
		}
		pool.Close()
	case "verify":
		pool := testsupport.OpenPersistentSchema(t, schema, false)
		repository := effectpostgres.New(pool)
		replay, err := repository.Observe(context.Background(), input)
		if err != nil || !replay.Replay {
			t.Fatalf("restart replay=%#v err=%v", replay.Value, err)
		}
		o := input.Prepared.Envelope.Observation
		head, err := repository.ReadHead(context.Background(), o.WorkspaceID, o.RunID, o.OccurrenceID, o.ApprovalID)
		if err != nil || head.SourceSequence != 1 {
			t.Fatalf("restart head=%#v err=%v", head, err)
		}
		pool.Close()
		testsupport.DropSchema(t, schema)
	default:
		t.Fatalf("unknown GS9-D restart phase %q", phase)
	}
}

func TestGS9DImageDefaultOff(t *testing.T) {
	origin := strings.TrimRight(os.Getenv("WORKFLOW_CONTROL_GS9D_DEFAULT_ORIGIN"), "/")
	if origin == "" {
		t.Skip("GS9-D image smoke origin is not configured")
	}
	version := gs9dHTTPResponse(t, http.MethodGet, origin+"/version", nil)
	data := gs9dHTTPResponse(t, http.MethodPost, origin+effectshadowstore.Route, []byte("{}"))
	if version.status != http.StatusOK || !strings.Contains(string(version.body), `"qualificationMode":false`) || !strings.Contains(string(version.body), `"goEffectDecisionAuthority":false`) || !strings.Contains(string(version.body), `"goEffectExecutionAuthority":false`) || data.status != http.StatusNotFound {
		t.Fatalf("GS9-D default-off image drift: version=%d %s data=%d %s", version.status, version.body, data.status, data.body)
	}
}

func gs9dService(t *testing.T, store effectshadowstore.Store) (*effectshadowapp.Service, string) {
	t.Helper()
	token := strings.Repeat("qualification-token-", 2)
	digest := sha256.Sum256([]byte(token))
	service, err := effectshadowapp.New(effectshadowapp.Options{
		QualificationMode: true, Store: store, BuildSHA: gs9dBuildSHA,
		BearerTokenSHA256: hex.EncodeToString(digest[:]), WorkspaceID: "workspace-d1",
		CallerID: "workflow-runner",
	})
	if err != nil {
		t.Fatal(err)
	}
	return service, token
}

func gs9dInput(t *testing.T, name string) effectshadowstore.ObserveInput {
	t.Helper()
	type golden struct {
		SourceEnvelopes map[string]struct {
			CanonicalBytes string `json:"canonicalBytes"`
		} `json:"sourceEnvelopes"`
	}
	path := filepath.Join("..", "..", "..", "..", "packages", "workflows", "contracts", "workflow-effect-shadow", "v1", "golden-vectors.json")
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var vectors golden
	if err := json.Unmarshal(body, &vectors); err != nil {
		t.Fatal(err)
	}
	vector, ok := vectors.SourceEnvelopes[name]
	if !ok {
		t.Fatalf("missing GS9-D golden %q", name)
	}
	exact := append([]byte(vector.CanonicalBytes), '\n')
	prepared, err := effectshadowstore.PrepareObservation(exact)
	if err != nil {
		t.Fatal(err)
	}
	key := effectshadowstore.IdempotencyPrefix + prepared.EnvelopeHash
	return effectshadowstore.ObserveInput{
		Prepared: prepared, IdempotencyKey: key,
		RequestFingerprint: effectshadowstore.Fingerprint(http.MethodPost, effectshadowstore.Route, key, exact),
		ServiceBuildHash:   gs9dBuildSHA,
	}
}

func gs9dHandlerRequest(t *testing.T, handler http.Handler, method, path string, body []byte, token string) *httptest.ResponseRecorder {
	t.Helper()
	request := httptest.NewRequest(method, path, bytes.NewReader(body))
	request.Header.Set("Authorization", "Bearer "+token)
	request.Header.Set("X-OpenSlack-Workspace-ID", "workspace-d1")
	request.Header.Set("X-OpenSlack-Caller-ID", "workflow-runner")
	if len(body) > 0 {
		request.Header.Set("Content-Type", "application/json")
		prepared, err := effectshadowstore.PrepareObservation(body)
		if err != nil {
			t.Fatal(err)
		}
		request.Header.Set("Idempotency-Key", effectshadowstore.IdempotencyPrefix+prepared.EnvelopeHash)
	}
	response := httptest.NewRecorder()
	handler.ServeHTTP(response, request)
	return response
}

type gs9dResponse struct {
	status int
	body   []byte
}

func gs9dHTTPResponse(t *testing.T, method, url string, body []byte) gs9dResponse {
	t.Helper()
	request, err := http.NewRequestWithContext(context.Background(), method, url, bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	response, err := (&http.Client{Timeout: 15 * time.Second}).Do(request)
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	responseBody, err := io.ReadAll(io.LimitReader(response.Body, 1<<20))
	if err != nil {
		t.Fatal(err)
	}
	return gs9dResponse{status: response.StatusCode, body: responseBody}
}
