package main

import (
	"os"
	"os/exec"
	"strings"
	"testing"
)

func TestMainHelperProcess(t *testing.T) {
	if os.Getenv("RC_WSMAN_MAIN_HELPER") != "1" {
		return
	}
	main()
}

func TestMainRejectsDeploymentDigestBeforeDatabaseInitialization(t *testing.T) {
	const invalidDigest = "sha256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"
	cmd := exec.Command(os.Args[0], "-test.run=^TestMainHelperProcess$")
	cmd.Env = []string{
		"PATH=" + os.Getenv("PATH"),
		"RC_WSMAN_MAIN_HELPER=1",
		"NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST=" + invalidDigest,
		"DATABASE_URL=postgres://invalid:invalid@127.0.0.1:1/unreachable?sslmode=disable",
		`API_KEY_PEPPER_ACTIVE={"id":"test","value":"not-used"}`,
		"ENV_CREDENTIAL_ALLOWLIST=VENDOR_TEST_TOKEN",
	}
	output, err := cmd.CombinedOutput()
	if err == nil {
		t.Fatal("server process accepted an invalid deployment digest")
	}
	logOutput := string(output)
	if !strings.Contains(logOutput, "config_load_failed") || !strings.Contains(logOutput, "NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST") {
		t.Fatalf("unexpected startup failure: %s", logOutput)
	}
	if strings.Contains(logOutput, "db_pool_") || strings.Contains(logOutput, "db_ping_") || strings.Contains(logOutput, invalidDigest) {
		t.Fatalf("configuration failure initialized the database or reflected input: %s", logOutput)
	}
}
