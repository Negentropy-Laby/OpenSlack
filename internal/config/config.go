// Package config loads and validates rc_wsman startup configuration.
//
// B1 scope: environment-based allowlist with fail-closed validation.  Secret
// values (API-key pepper generations, env:// credential contents) are kept in
// memory only and never written to logs, metrics, audit, Store or responses.
package config

import (
	"encoding/json"
	"fmt"
	"os"
	"regexp"
	"strconv"
	"strings"
	"time"
)

const (
	defaultHTTPBind          = ":8080"
	defaultMetricsPath       = "/metrics"
	defaultWorkerInterval    = 5 * time.Second
	defaultLeaseDuration     = 30 * time.Second
	defaultShutdownDeadline  = 30 * time.Second
	defaultWorkerConcurrency = 5
	defaultMigrationSource     = "migrations"
)

var envNamePattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,127}$`)

// Pepper is one generation of the API-key HMAC pepper.
// String() returns only the non-secret ID label.
type Pepper struct {
	ID    string
	Value []byte
}

func (p Pepper) String() string {
	return fmt.Sprintf("Pepper{ID:%s}", p.ID)
}

// PepperSet exposes the loaded generations for runtime checks such as
// "every non-revoked access_keys row has a known pepper_id".
type PepperSet struct {
	activeID string
	byID     map[string]Pepper
}

// Active returns the active pepper generation.
func (ps PepperSet) Active() Pepper {
	return ps.byID[ps.activeID]
}

// Previous returns the optional grace-generation pepper, or nil.
func (ps PepperSet) Previous() *Pepper {
	for id, p := range ps.byID {
		if id != ps.activeID {
			return &p
		}
	}
	return nil
}

// Has reports whether a pepper generation id is currently loaded.
func (ps PepperSet) Has(id string) bool {
	_, ok := ps.byID[id]
	return ok
}

// Config is the validated, immutable startup configuration.
// Pepper values live here only for the lifetime of the process.
type Config struct {
	DatabaseURL            string
	HTTPBind               string
	MetricsPath            string
	WorkerInterval         time.Duration
	LeaseDuration          time.Duration
	ShutdownDeadline       time.Duration
	WorkerConcurrency      int
	MigrationSource        string
	ActivePepper           Pepper
	PreviousPepper         *Pepper
	EnvCredentialAllowlist []string
}

// Peppers returns a PepperSet for id-membership checks.
func (c *Config) Peppers() PepperSet {
	ps := PepperSet{
		activeID: c.ActivePepper.ID,
		byID: map[string]Pepper{
			c.ActivePepper.ID: c.ActivePepper,
		},
	}
	if c.PreviousPepper != nil {
		ps.byID[c.PreviousPepper.ID] = *c.PreviousPepper
	}
	return ps
}

// Load reads and validates configuration from the environment.
// Missing required values or security-invariant violations return an error so
// the caller can fail closed at startup.
func Load() (*Config, error) {
	dbURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if dbURL == "" {
		return nil, fmt.Errorf("missing required env DATABASE_URL")
	}

	activePepper, err := loadPepper("API_KEY_PEPPER_ACTIVE")
	if err != nil {
		return nil, err
	}

	var previousPepper *Pepper
	if v := strings.TrimSpace(os.Getenv("API_KEY_PEPPER_PREVIOUS")); v != "" {
		p, err := parsePepper("API_KEY_PEPPER_PREVIOUS", v)
		if err != nil {
			return nil, err
		}
		previousPepper = p
	}

	allowlist := strings.TrimSpace(os.Getenv("ENV_CREDENTIAL_ALLOWLIST"))
	if allowlist == "" {
		return nil, fmt.Errorf("missing required env ENV_CREDENTIAL_ALLOWLIST")
	}
	credentialNames := parseList(allowlist)
	if len(credentialNames) == 0 {
		return nil, fmt.Errorf("ENV_CREDENTIAL_ALLOWLIST is empty")
	}
	for _, n := range credentialNames {
		if !envNamePattern.MatchString(n) {
			return nil, fmt.Errorf("ENV_CREDENTIAL_ALLOWLIST contains invalid name %q", n)
		}
	}

	cfg := &Config{
		DatabaseURL:            dbURL,
		HTTPBind:               stringOrDefault(strings.TrimSpace(os.Getenv("HTTP_BIND")), defaultHTTPBind),
		MetricsPath:            stringOrDefault(strings.TrimSpace(os.Getenv("METRICS_PATH")), defaultMetricsPath),
		MigrationSource:        stringOrDefault(strings.TrimSpace(os.Getenv("MIGRATION_SOURCE")), defaultMigrationSource),
		ActivePepper:           *activePepper,
		PreviousPepper:         previousPepper,
		EnvCredentialAllowlist: credentialNames,
	}

	if cfg.WorkerInterval, err = durationOrDefault("WORKER_INTERVAL", defaultWorkerInterval); err != nil {
		return nil, err
	}
	if cfg.LeaseDuration, err = durationOrDefault("LEASE_DURATION", defaultLeaseDuration); err != nil {
		return nil, err
	}
	if cfg.ShutdownDeadline, err = durationOrDefault("SHUTDOWN_DEADLINE", defaultShutdownDeadline); err != nil {
		return nil, err
	}
	if cfg.WorkerConcurrency, err = intOrDefault("WORKER_CONCURRENCY", defaultWorkerConcurrency); err != nil {
		return nil, err
	}

	if cfg.WorkerInterval <= 0 {
		return nil, fmt.Errorf("WORKER_INTERVAL must be positive")
	}
	if cfg.LeaseDuration <= 0 {
		return nil, fmt.Errorf("LEASE_DURATION must be positive")
	}
	if cfg.ShutdownDeadline <= 0 {
		return nil, fmt.Errorf("SHUTDOWN_DEADLINE must be positive")
	}
	if cfg.WorkerConcurrency <= 0 {
		return nil, fmt.Errorf("WORKER_CONCURRENCY must be positive")
	}
	if cfg.MetricsPath == "" || !strings.HasPrefix(cfg.MetricsPath, "/") {
		return nil, fmt.Errorf("METRICS_PATH must be an absolute path")
	}
	if cfg.MigrationSource == "" {
		return nil, fmt.Errorf("MIGRATION_SOURCE must not be empty")
	}

	return cfg, nil
}

// loadPepper parses a required `{id,value}` pepper env var.
// The value is never returned in error text.
func loadPepper(env string) (*Pepper, error) {
	v := strings.TrimSpace(os.Getenv(env))
	if v == "" {
		return nil, fmt.Errorf("missing required env %s", env)
	}
	return parsePepper(env, v)
}

// pepperEnvelope is the JSON shape for the env var value.
type pepperEnvelope struct {
	ID    string `json:"id"`
	Value string `json:"value"`
}

// parsePepper unmarshals a pepper env var and validates it.
func parsePepper(env, raw string) (*Pepper, error) {
	var e pepperEnvelope
	if err := json.Unmarshal([]byte(raw), &e); err != nil {
		return nil, fmt.Errorf("invalid %s: expected JSON {id,value}", env)
	}
	if strings.TrimSpace(e.ID) == "" {
		return nil, fmt.Errorf("invalid %s: id is empty", env)
	}
	if e.Value == "" {
		return nil, fmt.Errorf("invalid %s: value is empty", env)
	}
	return &Pepper{ID: e.ID, Value: []byte(e.Value)}, nil
}

func parseList(s string) []string {
	parts := strings.Split(s, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		p = strings.TrimSpace(p)
		if p != "" {
			out = append(out, p)
		}
	}
	return out
}

func stringOrDefault(v, d string) string {
	if v == "" {
		return d
	}
	return v
}

func durationOrDefault(env string, def time.Duration) (time.Duration, error) {
	v := strings.TrimSpace(os.Getenv(env))
	if v == "" {
		return def, nil
	}
	d, err := time.ParseDuration(v)
	if err != nil {
		return 0, fmt.Errorf("invalid %s: %w", env, err)
	}
	return d, nil
}

func intOrDefault(env string, def int) (int, error) {
	v := strings.TrimSpace(os.Getenv(env))
	if v == "" {
		return def, nil
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return 0, fmt.Errorf("invalid %s: %w", env, err)
	}
	return n, nil
}
