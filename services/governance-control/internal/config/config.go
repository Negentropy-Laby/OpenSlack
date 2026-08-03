// Package config loads the closed Governance Control shadow configuration.
package config

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/netbind"
)

const (
	defaultHTTPBind             = "127.0.0.1:8080"
	defaultMigrationSource      = "/migrations"
	NetworkLoopback             = "loopback"
	NetworkInternal             = "internal"
	AuthorityDisabled           = ""
	AuthorityLocalQualification = "local-qualification-v1"
	MaxAuthorityDrainEpochs     = 128
)

var buildPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
var authorityIdentifierPattern = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,255}$`)

type Config struct {
	DatabaseURL               string
	HTTPBind                  string
	NetworkMode               string
	ServiceBuildSHA           string
	MigrationSource           string
	ShutdownDeadline          time.Duration
	AuthorityEnabled          bool
	AuthorityWorkspaceID      string
	AuthorityCallerID         string
	AuthorityRoutingEpoch     int64
	AuthorityAcceptNewRecords bool
	AuthorityDrainEpochs      []int64
}

type MigrationConfig struct{ DatabaseURL, MigrationDatabaseURL, MigrationSource string }

func Load() (Config, error) { return LoadEnvironment(os.Environ()) }

func LoadEnvironment(environment []string) (Config, error) {
	values, err := parse(environment)
	if err != nil {
		return Config{}, err
	}
	migration, err := migrationValues(values)
	if err != nil {
		return Config{}, err
	}
	mode := strings.TrimSpace(values["GOVERNANCE_NETWORK_MODE"])
	if mode == "" {
		mode = NetworkLoopback
	}
	if mode != NetworkLoopback && mode != NetworkInternal {
		return Config{}, fmt.Errorf("GOVERNANCE_NETWORK_MODE must be loopback or internal")
	}
	bind := strings.TrimSpace(values["GOVERNANCE_HTTP_BIND"])
	if bind == "" {
		bind = defaultHTTPBind
	}
	bind, err = netbind.Validate(bind, mode)
	if err != nil {
		return Config{}, err
	}
	build := strings.TrimSpace(values["GOVERNANCE_SERVICE_BUILD_SHA"])
	if !buildPattern.MatchString(build) {
		return Config{}, fmt.Errorf("GOVERNANCE_SERVICE_BUILD_SHA must be 64 lowercase hexadecimal characters")
	}
	authorityMode := strings.TrimSpace(values["GOVERNANCE_AUTHORITY_MODE"])
	if authorityMode != AuthorityDisabled && authorityMode != AuthorityLocalQualification {
		return Config{}, fmt.Errorf("GOVERNANCE_AUTHORITY_MODE must be empty or local-qualification-v1")
	}
	authorityWorkspaceID := strings.TrimSpace(values["GOVERNANCE_AUTHORITY_WORKSPACE_ID"])
	authorityCallerID := strings.TrimSpace(values["GOVERNANCE_AUTHORITY_CALLER_ID"])
	authorityRoutingEpochText := strings.TrimSpace(values["GOVERNANCE_AUTHORITY_ROUTING_EPOCH"])
	authorityAcceptNewText := strings.TrimSpace(values["GOVERNANCE_AUTHORITY_ACCEPT_NEW_RECORDS"])
	authorityDrainText := strings.TrimSpace(values["GOVERNANCE_AUTHORITY_DRAIN_EPOCHS"])
	var authorityRoutingEpoch int64
	var authorityAcceptNew bool
	var authorityDrainEpochs []int64
	if authorityMode == AuthorityLocalQualification {
		var epochErr error
		authorityRoutingEpoch, epochErr = strconv.ParseInt(authorityRoutingEpochText, 10, 64)
		if !authorityIdentifierPattern.MatchString(authorityWorkspaceID) || !authorityIdentifierPattern.MatchString(authorityCallerID) ||
			epochErr != nil || authorityRoutingEpoch < 1 || authorityRoutingEpoch > 9_007_199_254_740_991 || strconv.FormatInt(authorityRoutingEpoch, 10) != authorityRoutingEpochText {
			return Config{}, fmt.Errorf("enabled GS6 authority requires exact workspace, caller, and canonical positive routing epoch")
		}
		if authorityAcceptNewText != "" && authorityAcceptNewText != "true" && authorityAcceptNewText != "false" {
			return Config{}, fmt.Errorf("GOVERNANCE_AUTHORITY_ACCEPT_NEW_RECORDS must be true or false")
		}
		authorityAcceptNew = authorityAcceptNewText == "true"
		seen := map[int64]struct{}{authorityRoutingEpoch: {}}
		if authorityDrainText != "" {
			for _, item := range strings.Split(authorityDrainText, ",") {
				if len(authorityDrainEpochs) >= MaxAuthorityDrainEpochs {
					return Config{}, fmt.Errorf("GOVERNANCE_AUTHORITY_DRAIN_EPOCHS exceeds the %d epoch limit", MaxAuthorityDrainEpochs)
				}
				epoch, epochErr := strconv.ParseInt(item, 10, 64)
				if epochErr != nil || epoch < 1 || epoch > 9_007_199_254_740_991 || strconv.FormatInt(epoch, 10) != item {
					return Config{}, fmt.Errorf("GOVERNANCE_AUTHORITY_DRAIN_EPOCHS must contain canonical positive safe integers")
				}
				if _, duplicate := seen[epoch]; duplicate {
					return Config{}, fmt.Errorf("GOVERNANCE_AUTHORITY_DRAIN_EPOCHS must be unique and exclude the active epoch")
				}
				seen[epoch] = struct{}{}
				authorityDrainEpochs = append(authorityDrainEpochs, epoch)
			}
		}
	} else if authorityWorkspaceID != "" || authorityCallerID != "" || authorityRoutingEpochText != "" || authorityAcceptNewText != "" || authorityDrainText != "" {
		return Config{}, fmt.Errorf("authority bindings require GOVERNANCE_AUTHORITY_MODE=local-qualification-v1")
	}
	return Config{DatabaseURL: migration.DatabaseURL, HTTPBind: bind, NetworkMode: mode, ServiceBuildSHA: build,
		MigrationSource: migration.MigrationSource, ShutdownDeadline: 30 * time.Second,
		AuthorityEnabled: authorityMode == AuthorityLocalQualification, AuthorityWorkspaceID: authorityWorkspaceID,
		AuthorityCallerID: authorityCallerID, AuthorityRoutingEpoch: authorityRoutingEpoch,
		AuthorityAcceptNewRecords: authorityAcceptNew, AuthorityDrainEpochs: authorityDrainEpochs}, nil
}

func LoadMigration() (MigrationConfig, error) { return LoadMigrationEnvironment(os.Environ()) }

func LoadMigrationEnvironment(environment []string) (MigrationConfig, error) {
	values, err := parse(environment)
	if err != nil {
		return MigrationConfig{}, err
	}
	return migrationValues(values)
}

func parse(environment []string) (map[string]string, error) {
	values := map[string]string{}
	allowed := map[string]struct{}{"GOVERNANCE_HTTP_BIND": {}, "GOVERNANCE_NETWORK_MODE": {}, "GOVERNANCE_SERVICE_BUILD_SHA": {}, "GOVERNANCE_AUTHORITY_MODE": {},
		"GOVERNANCE_AUTHORITY_WORKSPACE_ID": {}, "GOVERNANCE_AUTHORITY_CALLER_ID": {}, "GOVERNANCE_AUTHORITY_ROUTING_EPOCH": {}}
	allowed["GOVERNANCE_AUTHORITY_ACCEPT_NEW_RECORDS"] = struct{}{}
	allowed["GOVERNANCE_AUTHORITY_DRAIN_EPOCHS"] = struct{}{}
	for _, entry := range environment {
		name, value, found := strings.Cut(entry, "=")
		if !found || name == "" {
			continue
		}
		if _, duplicate := values[name]; duplicate {
			return nil, fmt.Errorf("duplicate environment variable %s", name)
		}
		values[name] = value
		if strings.HasPrefix(name, "GOVERNANCE_") {
			if _, ok := allowed[name]; !ok {
				return nil, fmt.Errorf("unknown Governance Control environment variable %s", name)
			}
		}
	}
	return values, nil
}

func migrationValues(values map[string]string) (MigrationConfig, error) {
	databaseURL := strings.TrimSpace(values["DATABASE_URL"])
	parsed, err := url.Parse(databaseURL)
	if err != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") || parsed.Host == "" || parsed.User == nil || parsed.Fragment != "" {
		return MigrationConfig{}, fmt.Errorf("DATABASE_URL must be a valid postgres URL with host and user")
	}
	source := strings.TrimSpace(values["MIGRATION_SOURCE"])
	if source == "" {
		source = defaultMigrationSource
	}
	if strings.ContainsRune(source, '\x00') || !filepath.IsAbs(source) {
		return MigrationConfig{}, fmt.Errorf("MIGRATION_SOURCE must be an absolute path")
	}
	migrationDatabaseURL := strings.TrimSpace(values["MIGRATION_DATABASE_URL"])
	if migrationDatabaseURL == "" {
		migrationDatabaseURL = "pgx5://" + strings.TrimPrefix(strings.TrimPrefix(databaseURL, "postgres://"), "postgresql://")
	}
	migrationParsed, migrationErr := url.Parse(migrationDatabaseURL)
	if migrationErr != nil || migrationParsed.Scheme != "pgx5" || migrationParsed.Host == "" || migrationParsed.User == nil {
		return MigrationConfig{}, fmt.Errorf("MIGRATION_DATABASE_URL must be a valid pgx5 URL with host and user")
	}
	return MigrationConfig{DatabaseURL: databaseURL, MigrationDatabaseURL: migrationDatabaseURL, MigrationSource: filepath.Clean(source)}, nil
}
