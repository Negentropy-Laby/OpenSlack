package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"os"
	"time"
)

func main() {
	if err := check(); err != nil {
		_, _ = fmt.Fprintln(os.Stderr, "governance shadow healthcheck failed")
		os.Exit(1)
	}
}

func check() error {
	endpoint := os.Getenv("GOVERNANCE_HEALTH_URL")
	if endpoint == "" {
		endpoint = "http://127.0.0.1:8080/health/ready"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	response, err := http.DefaultClient.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 128))
	if err != nil {
		return err
	}
	if response.StatusCode != http.StatusOK || string(body) != "{\"status\":\"ready\"}\n" {
		return fmt.Errorf("service not ready")
	}
	return nil
}
