package contracts_test

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestOpenSlackBootstrapRemainsOutsideHTTPComposition(t *testing.T) {
	root := repositoryRoot(t)
	for _, relative := range []string{
		"cmd/server",
		"internal/app",
	} {
		err := filepath.WalkDir(filepath.Join(root, relative), func(path string, entry os.DirEntry, err error) error {
			if err != nil {
				return err
			}
			if entry.IsDir() || !strings.HasSuffix(path, ".go") {
				return nil
			}
			data, err := os.ReadFile(path)
			if err != nil {
				return err
			}
			if strings.Contains(string(data), "internal/openslackbootstrap") || strings.Contains(string(data), "bootstrap-openslack") {
				t.Errorf("runtime HTTP composition references bootstrap surface: %s", path)
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}

	command, err := os.ReadFile(filepath.Join(root, "cmd", "bootstrap-openslack", "main.go"))
	if err != nil {
		t.Fatal(err)
	}
	for _, forbidden := range []string{"net/http", "chi.NewRouter", "ListenAndServe", "app.NewServer"} {
		if strings.Contains(string(command), forbidden) {
			t.Errorf("bootstrap command contains network server surface %q", forbidden)
		}
	}
}
