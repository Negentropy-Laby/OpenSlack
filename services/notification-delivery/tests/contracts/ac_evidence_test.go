package contracts_test

import (
	"encoding/json"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"testing"

	"gopkg.in/yaml.v3"
)

type registry struct {
	Families map[string]struct {
		Source           string   `yaml:"source"`
		ACs              []string `yaml:"acceptance_criteria"`
		BoundaryMappings []string `yaml:"boundary_coverage_mappings"`
	} `yaml:"requirement_families"`
}

type evidence struct {
	SchemaVersion    int `json:"schema_version"`
	Expected         int `json:"expected_ac_count"`
	ExpectedBoundary int `json:"expected_boundary_mapping_count"`
	Families         []struct {
		Family             string   `json:"family"`
		Type               string   `json:"type"`
		AcceptanceCriteria []string `json:"acceptance_criteria"`
		Tests              []string `json:"tests"`
	} `json:"families"`
	Criteria []struct {
		ID     string   `json:"id"`
		Family string   `json:"family"`
		Type   string   `json:"type"`
		Tests  []string `json:"tests"`
	} `json:"criteria"`
	BoundaryMappings []struct {
		ID    string   `json:"id"`
		Tests []string `json:"tests"`
	} `json:"boundary_mappings"`
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, file, _, _ := runtime.Caller(0)
	return filepath.Join(filepath.Dir(file), "..", "..")
}

func TestModulePathMatchesMonorepoLocation(t *testing.T) {
	root := repositoryRoot(t)
	data, err := os.ReadFile(filepath.Join(root, "go.mod"))
	if err != nil {
		t.Fatal(err)
	}
	const expected = "module github.com/Negentropy-Laby/OpenSlack/services/notification-delivery"
	moduleDirective := regexp.MustCompile(`(?m)^[\t ]*module[\t ]+.*$`)
	directives := moduleDirective.FindAllString(string(data), -1)
	if len(directives) != 1 {
		t.Fatalf("module directive count=%d want=1: %v", len(directives), directives)
	}
	actual := strings.TrimSpace(directives[0])
	if actual != expected {
		t.Fatalf("module directive=%q want=%q", actual, expected)
	}
}

func TestB1B6ACEvidenceIsComplete(t *testing.T) {
	root := repositoryRoot(t)
	var reg registry
	readYAML(t, filepath.Join(root, "docs", "architecture", "tr-registry.yaml"), &reg)
	var ev evidence
	readJSON(t, filepath.Join(root, "docs", "testing", "ac-evidence.json"), &ev)
	if ev.SchemaVersion != 3 {
		t.Fatalf("unsupported AC evidence schema_version %d, want 3", ev.SchemaVersion)
	}

	sources := map[string]int{
		"design/cdd/notification-store.md":        79,
		"design/cdd/caller-access.md":             15,
		"design/cdd/vendor-registry.md":           152,
		"design/cdd/delivery.md":                  20,
		"design/cdd/operations-control.md":        14,
		"design/cdd/reliability-observability.md": 10,
	}
	knownTests := collectTests(t, root)
	evidenceByFamily := make(map[string]struct {
		Type               string
		AcceptanceCriteria []string
		Tests              []string
	})
	evidenceByAC := make(map[string]string)
	for _, item := range ev.Families {
		if _, duplicate := evidenceByFamily[item.Family]; duplicate {
			t.Fatalf("duplicate evidence family %s", item.Family)
		}
		if item.Type == "" || strings.Contains(strings.ToLower(item.Type), "deferred") || strings.Contains(strings.ToLower(item.Type), "code-only") {
			t.Fatalf("invalid evidence type for %s", item.Family)
		}
		if len(item.Tests) == 0 {
			t.Fatalf("family %s has no tests", item.Family)
		}
		if len(item.AcceptanceCriteria) == 0 {
			t.Fatalf("family %s has no explicitly registered ACs", item.Family)
		}
		for _, name := range item.Tests {
			if !knownTests[name] {
				t.Fatalf("family %s references missing test %s", item.Family, name)
			}
		}
		evidenceByFamily[item.Family] = struct {
			Type               string
			AcceptanceCriteria []string
			Tests              []string
		}{item.Type, item.AcceptanceCriteria, item.Tests}
	}
	for _, item := range ev.Criteria {
		if item.ID == "" || item.Family == "" || item.Type == "" || len(item.Tests) == 0 {
			t.Fatalf("incomplete per-criterion evidence %+v", item)
		}
		lowerType := strings.ToLower(item.Type)
		if strings.Contains(lowerType, "deferred") || strings.Contains(lowerType, "code-only") {
			t.Fatalf("invalid evidence type for %s", item.ID)
		}
		if previous, duplicate := evidenceByAC[item.ID]; duplicate {
			t.Fatalf("AC %s has duplicate per-criterion evidence in %s and %s", item.ID, previous, item.Family)
		}
		evidenceByAC[item.ID] = item.Family
		for _, name := range item.Tests {
			if !knownTests[name] {
				t.Fatalf("AC %s references missing test %s", item.ID, name)
			}
		}
	}

	counts := make(map[string]int)
	seenAC := make(map[string]string)
	for family, item := range reg.Families {
		expected, inScope := sources[item.Source]
		if !inScope {
			continue
		}
		_ = expected
		familyEvidence, ok := evidenceByFamily[family]
		if !ok {
			t.Fatalf("family %s has no implementation evidence", family)
		}
		if !slices.Equal(familyEvidence.AcceptanceCriteria, item.ACs) {
			t.Fatalf("family %s explicit AC evidence differs from canonical registry: got=%v want=%v", family, familyEvidence.AcceptanceCriteria, item.ACs)
		}
		cdd, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(item.Source)))
		if err != nil {
			t.Fatal(err)
		}
		for _, ac := range item.ACs {
			if previous, duplicate := seenAC[ac]; duplicate {
				t.Fatalf("AC %s duplicated in %s and %s", ac, previous, family)
			}
			if !strings.Contains(string(cdd), ac) {
				t.Fatalf("AC %s from registry missing in %s", ac, item.Source)
			}
			if evidenceByAC[ac] != family {
				t.Fatalf("AC %s is not explicitly associated with family %s tests", ac, family)
			}
			seenAC[ac] = family
			counts[item.Source]++
		}
	}
	for source, expected := range sources {
		if counts[source] != expected {
			t.Fatalf("%s AC count=%d want=%d", source, counts[source], expected)
		}
	}
	if len(seenAC) != ev.Expected || ev.Expected != 290 {
		t.Fatalf("B1-B6 AC count=%d evidence_expected=%d want=290", len(seenAC), ev.Expected)
	}
	if len(evidenceByAC) != ev.Expected {
		t.Fatalf("explicit AC evidence count=%d want=%d", len(evidenceByAC), ev.Expected)
	}
	if len(evidenceByFamily) != 24 {
		t.Fatalf("evidence family count=%d want=24", len(evidenceByFamily))
	}
	wantedBoundaries := make(map[string]bool)
	for _, family := range reg.Families {
		for _, id := range family.BoundaryMappings {
			if wantedBoundaries[id] {
				t.Fatalf("duplicate canonical boundary mapping %s", id)
			}
			wantedBoundaries[id] = true
		}
	}
	seenBoundaries := make(map[string]bool)
	for _, item := range ev.BoundaryMappings {
		if !wantedBoundaries[item.ID] || seenBoundaries[item.ID] || len(item.Tests) == 0 {
			t.Fatalf("invalid boundary evidence %+v", item)
		}
		seenBoundaries[item.ID] = true
		for _, name := range item.Tests {
			if !knownTests[name] {
				t.Fatalf("boundary %s references missing test %s", item.ID, name)
			}
		}
	}
	if len(wantedBoundaries) != 4 || len(seenBoundaries) != 4 || ev.ExpectedBoundary != 4 {
		t.Fatalf("boundary mappings canonical=%d evidence=%d expected=%d want=4", len(wantedBoundaries), len(seenBoundaries), ev.ExpectedBoundary)
	}
}

func TestB1B6StaticArchitectureBoundaries(t *testing.T) {
	root := repositoryRoot(t)
	goMod, err := os.ReadFile(filepath.Join(root, "go.mod"))
	if err != nil {
		t.Fatal(err)
	}
	for _, prohibited := range []string{"segmentio/kafka", "redis/go-redis", "nats-io/nats", "temporalio/sdk-go"} {
		if strings.Contains(string(goMod), prohibited) {
			t.Errorf("prohibited infrastructure dependency %q", prohibited)
		}
	}
	for _, forbiddenPath := range []string{"internal/dlq", "internal/replayworker", "internal/leasesrenewal"} {
		if _, err := os.Stat(filepath.Join(root, forbiddenPath)); err == nil {
			t.Errorf("prohibited runtime component %s", forbiddenPath)
		}
	}
	compose, err := os.ReadFile(filepath.Join(root, "docker-compose.yml"))
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.ToLower(string(compose)), "alertmanager") {
		t.Fatal("day-1 compose must not introduce Alertmanager")
	}
}

func collectTests(t *testing.T, root string) map[string]bool {
	t.Helper()
	out := make(map[string]bool)
	re := regexp.MustCompile(`(?m)^func (Test[A-Za-z0-9_]+)\s*\(`)
	err := filepath.WalkDir(root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if d.IsDir() && (d.Name() == ".git" || d.Name() == ".claude" || d.Name() == ".aby" || d.Name() == ".gomodcache" || d.Name() == ".gocache") {
			return filepath.SkipDir
		}
		if d.IsDir() || !strings.HasSuffix(path, "_test.go") {
			return nil
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for _, match := range re.FindAllSubmatch(data, -1) {
			out[string(match[1])] = true
		}
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func readYAML(t *testing.T, path string, dst any) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := yaml.Unmarshal(data, dst); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
}
func readJSON(t *testing.T, path string, dst any) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(data, dst); err != nil {
		t.Fatalf("parse %s: %v", path, err)
	}
}

var _ = fmt.Sprintf
