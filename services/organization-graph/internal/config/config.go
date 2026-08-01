// Package config loads the closed Organization Graph service configuration.
package config

import (
	"bytes"
	"fmt"
	"net"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/netbind"
)

const (
	defaultHTTPBind        = "127.0.0.1:8080"
	defaultMigrationSource = "/migrations"

	NetworkLoopback = "loopback"
	NetworkInternal = "internal"

	MinCursorSecretBytes = 32
	MaxCursorSecretBytes = 1024
)

var (
	buildSHAPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
	allowedGraphEnv = map[string]struct{}{
		"GRAPH_HTTP_BIND":                    {},
		"GRAPH_NETWORK_MODE":                 {},
		"GRAPH_QUERY_CURSOR_SECRET":          {},
		"GRAPH_QUERY_CURSOR_SECRET_PREVIOUS": {},
		"GRAPH_SERVICE_BUILD_SHA":            {},
	}
)

// Config is immutable after successful startup validation.
type Config struct {
	DatabaseURL               string
	HTTPBind                  string
	NetworkMode               string
	QueryCursorSecret         []byte
	PreviousQueryCursorSecret []byte
	ServiceBuildSHA           string
	MigrationSource           string
	ShutdownDeadline          time.Duration
}

type MigrationConfig struct {
	DatabaseURL     string
	MigrationSource string
}

// Load reads the process environment and fails closed on unknown GRAPH_ keys.
func Load() (Config, error) {
	return LoadEnvironment(os.Environ())
}

// LoadEnvironment validates an explicit environment for deterministic tests.
func LoadEnvironment(environment []string) (Config, error) {
	values, err := parseEnvironment(environment)
	if err != nil {
		return Config{}, err
	}
	migration, err := loadMigrationValues(values)
	if err != nil {
		return Config{}, err
	}

	networkMode := strings.TrimSpace(values["GRAPH_NETWORK_MODE"])
	if networkMode == "" {
		networkMode = NetworkLoopback
	}
	if networkMode != NetworkLoopback && networkMode != NetworkInternal {
		return Config{}, fmt.Errorf("GRAPH_NETWORK_MODE must be loopback or internal")
	}

	httpBind := strings.TrimSpace(values["GRAPH_HTTP_BIND"])
	if httpBind == "" {
		httpBind = defaultHTTPBind
	}
	httpBind, err = resolveHTTPBind(httpBind, networkMode, netbind.ResolvePrivateWildcard)
	if err != nil {
		return Config{}, err
	}

	cursorSecret := []byte(values["GRAPH_QUERY_CURSOR_SECRET"])
	if len(cursorSecret) < MinCursorSecretBytes || len(cursorSecret) > MaxCursorSecretBytes {
		return Config{}, fmt.Errorf(
			"GRAPH_QUERY_CURSOR_SECRET must contain between %d and %d bytes",
			MinCursorSecretBytes,
			MaxCursorSecretBytes,
		)
	}
	previousCursorSecret := []byte(values["GRAPH_QUERY_CURSOR_SECRET_PREVIOUS"])
	if len(previousCursorSecret) != 0 &&
		(len(previousCursorSecret) < MinCursorSecretBytes || len(previousCursorSecret) > MaxCursorSecretBytes) {
		return Config{}, fmt.Errorf(
			"GRAPH_QUERY_CURSOR_SECRET_PREVIOUS must be empty or contain between %d and %d bytes",
			MinCursorSecretBytes,
			MaxCursorSecretBytes,
		)
	}
	if len(previousCursorSecret) != 0 && bytes.Equal(cursorSecret, previousCursorSecret) {
		return Config{}, fmt.Errorf("GRAPH_QUERY_CURSOR_SECRET_PREVIOUS must differ from GRAPH_QUERY_CURSOR_SECRET")
	}

	buildSHA := strings.TrimSpace(values["GRAPH_SERVICE_BUILD_SHA"])
	if !buildSHAPattern.MatchString(buildSHA) {
		return Config{}, fmt.Errorf("GRAPH_SERVICE_BUILD_SHA must be 64 lowercase hexadecimal characters")
	}

	return Config{
		DatabaseURL:               migration.DatabaseURL,
		HTTPBind:                  httpBind,
		NetworkMode:               networkMode,
		QueryCursorSecret:         append([]byte(nil), cursorSecret...),
		PreviousQueryCursorSecret: append([]byte(nil), previousCursorSecret...),
		ServiceBuildSHA:           buildSHA,
		MigrationSource:           migration.MigrationSource,
		ShutdownDeadline:          30 * time.Second,
	}, nil
}

func LoadMigration() (MigrationConfig, error) {
	return LoadMigrationEnvironment(os.Environ())
}

func LoadMigrationEnvironment(environment []string) (MigrationConfig, error) {
	values, err := parseEnvironment(environment)
	if err != nil {
		return MigrationConfig{}, err
	}
	return loadMigrationValues(values)
}

func parseEnvironment(environment []string) (map[string]string, error) {
	values := make(map[string]string, len(environment))
	for _, entry := range environment {
		name, value, found := strings.Cut(entry, "=")
		if !found || name == "" {
			continue
		}
		if _, duplicate := values[name]; duplicate {
			return nil, fmt.Errorf("duplicate environment variable %s", name)
		}
		values[name] = value
		if strings.HasPrefix(name, "GRAPH_") {
			if _, allowed := allowedGraphEnv[name]; !allowed {
				return nil, fmt.Errorf("unknown Organization Graph environment variable %s", name)
			}
		}
	}
	return values, nil
}

func loadMigrationValues(values map[string]string) (MigrationConfig, error) {
	databaseURL := strings.TrimSpace(values["DATABASE_URL"])
	if err := validateDatabaseURL(databaseURL); err != nil {
		return MigrationConfig{}, err
	}

	migrationSource := strings.TrimSpace(values["MIGRATION_SOURCE"])
	if migrationSource == "" {
		migrationSource = defaultMigrationSource
	}
	if strings.ContainsRune(migrationSource, '\x00') || !filepath.IsAbs(migrationSource) {
		return MigrationConfig{}, fmt.Errorf("MIGRATION_SOURCE must be an absolute path")
	}
	return MigrationConfig{
		DatabaseURL:     databaseURL,
		MigrationSource: filepath.Clean(migrationSource),
	}, nil
}

func validateDatabaseURL(raw string) error {
	if raw == "" {
		return fmt.Errorf("missing required env DATABASE_URL")
	}
	parsed, err := url.Parse(raw)
	if err != nil || (parsed.Scheme != "postgres" && parsed.Scheme != "postgresql") {
		return fmt.Errorf("DATABASE_URL must be a valid postgres or postgresql URL")
	}
	if parsed.Host == "" || parsed.User == nil || parsed.Fragment != "" {
		return fmt.Errorf("DATABASE_URL must include host and user and must not include a fragment")
	}
	return nil
}

func resolveHTTPBind(
	bind string,
	mode string,
	resolveWildcard func(string) (string, error),
) (string, error) {
	host, port, err := net.SplitHostPort(bind)
	if err != nil || port == "" {
		return "", fmt.Errorf("GRAPH_HTTP_BIND must be a valid host:port")
	}
	parsedPort, err := strconv.Atoi(port)
	if err != nil || parsedPort < 1 || parsedPort > 65535 {
		return "", fmt.Errorf("GRAPH_HTTP_BIND must use a numeric TCP port from 1 to 65535")
	}

	if mode == NetworkLoopback {
		address := net.ParseIP(host)
		if address == nil || !address.IsLoopback() {
			return "", fmt.Errorf("GRAPH_HTTP_BIND must be a loopback IP literal when GRAPH_NETWORK_MODE=loopback")
		}
		return bind, nil
	}

	// Internal mode is an explicit opt-in to one private container/network
	// interface. An empty host is resolved before listen, so the unauthenticated
	// service never opens an actual all-interface wildcard socket.
	if host == "" {
		resolved, resolveErr := resolveWildcard(bind)
		if resolveErr != nil {
			return "", fmt.Errorf("resolve GRAPH_HTTP_BIND private interface: %w", resolveErr)
		}
		return resolved, nil
	}
	address := net.ParseIP(host)
	if address == nil {
		return "", fmt.Errorf("GRAPH_HTTP_BIND internal host must be an IP literal or empty")
	}
	if !(address.IsPrivate() || address.IsLoopback() || address.IsLinkLocalUnicast()) {
		return "", fmt.Errorf("GRAPH_HTTP_BIND must not expose the unauthenticated service on a public address")
	}
	return bind, nil
}
