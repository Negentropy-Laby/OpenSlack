package organizationgraph_test

import (
	"testing"

	graph "github.com/Negentropy-Laby/OpenSlack/services/organization-graph"
)

func TestPublicPackageIsImportable(t *testing.T) {
	value, err := graph.ParseCanonicalJSON([]byte(`{"b":2,"a":1}`), graph.JSONLimits{})
	if err != nil {
		t.Fatal(err)
	}
	encoded, err := graph.CanonicalJSON(value)
	if err != nil {
		t.Fatal(err)
	}
	if string(encoded) != `{"a":1,"b":2}` {
		t.Fatalf("canonical bytes got %s", encoded)
	}
	if graph.SnapshotSchema != "openslack.graph_snapshot.v1" ||
		graph.AlgorithmQueryCursor != "openslack.graph_query_cursor.hmac_sha256.v1" {
		t.Fatal("public contract constants drifted")
	}
}
