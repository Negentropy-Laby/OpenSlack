package config

import "testing"

const testAuthorityBuild = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func TestAuthorityConfigDefaultsToHealthOnly(t *testing.T) {
	config, err := LoadAuthorityEnvironment(nil)
	if err != nil {
		t.Fatal(err)
	}
	if config.Mode.Qualification() || config.Mode != AuthorityModeDisabled || config.HTTPBind != "127.0.0.1:8082" || config.ServiceBuildSHA != zeroBuildSHA {
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
	if !config.Mode.Qualification() || config.RoutingEpoch != 9 || config.WorkspaceID != "workspace-1" || config.CallerID != "mcp-gateway-1" {
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

func TestAuthorityConfigBindsCanaryAcceptanceAndDrainEpochs(t *testing.T) {
	environment := []string{
		"WORKFLOW_CONTROL_AUTHORITY_MODE=new-record-canary-v1",
		"DATABASE_URL=postgres://test:test@127.0.0.1:5432/workflow",
		"WORKFLOW_CONTROL_AUTHORITY_SERVICE_BUILD_SHA=" + testAuthorityBuild,
		"WORKFLOW_CONTROL_AUTHORITY_BEARER_TOKEN_SHA256=" + testAuthorityBuild,
		"WORKFLOW_CONTROL_AUTHORITY_WORKSPACE_ID=workspace-1",
		"WORKFLOW_CONTROL_AUTHORITY_CALLER_ID=workflow-router-1",
		"WORKFLOW_CONTROL_AUTHORITY_ROUTING_EPOCH=11",
		"WORKFLOW_CONTROL_AUTHORITY_ACCEPT_NEW_RECORDS=false",
		"WORKFLOW_CONTROL_AUTHORITY_DRAIN_EPOCHS=9,10",
	}
	config, err := LoadAuthorityEnvironment(environment)
	if err != nil {
		t.Fatal(err)
	}
	if !config.Mode.Enabled() || !config.Mode.Canary() || config.Mode.Qualification() || config.AcceptNewRecords ||
		config.RoutingEpoch != 11 || len(config.DrainEpochs) != 2 || config.DrainEpochs[0] != 9 || config.DrainEpochs[1] != 10 {
		t.Fatalf("canary bindings were not preserved: %#v", config)
	}

	for name, replacement := range map[string]string{
		"missing acceptance": "",
		"active in drain":    "WORKFLOW_CONTROL_AUTHORITY_DRAIN_EPOCHS=11",
		"duplicate drain":    "WORKFLOW_CONTROL_AUTHORITY_DRAIN_EPOCHS=9,9",
		"noncanonical drain": "WORKFLOW_CONTROL_AUTHORITY_DRAIN_EPOCHS=09",
	} {
		t.Run(name, func(t *testing.T) {
			candidate := append([]string(nil), environment...)
			if replacement == "" {
				candidate = candidate[:len(candidate)-2]
				candidate = append(candidate, environment[len(environment)-1])
			} else {
				candidate[len(candidate)-1] = replacement
			}
			if _, err := LoadAuthorityEnvironment(candidate); err == nil {
				t.Fatal("invalid canary record policy must fail closed")
			}
		})
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
