// Package config loads the closed Workflow Control shadow configuration.
package config

import (
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/netbind"
)

const (
	defaultHTTPBind        = "127.0.0.1:8080"
	defaultMigrationSource = "/migrations"
	NetworkLoopback        = "loopback"
	NetworkInternal        = "internal"
)

var buildPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)

type Config struct {
	DatabaseURL      string
	HTTPBind         string
	NetworkMode      string
	ServiceBuildSHA  string
	MigrationSource  string
	ShutdownDeadline time.Duration
}

type MigrationConfig struct {
	DatabaseURL, MigrationDatabaseURL, MigrationSource string
}

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
	mode := strings.TrimSpace(values["WORKFLOW_CONTROL_NETWORK_MODE"])
	if mode == "" {
		mode = NetworkLoopback
	}
	if mode != NetworkLoopback && mode != NetworkInternal {
		return Config{}, fmt.Errorf("WORKFLOW_CONTROL_NETWORK_MODE must be loopback or internal")
	}
	bind := strings.TrimSpace(values["WORKFLOW_CONTROL_HTTP_BIND"])
	if bind == "" {
		bind = defaultHTTPBind
	}
	bind, err = netbind.Validate(bind, mode)
	if err != nil {
		return Config{}, err
	}
	build := strings.TrimSpace(values["WORKFLOW_CONTROL_SERVICE_BUILD_SHA"])
	if !buildPattern.MatchString(build) {
		return Config{}, fmt.Errorf("WORKFLOW_CONTROL_SERVICE_BUILD_SHA must be 64 lowercase hexadecimal characters")
	}
	return Config{
		DatabaseURL: migration.DatabaseURL, HTTPBind: bind, NetworkMode: mode,
		ServiceBuildSHA: build, MigrationSource: migration.MigrationSource,
		ShutdownDeadline: 30 * time.Second,
	}, nil
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
	allowed := map[string]struct{}{
		"WORKFLOW_CONTROL_HTTP_BIND": {}, "WORKFLOW_CONTROL_NETWORK_MODE": {},
		"WORKFLOW_CONTROL_SERVICE_BUILD_SHA": {},
	}
	for _, entry := range environment {
		name, value, found := strings.Cut(entry, "=")
		if !found || name == "" {
			continue
		}
		if _, duplicate := values[name]; duplicate {
			return nil, fmt.Errorf("duplicate environment variable %s", name)
		}
		values[name] = value
		if strings.HasPrefix(name, "WORKFLOW_CONTROL_") {
			if _, ok := allowed[name]; !ok {
				return nil, fmt.Errorf("unknown Workflow Control environment variable %s", name)
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
