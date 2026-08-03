// Package runnerconfig loads the closed, explicitly enabled GS8-B runner
// control configuration. It is intentionally separate from the credential-free
// Workflow Control shadow server configuration.
package runnerconfig

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/netbind"
)

const (
	EnabledValue    = "1"
	NetworkLoopback = "loopback"
	NetworkInternal = "internal"

	defaultHTTPBind = "127.0.0.1:8081"
)

var (
	hashPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
	safeID      = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$`)
)

type Config struct {
	DatabaseURL          string
	HTTPBind             string
	NetworkMode          string
	ServiceBuildSHA      string
	BearerTokenSHA256    string
	WorkspaceID          string
	SupervisorInstanceID string
	BundleRoot           string
	BundleManifestSHA256 string
	WorkspaceRoot        string
	DescriptorRoot       string

	ShutdownDeadline  time.Duration
	MaxProcesses      int
	LeaseOfferTimeout time.Duration
	LeaseDuration     time.Duration
	HeartbeatInterval time.Duration
	CancelWindow      time.Duration
	CancelGrace       time.Duration
	TerminalExitGrace time.Duration
	PollInterval      time.Duration
	RecoveryInterval  time.Duration
}

func Load() (Config, error) { return LoadEnvironment(os.Environ()) }

func LoadEnvironment(environment []string) (Config, error) {
	values, err := parse(environment)
	if err != nil {
		return Config{}, err
	}
	if values["WORKFLOW_RUNNER_CONTROL_ENABLED"] != EnabledValue {
		return Config{}, fmt.Errorf("WORKFLOW_RUNNER_CONTROL_ENABLED must be exactly 1")
	}
	databaseURL, err := postgresURL(values["DATABASE_URL"])
	if err != nil {
		return Config{}, err
	}
	mode := strings.TrimSpace(values["WORKFLOW_RUNNER_CONTROL_NETWORK_MODE"])
	if mode == "" {
		mode = NetworkLoopback
	}
	if mode != NetworkLoopback && mode != NetworkInternal {
		return Config{}, fmt.Errorf("WORKFLOW_RUNNER_CONTROL_NETWORK_MODE must be loopback or internal")
	}
	bind := strings.TrimSpace(values["WORKFLOW_RUNNER_CONTROL_HTTP_BIND"])
	if bind == "" {
		bind = defaultHTTPBind
	}
	bind, err = netbind.Validate(bind, mode)
	if err != nil {
		return Config{}, err
	}
	build := strings.TrimSpace(values["WORKFLOW_RUNNER_CONTROL_SERVICE_BUILD_SHA"])
	if !hashPattern.MatchString(build) {
		return Config{}, fmt.Errorf("WORKFLOW_RUNNER_CONTROL_SERVICE_BUILD_SHA must be 64 lowercase hexadecimal characters")
	}
	tokenHash := strings.TrimSpace(values["WORKFLOW_RUNNER_CONTROL_BEARER_TOKEN_SHA256"])
	if !hashPattern.MatchString(tokenHash) {
		return Config{}, fmt.Errorf("WORKFLOW_RUNNER_CONTROL_BEARER_TOKEN_SHA256 must be 64 lowercase hexadecimal characters")
	}
	workspaceID := strings.TrimSpace(values["WORKFLOW_RUNNER_CONTROL_WORKSPACE_ID"])
	instanceID := strings.TrimSpace(values["WORKFLOW_RUNNER_CONTROL_INSTANCE_ID"])
	if !safeID.MatchString(workspaceID) || !safeID.MatchString(instanceID) {
		return Config{}, fmt.Errorf("runner workspace and supervisor instance identities are required")
	}
	bundleRoot, err := absolutePath(values["WORKFLOW_RUNNER_CONTROL_BUNDLE_ROOT"], "WORKFLOW_RUNNER_CONTROL_BUNDLE_ROOT")
	if err != nil {
		return Config{}, err
	}
	bundleManifestHash := strings.TrimSpace(values["WORKFLOW_RUNNER_CONTROL_BUNDLE_MANIFEST_SHA256"])
	if !hashPattern.MatchString(bundleManifestHash) {
		return Config{}, fmt.Errorf("WORKFLOW_RUNNER_CONTROL_BUNDLE_MANIFEST_SHA256 must be 64 lowercase hexadecimal characters")
	}
	workspaceRoot, err := absolutePath(values["WORKFLOW_RUNNER_CONTROL_WORKSPACE_ROOT"], "WORKFLOW_RUNNER_CONTROL_WORKSPACE_ROOT")
	if err != nil {
		return Config{}, err
	}
	descriptorRoot, err := absolutePath(values["WORKFLOW_RUNNER_CONTROL_DESCRIPTOR_ROOT"], "WORKFLOW_RUNNER_CONTROL_DESCRIPTOR_ROOT")
	if err != nil {
		return Config{}, err
	}
	maxProcesses := 4
	if raw := strings.TrimSpace(values["WORKFLOW_RUNNER_CONTROL_MAX_PROCESSES"]); raw != "" {
		maxProcesses, err = strconv.Atoi(raw)
		if err != nil || maxProcesses < 1 || maxProcesses > 64 {
			return Config{}, fmt.Errorf("WORKFLOW_RUNNER_CONTROL_MAX_PROCESSES must be between 1 and 64")
		}
	}
	return Config{
		DatabaseURL: databaseURL, HTTPBind: bind, NetworkMode: mode,
		ServiceBuildSHA: build, BearerTokenSHA256: tokenHash,
		WorkspaceID: workspaceID, SupervisorInstanceID: instanceID,
		BundleRoot: bundleRoot, BundleManifestSHA256: bundleManifestHash,
		WorkspaceRoot: workspaceRoot, DescriptorRoot: descriptorRoot,
		ShutdownDeadline: 30 * time.Second, MaxProcesses: maxProcesses,
		LeaseOfferTimeout: 10 * time.Second, LeaseDuration: 60 * time.Second,
		HeartbeatInterval: 5 * time.Second, CancelWindow: 30 * time.Second,
		CancelGrace: 10 * time.Second, TerminalExitGrace: 5 * time.Second,
		PollInterval: 250 * time.Millisecond, RecoveryInterval: 5 * time.Second,
	}, nil
}

func parse(environment []string) (map[string]string, error) {
	allowed := map[string]struct{}{
		"DATABASE_URL":                                   {},
		"WORKFLOW_RUNNER_CONTROL_ENABLED":                {},
		"WORKFLOW_RUNNER_CONTROL_HTTP_BIND":              {},
		"WORKFLOW_RUNNER_CONTROL_NETWORK_MODE":           {},
		"WORKFLOW_RUNNER_CONTROL_SERVICE_BUILD_SHA":      {},
		"WORKFLOW_RUNNER_CONTROL_BEARER_TOKEN_SHA256":    {},
		"WORKFLOW_RUNNER_CONTROL_WORKSPACE_ID":           {},
		"WORKFLOW_RUNNER_CONTROL_INSTANCE_ID":            {},
		"WORKFLOW_RUNNER_CONTROL_BUNDLE_ROOT":            {},
		"WORKFLOW_RUNNER_CONTROL_BUNDLE_MANIFEST_SHA256": {},
		"WORKFLOW_RUNNER_CONTROL_WORKSPACE_ROOT":         {},
		"WORKFLOW_RUNNER_CONTROL_DESCRIPTOR_ROOT":        {},
		"WORKFLOW_RUNNER_CONTROL_MAX_PROCESSES":          {},
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
		if strings.HasPrefix(name, "WORKFLOW_RUNNER_CONTROL_") {
			if _, ok := allowed[name]; !ok {
				return nil, fmt.Errorf("unknown Workflow Runner Control environment variable %s", name)
			}
		}
	}
	return values, nil
}

func postgresURL(value string) (string, error) {
	value = strings.TrimSpace(value)
	parsed, err := url.Parse(value)
	if err != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") || parsed.Host == "" || parsed.User == nil || parsed.Fragment != "" {
		return "", fmt.Errorf("DATABASE_URL must be a valid postgres URL with host and user")
	}
	return value, nil
}

func absolutePath(value, name string) (string, error) {
	value = strings.TrimSpace(value)
	if value == "" || strings.ContainsRune(value, '\x00') || !filepath.IsAbs(value) || filepath.Clean(value) != value {
		return "", fmt.Errorf("%s must be a normalized absolute path", name)
	}
	return value, nil
}
