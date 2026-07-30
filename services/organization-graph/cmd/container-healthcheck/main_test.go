package main

import (
	"context"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestCheckAcceptsOnlyExactBoundedReadyResponse(t *testing.T) {
	tests := []struct {
		name    string
		status  int
		body    string
		wantErr bool
	}{
		{name: "ready", status: http.StatusOK, body: "{\"status\":\"ready\"}\n"},
		{name: "wrong status", status: http.StatusServiceUnavailable, body: "{\"status\":\"ready\"}\n", wantErr: true},
		{name: "wrong body", status: http.StatusOK, body: "{\"status\":\"live\"}\n", wantErr: true},
		{name: "oversized", status: http.StatusOK, body: strings.Repeat("x", 257), wantErr: true},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(test.status)
				_, _ = w.Write([]byte(test.body))
			}))
			defer server.Close()
			request, err := http.NewRequestWithContext(context.Background(), http.MethodGet, server.URL, nil)
			if err != nil {
				t.Fatal(err)
			}
			err = check(request, server.Client())
			if (err != nil) != test.wantErr {
				t.Fatalf("check() error = %v, wantErr %v", err, test.wantErr)
			}
		})
	}
}

func TestHealthURLUsesOnlyValidatedConfiguredPort(t *testing.T) {
	tests := []struct {
		bind    string
		want    string
		wantErr bool
	}{
		{bind: "", want: "http://127.0.0.1:8080/health/ready"},
		{bind: "127.0.0.1:9090", want: "http://127.0.0.1:9090/health/ready"},
		{bind: "10.0.0.4:8081", want: "http://10.0.0.4:8081/health/ready"},
		{bind: ":8082", want: "http://10.0.0.4:8082/health/ready"},
		{bind: "[::]:8083", wantErr: true},
		{bind: "8.8.8.8:8084", wantErr: true},
		{bind: "127.0.0.1:http", wantErr: true},
		{bind: "https://attacker.invalid", wantErr: true},
		{bind: "127.0.0.1:0", wantErr: true},
	}
	for _, test := range tests {
		got, err := healthURLFromBindWithResolver(test.bind, func(bind string) (string, error) {
			_, port, splitErr := net.SplitHostPort(bind)
			if splitErr != nil {
				return "", splitErr
			}
			return net.JoinHostPort("10.0.0.4", port), nil
		})
		if (err != nil) != test.wantErr {
			t.Fatalf("healthURLFromBind(%q) error = %v, wantErr %v", test.bind, err, test.wantErr)
		}
		if got != test.want {
			t.Fatalf("healthURLFromBind(%q) = %q, want %q", test.bind, got, test.want)
		}
	}
}
