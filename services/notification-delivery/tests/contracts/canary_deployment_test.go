package contracts_test

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestCanaryDeploymentPackIsParameterizedAndClosed(t *testing.T) {
	root := repositoryRoot(t)
	composeData, err := os.ReadFile(filepath.Join(root, "deploy", "canary", "docker-compose.yml"))
	if err != nil {
		t.Fatal(err)
	}
	var compose any
	if err := yaml.Unmarshal(composeData, &compose); err != nil {
		t.Fatalf("parse canary compose: %v", err)
	}
	composeText := string(composeData)
	for _, required := range []string{
		"${CANARY_POSTGRES_USER:?set CANARY_POSTGRES_USER}",
		"${CANARY_POSTGRES_PASSWORD:?set CANARY_POSTGRES_PASSWORD}",
		"${CANARY_POSTGRES_DB:?set CANARY_POSTGRES_DB}",
		"${CANARY_DATABASE_URL:?set CANARY_DATABASE_URL}",
		`ports: !reset []`,
		`build: !reset null`,
		`environment: !override`,
		`127.0.0.1:${APP_PORT:-8080}:8080`,
		`127.0.0.1:${WEBHOOK_RECEIVER_PORT:-8090}:8090`,
		`pg_isready -U "$${POSTGRES_USER}" -d "$${POSTGRES_DB}"`,
	} {
		if !strings.Contains(composeText, required) {
			t.Errorf("canary compose missing parameter %s", required)
		}
	}
	for _, forbidden := range []string{
		"openslack-notification-canary-a",
		"openslack-notification-canary-b",
		"postgres://rc_wsman:rc_wsman",
		"POSTGRES_PASSWORD: rc_wsman",
		"VENDOR_A_TOKEN",
		"VENDOR_B_TOKEN",
		"xoxb-",
		"ghp_",
	} {
		if strings.Contains(composeText, forbidden) {
			t.Errorf("canary compose contains forbidden concrete value %q", forbidden)
		}
	}

	schemaData, err := os.ReadFile(filepath.Join(root, "deploy", "canary", "webhook-record.schema.json"))
	if err != nil {
		t.Fatal(err)
	}
	var schema map[string]any
	if err := json.Unmarshal(schemaData, &schema); err != nil {
		t.Fatalf("parse webhook record schema: %v", err)
	}
	if schema["additionalProperties"] != false {
		t.Fatal("webhook record schema is not closed")
	}
	if schema["type"] != "object" {
		t.Fatal("webhook record schema is not an object")
	}

	pinnedData, err := os.ReadFile(filepath.Join(root, "deploy", "canary", "docker-compose.pinned.yml"))
	if err != nil {
		t.Fatal(err)
	}
	pinnedText := string(pinnedData)
	for _, required := range []string{
		`${NOTIFICATION_SERVICE_IMAGE:?set digest-pinned NOTIFICATION_SERVICE_IMAGE}`,
		`${CANARY_WEBHOOK_RECEIVER_IMAGE:?set digest-pinned CANARY_WEBHOOK_RECEIVER_IMAGE}`,
		"pull_policy: always",
		`io.negentropy-laby.canary.image-mode: "pinned-image"`,
	} {
		if !strings.Contains(pinnedText, required) {
			t.Errorf("pinned Canary overlay missing %q", required)
		}
	}
	if strings.Contains(pinnedText, "build:") {
		t.Fatal("pinned Canary overlay must not contain a build")
	}

	localData, err := os.ReadFile(filepath.Join(root, "deploy", "canary", "docker-compose.local-build.yml"))
	if err != nil {
		t.Fatal(err)
	}
	localText := string(localData)
	for _, required := range []string{
		"context: .",
		`org.opencontainers.image.revision: "${CANARY_SOURCE_COMMIT:?set CANARY_SOURCE_COMMIT}"`,
		`io.negentropy-laby.source-tree: "${CANARY_SOURCE_TREE:?set CANARY_SOURCE_TREE}"`,
		`io.negentropy-laby.canary.image-mode: "verified-local-build"`,
		"pull_policy: build",
	} {
		if !strings.Contains(localText, required) {
			t.Errorf("verified local-build overlay missing %q", required)
		}
	}
	if strings.Contains(localText, "context: ../..") {
		t.Fatal("Canary local build context escapes the repository root")
	}
}

func TestCanaryPreflightRejectsUnsafeConfigWithoutLeakingValues(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Canary deployment preflight targets the Linux Docker host")
	}
	root := repositoryRoot(t)
	script := filepath.Join(root, "deploy", "canary", "preflight.sh")
	fakeBin := t.TempDir()
	fakeDocker := filepath.Join(fakeBin, "docker")
	if err := os.WriteFile(fakeDocker, []byte("#!/bin/sh\nexit 0\n"), 0o700); err != nil {
		t.Fatal(err)
	}

	const secretMarker = "CANARY_TEST_SECRET_MUST_NOT_LEAK"
	valid := canaryPinnedEnvironment(secretMarker)
	tests := []struct {
		name      string
		transform func(string) string
		wantCode  string
	}{
		{
			name:      "valid",
			transform: func(s string) string { return s },
		},
		{
			name:      "unknown key",
			transform: func(s string) string { return s + "UNEXPECTED_KEY=value\n" },
			wantCode:  "env_file_unknown_key",
		},
		{
			name:      "duplicate key",
			transform: func(s string) string { return s + "CANARY_VENDOR_SLACK=duplicate\n" },
			wantCode:  "env_file_duplicate_key",
		},
		{
			name: "placeholder",
			transform: func(s string) string {
				return strings.Replace(s, "WEBHOOK_AUDIT_TOKEN="+secretMarker, "WEBHOOK_AUDIT_TOKEN=<secret>", 1)
			},
			wantCode: "placeholder_WEBHOOK_AUDIT_TOKEN",
		},
		{
			name: "digest mismatch",
			transform: func(s string) string {
				return strings.Replace(s, strings.Repeat("a", 64), strings.Repeat("c", 64), 1)
			},
			wantCode: "service_image_digest_mismatch",
		},
		{
			name: "cleartext origin",
			transform: func(s string) string {
				return strings.Replace(s, "https://receiver.example.test:443", "http://receiver.example.test", 1)
			},
			wantCode: "invalid_CANARY_WEBHOOK_ORIGIN",
		},
		{
			name: "non-443 origin",
			transform: func(s string) string {
				return strings.Replace(s, "https://service.example.test:443", "https://service.example.test:8443", 1)
			},
			wantCode: "invalid_CANARY_SERVICE_ORIGIN",
		},
		{
			name: "database mismatch",
			transform: func(s string) string {
				return strings.Replace(s, "@db:5432/canary_db", "@other:5432/canary_db", 1)
			},
			wantCode: "database_url_mismatch",
		},
		{
			name:      "crlf",
			transform: func(s string) string { return strings.ReplaceAll(s, "\n", "\r\n") },
			wantCode:  "env_file_crlf",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			envFile := filepath.Join(t.TempDir(), "runtime.env")
			if err := os.WriteFile(envFile, []byte(tt.transform(valid)), 0o600); err != nil {
				t.Fatal(err)
			}
			cmd := exec.Command("bash", script, "--env-file", envFile)
			cmd.Env = append(os.Environ(), "PATH="+fakeBin+string(os.PathListSeparator)+os.Getenv("PATH"))
			var output bytes.Buffer
			cmd.Stdout = &output
			cmd.Stderr = &output
			err := cmd.Run()
			got := output.String()
			if strings.Contains(got, secretMarker) {
				t.Fatal("Canary preflight leaked a secret marker")
			}
			if tt.wantCode == "" {
				if err != nil {
					t.Fatalf("valid preflight failed: %v output=%s", err, got)
				}
				if !strings.Contains(got, "CANARY_PREFLIGHT_PASS mode=pinned-image") {
					t.Fatalf("valid preflight lacks stable PASS output: %s", got)
				}
				return
			}
			if err == nil {
				t.Fatalf("unsafe config unexpectedly passed; wanted %s", tt.wantCode)
			}
			if !strings.Contains(got, "CANARY_PREFLIGHT_FAIL code="+tt.wantCode) {
				t.Fatalf("got output %q, want fail code %s", got, tt.wantCode)
			}
		})
	}

	t.Run("wrong env permissions", func(t *testing.T) {
		envFile := filepath.Join(t.TempDir(), "runtime.env")
		if err := os.WriteFile(envFile, []byte(valid), 0o644); err != nil {
			t.Fatal(err)
		}
		cmd := exec.Command("bash", script, "--env-file", envFile)
		cmd.Env = append(os.Environ(), "PATH="+fakeBin+string(os.PathListSeparator)+os.Getenv("PATH"))
		output, err := cmd.CombinedOutput()
		if err == nil || !strings.Contains(string(output), "CANARY_PREFLIGHT_FAIL code=env_file_mode") {
			t.Fatalf("mode-0644 env file did not fail closed: %q", output)
		}
		if strings.Contains(string(output), secretMarker) {
			t.Fatal("permission failure leaked a secret marker")
		}
	})
}

func TestCanaryPinnedComposeResolvesWithoutBuildOrPublicPorts(t *testing.T) {
	docker, err := exec.LookPath("docker")
	if err != nil {
		t.Skip("Docker Compose is unavailable")
	}
	root := repositoryRoot(t)
	envFile := filepath.Join(t.TempDir(), "runtime.env")
	if err := os.WriteFile(envFile, []byte(canaryPinnedEnvironment("fixture-token")), 0o600); err != nil {
		t.Fatal(err)
	}
	cmd := exec.Command(
		docker,
		"compose",
		"--env-file", envFile,
		"-f", filepath.Join(root, "docker-compose.yml"),
		"-f", filepath.Join(root, "deploy", "canary", "docker-compose.yml"),
		"-f", filepath.Join(root, "deploy", "canary", "docker-compose.pinned.yml"),
		"config", "--format", "json",
	)
	var stdout bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &bytes.Buffer{}
	if err := cmd.Run(); err != nil {
		t.Skipf("Docker Compose config is unavailable: %v", err)
	}
	var resolved struct {
		Services map[string]struct {
			Build       any               `json:"build"`
			Environment map[string]string `json:"environment"`
			Image       string            `json:"image"`
			Ports       []struct {
				HostIP    string `json:"host_ip"`
				Published string `json:"published"`
				Target    int    `json:"target"`
			} `json:"ports"`
		} `json:"services"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &resolved); err != nil {
		t.Fatalf("decode merged Canary Compose config: %v", err)
	}
	for _, name := range []string{"app", "webhook-receiver"} {
		service, ok := resolved.Services[name]
		if !ok {
			t.Fatalf("merged Canary Compose lacks service %s", name)
		}
		if service.Build != nil {
			t.Fatalf("pinned service %s unexpectedly has a build", name)
		}
		if !strings.Contains(service.Image, "@sha256:") {
			t.Fatalf("pinned service %s lacks a digest image", name)
		}
		for _, port := range service.Ports {
			if port.HostIP != "127.0.0.1" {
				t.Fatalf("service %s publishes target %d outside loopback: %q", name, port.Target, port.HostIP)
			}
		}
	}
	if ports := resolved.Services["db"].Ports; len(ports) != 0 {
		t.Fatalf("Canary database unexpectedly publishes host ports: %+v", ports)
	}
	for _, forbidden := range []string{"VENDOR_A_TOKEN", "VENDOR_B_TOKEN"} {
		if _, ok := resolved.Services["app"].Environment[forbidden]; ok {
			t.Fatalf("Canary app inherited demo credential %s", forbidden)
		}
	}
	if got := resolved.Services["db"].Environment["POSTGRES_USER"]; got != "canary_db" {
		t.Fatalf("Canary database identity was not parameterized: %q", got)
	}
}

func TestCanaryDocumentationRequiresExternalTLS443(t *testing.T) {
	root := repositoryRoot(t)
	for _, name := range []string{
		filepath.Join("deploy", "canary", "README.md"),
		filepath.Join("docs", "operations", "runbook.md"),
		filepath.Join("docs", "security", "threat-model.md"),
	} {
		data, err := os.ReadFile(filepath.Join(root, name))
		if err != nil {
			t.Fatal(err)
		}
		text := string(data)
		for _, required := range []string{"TLS/443", "loopback", "reverse proxy"} {
			if !strings.Contains(text, required) {
				t.Errorf("%s does not freeze the external TLS boundary term %q", name, required)
			}
		}
	}
}

func canaryPinnedEnvironment(secretMarker string) string {
	const serviceDigest = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	const receiverDigest = "sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	const databasePassword = "0123456789abcdef0123456789abcdef"
	return strings.Join([]string{
		"CANARY_DEPLOYMENT_MODE=pinned-image",
		"NOTIFICATION_SERVICE_IMAGE=registry.example.test/service@" + serviceDigest,
		"CANARY_WEBHOOK_RECEIVER_IMAGE=registry.example.test/receiver@" + receiverDigest,
		"NOTIFICATION_SERVICE_DEPLOYMENT_DIGEST=" + serviceDigest,
		`API_KEY_PEPPER_ACTIVE={"id":"fixture","value":"` + secretMarker + `"}`,
		"API_KEY_PEPPER_PREVIOUS=",
		"CANARY_SLACK_BOT_TOKEN=" + secretMarker,
		"WEBHOOK_AUDIT_TOKEN=" + secretMarker,
		"CANARY_VENDOR_SLACK=vendor-slack",
		"CANARY_VENDOR_WEBHOOK=vendor-webhook",
		"CANARY_POSTGRES_USER=canary_db",
		"CANARY_POSTGRES_PASSWORD=" + databasePassword,
		"CANARY_POSTGRES_DB=canary_db",
		"CANARY_DATABASE_URL=postgres://canary_db:" + databasePassword + "@db:5432/canary_db?sslmode=disable",
		"CANARY_SERVICE_ORIGIN=https://service.example.test:443",
		"CANARY_WEBHOOK_ORIGIN=https://receiver.example.test:443",
		"DB_PORT=5432",
		"APP_PORT=8080",
		"PROMETHEUS_PORT=9090",
		"WEBHOOK_RECEIVER_PORT=8090",
		"WEBHOOK_RECEIVER_EVIDENCE_DIR=/srv/openslack-notification-canary/webhook-evidence",
		"",
	}, "\n")
}

func TestPITRFixtureUsesPersistedMappingFieldNames(t *testing.T) {
	root := repositoryRoot(t)
	script, err := os.ReadFile(filepath.Join(root, "scripts", "acceptance", "pitr.sh"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(script)
	for _, required := range []string{
		`{\"mode\":\"none\"}`,
		`{\"mode\":\"headers\",\"source\":\"ingress_idempotency_key\",\"header_names\":`,
		`outbound_idempotency_mapping->>'source'`,
		`outbound_idempotency_mapping->'header_names'`,
	} {
		if !strings.Contains(text, required) {
			t.Errorf("PITR fixture missing persisted mapping form %q", required)
		}
	}
	for _, forbidden := range []string{
		`{\"Mode\":`,
		`\"Source\":`,
		`\"HeaderNames\":`,
		`outbound_idempotency_mapping->>'Source'`,
		`outbound_idempotency_mapping->'HeaderNames'`,
	} {
		if strings.Contains(text, forbidden) {
			t.Errorf("PITR fixture contains Go-only mapping field %q", forbidden)
		}
	}
}
