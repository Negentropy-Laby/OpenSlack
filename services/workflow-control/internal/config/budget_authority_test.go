package config

import (
	"strings"
	"testing"
)

const testBudgetAuthorityBuild = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"

func budgetQualificationEnvironment() []string {
	return []string{
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_MODE=local-qualification-v1",
		"DATABASE_URL=postgres://test:test@127.0.0.1:5432/workflow",
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_SERVICE_BUILD_SHA=" + testBudgetAuthorityBuild,
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_BEARER_TOKEN_SHA256=" + testBudgetAuthorityBuild,
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_WORKSPACE_ID=workspace-1",
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_CALLER_ID=typescript:budget-qualification",
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_ROUTING_EPOCH=9",
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_POLICY_HASH=" + testBudgetAuthorityBuild,
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_TOKENS=1000000",
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_NANO_USD=2000000",
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_CALLS=100",
	}
}

func TestBudgetAuthorityDefaultsToHealthOnly(t *testing.T) {
	configuration, err := LoadBudgetAuthorityEnvironment(nil)
	if err != nil {
		t.Fatal(err)
	}
	if configuration.QualificationMode || configuration.Mode != BudgetAuthorityModeDisabled ||
		configuration.HTTPBind != "127.0.0.1:8085" || configuration.ServiceBuildSHA != zeroBuildSHA ||
		configuration.DatabaseURL != "" || configuration.WorkspaceID != "" || configuration.CallerID != "" || configuration.RoutingEpoch != 0 {
		t.Fatalf("unexpected default budget authority config: %#v", configuration)
	}
}

func TestBudgetAuthorityRequiresClosedQualificationBindings(t *testing.T) {
	environment := budgetQualificationEnvironment()
	configuration, err := LoadBudgetAuthorityEnvironment(environment)
	if err != nil {
		t.Fatal(err)
	}
	if !configuration.QualificationMode || configuration.RoutingEpoch != 9 ||
		configuration.WorkspaceID != "workspace-1" || configuration.CallerID != "typescript:budget-qualification" {
		t.Fatalf("qualification bindings were not preserved: %#v", configuration)
	}
	for _, omitted := range []string{
		"DATABASE_URL", "WORKFLOW_CONTROL_BUDGET_AUTHORITY_SERVICE_BUILD_SHA",
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_BEARER_TOKEN_SHA256", "WORKFLOW_CONTROL_BUDGET_AUTHORITY_WORKSPACE_ID",
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_CALLER_ID", "WORKFLOW_CONTROL_BUDGET_AUTHORITY_ROUTING_EPOCH",
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_POLICY_HASH", "WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_TOKENS",
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_NANO_USD", "WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_CALLS",
	} {
		filtered := make([]string, 0, len(environment)-1)
		for _, entry := range environment {
			if len(entry) >= len(omitted)+1 && entry[:len(omitted)+1] == omitted+"=" {
				continue
			}
			filtered = append(filtered, entry)
		}
		if _, err := LoadBudgetAuthorityEnvironment(filtered); err == nil {
			t.Fatalf("expected missing %s to fail closed", omitted)
		}
	}
}

func TestBudgetAuthorityRejectsRemoteUnknownAndNonCanonicalConfiguration(t *testing.T) {
	for name, environment := range map[string][]string{
		"remote bind":      {"WORKFLOW_CONTROL_BUDGET_AUTHORITY_HTTP_BIND=0.0.0.0:8085"},
		"unknown mode":     {"WORKFLOW_CONTROL_BUDGET_AUTHORITY_MODE=enabled"},
		"unknown variable": {"WORKFLOW_CONTROL_BUDGET_AUTHORITY_SURPRISE=1"},
		"duplicate":        {"WORKFLOW_CONTROL_BUDGET_AUTHORITY_MODE=disabled", "WORKFLOW_CONTROL_BUDGET_AUTHORITY_MODE=disabled"},
	} {
		t.Run(name, func(t *testing.T) {
			if _, err := LoadBudgetAuthorityEnvironment(environment); err == nil {
				t.Fatal("expected configuration to fail closed")
			}
		})
	}
	for name, epoch := range map[string]string{"zero": "0", "leading zero": "09", "unsafe": "9007199254740992", "negative": "-1"} {
		t.Run("epoch "+name, func(t *testing.T) {
			environment := budgetQualificationEnvironment()
			environment[6] = "WORKFLOW_CONTROL_BUDGET_AUTHORITY_ROUTING_EPOCH=" + epoch
			if _, err := LoadBudgetAuthorityEnvironment(environment); err == nil {
				t.Fatal("invalid routing epoch was accepted")
			}
		})
	}
}

func TestBudgetAuthorityRejectsNonCanonicalQualificationSeed(t *testing.T) {
	for name, indexAndValue := range map[string]struct {
		index int
		value string
	}{
		"policy":       {index: 7, value: "not-a-hash"},
		"leading zero": {index: 8, value: "01"},
		"negative":     {index: 9, value: "-1"},
		"overflow":     {index: 10, value: "9223372036854775808"},
	} {
		t.Run(name, func(t *testing.T) {
			environment := budgetQualificationEnvironment()
			prefix, _, _ := strings.Cut(environment[indexAndValue.index], "=")
			environment[indexAndValue.index] = prefix + "=" + indexAndValue.value
			if _, err := LoadBudgetAuthorityEnvironment(environment); err == nil {
				t.Fatal("invalid qualification seed was accepted")
			}
		})
	}
}

func TestBudgetAuthorityDisabledDoesNotRetainDatabaseOrIdentityBindings(t *testing.T) {
	configuration, err := LoadBudgetAuthorityEnvironment([]string{
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_MODE=disabled",
		"DATABASE_URL=not-a-postgres-url",
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_SERVICE_BUILD_SHA=not-a-hash",
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_WORKSPACE_ID=not retained",
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_POLICY_HASH=not-a-hash",
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_TOKENS=not-a-decimal",
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_NANO_USD=-1",
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_CALLS=01",
	})
	if err != nil {
		t.Fatal(err)
	}
	if configuration.DatabaseURL != "" || configuration.BearerTokenSHA256 != "" ||
		configuration.WorkspaceID != "" || configuration.CallerID != "" || configuration.RoutingEpoch != 0 ||
		configuration.PolicyHash != "" || configuration.LimitTokens != "" || configuration.LimitNanoUSD != "" || configuration.LimitCalls != "" {
		t.Fatalf("disabled mode retained qualification bindings: %#v", configuration)
	}
}
