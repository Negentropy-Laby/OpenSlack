package graphstore_test

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphjson"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphstore"
)

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
