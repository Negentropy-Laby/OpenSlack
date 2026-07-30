// container-healthcheck performs the bounded in-container readiness probe.
package main

import (
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/netbind"
)

const defaultBind = "127.0.0.1:8080"

func main() {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	healthURL, err := healthURLFromBind(os.Getenv("GRAPH_HTTP_BIND"))
	if err != nil {
		fail(fmt.Errorf("invalid GRAPH_HTTP_BIND"))
	}
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, healthURL, nil)
	client := &http.Client{
		Transport: &http.Transport{
			Proxy:                 nil,
			DisableKeepAlives:     true,
			ResponseHeaderTimeout: time.Second,
			DialContext: (&net.Dialer{
				Timeout:   time.Second,
				KeepAlive: -1,
			}).DialContext,
		},
	}
	if err != nil {
		fail(err)
	}
	if err := check(request, client); err != nil {
		fail(err)
	}
}

func healthURLFromBind(bind string) (string, error) {
	return healthURLFromBindWithResolver(bind, netbind.ResolvePrivateWildcard)
}

func healthURLFromBindWithResolver(
	bind string,
	resolveWildcard func(string) (string, error),
) (string, error) {
	bind = strings.TrimSpace(bind)
	if bind == "" {
		bind = defaultBind
	}
	host, port, err := net.SplitHostPort(bind)
	if err != nil || port == "" {
		return "", fmt.Errorf("bind is not host:port")
	}
	value, err := strconv.Atoi(port)
	if err != nil || value < 1 || value > 65535 {
		return "", fmt.Errorf("bind port is not a numeric TCP port")
	}
	if host == "" {
		resolved, resolveErr := resolveWildcard(bind)
		if resolveErr != nil {
			return "", fmt.Errorf("resolve private healthcheck target: %w", resolveErr)
		}
		resolvedHost, resolvedPort, splitErr := net.SplitHostPort(resolved)
		if splitErr != nil || resolvedHost == "" || resolvedPort != strconv.Itoa(value) {
			return "", fmt.Errorf("private healthcheck resolver returned an invalid target")
		}
		host = resolvedHost
	}
	if host != "localhost" {
		address := net.ParseIP(host)
		if address == nil || address.IsUnspecified() ||
			!(address.IsLoopback() || address.IsPrivate() || address.IsLinkLocalUnicast()) {
			return "", fmt.Errorf("healthcheck target must be loopback or a private IP literal")
		}
	}
	return "http://" + net.JoinHostPort(host, strconv.Itoa(value)) + "/health/ready", nil
}

func check(request *http.Request, client *http.Client) error {
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	body, err := io.ReadAll(io.LimitReader(response.Body, 257))
	if err != nil {
		return err
	}
	if response.StatusCode != http.StatusOK ||
		len(body) > 256 ||
		string(body) != "{\"status\":\"ready\"}\n" {
		return fmt.Errorf("readiness response did not match the closed contract")
	}
	return nil
}

func fail(err error) {
	_, _ = fmt.Fprintln(os.Stderr, "organization graph healthcheck failed:", err)
	os.Exit(1)
}
