package contracts_test

import (
	"bufio"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

func TestDockerfileInputsArePinnedAndClosed(t *testing.T) {
	root := repositoryRoot(t)
	data, err := os.ReadFile(filepath.Join(root, "Dockerfile"))
	if err != nil {
		t.Fatal(err)
	}
	text := string(data)
	lines := strings.Split(text, "\n")
	if len(lines) < 3 {
		t.Fatal("Dockerfile is unexpectedly short")
	}
	if got, want := lines[0], "# syntax=docker/dockerfile:1.24.0@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89"; got != want {
		t.Fatalf("Dockerfile frontend=%q, want exact pin %q", got, want)
	}
	if got, want := lines[1], "# check=error=true"; got != want {
		t.Fatalf("Dockerfile check directive=%q, want %q", got, want)
	}

	var fromLines []string
	var copyLines []string
	for _, line := range lines {
		switch {
		case strings.HasPrefix(line, "FROM "):
			fromLines = append(fromLines, line)
		case strings.HasPrefix(line, "COPY "):
			copyLines = append(copyLines, line)
		}
	}
	wantFrom := []string{
		"FROM golang:1.26.5@sha256:3aff6657219a4d9c14e27fb1d8976c49c29fddb70ba835014f477e1c70636647 AS builder",
		"FROM builder AS build",
		"FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818 AS app",
		"FROM app AS canary-webhook-receiver",
	}
	if !reflect.DeepEqual(fromLines, wantFrom) {
		t.Fatalf("Dockerfile FROM contract=%q, want %q", fromLines, wantFrom)
	}
	wantCopy := []string{
		"COPY go.mod go.sum ./",
		"COPY cmd ./cmd",
		"COPY internal ./internal",
		"COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt",
		"COPY --from=build /usr/local/bin/server /server",
		"COPY --from=build /usr/local/bin/bootstrap-openslack /bootstrap-openslack",
		"COPY --from=build /usr/local/bin/container-healthcheck /container-healthcheck",
		"COPY migrations /migrations",
		"COPY --from=build /usr/local/bin/canary-webhook-receiver /canary-webhook-receiver",
	}
	if !reflect.DeepEqual(copyLines, wantCopy) {
		t.Fatalf("Dockerfile COPY contract=%q, want %q", copyLines, wantCopy)
	}

	required := []string{
		"ENV GOTOOLCHAIN=local",
		"RUN --network=none test -s /etc/ssl/certs/ca-certificates.crt",
		"RUN go mod download && go mod verify",
		"RUN --network=none set -eu;",
		"for pass in a b; do",
		`CGO_ENABLED=0 go build -mod=readonly -trimpath -buildvcs=false -ldflags="-s -w -buildid="`,
		"cmp /tmp/build-a/server /tmp/build-b/server;",
		"cmp /tmp/build-a/bootstrap-openslack /tmp/build-b/bootstrap-openslack;",
		"cmp /tmp/build-a/canary-webhook-receiver /tmp/build-b/canary-webhook-receiver;",
		"cmp /tmp/build-a/container-healthcheck /tmp/build-b/container-healthcheck;",
		"USER 65534:65534",
		`CMD ["/container-healthcheck", "app"]`,
		`CMD ["/container-healthcheck", "canary"]`,
	}
	for _, value := range required {
		if !strings.Contains(text, value) {
			t.Errorf("Dockerfile missing contract value %q", value)
		}
	}
	if got := strings.Count(text, "CGO_ENABLED=0 go build -mod=readonly -trimpath -buildvcs=false"); got != 4 {
		t.Errorf("deterministic production build commands=%d, want 4", got)
	}

	lower := strings.ToLower(text)
	for _, forbidden := range []string{
		"copy . .",
		"\nadd ",
		"apt-get",
		"apk ",
		"dnf ",
		"yum ",
		"curl ",
		"wget ",
		"git clone",
		"go install",
		"docker/dockerfile:1\n",
		"user nobody",
	} {
		if strings.Contains(lower, forbidden) {
			t.Errorf("Dockerfile contains forbidden open input %q", forbidden)
		}
	}
}

func TestDockerBuildContextIsAnExactAllowlist(t *testing.T) {
	root := repositoryRoot(t)
	data, err := os.ReadFile(filepath.Join(root, ".dockerignore"))
	if err != nil {
		t.Fatal(err)
	}
	want := strings.Join([]string{
		"**",
		"",
		"!Dockerfile",
		"!.dockerignore",
		"!go.mod",
		"!go.sum",
		"!cmd/",
		"!cmd/**/",
		"!cmd/**/*.go",
		"!internal/",
		"!internal/**/",
		"!internal/**/*.go",
		"!migrations/",
		"!migrations/*.sql",
		"",
		"**/*_test.go",
		"",
		".env",
		".env.*",
		"**/.env",
		"**/.env.*",
		"*.pem",
		"**/*.pem",
		"*.key",
		"**/*.key",
		"secrets",
		"secrets/**",
		"**/secrets/**",
		"credentials",
		"credentials/**",
		"**/credentials/**",
	}, "\n")
	if got := strings.TrimSuffix(string(data), "\n"); got != want {
		t.Fatalf(".dockerignore differs from the reviewed allowlist:\n%s", got)
	}

	for _, directory := range []string{"cmd", "internal"} {
		err := filepath.WalkDir(filepath.Join(root, directory), func(path string, entry os.DirEntry, walkErr error) error {
			if walkErr != nil {
				return walkErr
			}
			if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") {
				return nil
			}
			source, readErr := os.ReadFile(path)
			if readErr != nil {
				return readErr
			}
			if strings.Contains(string(source), "//go:embed") {
				t.Errorf("%s uses go:embed; update the reviewed Docker context before building", path)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
}

func TestComposeBuildContextRemainsTheServiceRoot(t *testing.T) {
	root := repositoryRoot(t)
	data, err := os.ReadFile(filepath.Join(root, "docker-compose.yml"))
	if err != nil {
		t.Fatal(err)
	}
	var compose struct {
		Services map[string]struct {
			Build struct {
				Context    string `yaml:"context"`
				Dockerfile string `yaml:"dockerfile"`
				Target     string `yaml:"target"`
			} `yaml:"build"`
		} `yaml:"services"`
	}
	if err := yaml.Unmarshal(data, &compose); err != nil {
		t.Fatalf("parse service Compose: %v", err)
	}
	build := compose.Services["app"].Build
	if build.Context != "." {
		t.Fatalf("app build context=%q, want service-root relative '.'", build.Context)
	}
	if build.Dockerfile != "" && build.Dockerfile != "Dockerfile" {
		t.Fatalf("app Dockerfile=%q, want the service-root Dockerfile", build.Dockerfile)
	}
	if build.Target != "app" {
		t.Fatalf("app build target=%q, want app", build.Target)
	}
	if strings.Contains(string(data), "context: ../..") {
		t.Fatal("service Compose build context escapes to the OpenSlack root")
	}
}

func TestWorkspaceManifestPathsAreStrictlyOrdered(t *testing.T) {
	root := repositoryRoot(t)
	manifest, err := os.Open(filepath.Join(root, "docs", "testing", "workspace-manifest.sha256"))
	if err != nil {
		t.Fatal(err)
	}
	defer manifest.Close()

	var previous string
	scanner := bufio.NewScanner(manifest)
	for scanner.Scan() {
		parts := strings.SplitN(scanner.Text(), "  ", 2)
		if len(parts) != 2 {
			t.Fatalf("invalid manifest row %q", scanner.Text())
		}
		if previous != "" && strings.Compare(previous, parts[1]) >= 0 {
			t.Fatalf("manifest path %q is not strictly after %q", parts[1], previous)
		}
		previous = parts[1]
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
}
