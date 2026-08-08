package config

import "testing"

const testAuthorityBuild = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestAuthorityConfigDefaultsToHealthOnly(t *testing.T) {
	config, err := LoadAuthorityEnvironment(nil)
	if err != nil {
		t.Fatal(err)
	}
	if config.QualificationMode || config.Mode != AuthorityModeDisabled || config.HTTPBind != "127.0.0.1:8082" || config.ServiceBuildSHA != zeroBuildSHA {
		t.Fatalf("unexpected default authority config: %#v", config)
	}
}

func TestAuthorityConfigRequiresClosedQualificationBindings(t *testing.T) {
	environment := []string{
		"WORKFLOW_CONTROL_AUTHORITY_MODE=local-qualification-v1",
		"DATABASE_URL=postgres://test:test@127.0.0.1:5432/workflow",
		"WORKFLOW_CONTROL_AUTHORITY_SERVICE_BUILD_SHA=" + testAuthorityBuild,
		"WORKFLOW_CONTROL_AUTHORITY_BEARER_TOKEN_SHA256=" + testAuthorityBuild,
		"WORKFLOW_CONTROL_AUTHORITY_WORKSPACE_ID=workspace-1",
		"WORKFLOW_CONTROL_AUTHORITY_CALLER_ID=mcp-gateway-1",
		"WORKFLOW_CONTROL_AUTHORITY_ROUTING_EPOCH=9",
	}
	config, err := LoadAuthorityEnvironment(environment)
	if err != nil {
		t.Fatal(err)
	}
	if !config.QualificationMode || config.RoutingEpoch != 9 || config.WorkspaceID != "workspace-1" || config.CallerID != "mcp-gateway-1" {
		t.Fatalf("qualification bindings were not preserved: %#v", config)
	}
	for _, omitted := range []string{
		"DATABASE_URL", "WORKFLOW_CONTROL_AUTHORITY_SERVICE_BUILD_SHA",
		"WORKFLOW_CONTROL_AUTHORITY_BEARER_TOKEN_SHA256", "WORKFLOW_CONTROL_AUTHORITY_WORKSPACE_ID",
		"WORKFLOW_CONTROL_AUTHORITY_CALLER_ID", "WORKFLOW_CONTROL_AUTHORITY_ROUTING_EPOCH",
	} {
		filtered := make([]string, 0, len(environment)-1)
		for _, entry := range environment {
			if len(entry) >= len(omitted)+1 && entry[:len(omitted)+1] == omitted+"=" {
				continue
			}
			filtered = append(filtered, entry)
		}
		if _, err := LoadAuthorityEnvironment(filtered); err == nil {
			t.Fatalf("expected missing %s to fail closed", omitted)
		}
	}
}

func TestAuthorityConfigRejectsRemoteAndUnknownConfiguration(t *testing.T) {
	for name, environment := range map[string][]string{
		"remote bind":                {"WORKFLOW_CONTROL_AUTHORITY_HTTP_BIND=0.0.0.0:8082"},
		"unknown mode":               {"WORKFLOW_CONTROL_AUTHORITY_MODE=enabled"},
		"unknown authority variable": {"WORKFLOW_CONTROL_AUTHORITY_SURPRISE=1"},
		"duplicate":                  {"WORKFLOW_CONTROL_AUTHORITY_MODE=disabled", "WORKFLOW_CONTROL_AUTHORITY_MODE=disabled"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := LoadAuthorityEnvironment(environment); err == nil {
				t.Fatal("expected configuration to fail closed")
			}
		})
	}
}

func TestAuthorityConfigRejectsEpochOutsideCanonicalSafeInteger(t *testing.T) {
	environment := []string{
		"WORKFLOW_CONTROL_AUTHORITY_MODE=local-qualification-v1",
		"DATABASE_URL=postgres://test:test@127.0.0.1:5432/workflow",
		"WORKFLOW_CONTROL_AUTHORITY_SERVICE_BUILD_SHA=" + testAuthorityBuild,
		"WORKFLOW_CONTROL_AUTHORITY_BEARER_TOKEN_SHA256=" + testAuthorityBuild,
		"WORKFLOW_CONTROL_AUTHORITY_WORKSPACE_ID=workspace-1",
		"WORKFLOW_CONTROL_AUTHORITY_CALLER_ID=mcp-gateway-1",
		"WORKFLOW_CONTROL_AUTHORITY_ROUTING_EPOCH=9007199254740992",
	}
	if _, err := LoadAuthorityEnvironment(environment); err == nil {
		t.Fatal("unsafe routing epoch must fail closed during startup")
	}
}
