package graphstore

import (
	"bytes"
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"fmt"
	"reflect"
	"sort"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphjson"
)

const (
	MaxIdempotencyKeyBytes  = 512
	MaxListLimit            = 200
	MaxScenarioList         = 10000
	MaxStoredCanonicalBytes = 64 * 1024 * 1024
	ReceiptSchema           = "openslack.graph_ingest_receipt.v1"
	OperationSnapshot       = "snapshot_ingest"
	OperationSnapshotDelta  = "delta_ingest"
	SnapshotIngestPath      = "/v1/graph/snapshots:ingest"
	DeltaIngestPath         = "/v1/graph/deltas:ingest"
)

const (
	maxStoredJSONDepth = 32
	maxStoredJSONNodes = 2_000_000
)

type ReceiptStatus string

const (
	ReceiptAccepted               ReceiptStatus = "accepted"
	ReceiptDuplicate              ReceiptStatus = "duplicate"
	ReceiptReconciliationRequired ReceiptStatus = "reconciliation_required"
)

type (
	Snapshot = graphcontract.Snapshot
	Delta    = graphcontract.Delta
)

type PublishInput struct {
	IdempotencyKey     string
	RequestFingerprint string
	ExpectedCursor     *string
	ExpectedRevision   int64
	Snapshot           Snapshot
	Delta              *Delta
}

type PreparedPublish struct {
	Input              PublishInput
	Snapshot           Snapshot
	Delta              *Delta
	SnapshotBytes      []byte
	DeltaBytes         []byte
	RequestFingerprint [sha256.Size]byte
}

type Receipt struct {
	Schema                string
	Operation             string
	Status                ReceiptStatus
	IdempotencyKey        string
	RequestFingerprint    string
	ScenarioInstanceID    string
	Cursor                string
	Revision              int64
	SnapshotIntegrityHash string
	DeltaIntegrityHash    *string
	CommittedAt           *time.Time
	ReconciliationToken   *string

	ReceiptID      string
	PreviousCursor *string
	RecordedAt     time.Time
}

type Head struct {
	ScenarioInstanceID    string
	Cursor                string
	Revision              int64
	SnapshotIntegrityHash string
	GeneratedAt           string
	UpdatedAt             time.Time
}

type StoredSnapshot struct {
	Snapshot       Snapshot
	CanonicalBytes []byte
	Revision       int64
	StoredAt       time.Time
}

type StoredDelta struct {
	Delta          Delta
	CanonicalBytes []byte
	Revision       int64
	StoredAt       time.Time
}

type Statistics struct {
	PublishedScenarios       int64
	PublishedHeadRevisionMax int64
	ReconciliationPending    int64
}

type Store interface {
	Publish(context.Context, PublishInput) (Receipt, error)
	Current(context.Context, string) (Head, StoredSnapshot, error)
	ReadSnapshot(context.Context, string, string) (StoredSnapshot, error)
	ReadDelta(context.Context, string, string, string) (StoredDelta, error)
	ListSnapshots(context.Context, string, int64, int) ([]StoredSnapshot, error)
	ListDeltas(context.Context, string, int64, int) ([]StoredDelta, error)
	ListHeads(context.Context, int) ([]Head, error)
	ReadReceipt(context.Context, string, string) (Receipt, error)
	ReadReceiptByKey(context.Context, string) (Receipt, error)
	Statistics(context.Context) (Statistics, error)
}

func PreparePublish(input PublishInput) (PreparedPublish, error) {
	if err := ValidateIdempotencyKey(input.IdempotencyKey); err != nil {
		return PreparedPublish{}, err
	}
	requestFingerprint, err := ParseRequestFingerprint(input.RequestFingerprint)
	if err != nil {
		return PreparedPublish{}, err
	}
	if input.ExpectedRevision < 0 {
		return PreparedPublish{}, Failure(
			ErrorInvalidInput,
			"expected revision must not be negative",
			nil,
		)
	}
	if input.ExpectedRevision == 1<<63-1 {
		return PreparedPublish{}, Failure(
			ErrorInvalidInput,
			"expected revision cannot advance beyond int64",
			nil,
		)
	}
	if input.ExpectedCursor == nil && input.ExpectedRevision != 0 {
		return PreparedPublish{}, Failure(
			ErrorInvalidInput,
			"an absent expected cursor requires revision zero",
			nil,
		)
	}
	if input.ExpectedCursor != nil {
		if err := validateIdentifier(*input.ExpectedCursor, "expected cursor", graphcontract.MaxIdentifierCharacters); err != nil {
			return PreparedPublish{}, err
		}
		if input.ExpectedRevision < 1 {
			return PreparedPublish{}, Failure(
				ErrorInvalidInput,
				"a present expected cursor requires a positive revision",
				nil,
			)
		}
	}

	snapshot, err := graphcontract.AssertSnapshotIntegrity(input.Snapshot)
	if err != nil {
		return PreparedPublish{}, Failure(ErrorContentInvalid, "validate snapshot", err)
	}
	snapshotBytes, err := graphcontract.SerializeSnapshot(snapshot)
	if err != nil {
		return PreparedPublish{}, Failure(ErrorContentInvalid, "serialize snapshot", err)
	}
	if _, err := parseStoredCanonicalJSON(snapshotBytes); err != nil {
		return PreparedPublish{}, Failure(
			ErrorContentInvalid,
			"snapshot canonical form exceeds the durable store parsing bounds",
			err,
		)
	}

	var delta *Delta
	var deltaBytes []byte
	if input.Delta != nil {
		if input.ExpectedCursor == nil {
			return PreparedPublish{}, Failure(
				ErrorContentInvalid,
				"an initial snapshot cannot include a delta",
				nil,
			)
		}
		canonical, canonicalErr := graphcontract.AssertDeltaIntegrity(*input.Delta)
		if canonicalErr != nil {
			return PreparedPublish{}, Failure(ErrorContentInvalid, "validate delta", canonicalErr)
		}
		if canonical.ScenarioInstanceID != snapshot.ScenarioInstanceID ||
			canonical.FromCursor != *input.ExpectedCursor ||
			canonical.ToCursor != snapshot.Cursor {
			return PreparedPublish{}, Failure(
				ErrorContentInvalid,
				"delta scope and cursors do not bind the expected and target snapshots",
				nil,
			)
		}
		encoded, encodeErr := graphcontract.SerializeDelta(canonical)
		if encodeErr != nil {
			return PreparedPublish{}, Failure(ErrorContentInvalid, "serialize delta", encodeErr)
		}
		if _, parseErr := parseStoredCanonicalJSON(encoded); parseErr != nil {
			return PreparedPublish{}, Failure(
				ErrorContentInvalid,
				"delta canonical form exceeds the durable store parsing bounds",
				parseErr,
			)
		}
		delta = &canonical
		deltaBytes = encoded
	}

	prepared := PreparedPublish{
		Input:         input,
		Snapshot:      snapshot,
		Delta:         delta,
		SnapshotBytes: append([]byte(nil), snapshotBytes...),
		DeltaBytes:    append([]byte(nil), deltaBytes...),
	}
	prepared.RequestFingerprint = requestFingerprint
	expectedFingerprint, err := computePublishRequestFingerprint(prepared)
	if err != nil {
		return PreparedPublish{}, err
	}
	expectedRaw, err := ParseRequestFingerprint(expectedFingerprint)
	if err != nil {
		return PreparedPublish{}, err
	}
	if subtle.ConstantTimeCompare(requestFingerprint[:], expectedRaw[:]) != 1 {
		return PreparedPublish{}, Failure(
			ErrorInvalidInput,
			"request fingerprint does not match the canonical ingest request",
			nil,
		)
	}
	return prepared, nil
}

func (value PreparedPublish) Operation() string {
	if value.Delta == nil {
		return OperationSnapshot
	}
	return OperationSnapshotDelta
}

func (value PreparedPublish) FingerprintString() string {
	return value.Input.RequestFingerprint
}

func ValidateDeltaTransition(parent, target Snapshot, delta Delta) error {
	parent, err := graphcontract.AssertSnapshotIntegrity(parent)
	if err != nil {
		return Failure(ErrorContentInvalid, "validate parent snapshot", err)
	}
	target, err = graphcontract.AssertSnapshotIntegrity(target)
	if err != nil {
		return Failure(ErrorContentInvalid, "validate target snapshot", err)
	}
	delta, err = graphcontract.AssertDeltaIntegrity(delta)
	if err != nil {
		return Failure(ErrorContentInvalid, "validate transition delta", err)
	}
	if parent.ScenarioInstanceID != target.ScenarioInstanceID ||
		delta.ScenarioInstanceID != target.ScenarioInstanceID ||
		delta.FromCursor != parent.Cursor ||
		delta.ToCursor != target.Cursor {
		return Failure(ErrorContentInvalid, "delta does not bind parent and target", nil)
	}
	if target.GeneratedAt != delta.GeneratedAt {
		return Failure(
			ErrorContentInvalid,
			"snapshot and delta generatedAt must identify the same projection run",
			nil,
		)
	}

	nodes := make(map[string]graphcontract.Node, len(parent.Nodes))
	for _, node := range parent.Nodes {
		nodes[node.ID] = node
	}
	edges := make(map[string]graphcontract.Edge, len(parent.Edges))
	for _, edge := range parent.Edges {
		edges[edge.ID] = edge
	}

	for _, node := range delta.UpsertNodes {
		if existing, ok := nodes[node.ID]; ok && existing.ValidTo != nil {
			return Failure(
				ErrorContentInvalid,
				fmt.Sprintf("delta node upsert %s cannot reopen a closed v1 record", node.ID),
				nil,
			)
		}
		nodes[node.ID] = node
	}
	for _, id := range delta.CloseNodeIDs {
		existing, ok := nodes[id]
		if !ok || existing.ValidTo != nil {
			return Failure(
				ErrorContentInvalid,
				fmt.Sprintf("delta node closure %s must identify an open node", id),
				nil,
			)
		}
		closedAt := delta.GeneratedAt
		existing.ValidTo = &closedAt
		nodes[id] = existing
	}
	for _, edge := range delta.UpsertEdges {
		if existing, ok := edges[edge.ID]; ok && existing.ValidTo != nil {
			return Failure(
				ErrorContentInvalid,
				fmt.Sprintf("delta edge upsert %s cannot reopen a closed v1 record", edge.ID),
				nil,
			)
		}
		edges[edge.ID] = edge
	}
	for _, id := range delta.CloseEdgeIDs {
		existing, ok := edges[id]
		if !ok || existing.ValidTo != nil {
			return Failure(
				ErrorContentInvalid,
				fmt.Sprintf("delta edge closure %s must identify an open edge", id),
				nil,
			)
		}
		closedAt := delta.GeneratedAt
		existing.ValidTo = &closedAt
		edges[id] = existing
	}

	actualNodes := make([]graphcontract.Node, 0, len(nodes))
	for _, node := range nodes {
		actualNodes = append(actualNodes, node)
	}
	sort.Slice(actualNodes, func(left, right int) bool {
		return actualNodes[left].ID < actualNodes[right].ID
	})
	actualEdges := make([]graphcontract.Edge, 0, len(edges))
	for _, edge := range edges {
		actualEdges = append(actualEdges, edge)
	}
	sort.Slice(actualEdges, func(left, right int) bool {
		return actualEdges[left].ID < actualEdges[right].ID
	})

	if !reflect.DeepEqual(actualNodes, target.Nodes) ||
		!reflect.DeepEqual(actualEdges, target.Edges) {
		return Failure(
			ErrorContentInvalid,
			"delta operations do not reconstruct the target snapshot exactly",
			nil,
		)
	}
	return nil
}

func ValidateList(scenarioInstanceID string, afterRevision int64, limit int) error {
	if err := ValidateScenarioInstanceID(scenarioInstanceID); err != nil {
		return err
	}
	if afterRevision < 0 {
		return Failure(ErrorInvalidInput, "after revision must not be negative", nil)
	}
	if limit < 1 || limit > MaxListLimit {
		return Failure(
			ErrorInvalidInput,
			fmt.Sprintf("list limit must be between 1 and %d", MaxListLimit),
			nil,
		)
	}
	return nil
}

func ValidateHeadListLimit(limit int) error {
	if limit < 1 || limit > MaxScenarioList {
		return Failure(
			ErrorInvalidInput,
			fmt.Sprintf("head list limit must be between 1 and %d", MaxScenarioList),
			nil,
		)
	}
	return nil
}

func ValidateScenarioInstanceID(value string) error {
	return validateIdentifier(
		value,
		"scenario instance id",
		graphcontract.MaxIdentifierCharacters,
	)
}

func ValidateCursor(value string) error {
	return validateIdentifier(value, "cursor", graphcontract.MaxIdentifierCharacters)
}

func ValidateIdempotencyKey(value string) error {
	return validateByteIdentifier(value, "idempotency key", MaxIdempotencyKeyBytes)
}

func DecodeStoredSnapshot(
	canonicalBytes []byte,
	scenarioInstanceID string,
	cursor string,
) (Snapshot, error) {
	parsed, err := parseStoredCanonicalJSON(canonicalBytes)
	if err != nil {
		return Snapshot{}, Failure(ErrorContentInvalid, "parse stored snapshot", err)
	}
	value, err := graphcontract.SnapshotFromValue(parsed)
	if err != nil {
		return Snapshot{}, Failure(ErrorContentInvalid, "parse stored snapshot", err)
	}
	value, err = graphcontract.AssertSnapshotIntegrity(value)
	if err != nil {
		return Snapshot{}, Failure(ErrorContentInvalid, "verify stored snapshot", err)
	}
	if value.ScenarioInstanceID != scenarioInstanceID || value.Cursor != cursor {
		return Snapshot{}, Failure(
			ErrorContentInvalid,
			"stored snapshot does not match its database identity",
			nil,
		)
	}
	encoded, err := graphcontract.SerializeSnapshot(value)
	if err != nil {
		return Snapshot{}, Failure(ErrorContentInvalid, "serialize stored snapshot", err)
	}
	if !bytes.Equal(encoded, canonicalBytes) {
		return Snapshot{}, Failure(
			ErrorContentInvalid,
			"stored snapshot bytes are not the exact canonical serialization",
			nil,
		)
	}
	return value, nil
}

func DecodeStoredDelta(
	canonicalBytes []byte,
	scenarioInstanceID string,
	fromCursor string,
	toCursor string,
) (Delta, error) {
	parsed, err := parseStoredCanonicalJSON(canonicalBytes)
	if err != nil {
		return Delta{}, Failure(ErrorContentInvalid, "parse stored delta", err)
	}
	value, err := graphcontract.DeltaFromValue(parsed)
	if err != nil {
		return Delta{}, Failure(ErrorContentInvalid, "parse stored delta", err)
	}
	value, err = graphcontract.AssertDeltaIntegrity(value)
	if err != nil {
		return Delta{}, Failure(ErrorContentInvalid, "verify stored delta", err)
	}
	if value.ScenarioInstanceID != scenarioInstanceID ||
		value.FromCursor != fromCursor ||
		value.ToCursor != toCursor {
		return Delta{}, Failure(
			ErrorContentInvalid,
			"stored delta does not match its database identity",
			nil,
		)
	}
	encoded, err := graphcontract.SerializeDelta(value)
	if err != nil {
		return Delta{}, Failure(ErrorContentInvalid, "serialize stored delta", err)
	}
	if !bytes.Equal(encoded, canonicalBytes) {
		return Delta{}, Failure(
			ErrorContentInvalid,
			"stored delta bytes are not the exact canonical serialization",
			nil,
		)
	}
	return value, nil
}

func parseStoredCanonicalJSON(canonicalBytes []byte) (graphjson.Value, error) {
	if len(canonicalBytes) == 0 || len(canonicalBytes) > MaxStoredCanonicalBytes {
		return nil, fmt.Errorf(
			"stored canonical bytes must contain between 1 and %d bytes",
			MaxStoredCanonicalBytes,
		)
	}
	return graphjson.Parse(canonicalBytes, graphjson.Limits{
		MaxDepth:        graphjson.Limit(maxStoredJSONDepth),
		MaxNodes:        graphjson.Limit(maxStoredJSONNodes),
		MaxStringLength: graphjson.Limit(graphcontract.MaxPropertyStringCharacters),
	})
}

func validateIdentifier(value, name string, maximum int) error {
	if value == "" || !utf8.ValidString(value) {
		return Failure(ErrorInvalidInput, name+" is empty, oversized, or invalid UTF-8", nil)
	}
	units := 0
	for _, character := range value {
		if character <= 0x1f || character == 0x7f {
			return Failure(ErrorInvalidInput, name+" contains a control character", nil)
		}
		units += utf16.RuneLen(character)
		if units > maximum {
			return Failure(ErrorInvalidInput, name+" is empty, oversized, or invalid UTF-8", nil)
		}
	}
	return nil
}

func validateByteIdentifier(value, name string, maximum int) error {
	if value == "" || len(value) > maximum || !utf8.ValidString(value) {
		return Failure(ErrorInvalidInput, name+" is empty, oversized, or invalid UTF-8", nil)
	}
	for _, character := range value {
		if character <= 0x1f || character == 0x7f {
			return Failure(ErrorInvalidInput, name+" contains a control character", nil)
		}
	}
	return nil
}

func ComputeRequestFingerprint(method, path string, canonicalRequestBody []byte) (string, error) {
	if method == "" || path == "" || path[0] != '/' {
		return "", Failure(
			ErrorInvalidInput,
			"request fingerprint method and path must be non-empty and canonical",
			nil,
		)
	}
	for _, value := range []string{method, path} {
		for _, character := range value {
			if character <= 0x20 || character == 0x7f {
				return "", Failure(
					ErrorInvalidInput,
					"request fingerprint method and path contain whitespace or controls",
					nil,
				)
			}
		}
	}
	digest := sha256.New()
	_, _ = digest.Write([]byte(method))
	_, _ = digest.Write([]byte{'\n'})
	_, _ = digest.Write([]byte(path))
	_, _ = digest.Write([]byte{'\n'})
	_, _ = digest.Write(canonicalRequestBody)
	return "sha256:" + hex.EncodeToString(digest.Sum(nil)), nil
}

func ComputeSnapshotRequestFingerprint(canonicalRequestBody []byte) string {
	value, err := ComputeRequestFingerprint("POST", SnapshotIngestPath, canonicalRequestBody)
	if err != nil {
		panic(err)
	}
	return value
}

func ComputeDeltaRequestFingerprint(canonicalRequestBody []byte) string {
	value, err := ComputeRequestFingerprint("POST", DeltaIngestPath, canonicalRequestBody)
	if err != nil {
		panic(err)
	}
	return value
}

func computePublishRequestFingerprint(value PreparedPublish) (string, error) {
	var expectedCursor graphjson.Value
	if value.Input.ExpectedCursor != nil {
		expectedCursor = *value.Input.ExpectedCursor
	}
	body := graphjson.Object{
		"expectedCursor": expectedCursor,
	}
	var path string
	if value.Delta == nil {
		path = SnapshotIngestPath
		body["snapshot"] = graphcontract.SnapshotValue(value.Snapshot)
	} else {
		path = DeltaIngestPath
		body["targetSnapshot"] = graphcontract.SnapshotValue(value.Snapshot)
		body["delta"] = graphcontract.DeltaValue(*value.Delta)
	}
	canonicalBody, err := graphjson.Encode(body)
	if err != nil {
		return "", Failure(
			ErrorContentInvalid,
			"encode canonical ingest request fingerprint body",
			err,
		)
	}
	return ComputeRequestFingerprint("POST", path, canonicalBody)
}

func ParseRequestFingerprint(value string) ([sha256.Size]byte, error) {
	var result [sha256.Size]byte
	const prefix = "sha256:"
	if len(value) != len(prefix)+sha256.Size*2 || value[:len(prefix)] != prefix {
		return result, Failure(
			ErrorInvalidInput,
			"request fingerprint must be sha256 followed by 64 lowercase hexadecimal characters",
			nil,
		)
	}
	for _, character := range value[len(prefix):] {
		if (character < '0' || character > '9') && (character < 'a' || character > 'f') {
			return result, Failure(
				ErrorInvalidInput,
				"request fingerprint must use lowercase hexadecimal characters",
				nil,
			)
		}
	}
	decoded, err := hex.DecodeString(value[len(prefix):])
	if err != nil {
		return result, Failure(ErrorInvalidInput, "decode request fingerprint", err)
	}
	copy(result[:], decoded)
	return result, nil
}
