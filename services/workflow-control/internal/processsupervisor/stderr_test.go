package processsupervisor

import (
	"bytes"
	"testing"
)

func TestBoundedStderrKeepsOnlyTheNewestBoundedBytes(t *testing.T) {
	buffer := newBoundedStderr(8)
	for _, value := range [][]byte{[]byte("abc"), []byte("defgh"), []byte("ijk")} {
		if written, err := buffer.Write(value); err != nil || written != len(value) {
			t.Fatalf("write=%d err=%v", written, err)
		}
	}
	snapshot := buffer.Snapshot()
	if !bytes.Equal(snapshot.Bytes, []byte("defghijk")) || !snapshot.Truncated || snapshot.Total != 11 {
		t.Fatalf("unexpected stderr snapshot: %+v %q", snapshot, snapshot.Bytes)
	}
	snapshot.Bytes[0] = 'X'
	if bytes.Equal(buffer.Snapshot().Bytes, snapshot.Bytes) {
		t.Fatal("stderr snapshot aliases the internal buffer")
	}
}

func TestZeroLengthStderrStillAccountsWithoutRetainingBytes(t *testing.T) {
	buffer := newBoundedStderr(0)
	if _, err := buffer.Write([]byte("secret diagnostic")); err != nil {
		t.Fatal(err)
	}
	snapshot := buffer.Snapshot()
	if len(snapshot.Bytes) != 0 || !snapshot.Truncated || snapshot.Total != 17 {
		t.Fatalf("unexpected zero-length stderr snapshot: %+v", snapshot)
	}
}
