package contracts_test

import (
	"bufio"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

var markdownLink = regexp.MustCompile(`\[[^\]]*\]\(([^)]+)\)`)

func TestMarkdownRelativeLinksResolve(t *testing.T) {
	root := repositoryRoot(t)
	err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() && (entry.Name() == ".git" || entry.Name() == ".claude" || entry.Name() == ".aby" || entry.Name() == ".gomodcache" || entry.Name() == ".gocache") {
			return filepath.SkipDir
		}
		if entry.IsDir() || !strings.HasSuffix(path, ".md") {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, match := range markdownLink.FindAllSubmatch(data, -1) {
			raw := strings.Trim(string(match[1]), "<>")
			if strings.HasPrefix(raw, "http://") || strings.HasPrefix(raw, "https://") || strings.HasPrefix(raw, "mailto:") || strings.HasPrefix(raw, "#") {
				continue
			}
			target := strings.SplitN(raw, "#", 2)[0]
			decoded, decodeErr := url.PathUnescape(target)
			if decodeErr != nil {
				t.Errorf("%s has invalid encoded link %q: %v", path, raw, decodeErr)
				continue
			}
			resolved := filepath.Clean(filepath.Join(filepath.Dir(path), filepath.FromSlash(decoded)))
			if _, statErr := os.Stat(resolved); statErr != nil {
				t.Errorf("%s has unresolved link %q -> %s", path, raw, resolved)
			}
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
}

func TestRegistriesAndStageMirrorsAreCurrent(t *testing.T) {
	root := repositoryRoot(t)
	for _, relative := range []string{
		"design/registry/entities.yaml", "docs/architecture/tr-registry.yaml",
		"docs/architecture/adr-registry.yaml", "memory_bank/t1_axioms/module_support_map.yaml",
	} {
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relative)))
		if err != nil {
			t.Fatal(err)
		}
		var parsed any
		if err := yaml.Unmarshal(data, &parsed); err != nil {
			t.Errorf("parse %s: %v", relative, err)
		}
	}
	for _, relative := range []string{"docs/testing/ac-evidence.json", "docs/testing/acceptance-report.json"} {
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relative)))
		if err != nil {
			t.Fatal(err)
		}
		var parsed any
		if err := json.Unmarshal(data, &parsed); err != nil {
			t.Errorf("parse %s: %v", relative, err)
		}
	}
	stage, err := os.ReadFile(filepath.Join(root, "production", "stage.txt"))
	if err != nil || strings.TrimSpace(string(stage)) != "Implementation" {
		t.Fatalf("stage=%q err=%v", stage, err)
	}
	activeFiles := []string{
		"README.md", "docs/development-plan.md", "docs/architecture/architecture.md",
		"design/cdd/module-index.md", "memory_bank/t0_core/active_context.md",
		"memory_bank/t1_axioms/architecture_context.md", "memory_bank/t1_axioms/tech_context.md",
	}
	for _, relative := range activeFiles {
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relative)))
		if err != nil {
			t.Fatal(err)
		}
		lower := strings.ToLower(string(data))
		for _, stale := range []string{"b5/b6 not started", "b5/b6 尚未开始", "b5/b6 未授权", "b1-b4-ac-evidence.json", "implementation: not started", "实现仍未开始"} {
			if strings.Contains(lower, strings.ToLower(stale)) {
				t.Errorf("%s contains stale status %q", relative, stale)
			}
		}
	}
}

func TestAcceptanceArtifactsContainNoSecretOrPayloadMarkers(t *testing.T) {
	root := repositoryRoot(t)
	markers := []string{
		"local-only-active-pepper-not-for-production", "local-only-previous-pepper-not-for-production",
		"local-only-vendor-a-token", "local-only-vendor-b-token", "RC_WSMAN_FORBIDDEN_PAYLOAD_MARKER",
	}
	for _, relative := range []string{
		"docs/testing/acceptance-report.json", "docs/testing/capacity-report.md", "docs/testing/ac-evidence.json",
		"docs/testing/fault-drill-report.md", "docs/testing/pitr-report.md", "docs/testing/marker-scan-report.md",
		"docs/testing/ib4-r1-local-report.json",
	} {
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(relative)))
		if err != nil {
			t.Fatal(err)
		}
		for _, marker := range markers {
			if strings.Contains(string(data), marker) {
				t.Errorf("%s contains forbidden marker %q", relative, marker)
			}
		}
	}
}

func TestWorkspaceManifestMatchesFiles(t *testing.T) {
	root := repositoryRoot(t)
	manifest, err := os.Open(filepath.Join(root, "docs", "testing", "workspace-manifest.sha256"))
	if err != nil {
		t.Fatal(err)
	}
	defer manifest.Close()
	scanner := bufio.NewScanner(manifest)
	manifestPaths := make(map[string]bool)
	for scanner.Scan() {
		parts := strings.SplitN(scanner.Text(), "  ", 2)
		if len(parts) != 2 || len(parts[0]) != 64 {
			t.Fatalf("invalid manifest row %q", scanner.Text())
		}
		if manifestPaths[parts[1]] {
			t.Fatalf("duplicate manifest path %s", parts[1])
		}
		manifestPaths[parts[1]] = true
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(parts[1])))
		if err != nil {
			t.Fatalf("manifest path %s: %v", parts[1], err)
		}
		if got := fmt.Sprintf("%x", sha256.Sum256(data)); got != parts[0] {
			t.Fatalf("manifest mismatch %s: got %s want %s", parts[1], got, parts[0])
		}
	}
	if err := scanner.Err(); err != nil {
		t.Fatal(err)
	}
	allowedTopLevel := map[string]bool{
		".github": true, ".dockerignore": true, ".gitignore": true, "CLAUDE.md": true,
		"README.md": true, "Dockerfile": true, "LICENSE": true, "NOTICE": true, "THIRD_PARTY_NOTICES.md": true, "SBOM.cdx.json": true,
		"cmd": true, "deploy": true, "design": true,
		"docker-compose.yml": true, "docs": true, "go.mod": true, "go.sum": true, "internal": true,
		"integration": true, "memory_bank": true, "migrations": true, "production": true, "scripts": true, "standards": true, "tests": true,
	}
	expectedPaths := make(map[string]bool)
	if err := filepath.WalkDir(root, func(path string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() && (entry.Name() == ".git" || entry.Name() == ".claude" || entry.Name() == ".aby" || entry.Name() == ".gomodcache" || entry.Name() == ".gocache") {
			return filepath.SkipDir
		}
		if entry.IsDir() {
			return nil
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		if relative == "docs/testing/workspace-manifest.sha256" {
			return nil
		}
		top := strings.SplitN(relative, "/", 2)[0]
		if allowedTopLevel[top] {
			expectedPaths[relative] = true
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	for path := range expectedPaths {
		if !manifestPaths[path] {
			t.Errorf("deliverable file missing from manifest: %s", path)
		}
	}
	for path := range manifestPaths {
		if !expectedPaths[path] {
			t.Errorf("manifest contains non-deliverable or stale path: %s", path)
		}
	}
	if len(manifestPaths) != len(expectedPaths) {
		t.Fatalf("manifest entries=%d deliverable files=%d", len(manifestPaths), len(expectedPaths))
	}
}
