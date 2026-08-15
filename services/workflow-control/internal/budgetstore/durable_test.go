package budgetstore

import (
	"bytes"
	"testing"
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
