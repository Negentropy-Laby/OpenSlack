package budgetstore

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
)

func TestMutationResponseExactEnvelopeAndCrossSpliceRejection(t *testing.T) {
	records := goldenBudgetRecords(t)
	decision := decodeGoldenRecord(t, records["reserveReserved"].Value)
	receipt := decodeGoldenRecord(t, records["reserveReceipt"].Value)
	decisionOuter, err := NewDurableRecord(RecordKindReserveDecision, decision, testResponseBuild)
	if err != nil {
		t.Fatal(err)
	}
	receiptOuter, err := NewDurableRecord(RecordKindReceipt, receipt, testResponseBuild)
	if err != nil {
		t.Fatal(err)
	}

	exact, err := EncodeMutationResponse("reserve", &decisionOuter, receiptOuter, nil)
	if err != nil {
		t.Fatalf("encode response: %v", err)
	}
	decoded, err := DecodeMutationResponse(exact)
	if err != nil {
		t.Fatalf("decode response: %v exact=%s", err, exact)
	}
	reencoded, err := EncodeMutationResponse(decoded.Operation, decoded.Record, decoded.Receipt, decoded.Reconciliation)
	if err != nil || !bytes.Equal(exact, reencoded) {
		t.Fatalf("exact response replay drifted: err=%v", err)
	}

	crossSpliced := decodeGoldenRecord(t, records["rejectedReserveReceipt"].Value)
	crossSplicedOuter, err := NewDurableRecord(RecordKindReceipt, crossSpliced, testResponseBuild)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := EncodeMutationResponse("reserve", &decisionOuter, crossSplicedOuter, nil); !IsCode(err, ErrorContentInvalid) {
		t.Fatalf("cross-spliced response err=%v, want %s", err, ErrorContentInvalid)
	}

	tampered := append([]byte(nil), exact...)
	tampered[len(tampered)-2] ^= 1
	if _, err := DecodeMutationResponse(tampered); !IsCode(err, ErrorIntegrity) {
		t.Fatalf("tampered exact response err=%v, want %s", err, ErrorIntegrity)
	}
	// The prior manifest changed only source pins. Retain its immutable response bytes on replay.
	previousExact := bytes.ReplaceAll(exact, []byte(ContractManifestSHA256), []byte(budgetcontract.PreviousManifestSHA256))
	previous, err := DecodeMutationResponse(previousExact)
	if err != nil {
		t.Fatal(err)
	}
	previousReplay, err := EncodeMutationResponse(previous.Operation, previous.Record, previous.Receipt, previous.Reconciliation)
	if err != nil || !bytes.Equal(previousExact, previousReplay) {
		t.Fatalf("previous response was rewritten: %v", err)
	}
}

const testResponseBuild = "8888888888888888888888888888888888888888888888888888888888888888"

type goldenRecord struct {
	Value json.RawMessage `json:"value"`
}

func goldenBudgetRecords(t *testing.T) map[string]goldenRecord {
	t.Helper()
	path := filepath.Join("..", "..", "budgetcontract", "generated", "v1", "golden-vectors.json")
	contents, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	var bundle struct {
		Vectors struct {
			Records map[string]goldenRecord `json:"records"`
		} `json:"vectors"`
	}
	if err := json.Unmarshal(contents, &bundle); err != nil {
		t.Fatal(err)
	}
	return bundle.Vectors.Records
}

func decodeGoldenRecord(t *testing.T, raw json.RawMessage) budgetcontract.Record {
	t.Helper()
	value, err := budgetcontract.ParseBytes(raw)
	if err != nil {
		t.Fatal(err)
	}
	record, err := budgetcontract.ValidateRecord(value)
	if err != nil {
		t.Fatal(err)
	}
	return record
}
