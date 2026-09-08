package runnerstore

import (
	"bytes"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"strings"
	"testing"
)

func TestCanonicalPageExactEnvelopeAndTerminalBoundary(t *testing.T) {
	record := canonicaljson.Object{"text": "引用 \"line\\next\n"}
	envelope := canonicaljson.Object{"schema": "test", "complete": true, "records": []any{record}, "nextCursor": nil}
	want, err := canonicaljson.Encode(envelope)
	if err != nil {
		t.Fatal(err)
	}
	want = append(want, '\n')
	page, err := NewCanonicalArrayPage(canonicaljson.Object{"schema": "test", "complete": true}, "records", len(want))
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := page.Add(record, strings.Repeat("cursor", 10)); err != nil || !ok {
		t.Fatal(ok, err)
	}
	raw, next, err := page.Finish(false)
	if err != nil || next != nil || !bytes.Equal(raw, want) {
		t.Fatalf("terminal boundary: %s %v", raw, err)
	}
	page, _ = NewCanonicalArrayPage(canonicaljson.Object{"schema": "test", "complete": true}, "records", len(want)-1)
	if _, err := page.Add(record, "cursor"); !IsCode(err, ErrorLimitExceeded) {
		t.Fatal("oversize accepted", err)
	}
}

func TestCanonicalPageContinuationBytesAndTail(t *testing.T) {
	for _, limit := range []int{128, 256, 1024} {
		page, err := NewCanonicalArrayPage(canonicaljson.Object{"schema": "test", "complete": true}, "records", limit)
		if err != nil {
			t.Fatal(err)
		}
		items := []any{}
		for i := 0; i < 1000; i++ {
			item := strings.Repeat("x", 13)
			fits, err := page.Add(item, strings.Repeat("cursor", 4))
			if err != nil {
				t.Fatal(err)
			}
			if !fits {
				break
			}
			items = append(items, item)
		}
		raw, next, err := page.Finish(true)
		if err != nil || next == nil || len(raw) > limit {
			t.Fatal(len(raw), err)
		}
		want, _ := canonicaljson.Encode(canonicaljson.Object{"schema": "test", "complete": false, "records": items[:page.Count()], "nextCursor": *next})
		if !bytes.Equal(raw, append(want, '\n')) {
			t.Fatal("page differs from exact canonical envelope")
		}
	}
}

func TestCanonicalPageRetainsTwoMiBLimit(t *testing.T) {
	page, _ := NewCanonicalArrayPage(canonicaljson.Object{"schema": "test"}, "records", RecoveryEvidenceMaxResponseBytes)
	if _, err := page.Add(strings.Repeat("x", RecoveryEvidenceMaxResponseBytes), "oversize"); !IsCode(err, ErrorLimitExceeded) {
		t.Fatal(err)
	}
}
