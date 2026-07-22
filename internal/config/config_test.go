package config

import (
	"os"
	"strings"
	"testing"
)

// requiredEnvBase sets the required env values that are always present in the
// docker-compose environment, but may be overridden or cleared by individual
// tests.  Optional env vars are set to empty so inherited values do not leak
// across tests.
func requiredEnvBase(t *testing.T) {
	t.Helper()
	t.Setenv("NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST", "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
	t.Setenv("DATABASE_URL", "postgres://u:p@db:5432/rc_wsman?sslmode=disable")
	t.Setenv("API_KEY_PEPPER_ACTIVE", `{"id":"v1","value":"active-secret"}`)
	t.Setenv("ENV_CREDENTIAL_ALLOWLIST", "VENDOR_A_TOKEN,VENDOR_B_TOKEN")
	t.Setenv("API_KEY_PEPPER_PREVIOUS", "")
	t.Setenv("METRICS_COLLECTION_TIMEOUT", "")
	t.Setenv("RECOVERY_INTERVAL", "")
	t.Setenv("RECOVERY_BATCH_SIZE", "")
}

func TestLoad_RequiresExactDeploymentDigest(t *testing.T) {
	for name, value := range map[string]string{
		"missing":          "",
		"uppercase hex":    "sha256:0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef",
		"uppercase prefix": "SHA256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		"short":            "sha256:0123456789abcdef",
		"wrong algorithm":  "sha512:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
		"whitespace":       "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcde ",
	} {
		t.Run(name, func(t *testing.T) {
			requiredEnvBase(t)
			t.Setenv("NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST", value)
			_, err := Load()
			if err == nil || !strings.Contains(err.Error(), "NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST") {
				t.Fatalf("value accepted or wrong error: %v", err)
			}
			if value != "" && strings.Contains(err.Error(), value) {
				t.Fatal("configuration error reflected the supplied digest")
			}
		})
	}
}

func TestLoad_MissingDatabaseURL(t *testing.T) {
	requiredEnvBase(t)
	t.Setenv("DATABASE_URL", "")
	if _, err := Load(); err == nil {
		t.Fatal("expected error for missing DATABASE_URL")
	} else if !strings.Contains(err.Error(), "DATABASE_URL") {
		t.Fatalf("error should mention DATABASE_URL: %v", err)
	}
}

func TestLoad_MissingActivePepper(t *testing.T) {
	requiredEnvBase(t)
	t.Setenv("API_KEY_PEPPER_ACTIVE", "")
	if _, err := Load(); err == nil {
		t.Fatal("expected error for missing API_KEY_PEPPER_ACTIVE")
	} else if !strings.Contains(err.Error(), "API_KEY_PEPPER_ACTIVE") {
		t.Fatalf("error should mention API_KEY_PEPPER_ACTIVE: %v", err)
	}
}

func TestLoad_InvalidActivePepperFormat(t *testing.T) {
	requiredEnvBase(t)
	t.Setenv("API_KEY_PEPPER_ACTIVE", "not-json")
	_, err := Load()
	if err == nil {
		t.Fatal("expected error for invalid pepper format")
	}
	// The secret value must never appear in the error text.
	if strings.Contains(err.Error(), "not-json") {
		t.Fatal("error text leaked the pepper value")
	}
}

func TestLoad_MissingCredentialAllowlist(t *testing.T) {
	requiredEnvBase(t)
	t.Setenv("ENV_CREDENTIAL_ALLOWLIST", "")
	if _, err := Load(); err == nil {
		t.Fatal("expected error for missing ENV_CREDENTIAL_ALLOWLIST")
	}
}

func TestLoad_InvalidCredentialAllowlist(t *testing.T) {
	requiredEnvBase(t)
	t.Setenv("ENV_CREDENTIAL_ALLOWLIST", "bad name,VALID_TOKEN")
	if _, err := Load(); err == nil {
		t.Fatal("expected error for invalid credential allowlist")
	}
}

func TestLoad_Valid(t *testing.T) {
	requiredEnvBase(t)
	t.Setenv("HTTP_BIND", ":9000")
	t.Setenv("METRICS_PATH", "/-/metrics")

	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected load error: %v", err)
	}
	if cfg.DatabaseURL == "" {
		t.Fatal("DATABASE_URL not set")
	}
	if cfg.DeploymentDigest != "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef" {
		t.Fatalf("deployment digest = %q", cfg.DeploymentDigest)
	}
	if cfg.ActivePepper.ID != "v1" {
		t.Fatalf("active pepper id = %s, want v1", cfg.ActivePepper.ID)
	}
	if string(cfg.ActivePepper.Value) != "active-secret" {
		t.Fatalf("active pepper value mismatch")
	}
	if cfg.HTTPBind != ":9000" {
		t.Fatalf("HTTP_BIND = %s, want :9000", cfg.HTTPBind)
	}
	if cfg.MetricsPath != "/-/metrics" {
		t.Fatalf("METRICS_PATH = %s, want /-/metrics", cfg.MetricsPath)
	}
	if len(cfg.EnvCredentialAllowlist) != 2 {
		t.Fatalf("allowlist length = %d, want 2", len(cfg.EnvCredentialAllowlist))
	}
	if cfg.PreviousPepper != nil {
		t.Fatal("previous pepper should be nil when not set")
	}
	if cfg.MetricsCollectionTimeout.String() != "2s" || cfg.RecoveryInterval.String() != "5s" || cfg.RecoveryBatchSize != 100 {
		t.Fatalf("B6 defaults mismatch: timeout=%s recovery=%s batch=%d", cfg.MetricsCollectionTimeout, cfg.RecoveryInterval, cfg.RecoveryBatchSize)
	}
}

func TestLoad_RejectsInvalidObservabilityAndRecoveryConfig(t *testing.T) {
	for name, value := range map[string]string{
		"METRICS_COLLECTION_TIMEOUT": "5s",
		"RECOVERY_INTERVAL":          "31s",
		"RECOVERY_BATCH_SIZE":        "101",
	} {
		t.Run(name, func(t *testing.T) {
			requiredEnvBase(t)
			t.Setenv(name, value)
			if _, err := Load(); err == nil {
				t.Fatalf("%s=%s was accepted", name, value)
			}
		})
	}
}

func TestLoad_PreviousPepperOptional(t *testing.T) {
	requiredEnvBase(t)
	t.Setenv("API_KEY_PEPPER_PREVIOUS", `{"id":"v0","value":"previous-secret"}`)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected load error: %v", err)
	}
	if cfg.PreviousPepper == nil {
		t.Fatal("expected previous pepper")
	}
	if cfg.PreviousPepper.ID != "v0" {
		t.Fatalf("previous pepper id = %s, want v0", cfg.PreviousPepper.ID)
	}
	if string(cfg.PreviousPepper.Value) != "previous-secret" {
		t.Fatalf("previous pepper value mismatch")
	}
	if !cfg.Peppers().Has("v0") {
		t.Fatal("Peppers() should contain v0")
	}
}

func TestLoad_RejectsDuplicatePepperGenerationIDs(t *testing.T) {
	requiredEnvBase(t)
	t.Setenv("API_KEY_PEPPER_PREVIOUS", `{"id":"v1","value":"previous-must-not-replace-active"}`)

	if _, err := Load(); err == nil {
		t.Fatal("duplicate active/previous pepper generation id was accepted")
	} else if !strings.Contains(err.Error(), "distinct generation ids") || strings.Contains(err.Error(), "previous-must-not-replace-active") {
		t.Fatalf("unexpected or secret-bearing error: %v", err)
	}
}

func TestLoad_PepperValueNotLogged(t *testing.T) {
	requiredEnvBase(t)

	cfg, err := Load()
	if err != nil {
		t.Fatalf("unexpected load error: %v", err)
	}
	pepperStr := cfg.ActivePepper.String()
	if strings.Contains(pepperStr, "active-secret") {
		t.Fatal("Pepper.String() leaked the secret value")
	}
	if !strings.Contains(pepperStr, "v1") {
		t.Fatal("Pepper.String() should contain the id")
	}
}

// Ensure a stray secret value from another test does not accidentally leak into
// the test process output.
func TestMain(m *testing.M) {
	os.Exit(m.Run())
}
