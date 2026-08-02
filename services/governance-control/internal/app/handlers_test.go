package app

import (
	"bytes"
	"context"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/shadowstore"
	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/testsupport"
)

const testBuildSHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

type fakeStore struct {
	observeCalls int
}

func (store *fakeStore) Observe(context.Context, shadowstore.ObserveInput) (shadowstore.Receipt, error) {
	store.observeCalls++
	return shadowstore.Receipt{}, nil
}

func (*fakeStore) Projection(context.Context, string, string) (shadowstore.Projection, error) {
	return shadowstore.Projection{}, shadowstore.Failure(shadowstore.ErrorNotFound, "not found", nil)
}

func (*fakeStore) Statistics(context.Context) (shadowstore.Statistics, error) {
	return shadowstore.Statistics{}, nil
}

func testService(t *testing.T, store shadowstore.Store) *Service {
	t.Helper()
	service, err := New(Options{
		Store: store, BuildSHA: testBuildSHA,
		Logger: slog.New(slog.NewTextHandler(io.Discard, nil)),
	})
	if err != nil {
		t.Fatal(err)
	}
	return service
}

func TestObservationRejectsRepeatedContentType(t *testing.T) {
	store := &fakeStore{}
	service := testService(t, store)
	_, input := testsupport.PendingObservation(t, 1)
	request := httptest.NewRequest(http.MethodPost, RouteObservation, bytes.NewReader(input.ExactBody))
	request.Header.Add("Content-Type", "application/json")
	request.Header.Add("Content-Type", "application/json")
	request.Header.Set("Idempotency-Key", input.IdempotencyKey)
	response := httptest.NewRecorder()
	service.Handler().ServeHTTP(response, request)
	if response.Code != http.StatusUnsupportedMediaType || store.observeCalls != 0 {
		t.Fatalf("status=%d observeCalls=%d", response.Code, store.observeCalls)
	}
}

func TestProjectionRejectsUnboundedOrMalformedIdentity(t *testing.T) {
	service := testService(t, &fakeStore{})
	for _, test := range []struct {
		name      string
		workspace string
		plan      string
	}{
		{name: "workspace", workspace: "workspace with spaces", plan: testsupport.PlanID},
		{name: "plan", workspace: testsupport.WorkspaceID, plan: "GPLAN-not-a-v4-uuid"},
	} {
		t.Run(test.name, func(t *testing.T) {
			request := httptest.NewRequest(http.MethodGet, "/v1/shadow/governance/plans/"+test.plan+"/projection", nil)
			request.Header.Set(HeaderWorkspaceID, test.workspace)
			response := httptest.NewRecorder()
			service.Handler().ServeHTTP(response, request)
			if response.Code != http.StatusUnprocessableEntity {
				t.Fatalf("status=%d body=%s", response.Code, response.Body.Bytes())
			}
		})
	}
}
