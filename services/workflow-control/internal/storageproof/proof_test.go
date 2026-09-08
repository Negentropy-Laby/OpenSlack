package storageproof

import (
	"fmt"
	"testing"
)

func TestSameWriterRequiresDatabaseLockAndRelationIdentity(t *testing.T) {
	local := Answer{Schema: Schema, Challenge: Challenge{Key: 1, PID: 2}, DatabaseOID: 3,
		Relations: map[string]uint32{}, SchemaVersion: 10, Writable: true, FenceEnabled: true, LockObserved: true}
	for i := 0; i < 12; i++ {
		local.Relations[fmt.Sprint(i)] = uint32(i + 10)
	}
	if !SameWriter(local, local) {
		t.Fatal("same writer rejected")
	}
	upgraded := local
	upgraded.SchemaVersion = 11
	if !SameWriter(upgraded, upgraded) || SameWriter(local, upgraded) {
		t.Fatal("upgraded writer capability differs")
	}
	for _, version := range []int64{9, 12} {
		unsupported := local
		unsupported.SchemaVersion = version
		if SameWriter(unsupported, unsupported) {
			t.Fatal("unsupported schema accepted", version)
		}
	}
	for _, tc := range []struct {
		name   string
		change func(*Answer)
	}{
		{"database", func(a *Answer) { a.DatabaseOID++ }},
		{"cloned relations", func(a *Answer) { a.Relations["0"]++ }},
		{"missing relation", func(a *Answer) { delete(a.Relations, "0") }},
		{"other schema", func(a *Answer) { a.SchemaVersion-- }},
		{"read only", func(a *Answer) { a.Writable = false }},
		{"missing fence", func(a *Answer) { a.FenceEnabled = false }},
		{"unobserved lock", func(a *Answer) { a.LockObserved = false }},
		{"other backend", func(a *Answer) { a.Challenge.PID++ }},
		{"other challenge", func(a *Answer) { a.Challenge.Key++ }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			source := local
			source.Relations = map[string]uint32{}
			for name, oid := range local.Relations {
				source.Relations[name] = oid
			}
			tc.change(&source)
			if SameWriter(local, source) {
				t.Fatal("different writer accepted")
			}
		})
	}
}
