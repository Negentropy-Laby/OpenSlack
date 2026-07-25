package contracts_test

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

var deploymentDigestFixturePattern = regexp.MustCompile(`(?m)^NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST=sha256:[0-9a-f]{64}$`)

func TestDeploymentDigestFixturesAreExplicitAndNonDefaulting(t *testing.T) {
	root := repositoryRoot(t)
	localEnv, err := os.ReadFile(filepath.Join(root, "deploy", "local.env.example"))
	if err != nil {
		t.Fatal(err)
	}
	if !deploymentDigestFixturePattern.Match(localEnv) {
		t.Fatal("local acceptance environment lacks an explicit valid deployment digest fixture")
	}

	compose, err := os.ReadFile(filepath.Join(root, "docker-compose.yml"))
	if err != nil {
		t.Fatal(err)
	}
	composeText := string(compose)
	if !strings.Contains(composeText, `NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST: "${NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST}"`) ||
		strings.Contains(composeText, "NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST:-") {
		t.Fatal("Compose must require direct deployment-digest injection without a default")
	}

	workflow, err := os.ReadFile(filepath.Join(root, ".github", "workflows", "tests.yml"))
	if err != nil {
		t.Fatal(err)
	}
	if !regexp.MustCompile(`(?m)^      NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST: sha256:[0-9a-f]{64}$`).Match(workflow) {
		t.Fatal("CI lacks an explicit valid non-production deployment digest fixture")
	}
}

func TestDeploymentDigestIsNotPartOfNotificationStorage(t *testing.T) {
	root := repositoryRoot(t)
	entries, err := os.ReadDir(filepath.Join(root, "migrations"))
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".sql") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(root, "migrations", entry.Name()))
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(strings.ToLower(string(data)), "deployment_digest") {
			t.Fatalf("deployment digest leaked into persistence migration %s", entry.Name())
		}
	}
}
