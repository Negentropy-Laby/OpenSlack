package storageproof

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
)

func TestClientChecksExactProofResponseAndCancellation(t *testing.T) {
	challenge := Challenge{Key: 17, PID: 23}
	answer := Answer{Schema: Schema, Challenge: challenge, Relations: map[string]uint32{}}
	encoded, err := canonicaljson.Encode(answer)
	if err != nil {
		t.Fatal(err)
	}
	exact := append(encoded, '\n')
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	_, _ = writer.Write(exact)
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct {
		name, contentType, encoding string
		status                      int
		body                        []byte
		valid                       bool
	}{
		{"exact", "application/json", "", 200, exact, true},
		{"missing newline", "application/json", "", 200, encoded, false},
		{"unknown field", "application/json", "", 200, []byte(strings.Replace(string(exact), "{", "{\"unknown\":1,", 1)), false},
		{"duplicate field", "application/json", "", 200, []byte(strings.Replace(string(exact), "{", "{\"schema\":\"ignored\",", 1)), false},
		{"wrong identity", "application/json", "", 200, bytes.ReplaceAll(exact, []byte(`"pid":23`), []byte(`"pid":24`)), false},
		{"invalid UTF8", "application/json", "", 200, []byte{0xff}, false},
		{"over limit", "application/json", "", 200, bytes.Repeat([]byte(" "), 16*1024+1), false},
		{"media type", "text/plain", "", 200, exact, false},
		{"compressed", "application/json", "gzip", 200, compressed.Bytes(), false},
		{"unavailable", "application/json", "", 503, exact, false},
		{"redirect", "application/json", "", 302, exact, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
				calls.Add(1)
				if request.URL.Path != "/v1/workflow-control/storage-proof" || request.URL.Query().Get("key") != "17" || request.URL.Query().Get("pid") != "23" ||
					request.Header.Get("Authorization") != "Bearer test-token" || request.Header.Get("X-OpenSlack-Workflow-Control-Workspace-ID") != "workspace.test" ||
					request.Header.Get("X-OpenSlack-Workflow-Control-Routing-Epoch") != "7" || request.Header.Get("Accept-Encoding") != "identity" {
					t.Error("proof request lost its authenticated identity")
				}
				w.Header().Set("Content-Type", tc.contentType)
				w.Header().Set("Content-Encoding", tc.encoding)
				w.Header().Set("Location", "/must-not-follow")
				w.WriteHeader(tc.status)
				_, _ = w.Write(tc.body)
			}))
			defer server.Close()
			client := NewClient(server.URL, "test-token", "workspace.test", "caller.test", strings.Repeat("a", 64))
			got, err := client(context.Background(), challenge, 7)
			if (err == nil) != tc.valid || calls.Load() != 1 || (tc.valid && got.Challenge != challenge) {
				t.Fatalf("proof response valid=%v calls=%d: %v", tc.valid, calls.Load(), err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			cancel()
			_, err = client(ctx, challenge, 7)
			if !errors.Is(err, context.Canceled) || calls.Load() != 1 {
				t.Fatalf("cancelled proof reached writer: %v", err)
			}
		})
	}
}
