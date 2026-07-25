package main

import (
	"errors"
	"net/http"
	"os"
	"time"
)

const healthcheckTimeout = 2 * time.Second

func main() {
	if err := run(os.Args[1:], healthClient(), fixedEndpoint); err != nil {
		os.Exit(1)
	}
}

func healthClient() *http.Client {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.Proxy = nil
	return &http.Client{
		Transport: transport,
		Timeout:   healthcheckTimeout,
		CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
			return http.ErrUseLastResponse
		},
	}
}

func run(args []string, client *http.Client, resolve func(string) (string, bool)) error {
	if len(args) != 1 {
		return errors.New("exactly one healthcheck target is required")
	}
	endpoint, ok := resolve(args[0])
	if !ok {
		return errors.New("unknown healthcheck target")
	}

	request, err := http.NewRequest(http.MethodGet, endpoint, nil)
	if err != nil {
		return err
	}
	response, err := client.Do(request)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	if response.StatusCode != http.StatusOK {
		return errors.New("readiness endpoint is not ready")
	}
	return nil
}

func fixedEndpoint(target string) (string, bool) {
	switch target {
	case "app":
		return "http://127.0.0.1:8080/health/ready", true
	case "canary":
		return "http://127.0.0.1:8090/health/ready", true
	default:
		return "", false
	}
}
