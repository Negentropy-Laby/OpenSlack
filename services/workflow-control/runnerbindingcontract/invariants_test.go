package runnerbindingcontract

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
)

func TestPackageHasNoDatabaseHTTPOrRuntimeAuthoritySurface(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatal(err)
	}
	forbiddenImports := []string{
		"database/",
		"net/http",
		"github.com/jackc/pgx",
		"internal/authoritystore",
		"internal/budgetstore",
		"internal/checkpointshadowstore",
		"internal/effectshadowstore",
		"internal/runnerapp",
		"internal/runnerscheduler",
		"internal/runnerstore",
		"/cmd/",
	}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".go") ||
			strings.HasSuffix(entry.Name(), "_test.go") {
			continue
		}
		path := filepath.Join(".", entry.Name())
		file, parseErr := parser.ParseFile(token.NewFileSet(), path, nil, parser.ImportsOnly)
		if parseErr != nil {
			t.Fatalf("parse %s: %v", path, parseErr)
		}
		for _, imported := range file.Imports {
			name, unquoteErr := strconv.Unquote(imported.Path.Value)
			if unquoteErr != nil {
				t.Fatalf("unquote import in %s: %v", path, unquoteErr)
			}
			for _, forbidden := range forbiddenImports {
				if strings.Contains(name, forbidden) {
					t.Fatalf("pure mirror imports forbidden runtime surface %q from %s", name, path)
				}
			}
		}
		if hasAuthorityDeclaration(file) {
			t.Fatalf("pure mirror declares a runtime main entrypoint in %s", path)
		}
	}
	if HasDurableAuthority() {
		t.Fatal("F2a Go mirror claimed durable authority")
	}
}

func hasAuthorityDeclaration(file *ast.File) bool {
	return file.Name.Name == "main"
}
