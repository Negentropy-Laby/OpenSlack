package contracts_test

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestCanaryDeploymentPackIsParameterizedAndClosed(t *testing.T) {
	root := repositoryRoot(t)
	composeData, err := os.ReadFile(filepath.Join(root, "deploy", "canary", "docker-compose.yml"))
	if err != nil {
		t.Fatal(err)
	}
	var compose any
	if err := yaml.Unmarshal(composeData, &compose); err != nil {
		t.Fatalf("parse canary compose: %v", err)
	}
	composeText := string(composeData)
	for _, required := range []string{
		"${CANARY_SLACK_BOT_TOKEN}",
		"${WEBHOOK_AUDIT_TOKEN}",
		"${CANARY_VENDOR_SLACK}",
		"${CANARY_VENDOR_WEBHOOK}",
		"${WEBHOOK_RECEIVER_EVIDENCE_DIR}",
	} {
		if !strings.Contains(composeText, required) {
			t.Errorf("canary compose missing parameter %s", required)
		}
	}
	for _, forbidden := range []string{
		"openslack-notification-canary-a",
		"openslack-notification-canary-b",
		"xoxb-",
		"ghp_",
	} {
		if strings.Contains(composeText, forbidden) {
			t.Errorf("canary compose contains forbidden concrete value %q", forbidden)
		}
	}

	schemaData, err := os.ReadFile(filepath.Join(root, "deploy", "canary", "webhook-record.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	var schema map[string]any
	if err := json.Unmarshal(schemaData, &schema); err != nil {
		t.Fatalf("parse webhook record schema: %v", err)
	}
	if schema["additionalProperties"] != false {
		t.Fatal("webhook record schema is not closed")
	}
	if schema["type"] != "object" {
		t.Fatal("webhook record schema is not an object")
	}
}

func TestPITRFixtureUsesPersistedMappingFieldNames(t *testing.T) {
	root := repositoryRoot(t)
	script, err := os.ReadFile(filepath.Join(root, "scripts", "acceptance", "pitr.sh"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(script)
	for _, required := range []string{
		`{\"mode\":\"none\"}`,
		`{\"mode\":\"headers\",\"source\":\"ingress_idempotency_key\",\"header_names\":`,
		`outbound_idempotency_mapping->>'source'`,
		`outbound_idempotency_mapping->'header_names'`,
	} {
		if !strings.Contains(text, required) {
			t.Errorf("PITR fixture missing persisted mapping form %q", required)
		}
	}
	for _, forbidden := range []string{
		`{\"Mode\":`,
		`\"Source\":`,
		`\"HeaderNames\":`,
		`outbound_idempotency_mapping->>'Source'`,
		`outbound_idempotency_mapping->'HeaderNames'`,
	} {
		if strings.Contains(text, forbidden) {
			t.Errorf("PITR fixture contains Go-only mapping field %q", forbidden)
		}
	}
}
