package processsupervisor

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// TestCrossBuildSupportedProcessSupervisors is opt-in because it recursively
// invokes the Go compiler. CI enables it to prove both platform implementations
// compile without pretending a cross-compiled binary was executed.
func TestCrossBuildSupportedProcessSupervisors(t *testing.T) {
	if os.Getenv("OPENSLACK_PROCESS_SUPERVISOR_CROSS_BUILD") != "1" {
		t.Skip("cross-platform process-supervisor build is not enabled")
	}
	for _, target := range []string{"linux", "windows"} {
		t.Run(target, func(t *testing.T) {
			output := filepath.Join(t.TempDir(), "processsupervisor.test")
			if target == "windows" {
				output += ".exe"
			}
			command := exec.Command("go", "test", "-c", "-o", output, ".")
			command.Env = crossBuildEnvironment(os.Environ(), target)
			body, err := command.CombinedOutput()
			if err != nil {
				t.Fatalf("cross-build %s: %v\n%s", target, err, body)
			}
		})
	}
}

func crossBuildEnvironment(environment []string, target string) []string {
	result := make([]string, 0, len(environment)+4)
	for _, entry := range environment {
		name, _, _ := strings.Cut(entry, "=")
		switch strings.ToUpper(name) {
		case "GOOS", "GOARCH", "CGO_ENABLED", "GOWORK":
			continue
		}
		result = append(result, entry)
	}
	return append(result, "GOOS="+target, "GOARCH=amd64", "CGO_ENABLED=0", "GOWORK=off")
}
