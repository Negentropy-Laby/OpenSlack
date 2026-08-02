package main

import (
	"bytes"
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/app"
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
	if version.status != http.StatusOK || string(version.body) != `{"buildSha":"`+qualificationBuildSHA+`","contractVersion":"v1","schema":"openslack.governance_shadow_service_version.v1"}`+"\n" {
		t.Fatalf("version = %d %s", version.status, version.body)
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
	build := os.Getenv("GOVERNANCE_SERVICE_BUILD_SHA")
	if build == "" {
		build = qualificationBuildSHA
	}
	for path, expected := range map[string]string{
		app.RouteLive:    `{"status":"live"}` + "\n",
		app.RouteReady:   `{"status":"ready"}` + "\n",
		app.RouteVersion: `{"buildSha":"` + build + `","contractVersion":"v1","schema":"openslack.governance_shadow_service_version.v1"}` + "\n",
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
