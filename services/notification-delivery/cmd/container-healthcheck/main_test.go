package main

import (
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

func TestRunAcceptsOnlyReadyAppAndCanaryTargets(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	resolve := func(target string) (string, bool) {
		switch target {
		case "app", "canary":
			return server.URL, true
		default:
			return "", false
		}
	}
	client := &http.Client{Timeout: time.Second}
	for _, target := range []string{"app", "canary"} {
		t.Run(target, func(t *testing.T) {
			if err := run([]string{target}, client, resolve); err != nil {
				t.Fatalf("ready target %s failed: %v", target, err)
			}
		})
	}
}

func TestRunFailsClosed(t *testing.T) {
	t.Run("non-200", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			writer.WriteHeader(http.StatusServiceUnavailable)
		}))
		defer server.Close()

		resolve := func(string) (string, bool) { return server.URL, true }
		if err := run([]string{"app"}, &http.Client{Timeout: time.Second}, resolve); err == nil {
			t.Fatal("non-200 readiness response unexpectedly passed")
		}
	})

	t.Run("timeout", func(t *testing.T) {
		server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			time.Sleep(100 * time.Millisecond)
			writer.WriteHeader(http.StatusOK)
		}))
		defer server.Close()

		resolve := func(string) (string, bool) { return server.URL, true }
		if err := run([]string{"canary"}, &http.Client{Timeout: 10 * time.Millisecond}, resolve); err == nil {
			t.Fatal("timed-out readiness request unexpectedly passed")
		}
	})

	t.Run("unknown target", func(t *testing.T) {
		if err := run([]string{"unknown"}, &http.Client{Timeout: time.Second}, fixedEndpoint); err == nil {
			t.Fatal("unknown healthcheck target unexpectedly passed")
		}
	})

	t.Run("redirect", func(t *testing.T) {
		var redirectedHits atomic.Int32
		destination := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, _ *http.Request) {
			redirectedHits.Add(1)
			writer.WriteHeader(http.StatusOK)
		}))
		defer destination.Close()
		source := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
			http.Redirect(writer, request, destination.URL, http.StatusFound)
		}))
		defer source.Close()

		resolve := func(string) (string, bool) { return source.URL, true }
		if err := run([]string{"app"}, healthClient(), resolve); err == nil {
			t.Fatal("redirected readiness response unexpectedly passed")
		}
		if got := redirectedHits.Load(); got != 0 {
			t.Fatalf("healthcheck followed redirect to a second server: hits=%d", got)
		}
	})

	t.Run("missing target", func(t *testing.T) {
		if err := run(nil, &http.Client{Timeout: time.Second}, fixedEndpoint); err == nil {
			t.Fatal("missing healthcheck target unexpectedly passed")
		}
	})
}

func TestFixedEndpointContract(t *testing.T) {
	tests := map[string]string{
		"app":    "http://127.0.0.1:8080/health/ready",
		"canary": "http://127.0.0.1:8090/health/ready",
	}
	for target, want := range tests {
		got, ok := fixedEndpoint(target)
		if !ok || got != want {
			t.Fatalf("fixedEndpoint(%q)=(%q,%t), want (%q,true)", target, got, ok, want)
		}
	}
	if got, ok := fixedEndpoint("other"); ok || got != "" {
		t.Fatalf("unknown fixed endpoint=(%q,%t), want empty,false", got, ok)
	}
}

func TestHealthClientDisablesProxyAndUsesClosedTimeout(t *testing.T) {
	client := healthClient()
	if healthcheckTimeout != 2*time.Second || client.Timeout != healthcheckTimeout {
		t.Fatalf("health client timeout=%s, want 2s", client.Timeout)
	}
	transport, ok := client.Transport.(*http.Transport)
	if !ok {
		t.Fatalf("health client transport=%T, want *http.Transport", client.Transport)
	}
	if transport.Proxy != nil {
		t.Fatal("health client must not consult an environment proxy")
	}
	if client.CheckRedirect == nil {
		t.Fatal("health client must reject redirects")
	}
}
