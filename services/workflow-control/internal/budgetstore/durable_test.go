package budgetstore

import (
	"bytes"
	"testing"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
)

func TestDurableRecordExactAuthorityAndProjectionBinding(t *testing.T) {
	records := goldenBudgetRecords(t)
	decision := decodeGoldenRecord(t, records["reserveReserved"].Value)
	outer, err := NewDurableRecord(RecordKindReserveDecision, decision, testResponseBuild)
	if err != nil {
		t.Fatal(err)
	}
	exact, err := EncodeDurableRecord(outer)
	if err != nil {
		t.Fatal(err)
	}
	replayed, err := DecodeDurableRecord(exact)
	if err != nil {
		t.Fatal(err)
	}
	reencoded, err := EncodeDurableRecord(replayed)
	if err != nil || !bytes.Equal(exact, reencoded) || replayed.Authority != Authority || replayed.Writer != DurableWriter ||
		replayed.AuthorityMode != DurableAuthorityMode || replayed.ProductionAuthority || replayed.ContractManifestSHA256 != ContractManifestSHA256 {
		t.Fatalf("durable record replay/binding drifted: %#v err=%v", replayed, err)
	}

	for name, mutate := range map[string]func(*DurableRecord){
		"kind":     func(value *DurableRecord) { value.RecordKind = RecordKindSettlement },
		"build":    func(value *DurableRecord) { value.AuthorityBuildHash = "7" + value.AuthorityBuildHash[1:] },
		"manifest": func(value *DurableRecord) { value.ContractManifestSHA256 = "7" + value.ContractManifestSHA256[1:] },
		"writer":   func(value *DurableRecord) { value.Writer = "@openslack/workflows" },
		"hash": func(value *DurableRecord) {
			value.OperationalProjectionHash = "7" + value.OperationalProjectionHash[1:]
		},
	} {
		t.Run(name, func(t *testing.T) {
			drifted := outer
			mutate(&drifted)
			if _, err := ValidateDurableRecord(drifted); !IsCode(err, ErrorContentInvalid) {
				t.Fatalf("drifted durable record err=%v", err)
			}
		})
	}

	tampered := append([]byte(nil), exact...)
	tampered[len(tampered)-2] ^= 1
	if _, err := DecodeDurableRecord(tampered); !IsCode(err, ErrorIntegrity) {
		t.Fatalf("tampered durable record err=%v", err)
	}
}

func TestPreviousManifestDurableRecordsPreserveExactBytes(t *testing.T) {
	golden := goldenBudgetRecords(t)
	for kind, name := range map[string]string{
		RecordKindAccount: "account", RecordKindReserveDecision: "reserveReserved",
		RecordKindReservation: "reservation", RecordKindSettlement: "settlementSettled",
		RecordKindLedgerEntry: "reserveLedger", RecordKindReceipt: "reserveReceipt",
		RecordKindReconciliation: "providerReconciliation",
	} {
		t.Run(kind, func(t *testing.T) {
			current, err := NewDurableRecord(kind, decodeGoldenRecord(t, golden[name].Value), testResponseBuild)
			if err != nil {
				t.Fatal(err)
			}
			if current.ContractManifestSHA256 != ContractManifestSHA256 {
				t.Fatal("new write used a historical manifest")
			}
			exact, err := EncodeDurableRecord(current)
			if err != nil {
				t.Fatal(err)
			}
			previousExact := bytes.ReplaceAll(exact, []byte(ContractManifestSHA256), []byte(budgetcontract.PreviousManifestSHA256))
			previous, err := DecodeDurableRecord(previousExact)
			if err != nil {
				t.Fatal(err)
			}
			replay, err := EncodeDurableRecord(previous)
			if err != nil || !bytes.Equal(replay, previousExact) || previous.OperationalProjectionHash != current.OperationalProjectionHash {
				t.Fatalf("historical durable bytes or hash drifted: %v", err)
			}
			unknown := bytes.ReplaceAll(previousExact, []byte(budgetcontract.PreviousManifestSHA256), bytes.Repeat([]byte("0"), 64))
			if _, err := DecodeDurableRecord(unknown); !IsCode(err, ErrorIntegrity) {
				t.Fatalf("unknown manifest accepted: %v", err)
			}
		})
	}
}
