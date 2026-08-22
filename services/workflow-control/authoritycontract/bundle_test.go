package authoritycontract

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"testing"
)

type bundleManifest struct {
	Schema            string `json:"schema"`
	ContractVersion   string `json:"contractVersion"`
	ContractAuthority string `json:"contractAuthority"`
	AuthorityBoundary struct {
		CurrentWriter                string `json:"currentWriter"`
		TypeScriptRemainsSoleWriter  bool   `json:"typescriptRemainsSoleWriter"`
		GoRole                       string `json:"goRole"`
		AuthorityClaim               string `json:"authorityClaim"`
		AuthorityEligible            bool   `json:"authorityEligible"`
		PostgresAuthorityImplemented bool   `json:"postgresAuthorityImplemented"`
		RoutingActivated             bool   `json:"routingActivated"`
	} `json:"authorityBoundary"`
	Protocol struct {
		Version          string   `json:"version"`
		BaseVersion      string   `json:"baseVersion"`
		Kinds            []string `json:"kinds"`
		AddedKinds       []string `json:"addedKinds"`
		ReceiptableKinds []string `json:"receiptableKinds"`
	} `json:"protocol"`
	Receipts struct {
		Operations        []string `json:"operations"`
		Statuses          []string `json:"statuses"`
		IdempotencyPrefix string   `json:"idempotencyPrefix"`
	} `json:"receipts"`
	Budget struct {
		Max                          string `json:"max"`
		MoneyUnit                    string `json:"moneyUnit"`
		MoneyScale                   int    `json:"moneyScale"`
		Rounding                     string `json:"rounding"`
		BinaryFloatingPointAuthority bool   `json:"binaryFloatingPointAuthority"`
		RevisionPlanes               struct {
			Envelope         string `json:"envelope"`
			Committed        string `json:"committed"`
			EqualityRequired *bool  `json:"equalityRequired"`
		} `json:"revisionPlanes"`
	} `json:"budget"`
	Limits struct {
		MaxMessageBytes    int   `json:"maxMessageBytes"`
		MaxReceiptBytes    int   `json:"maxReceiptBytes"`
		MaxStateBytes      int   `json:"maxStateBytes"`
		MaxJSONDepth       int   `json:"maxJsonDepth"`
		MaxJSONNodes       int   `json:"maxJsonNodes"`
		MaxStringBytes     int   `json:"maxStringBytes"`
		MaxIdentifierBytes int   `json:"maxIdentifierBytes"`
		MaxSafeInteger     int64 `json:"maxSafeInteger"`
	} `json:"limits"`
	ErrorCodes []string `json:"errorCodes"`
	Artifacts  map[string]struct {
		Path       string `json:"path"`
		ByteLength int    `json:"byteLength"`
		SHA256     string `json:"sha256"`
	} `json:"artifacts"`
	BundleFiles []string          `json:"bundleFiles"`
	V1Locks     map[string]string `json:"v1Locks"`
}

func TestGeneratedBundleIsExactTypeScriptMirror(t *testing.T) {
	repository := repositoryRoot(t)
	for _, name := range BundleFiles() {
		mirrored, err := BundleFile(name)
		if err != nil {
			t.Fatalf("read embedded mirror %s: %v", name, err)
		}
		source, err := os.ReadFile(filepath.Join(repository, "packages", "workflows", "contracts", "workflow-control-authority", "v2", name))
		if err != nil {
			t.Fatalf("read TypeScript authority artifact %s: %v", name, err)
		}
		if !reflect.DeepEqual(mirrored, source) {
			t.Fatalf("generated mirror differs byte-for-byte for %s", name)
		}
	}
}

func TestManifestParityAndAuthorityCeiling(t *testing.T) {
	manifestBytes, err := BundleFile("manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	var manifest bundleManifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		t.Fatalf("decode manifest: %v", err)
	}
	boundary := manifest.AuthorityBoundary
	if manifest.Schema != "openslack.workflow_control_authority_contract_manifest.v2" ||
		manifest.ContractVersion != ContractVersion || manifest.ContractAuthority != Authority {
		t.Fatalf("manifest identity is not mirrored: %+v", manifest)
	}
	if boundary.CurrentWriter != "@openslack/workflows" || !boundary.TypeScriptRemainsSoleWriter ||
		boundary.GoRole != GoRole || boundary.AuthorityClaim != AuthorityClaim ||
		boundary.AuthorityEligible || boundary.PostgresAuthorityImplemented || boundary.RoutingActivated || HasDurableAuthority() {
		t.Fatalf("authority ceiling widened: %+v", boundary)
	}
	if manifest.Protocol.Version != ProtocolVersion || manifest.Protocol.BaseVersion != V1ProtocolVersion ||
		!reflect.DeepEqual(manifest.Protocol.Kinds, stringKinds(MessageKinds())) {
		t.Fatalf("protocol vocabulary drifted: %+v", manifest.Protocol)
	}
	if !reflect.DeepEqual(manifest.Receipts.Operations, stringReceiptOperations(ReceiptOperations())) ||
		!reflect.DeepEqual(manifest.Receipts.Statuses, []string{"accepted", "duplicate", "reconciliation_required"}) ||
		manifest.Receipts.IdempotencyPrefix != IdempotencyPrefix {
		t.Fatalf("receipt vocabulary drifted: %+v", manifest.Receipts)
	}
	if manifest.Budget.Max != "9223372036854775807" || manifest.Budget.MoneyUnit != CostUnit ||
		manifest.Budget.MoneyScale != CostScale || manifest.Budget.Rounding != RoundingMode ||
		manifest.Budget.BinaryFloatingPointAuthority || manifest.Budget.RevisionPlanes.Envelope != BudgetEnvelopeRevisionPlane ||
		manifest.Budget.RevisionPlanes.Committed != BudgetCommittedRevisionPlane || manifest.Budget.RevisionPlanes.EqualityRequired == nil ||
		*manifest.Budget.RevisionPlanes.EqualityRequired != BudgetRevisionPlaneEqualityRequired {
		t.Fatalf("budget contract drifted: %+v", manifest.Budget)
	}
	limits := manifest.Limits
	if limits.MaxMessageBytes != MaxMessageBytes || limits.MaxReceiptBytes != MaxReceiptBytes ||
		limits.MaxStateBytes != MaxStateBytes || limits.MaxJSONDepth != MaxJSONDepth ||
		limits.MaxJSONNodes != MaxJSONNodes || limits.MaxStringBytes != MaxStringBytes ||
		limits.MaxIdentifierBytes != MaxIdentifierBytes || limits.MaxSafeInteger != MaxSafeInteger {
		t.Fatalf("limit contract drifted: %+v", limits)
	}
	if !reflect.DeepEqual(manifest.ErrorCodes, stringErrorCodes(ErrorCodes())) || !reflect.DeepEqual(manifest.BundleFiles, BundleFiles()) {
		t.Fatalf("manifest closed inventories drifted")
	}

	repository := repositoryRoot(t)
	bundleRoot := filepath.Join(repository, "packages", "workflows", "contracts", "workflow-control-authority", "v2")
	for name, artifact := range manifest.Artifacts {
		contents, err := os.ReadFile(filepath.Join(bundleRoot, artifact.Path))
		if err != nil {
			t.Fatalf("read artifact %s: %v", name, err)
		}
		if len(contents) != artifact.ByteLength || sha256String(contents) != artifact.SHA256 {
			t.Fatalf("manifest artifact evidence mismatch for %s", name)
		}
	}
	v1Paths := map[string]string{
		"workflowControlManifest": "packages/workflows/contracts/workflow-control/v1/manifest.json",
		"workflowControlGolden":   "packages/workflows/contracts/workflow-control/v1/golden-vectors.json",
		"workflowRunnerManifest":  "packages/workflows/contracts/workflow-runner/v1/manifest.json",
		"workflowRunnerGolden":    "packages/workflows/contracts/workflow-runner/v1/golden-vectors.json",
	}
	for name, relative := range v1Paths {
		contents, err := os.ReadFile(filepath.Join(repository, filepath.FromSlash(relative)))
		if err != nil {
			t.Fatalf("read v1 lock %s: %v", name, err)
		}
		if sha256String(contents) != manifest.V1Locks[name] {
			t.Fatalf("v1 lock changed for %s", name)
		}
	}
}

func TestBundleSchemasCloseEveryObjectShape(t *testing.T) {
	for _, name := range BundleFiles()[:4] {
		contents, err := BundleFile(name)
		if err != nil {
			t.Fatal(err)
		}
		var schema any
		if err := json.Unmarshal(contents, &schema); err != nil {
			t.Fatalf("decode schema %s: %v", name, err)
		}
		assertClosedSchemaObjects(t, schema, name)
	}
}

func assertClosedSchemaObjects(t *testing.T, value any, path string) {
	t.Helper()
	switch current := value.(type) {
	case map[string]any:
		if current["type"] == "object" {
			closed, exists := current["additionalProperties"]
			if !exists || closed != false {
				t.Fatalf("object schema is not closed at %s", path)
			}
		}
		for key, item := range current {
			assertClosedSchemaObjects(t, item, path+"/"+key)
		}
	case []any:
		for index, item := range current {
			assertClosedSchemaObjects(t, item, path+"/"+string(rune(index)))
		}
	}
}

func repositoryRoot(t *testing.T) string {
	t.Helper()
	_, file, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("resolve test source path")
	}
	return filepath.Clean(filepath.Join(filepath.Dir(file), "..", "..", ".."))
}

func sha256String(value []byte) string {
	digest := sha256.Sum256(value)
	return hex.EncodeToString(digest[:])
}

func stringKinds(values []Kind) []string {
	result := make([]string, len(values))
	for index, value := range values {
		result[index] = string(value)
	}
	return result
}

func stringReceiptOperations(values []ReceiptOperation) []string {
	result := make([]string, len(values))
	for index, value := range values {
		result[index] = string(value)
	}
	return result
}

func stringErrorCodes(values []ErrorCode) []string {
	result := make([]string, len(values))
	for index, value := range values {
		result[index] = string(value)
	}
	return result
}
