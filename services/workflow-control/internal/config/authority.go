package config

import (
	"fmt"
	"net/url"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/netbind"
)

const (
	AuthorityModeDisabled           = "disabled"
	AuthorityModeLocalQualification = "local-qualification-v1"
	defaultAuthorityHTTPBind        = "127.0.0.1:8082"
	zeroBuildSHA                    = "0000000000000000000000000000000000000000000000000000000000000000"
	maxSafeAuthorityEpoch           = int64(1<<53 - 1)
)

type AuthorityConfig struct {
	Mode              string
	QualificationMode bool
	DatabaseURL       string
	HTTPBind          string
	ServiceBuildSHA   string
	BearerTokenSHA256 string
	WorkspaceID       string
	CallerID          string
	RoutingEpoch      int64
	ShutdownDeadline  time.Duration
}

func LoadAuthority() (AuthorityConfig, error) {
	return LoadAuthorityEnvironment(os.Environ())
}

// LoadAuthorityEnvironment keeps the production default deliberately inert.
// Only the one frozen local qualification mode accepts authority requests.
func LoadAuthorityEnvironment(environment []string) (AuthorityConfig, error) {
	values, err := parseAuthorityEnvironment(environment)
	if err != nil {
		return AuthorityConfig{}, err
	}
	mode := strings.TrimSpace(values["WORKFLOW_CONTROL_AUTHORITY_MODE"])
	if mode == "" {
		mode = AuthorityModeDisabled
	}
	if mode != AuthorityModeDisabled && mode != AuthorityModeLocalQualification {
		return AuthorityConfig{}, fmt.Errorf("WORKFLOW_CONTROL_AUTHORITY_MODE must be disabled or local-qualification-v1")
	}
	bind := strings.TrimSpace(values["WORKFLOW_CONTROL_AUTHORITY_HTTP_BIND"])
	if bind == "" {
		bind = defaultAuthorityHTTPBind
	}
	bind, err = netbind.Validate(bind, NetworkLoopback)
	if err != nil {
		return AuthorityConfig{}, fmt.Errorf("authority HTTP bind: %w", err)
	}
	config := AuthorityConfig{
		Mode: mode, QualificationMode: mode == AuthorityModeLocalQualification,
		HTTPBind: bind, ServiceBuildSHA: zeroBuildSHA, ShutdownDeadline: 30 * time.Second,
	}
	if !config.QualificationMode {
		return config, nil
	}

	databaseURL := strings.TrimSpace(values["DATABASE_URL"])
	parsed, parseErr := url.Parse(databaseURL)
	if parseErr != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") || parsed.Host == "" || parsed.User == nil || parsed.Fragment != "" {
		return AuthorityConfig{}, fmt.Errorf("DATABASE_URL must be a valid postgres URL with host and user")
	}
	buildSHA := strings.TrimSpace(values["WORKFLOW_CONTROL_AUTHORITY_SERVICE_BUILD_SHA"])
	tokenHash := strings.TrimSpace(values["WORKFLOW_CONTROL_AUTHORITY_BEARER_TOKEN_SHA256"])
	if !buildPattern.MatchString(buildSHA) || !buildPattern.MatchString(tokenHash) {
		return AuthorityConfig{}, fmt.Errorf("authority build and bearer token hashes must be 64 lowercase hexadecimal characters")
	}
	workspaceID := strings.TrimSpace(values["WORKFLOW_CONTROL_AUTHORITY_WORKSPACE_ID"])
	callerID := strings.TrimSpace(values["WORKFLOW_CONTROL_AUTHORITY_CALLER_ID"])
	if !authorityIdentityPattern.MatchString(workspaceID) || !authorityIdentityPattern.MatchString(callerID) {
		return AuthorityConfig{}, fmt.Errorf("authority workspace and caller identities are required")
	}
	routingEpoch, epochErr := strconv.ParseInt(strings.TrimSpace(values["WORKFLOW_CONTROL_AUTHORITY_ROUTING_EPOCH"]), 10, 64)
	if epochErr != nil || routingEpoch < 1 || routingEpoch > maxSafeAuthorityEpoch {
		return AuthorityConfig{}, fmt.Errorf("WORKFLOW_CONTROL_AUTHORITY_ROUTING_EPOCH must be a positive integer")
	}
	config.DatabaseURL = databaseURL
	config.ServiceBuildSHA = buildSHA
	config.BearerTokenSHA256 = tokenHash
	config.WorkspaceID = workspaceID
	config.CallerID = callerID
	config.RoutingEpoch = routingEpoch
	return config, nil
}

var authorityIdentityPattern = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$`)

func parseAuthorityEnvironment(environment []string) (map[string]string, error) {
	allowed := map[string]struct{}{
		"DATABASE_URL":                                   {},
		"WORKFLOW_CONTROL_AUTHORITY_MODE":                {},
		"WORKFLOW_CONTROL_AUTHORITY_HTTP_BIND":           {},
		"WORKFLOW_CONTROL_AUTHORITY_SERVICE_BUILD_SHA":   {},
		"WORKFLOW_CONTROL_AUTHORITY_BEARER_TOKEN_SHA256": {},
		"WORKFLOW_CONTROL_AUTHORITY_WORKSPACE_ID":        {},
		"WORKFLOW_CONTROL_AUTHORITY_CALLER_ID":           {},
		"WORKFLOW_CONTROL_AUTHORITY_ROUTING_EPOCH":       {},
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
		if strings.HasPrefix(name, "WORKFLOW_CONTROL_AUTHORITY_") {
			if _, ok := allowed[name]; !ok {
				return nil, fmt.Errorf("unknown Workflow Control Authority environment variable %s", name)
			}
		}
	}
	return values, nil
}
