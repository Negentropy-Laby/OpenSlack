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

	"rc_wsman/internal/calleraccess"
)

const (
	defaultHTTPBind          = ":8080"
	defaultMetricsPath       = "/metrics"
	defaultWorkerInterval    = 5 * time.Second
	defaultLeaseDuration     = 30 * time.Second
	defaultShutdownDeadline  = 30 * time.Second
	defaultWorkerConcurrency = 5
	defaultMigrationSource   = "migrations"
	defaultMetricsTimeout    = 2 * time.Second
	defaultRecoveryInterval  = 5 * time.Second
	defaultRecoveryBatchSize = 100
	maxMetricsScrapeTimeout  = 5 * time.Second
)

var envNamePattern = regexp.MustCompile(`^[A-Z][A-Z0-9_]{0,127}$`)
var deploymentDigestPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

// Pepper is one generation of the API-key HMAC pepper.
// String() returns only the non-secret ID label.
type Pepper struct {
	ID    string
	Value []byte
}

func (p Pepper) String() string {
	return fmt.Sprintf("Pepper{ID:%s}", p.ID)
}

// PepperID returns the non-secret pepper generation id; satisfies calleraccess.Pepper.
func (p Pepper) PepperID() string { return p.ID }

// PepperValue returns the secret pepper bytes; satisfies calleraccess.Pepper.
func (p Pepper) PepperValue() []byte { return p.Value }

// PepperSet exposes the loaded generations for runtime checks such as
// "every non-revoked access_keys row has a known pepper_id".
type PepperSet struct {
	activeID string
	byID     map[string]Pepper
}

// Active returns the active pepper generation as the calleraccess.Pepper interface.
func (ps PepperSet) Active() calleraccess.Pepper {
	return ps.byID[ps.activeID]
}

// Previous returns the optional grace-generation pepper as the calleraccess.Pepper interface, or nil.
func (ps PepperSet) Previous() calleraccess.Pepper {
	for id, p := range ps.byID {
		if id != ps.activeID {
			return p
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
	DatabaseURL              string
	DeploymentDigest         string
	HTTPBind                 string
	MetricsPath              string
	WorkerInterval           time.Duration
	LeaseDuration            time.Duration
	ShutdownDeadline         time.Duration
	WorkerConcurrency        int
	MetricsCollectionTimeout time.Duration
	RecoveryInterval         time.Duration
	RecoveryBatchSize        int
	MigrationSource          string
	ActivePepper             Pepper
	PreviousPepper           *Pepper
	EnvCredentialAllowlist   []string
	WorkerVendorScope        []string
}

// OpenSlackBootstrapConfig is the deliberately narrow configuration surface
// for the one-shot OpenSlack identity bootstrap command. The command does not
// initialize the HTTP server, delivery worker, or vendor credential resolver.
type OpenSlackBootstrapConfig struct {
	DatabaseURL  string
	ActivePepper Pepper
}

// LoadOpenSlackBootstrap loads only the database locator and active API-key
// pepper needed by cmd/bootstrap-openslack.
func LoadOpenSlackBootstrap() (*OpenSlackBootstrapConfig, error) {
	dbURL := strings.TrimSpace(os.Getenv("DATABASE_URL"))
	if dbURL == "" {
		return nil, fmt.Errorf("missing required env DATABASE_URL")
	}
	activePepper, err := loadPepper("API_KEY_PEPPER_ACTIVE")
	if err != nil {
		return nil, err
	}
	return &OpenSlackBootstrapConfig{DatabaseURL: dbURL, ActivePepper: *activePepper}, nil
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
		if c.PreviousPepper.ID != c.ActivePepper.ID {
			ps.byID[c.PreviousPepper.ID] = *c.PreviousPepper
		}
	}
	return ps
}

// Load reads and validates configuration from the environment.
// Missing required values or security-invariant violations return an error so
// the caller can fail closed at startup.
func Load() (*Config, error) {
	deploymentDigest := os.Getenv("NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST")
	if !deploymentDigestPattern.MatchString(deploymentDigest) {
		return nil, fmt.Errorf("NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST must match sha256:<64 lowercase hex>")
	}

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
		if p.ID == activePepper.ID {
			return nil, fmt.Errorf("API_KEY_PEPPER_ACTIVE and API_KEY_PEPPER_PREVIOUS must use distinct generation ids")
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
		DeploymentDigest:       deploymentDigest,
		HTTPBind:               stringOrDefault(strings.TrimSpace(os.Getenv("HTTP_BIND")), defaultHTTPBind),
		MetricsPath:            stringOrDefault(strings.TrimSpace(os.Getenv("METRICS_PATH")), defaultMetricsPath),
		MigrationSource:        stringOrDefault(strings.TrimSpace(os.Getenv("MIGRATION_SOURCE")), defaultMigrationSource),
		ActivePepper:           *activePepper,
		PreviousPepper:         previousPepper,
		EnvCredentialAllowlist: credentialNames,
		WorkerVendorScope:      parseList(strings.TrimSpace(os.Getenv("WORKER_VENDOR_SCOPE"))),
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
	if cfg.MetricsCollectionTimeout, err = durationOrDefault("METRICS_COLLECTION_TIMEOUT", defaultMetricsTimeout); err != nil {
		return nil, err
	}
	if cfg.RecoveryInterval, err = durationOrDefault("RECOVERY_INTERVAL", defaultRecoveryInterval); err != nil {
		return nil, err
	}
	if cfg.RecoveryBatchSize, err = intOrDefault("RECOVERY_BATCH_SIZE", defaultRecoveryBatchSize); err != nil {
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
	if cfg.MetricsCollectionTimeout <= 0 || cfg.MetricsCollectionTimeout >= maxMetricsScrapeTimeout {
		return nil, fmt.Errorf("METRICS_COLLECTION_TIMEOUT must be in (0, 5s)")
	}
	if cfg.RecoveryInterval <= 0 || cfg.RecoveryInterval > cfg.LeaseDuration {
		return nil, fmt.Errorf("RECOVERY_INTERVAL must be in (0, LEASE_DURATION]")
	}
	if cfg.RecoveryBatchSize < 1 || cfg.RecoveryBatchSize > 100 {
		return nil, fmt.Errorf("RECOVERY_BATCH_SIZE must be in [1, 100]")
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
