package canaryreceiver

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestReceiverPersistsMetadataOnlyAndSupportsAuthenticatedLookup(t *testing.T) {
	store := t.TempDir()
	auditKey := strings.Repeat("k", 32)
	server, err := New(store, auditKey)
	if err != nil {
		t.Fatal(err)
	}
	server.now = func() time.Time { return time.Date(2026, 7, 23, 1, 2, 3, 0, time.UTC) }
	server.randomID = func() (string, error) { return strings.Repeat("a", 32), nil }
	payload := []byte(`{"secret_payload":"must-never-persist"}`)
	req := httptest.NewRequest(http.MethodPost, "/v1/receive", bytes.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", "idem-1")
	req.Header.Set("X-OpenSlack-Idempotency-Key", "idem-1")
	rec := httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusNoContent {
		t.Fatalf("receive status = %d body=%q", rec.Code, rec.Body.String())
	}

	path := filepath.Join(store, strings.Repeat("a", 32)+".json")
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Contains(data, payload) || bytes.Contains(data, []byte("must-never-persist")) {
		t.Fatal("payload leaked into receiver evidence")
	}
	if info, err := os.Stat(path); err != nil || info.Mode().Perm() != 0o600 {
		t.Fatalf("record permissions: info=%v err=%v", info, err)
	}

	req = httptest.NewRequest(http.MethodGet, "/v1/records?idempotency_key=idem-1", nil)
	rec = httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusUnauthorized {
		t.Fatalf("unauthenticated status = %d", rec.Code)
	}
	req.Header.Set("Authorization", "Bearer "+auditKey)
	rec = httptest.NewRecorder()
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusOK {
		t.Fatalf("lookup status = %d body=%q", rec.Code, rec.Body.String())
	}
	var response struct {
		Items []Record `json:"items"`
	}
	decoder := json.NewDecoder(rec.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&response); err != nil {
		t.Fatal(err)
	}
	if len(response.Items) != 1 || response.Items[0].BodySize != len(payload) ||
		response.Items[0].IdempotencyKey != "idem-1" ||
		response.Items[0].BodyDigest == "" {
		t.Fatalf("records = %+v", response.Items)
	}
}

func TestReceiverRejectsOversizeAndUnsafeStore(t *testing.T) {
	server, err := New(t.TempDir(), strings.Repeat("k", 32))
	if err != nil {
		t.Fatal(err)
	}
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(
		http.MethodPost,
		"/v1/receive",
		bytes.NewReader(make([]byte, MaxBodyBytes+1)),
	)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Idempotency-Key", "idem-oversize")
	req.Header.Set("X-OpenSlack-Idempotency-Key", "idem-oversize")
	server.Handler().ServeHTTP(rec, req)
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("oversize status = %d", rec.Code)
	}

	root := t.TempDir()
	target := filepath.Join(root, "target")
	if err := os.Mkdir(target, 0o700); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(root, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if _, err := New(link, strings.Repeat("k", 32)); err == nil {
		t.Fatal("receiver accepted symlink store")
	}
}

func TestReceiverRequiresExactDualIdempotencyHeadersAndBoundedQuery(t *testing.T) {
	auditKey := strings.Repeat("k", 32)
	server, err := New(t.TempDir(), auditKey)
	if err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name        string
		contentType string
		first       string
		second      string
		want        int
	}{
		{name: "missing content type", first: "idem-1", second: "idem-1", want: http.StatusUnsupportedMediaType},
		{name: "missing first", contentType: "application/json", second: "idem-1", want: http.StatusBadRequest},
		{name: "mismatch", contentType: "application/json", first: "idem-1", second: "idem-2", want: http.StatusBadRequest},
		{name: "valid", contentType: "application/json", first: "idem-1", second: "idem-1", want: http.StatusNoContent},
	} {
		t.Run(tc.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "/v1/receive", strings.NewReader(`{}`))
			req.Header.Set("Content-Type", tc.contentType)
			req.Header.Set("Idempotency-Key", tc.first)
			req.Header.Set("X-OpenSlack-Idempotency-Key", tc.second)
			rec := httptest.NewRecorder()
			server.Handler().ServeHTTP(rec, req)
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d", rec.Code, tc.want)
			}
		})
	}

	for _, target := range []string{"/v1/records", "/v1/records?idempotency_key="} {
		req := httptest.NewRequest(http.MethodGet, target, nil)
		req.Header.Set("Authorization", "Bearer "+auditKey)
		rec := httptest.NewRecorder()
		server.Handler().ServeHTTP(rec, req)
		if rec.Code != http.StatusBadRequest {
			t.Fatalf("%s status = %d, want 400", target, rec.Code)
		}
	}
}
