package config

import (
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/netbind"
)

const CheckpointShadowModeDisabled = "disabled"
const CheckpointShadowModeLocalQualification = "local-qualification-v1"
const defaultCheckpointShadowHTTPBind = "127.0.0.1:8083"

type CheckpointShadowConfig struct {
	Mode              string
	QualificationMode bool
	DatabaseURL       string
	HTTPBind          string
	ServiceBuildSHA   string
	BearerTokenSHA256 string
	WorkspaceID       string
	CallerID          string
	ShutdownDeadline  time.Duration
}

func LoadCheckpointShadow() (CheckpointShadowConfig, error) {
	return LoadCheckpointShadowEnvironment(os.Environ())
}
func LoadCheckpointShadowEnvironment(environment []string) (CheckpointShadowConfig, error) {
	allowed := map[string]struct{}{"DATABASE_URL": {}, "WORKFLOW_CONTROL_CHECKPOINT_SHADOW_MODE": {}, "WORKFLOW_CONTROL_CHECKPOINT_SHADOW_HTTP_BIND": {}, "WORKFLOW_CONTROL_CHECKPOINT_SHADOW_SERVICE_BUILD_SHA": {}, "WORKFLOW_CONTROL_CHECKPOINT_SHADOW_BEARER_TOKEN_SHA256": {}, "WORKFLOW_CONTROL_CHECKPOINT_SHADOW_WORKSPACE_ID": {}, "WORKFLOW_CONTROL_CHECKPOINT_SHADOW_CALLER_ID": {}}
	values := map[string]string{}
	for _, entry := range environment {
		name, value, ok := strings.Cut(entry, "=")
		if !ok || name == "" {
			continue
		}
		if _, exists := values[name]; exists {
			return CheckpointShadowConfig{}, fmt.Errorf("duplicate environment variable %s", name)
		}
		values[name] = value
		if strings.HasPrefix(name, "WORKFLOW_CONTROL_CHECKPOINT_SHADOW_") {
			if _, ok := allowed[name]; !ok {
				return CheckpointShadowConfig{}, fmt.Errorf("unknown checkpoint shadow environment variable %s", name)
			}
		}
	}
	mode := strings.TrimSpace(values["WORKFLOW_CONTROL_CHECKPOINT_SHADOW_MODE"])
	if mode == "" {
		mode = CheckpointShadowModeDisabled
	}
	if mode != CheckpointShadowModeDisabled && mode != CheckpointShadowModeLocalQualification {
		return CheckpointShadowConfig{}, fmt.Errorf("checkpoint shadow mode must be disabled or local-qualification-v1")
	}
	bind := strings.TrimSpace(values["WORKFLOW_CONTROL_CHECKPOINT_SHADOW_HTTP_BIND"])
	if bind == "" {
		bind = defaultCheckpointShadowHTTPBind
	}
	var err error
	bind, err = netbind.Validate(bind, NetworkLoopback)
	if err != nil {
		return CheckpointShadowConfig{}, fmt.Errorf("checkpoint shadow HTTP bind: %w", err)
	}
	result := CheckpointShadowConfig{Mode: mode, QualificationMode: mode == CheckpointShadowModeLocalQualification, HTTPBind: bind, ServiceBuildSHA: zeroBuildSHA, ShutdownDeadline: 30 * time.Second}
	if !result.QualificationMode {
		return result, nil
	}
	databaseURL := strings.TrimSpace(values["DATABASE_URL"])
	parsed, parseErr := url.Parse(databaseURL)
	if parseErr != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") || parsed.Host == "" || parsed.User == nil || parsed.Fragment != "" {
		return CheckpointShadowConfig{}, fmt.Errorf("DATABASE_URL must be a valid postgres URL with host and user")
	}
	build := strings.TrimSpace(values["WORKFLOW_CONTROL_CHECKPOINT_SHADOW_SERVICE_BUILD_SHA"])
	token := strings.TrimSpace(values["WORKFLOW_CONTROL_CHECKPOINT_SHADOW_BEARER_TOKEN_SHA256"])
	if !buildPattern.MatchString(build) || !buildPattern.MatchString(token) {
		return CheckpointShadowConfig{}, fmt.Errorf("checkpoint shadow hashes must be 64 lowercase hexadecimal characters")
	}
	workspace := strings.TrimSpace(values["WORKFLOW_CONTROL_CHECKPOINT_SHADOW_WORKSPACE_ID"])
	caller := strings.TrimSpace(values["WORKFLOW_CONTROL_CHECKPOINT_SHADOW_CALLER_ID"])
	if !authorityIdentityPattern.MatchString(workspace) || !authorityIdentityPattern.MatchString(caller) {
		return CheckpointShadowConfig{}, fmt.Errorf("checkpoint shadow workspace and caller identities are required")
	}
	result.DatabaseURL, result.ServiceBuildSHA, result.BearerTokenSHA256, result.WorkspaceID, result.CallerID = databaseURL, build, token, workspace, caller
	return result, nil
}
