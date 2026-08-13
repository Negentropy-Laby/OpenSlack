package config

import (
	"fmt"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/netbind"
)

const EffectShadowModeDisabled = "disabled"
const EffectShadowModeLocalQualification = "local-qualification-v1"
const defaultEffectShadowHTTPBind = "127.0.0.1:8084"

type EffectShadowConfig struct {
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

func LoadEffectShadow() (EffectShadowConfig, error) {
	return LoadEffectShadowEnvironment(os.Environ())
}
func LoadEffectShadowEnvironment(environment []string) (EffectShadowConfig, error) {
	allowed := map[string]struct{}{"DATABASE_URL": {}, "WORKFLOW_CONTROL_EFFECT_SHADOW_MODE": {}, "WORKFLOW_CONTROL_EFFECT_SHADOW_HTTP_BIND": {}, "WORKFLOW_CONTROL_EFFECT_SHADOW_SERVICE_BUILD_SHA": {}, "WORKFLOW_CONTROL_EFFECT_SHADOW_BEARER_TOKEN_SHA256": {}, "WORKFLOW_CONTROL_EFFECT_SHADOW_WORKSPACE_ID": {}, "WORKFLOW_CONTROL_EFFECT_SHADOW_CALLER_ID": {}}
	values := map[string]string{}
	for _, entry := range environment {
		name, value, ok := strings.Cut(entry, "=")
		if !ok || name == "" {
			continue
		}
		if _, exists := values[name]; exists {
			return EffectShadowConfig{}, fmt.Errorf("duplicate environment variable %s", name)
		}
		values[name] = value
		if strings.HasPrefix(name, "WORKFLOW_CONTROL_EFFECT_SHADOW_") {
			if _, ok := allowed[name]; !ok {
				return EffectShadowConfig{}, fmt.Errorf("unknown effect shadow environment variable %s", name)
			}
		}
	}
	mode := strings.TrimSpace(values["WORKFLOW_CONTROL_EFFECT_SHADOW_MODE"])
	if mode == "" {
		mode = EffectShadowModeDisabled
	}
	if mode != EffectShadowModeDisabled && mode != EffectShadowModeLocalQualification {
		return EffectShadowConfig{}, fmt.Errorf("effect shadow mode must be disabled or local-qualification-v1")
	}
	bind := strings.TrimSpace(values["WORKFLOW_CONTROL_EFFECT_SHADOW_HTTP_BIND"])
	if bind == "" {
		bind = defaultEffectShadowHTTPBind
	}
	var err error
	bind, err = netbind.Validate(bind, NetworkLoopback)
	if err != nil {
		return EffectShadowConfig{}, fmt.Errorf("effect shadow HTTP bind: %w", err)
	}
	result := EffectShadowConfig{Mode: mode, QualificationMode: mode == EffectShadowModeLocalQualification, HTTPBind: bind, ServiceBuildSHA: zeroBuildSHA, ShutdownDeadline: 30 * time.Second}
	if !result.QualificationMode {
		return result, nil
	}
	databaseURL := strings.TrimSpace(values["DATABASE_URL"])
	parsed, parseErr := url.Parse(databaseURL)
	if parseErr != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") || parsed.Host == "" || parsed.User == nil || parsed.Fragment != "" {
		return EffectShadowConfig{}, fmt.Errorf("DATABASE_URL must be a valid postgres URL with host and user")
	}
	build := strings.TrimSpace(values["WORKFLOW_CONTROL_EFFECT_SHADOW_SERVICE_BUILD_SHA"])
	token := strings.TrimSpace(values["WORKFLOW_CONTROL_EFFECT_SHADOW_BEARER_TOKEN_SHA256"])
	if !buildPattern.MatchString(build) || !buildPattern.MatchString(token) {
		return EffectShadowConfig{}, fmt.Errorf("effect shadow hashes must be 64 lowercase hexadecimal characters")
	}
	workspace := strings.TrimSpace(values["WORKFLOW_CONTROL_EFFECT_SHADOW_WORKSPACE_ID"])
	caller := strings.TrimSpace(values["WORKFLOW_CONTROL_EFFECT_SHADOW_CALLER_ID"])
	if !authorityIdentityPattern.MatchString(workspace) || !authorityIdentityPattern.MatchString(caller) {
		return EffectShadowConfig{}, fmt.Errorf("effect shadow workspace and caller identities are required")
	}
	result.DatabaseURL, result.ServiceBuildSHA, result.BearerTokenSHA256, result.WorkspaceID, result.CallerID = databaseURL, build, token, workspace, caller
	return result, nil
}
