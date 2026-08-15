package config

import (
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/netbind"
)

const (
	BudgetAuthorityModeDisabled           = "disabled"
	BudgetAuthorityModeLocalQualification = "local-qualification-v1"
	defaultBudgetAuthorityHTTPBind        = "127.0.0.1:8085"
	maxSafeBudgetAuthorityEpoch           = int64(1<<53 - 1)
)

// BudgetAuthorityConfig is the closed, qualification-only composition for
// GS9-E2. The fixed seed exists only to make first-account qualification
// deterministic; no production initial-budget policy source is delivered.
type BudgetAuthorityConfig struct {
	Mode              string
	QualificationMode bool
	DatabaseURL       string
	HTTPBind          string
	ServiceBuildSHA   string
	BearerTokenSHA256 string
	WorkspaceID       string
	CallerID          string
	RoutingEpoch      int64
	PolicyHash        string
	LimitTokens       string
	LimitNanoUSD      string
	LimitCalls        string
	ShutdownDeadline  time.Duration
}

func LoadBudgetAuthority() (BudgetAuthorityConfig, error) {
	return LoadBudgetAuthorityEnvironment(os.Environ())
}

// LoadBudgetAuthorityEnvironment keeps the process inert unless the one
// reviewed local qualification mode and every exact binding are present.
func LoadBudgetAuthorityEnvironment(environment []string) (BudgetAuthorityConfig, error) {
	values, err := parseBudgetAuthorityEnvironment(environment)
	if err != nil {
		return BudgetAuthorityConfig{}, err
	}
	mode := strings.TrimSpace(values["WORKFLOW_CONTROL_BUDGET_AUTHORITY_MODE"])
	if mode == "" {
		mode = BudgetAuthorityModeDisabled
	}
	if mode != BudgetAuthorityModeDisabled && mode != BudgetAuthorityModeLocalQualification {
		return BudgetAuthorityConfig{}, fmt.Errorf("WORKFLOW_CONTROL_BUDGET_AUTHORITY_MODE must be disabled or local-qualification-v1")
	}
	bind := strings.TrimSpace(values["WORKFLOW_CONTROL_BUDGET_AUTHORITY_HTTP_BIND"])
	if bind == "" {
		bind = defaultBudgetAuthorityHTTPBind
	}
	bind, err = netbind.Validate(bind, NetworkLoopback)
	if err != nil {
		return BudgetAuthorityConfig{}, fmt.Errorf("budget authority HTTP bind: %w", err)
	}
	configuration := BudgetAuthorityConfig{
		Mode: mode, QualificationMode: mode == BudgetAuthorityModeLocalQualification,
		HTTPBind: bind, ServiceBuildSHA: zeroBuildSHA, ShutdownDeadline: 30 * time.Second,
	}
	if !configuration.QualificationMode {
		return configuration, nil
	}

	databaseURL := strings.TrimSpace(values["DATABASE_URL"])
	parsed, parseErr := url.Parse(databaseURL)
	if parseErr != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") || parsed.Host == "" || parsed.User == nil || parsed.Fragment != "" {
		return BudgetAuthorityConfig{}, fmt.Errorf("DATABASE_URL must be a valid postgres URL with host and user")
	}
	buildSHA := strings.TrimSpace(values["WORKFLOW_CONTROL_BUDGET_AUTHORITY_SERVICE_BUILD_SHA"])
	tokenHash := strings.TrimSpace(values["WORKFLOW_CONTROL_BUDGET_AUTHORITY_BEARER_TOKEN_SHA256"])
	if !buildPattern.MatchString(buildSHA) || !buildPattern.MatchString(tokenHash) {
		return BudgetAuthorityConfig{}, fmt.Errorf("budget authority build and bearer token hashes must be 64 lowercase hexadecimal characters")
	}
	workspaceID := strings.TrimSpace(values["WORKFLOW_CONTROL_BUDGET_AUTHORITY_WORKSPACE_ID"])
	callerID := strings.TrimSpace(values["WORKFLOW_CONTROL_BUDGET_AUTHORITY_CALLER_ID"])
	if !budgetAuthorityIdentityPattern.MatchString(workspaceID) || !budgetAuthorityIdentityPattern.MatchString(callerID) {
		return BudgetAuthorityConfig{}, fmt.Errorf("budget authority workspace and caller identities are required")
	}
	routingRaw := strings.TrimSpace(values["WORKFLOW_CONTROL_BUDGET_AUTHORITY_ROUTING_EPOCH"])
	routingEpoch, epochErr := strconv.ParseInt(routingRaw, 10, 64)
	if epochErr != nil || routingEpoch < 1 || routingEpoch > maxSafeBudgetAuthorityEpoch || strconv.FormatInt(routingEpoch, 10) != routingRaw {
		return BudgetAuthorityConfig{}, fmt.Errorf("WORKFLOW_CONTROL_BUDGET_AUTHORITY_ROUTING_EPOCH must be a canonical positive safe integer")
	}
	policyHash := strings.TrimSpace(values["WORKFLOW_CONTROL_BUDGET_AUTHORITY_POLICY_HASH"])
	if !buildPattern.MatchString(policyHash) {
		return BudgetAuthorityConfig{}, fmt.Errorf("WORKFLOW_CONTROL_BUDGET_AUTHORITY_POLICY_HASH must be 64 lowercase hexadecimal characters")
	}
	limits := map[string]string{
		"tokens":  strings.TrimSpace(values["WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_TOKENS"]),
		"nanoUsd": strings.TrimSpace(values["WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_NANO_USD"]),
		"calls":   strings.TrimSpace(values["WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_CALLS"]),
	}
	for dimension, value := range limits {
		if _, decimalErr := budgetcontract.ValidateDecimal(value, "$/qualificationSeed/limit/"+dimension); decimalErr != nil {
			return BudgetAuthorityConfig{}, fmt.Errorf("budget authority qualification %s limit must be a canonical nonnegative int64 decimal: %w", dimension, decimalErr)
		}
	}
	configuration.DatabaseURL = databaseURL
	configuration.ServiceBuildSHA = buildSHA
	configuration.BearerTokenSHA256 = tokenHash
	configuration.WorkspaceID = workspaceID
	configuration.CallerID = callerID
	configuration.RoutingEpoch = routingEpoch
	configuration.PolicyHash = policyHash
	configuration.LimitTokens = limits["tokens"]
	configuration.LimitNanoUSD = limits["nanoUsd"]
	configuration.LimitCalls = limits["calls"]
	return configuration, nil
}

var budgetAuthorityIdentityPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$`)

func parseBudgetAuthorityEnvironment(environment []string) (map[string]string, error) {
	allowed := map[string]struct{}{
		"DATABASE_URL":                                          {},
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_MODE":                {},
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_HTTP_BIND":           {},
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_SERVICE_BUILD_SHA":   {},
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_BEARER_TOKEN_SHA256": {},
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_WORKSPACE_ID":        {},
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_CALLER_ID":           {},
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_ROUTING_EPOCH":       {},
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_POLICY_HASH":         {},
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_TOKENS":        {},
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_NANO_USD":      {},
		"WORKFLOW_CONTROL_BUDGET_AUTHORITY_LIMIT_CALLS":         {},
	}
	values := make(map[string]string)
	for _, entry := range environment {
		name, value, found := strings.Cut(entry, "=")
		if !found || name == "" {
			continue
		}
		if _, duplicate := values[name]; duplicate {
			return nil, fmt.Errorf("duplicate environment variable %s", name)
		}
		values[name] = value
		if strings.HasPrefix(name, "WORKFLOW_CONTROL_BUDGET_AUTHORITY_") {
			if _, ok := allowed[name]; !ok {
				return nil, fmt.Errorf("unknown Workflow Control Budget Authority environment variable %s", name)
			}
		}
	}
	return values, nil
}
