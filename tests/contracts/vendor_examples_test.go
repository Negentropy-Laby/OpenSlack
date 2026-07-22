package contracts_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestOpenSlackVendorExamplesRemainParameterizedAndNonActivating(t *testing.T) {
	root := repositoryRoot(t)
	for _, name := range []string{"openslack-slack-v2.yaml", "openslack-webhook-v2.yaml"} {
		path := filepath.Join(root, "deploy", "vendor-examples", name)
		data, err := os.ReadFile(path)
		if err != nil {
			t.Fatal(err)
		}
		var document map[string]any
		if err := yaml.Unmarshal(data, &document); err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		text := string(data)
		if document["operation"] != "register" || !strings.Contains(text, "${OPENSLACK_") {
			t.Errorf("%s is not a parameterized draft registration", name)
		}
		for _, forbidden := range []string{"operation: activate", "canary-repo", "canary-vendor", "lifecycle: active"} {
			if strings.Contains(strings.ToLower(text), forbidden) {
				t.Errorf("%s contains forbidden live value %q", name, forbidden)
			}
		}
		if !strings.Contains(text, "config_schema_version: 2") || !strings.Contains(text, "response_policy:") {
			t.Errorf("%s is not explicit schema v2", name)
		}
	}
}
