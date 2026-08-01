package graphstore_test

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/app"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphjson"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphstore"
)

func TestDecodeStoredSnapshotAcceptsLegalContractAboveDefaultJSONNodeLimit(t *testing.T) {
	items := make(graphjson.Array, graphcontract.MaxPropertyItems)
	for itemIndex := range items {
		item := make(graphjson.Object, graphcontract.MaxPropertyKeys)
		for keyIndex := 0; keyIndex < graphcontract.MaxPropertyKeys; keyIndex++ {
			item[fmt.Sprintf("k%02d", keyIndex)] = float64(itemIndex*graphcontract.MaxPropertyKeys + keyIndex)
		}
		items[itemIndex] = item
	}
	const scenario = "scenario-large-stored-json"
	const generatedAt = "2026-08-01T02:00:00Z"
	nodes := make([]graphcontract.Node, 20)
	for index := range nodes {
		authority := graphcontract.AuthorityRef{
			Provider: "openslack", ObjectType: "stored-json", ObjectID: fmt.Sprintf("%02d", index),
			Version: "v1", ObservedAt: generatedAt,
		}
		id, err := graphcontract.DeriveNodeID(scenario, "core.work_item", authority)
		if err != nil {
			t.Fatal(err)
		}
		nodes[index] = graphcontract.Node{
			ID: id, Type: "core.work_item", ScenarioDefinitionID: "large-stored-json",
			ScenarioInstanceID: scenario, Title: fmt.Sprintf("Node %02d", index), AuthorityRef: authority,
			Owners: []graphcontract.ActorRef{}, Properties: graphjson.Object{"items": items},
			SourceEventIDs: []string{}, EvidenceRefs: []string{}, ProjectorVersion: "graphstore-test",
			ValidFrom: generatedAt,
		}
	}
	snapshot, err := graphcontract.SealSnapshot(graphcontract.Snapshot{
		Schema: graphcontract.SnapshotSchema, Cursor: "cursor-large-stored-json",
		ScenarioInstanceID: scenario, GeneratedAt: generatedAt, ProjectorVersion: "graphstore-test",
		Nodes: nodes, Edges: []graphcontract.Edge{}, Completeness: graphcontract.Completeness{
			SourcesRequested: []string{"openslack"}, SourcesObserved: []string{"openslack"},
			MissingSources: []string{}, Warnings: []string{},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	raw, err := graphcontract.SerializeSnapshot(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	_, err = graphjson.Parse(raw, graphjson.DefaultLimits())
	var jsonFailure *graphjson.Error
	if !errors.As(err, &jsonFailure) || jsonFailure.Code != graphjson.ErrorLimit {
		t.Fatalf("default strict JSON parse error = %v, want %s", err, graphjson.ErrorLimit)
	}
	body, err := graphjson.Encode(graphjson.Object{
		"expectedCursor": nil,
		"snapshot":       graphcontract.SnapshotValue(snapshot),
	})
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(append(
		[]byte("POST\n"+graphstore.SnapshotIngestPath+"\n"),
		body...,
	))
	prepared, err := graphstore.PreparePublish(graphstore.PublishInput{
		IdempotencyKey:     "large-stored-json",
		RequestFingerprint: "sha256:" + hex.EncodeToString(digest[:]),
		ExpectedRevision:   0,
		Snapshot:           snapshot,
	})
	if err != nil {
		t.Fatalf("prepare legal large stored snapshot: %v", err)
	}
	if prepared.RequestFingerprint != digest {
		t.Fatal("prepared large stored snapshot fingerprint drifted")
	}
	decoded, err := graphstore.DecodeStoredSnapshot(raw, scenario, snapshot.Cursor)
	if err != nil {
		t.Fatalf("decode legal stored snapshot: %v", err)
	}
	if decoded.IntegrityHash != snapshot.IntegrityHash || len(decoded.Nodes) != len(nodes) {
		t.Fatalf("decoded stored snapshot drifted: hash=%s nodes=%d", decoded.IntegrityHash, len(decoded.Nodes))
	}
}

func TestDecodeStoredCanonicalBytesRejectsEmptyAndOversizedRows(t *testing.T) {
	if int64(graphstore.MaxStoredCanonicalBytes) != app.MaxRequestBodyBytes {
		t.Fatalf(
			"durable/HTTP byte bounds drifted: %d != %d",
			graphstore.MaxStoredCanonicalBytes,
			app.MaxRequestBodyBytes,
		)
	}
	for name, raw := range map[string][]byte{
		"empty":     nil,
		"oversized": make([]byte, graphstore.MaxStoredCanonicalBytes+1),
	} {
		t.Run(name, func(t *testing.T) {
			_, err := graphstore.DecodeStoredSnapshot(raw, "scenario", "cursor")
			if !graphstore.IsCode(err, graphstore.ErrorContentInvalid) {
				t.Fatalf("stored byte bound error = %v", err)
			}
		})
	}
}

func TestPreparePublishStrictlyValidatesFrozenExternalFingerprint(t *testing.T) {
	snapshot, err := graphcontract.SealSnapshot(graphcontract.Snapshot{
		Schema:             graphcontract.SnapshotSchema,
		Cursor:             "cursor-target",
		ScenarioInstanceID: "scenario-fingerprint",
		GeneratedAt:        "2026-07-30T01:00:00.000Z",
		ProjectorVersion:   "graphstore-test",
		Nodes:              []graphcontract.Node{},
		Edges:              []graphcontract.Edge{},
		Completeness: graphcontract.Completeness{
			SourcesRequested: []string{},
			SourcesObserved:  []string{},
			MissingSources:   []string{},
			Warnings:         []string{},
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	parentCursor := "cursor-parent"
	body, err := graphjson.Encode(graphjson.Object{
		"expectedCursor": parentCursor,
		"snapshot":       graphcontract.SnapshotValue(snapshot),
	})
	if err != nil {
		t.Fatal(err)
	}
	digest := sha256.Sum256(append(
		[]byte("POST\n"+graphstore.SnapshotIngestPath+"\n"),
		body...,
	))
	fingerprint := "sha256:" + hex.EncodeToString(digest[:])

	input := graphstore.PublishInput{
		IdempotencyKey:     "fingerprint-test",
		RequestFingerprint: fingerprint,
		ExpectedCursor:     &parentCursor,
		ExpectedRevision:   1,
		Snapshot:           snapshot,
	}
	if _, err := graphstore.PreparePublish(input); err != nil {
		t.Fatalf("frozen fingerprint rejected: %v", err)
	}

	input.ExpectedRevision = 99
	if _, err := graphstore.PreparePublish(input); err != nil {
		t.Fatalf("internal revision unexpectedly entered external fingerprint: %v", err)
	}

	input.RequestFingerprint = "sha256:" + strings.Repeat("0", 64)
	if _, err := graphstore.PreparePublish(input); !graphstore.IsCode(
		err,
		graphstore.ErrorInvalidInput,
	) {
		t.Fatalf("non-canonical fingerprint got %v", err)
	}
}

func TestContractIdentifiersUseUTF16UnitsWhileIdempotencyKeysRemainByteBounded(t *testing.T) {
	bmpIdentifier := strings.Repeat("界", graphcontract.MaxIdentifierCharacters)
	if err := graphstore.ValidateScenarioInstanceID(bmpIdentifier); err != nil {
		t.Fatalf("512 UTF-16-unit scenario identifier was rejected: %v", err)
	}
	if err := graphstore.ValidateCursor(bmpIdentifier); err != nil {
		t.Fatalf("512 UTF-16-unit cursor was rejected: %v", err)
	}
	if err := graphstore.ValidateCursor(bmpIdentifier + "a"); !graphstore.IsCode(
		err,
		graphstore.ErrorInvalidInput,
	) {
		t.Fatalf("513 UTF-16-unit cursor got %v", err)
	}

	astralIdentifier := strings.Repeat("😀", graphcontract.MaxIdentifierCharacters/2)
	if err := graphstore.ValidateScenarioInstanceID(astralIdentifier); err != nil {
		t.Fatalf("512 UTF-16-unit astral identifier was rejected: %v", err)
	}
	if err := graphstore.ValidateScenarioInstanceID(astralIdentifier + "a"); !graphstore.IsCode(
		err,
		graphstore.ErrorInvalidInput,
	) {
		t.Fatalf("513 UTF-16-unit astral identifier got %v", err)
	}

	byteBoundedKey := strings.Repeat("é", graphstore.MaxIdempotencyKeyBytes/2)
	if err := graphstore.ValidateIdempotencyKey(byteBoundedKey); err != nil {
		t.Fatalf("512-byte idempotency key was rejected: %v", err)
	}
	if err := graphstore.ValidateIdempotencyKey(byteBoundedKey + "a"); !graphstore.IsCode(
		err,
		graphstore.ErrorInvalidInput,
	) {
		t.Fatalf("513-byte idempotency key got %v", err)
	}
}
