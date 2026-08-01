package contracttodelivery

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	graph "github.com/Negentropy-Laby/OpenSlack/services/organization-graph"
)

func fixtureBytes(t *testing.T) []byte {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("..", "..", "..", "packages", "organization-graph", "src", "fixtures", "contract-to-delivery-source.json"))
	if err != nil {
		t.Fatalf("read fixture: %v", err)
	}
	return data
}

func TestProjectAcceptsOnlyStrictCallerSuppliedJSON(t *testing.T) {
	valid := fixtureBytes(t)
	if _, err := Project(valid); err != nil {
		t.Fatalf("valid fixture failed: %v", err)
	}

	tests := []struct {
		name string
		data []byte
		code graph.JSONErrorCode
	}{
		{name: "BOM", data: append([]byte{0xef, 0xbb, 0xbf}, valid...), code: graph.JSONBOMForbidden},
		{name: "invalid UTF-8", data: []byte{'{', '"', 'x', '"', ':', '"', 0xff, '"', '}'}, code: graph.JSONUTF8Invalid},
		{name: "duplicate key", data: []byte(`{"schema":"a","schema":"b"}`), code: graph.JSONDuplicateKey},
		{name: "trailing token", data: append(append([]byte{}, valid...), []byte(` true`)...), code: graph.JSONSyntaxInvalid},
	}
	for _, testCase := range tests {
		t.Run(testCase.name, func(t *testing.T) {
			_, err := Project(testCase.data)
			if err == nil {
				t.Fatal("Project succeeded, want strict-JSON error")
			}
			var jsonError *graph.JSONError
			if !errors.As(err, &jsonError) {
				t.Fatalf("error type = %T, want *organizationgraph.JSONError: %v", err, err)
			}
			if jsonError.Code != testCase.code {
				t.Fatalf("JSON error code = %s, want %s", jsonError.Code, testCase.code)
			}
		})
	}
}
