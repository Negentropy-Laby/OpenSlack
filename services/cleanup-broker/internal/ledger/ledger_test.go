//go:build linux

package ledger

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

const digest = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"

func openTestLedger(t *testing.T) (*Ledger, string) {
	t.Helper()
	dir := filepath.Join(t.TempDir(), "ledger")
	l, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = l.Close() })
	return l, dir
}

func TestDurableReservationAndReceipt(t *testing.T) {
	l, dir := openTestLedger(t)
	r, err := l.Reserve("permit-1", "op-1", digest, "uid:1001/runtime/run", json.RawMessage(`{"request":"fixture"}`))
	if err != nil || !r.Fresh || r.Record.State != Reserved || r.Record.Sequence != 1 {
		t.Fatalf("reserve: %+v %v", r, err)
	}
	repeat, err := l.Reserve("permit-1", "op-1", digest, "uid:1001/runtime/run", json.RawMessage(`{"request":"fixture"}`))
	if err != nil || repeat.Fresh || repeat.Record.Hash != r.Record.Hash {
		t.Fatalf("repeat: %+v %v", repeat, err)
	}
	receipt := json.RawMessage(`{"attempted":true,"auditStatus":"RECORDED","result":"DELETED"}`)
	finished, err := l.Finish("op-1", Consumed, receipt)
	if err != nil || finished.Sequence != 2 {
		t.Fatalf("finish: %+v %v", finished, err)
	}
	finished.Receipt[0] = 'x'
	if err := l.Close(); err != nil {
		t.Fatal(err)
	}
	l, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	replay, err := l.Reserve("permit-1", "op-1", digest, "uid:1001/runtime/run", json.RawMessage(`{"request":"fixture"}`))
	if err != nil || replay.Fresh || replay.Record.State != Consumed || !bytes.Equal(replay.Record.Receipt, receipt) {
		t.Fatalf("replay: %+v %v", replay, err)
	}
	same, err := l.Finish("op-1", Consumed, receipt)
	if err != nil || same.Sequence != 2 {
		t.Fatalf("duplicate finish: %+v %v", same, err)
	}
}

func TestRecoveredReservationNeverFresh(t *testing.T) {
	l, dir := openTestLedger(t)
	if _, err := l.Reserve("permit", "op", digest, "subject", json.RawMessage(`{"request":"fixture"}`)); err != nil {
		t.Fatal(err)
	}
	if err := l.Close(); err != nil {
		t.Fatal(err)
	}
	l, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	r, err := l.Reserve("permit", "op", digest, "subject", json.RawMessage(`{"request":"fixture"}`))
	if err != nil || r.Fresh || r.Record.State != Reserved {
		t.Fatalf("restart must not authorize execution: %+v %v", r, err)
	}
	if _, err := l.Finish("op", ReconciliationRequired, json.RawMessage(`{"attempted":true,"result":"UNKNOWN"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Reserve("permit", "new-op", digest, "subject", json.RawMessage(`{"request":"fixture"}`)); !errors.Is(err, ErrConflict) {
		t.Fatalf("permit reusable after unknown result: %v", err)
	}
}

func TestConflictAndInvalidInputs(t *testing.T) {
	l, _ := openTestLedger(t)
	if _, err := l.Reserve("permit", "op", digest, "subject", json.RawMessage(`{"request":"fixture"}`)); err != nil {
		t.Fatal(err)
	}
	for _, tc := range []struct{ permit, op, digest, subject string }{
		{"permit", "other-op", digest, "subject"},
		{"other-permit", "op", digest, "subject"},
		{"permit", "op", strings.Repeat("a", 64), "subject"},
		{"permit", "op", digest, "other-subject"},
	} {
		if _, err := l.Reserve(tc.permit, tc.op, tc.digest, tc.subject, json.RawMessage(`{"request":"fixture"}`)); !errors.Is(err, ErrConflict) {
			t.Errorf("expected conflict for %+v: %v", tc, err)
		}
	}
	for _, receipt := range []string{`null`, `[]`, `{`, `{"a":1,"a":2}`, `{"nested":{"a":1,"a":2}}`, strings.Repeat("a", maxReceiptBytes+1)} {
		if _, err := l.Finish("op", Consumed, json.RawMessage(receipt)); !errors.Is(err, ErrInvalid) {
			t.Errorf("invalid receipt accepted: %v", err)
		}
	}
	if _, err := l.Finish("op", Reserved, json.RawMessage(`{}`)); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
	if _, err := l.Reserve("new", "new", "weak", "subject", json.RawMessage(`{"request":"fixture"}`)); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
	if _, err := l.Reserve("../new", "new", digest, "subject", json.RawMessage(`{"request":"fixture"}`)); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
	if _, err := l.Reserve("new", "new", digest, "subject\nsecret", json.RawMessage(`{"request":"fixture"}`)); !errors.Is(err, ErrInvalid) {
		t.Fatal(err)
	}
	if _, err := l.Finish("op", Consumed, json.RawMessage(`{"result":"DELETED"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Finish("op", ReconciliationRequired, json.RawMessage(`{}`)); !errors.Is(err, ErrConflict) {
		t.Fatal(err)
	}
}

func TestExclusiveOSLock(t *testing.T) {
	if os.Getenv("OPENSLACK_LEDGER_LOCK_CHILD") == "1" {
		l, err := Open(os.Getenv("OPENSLACK_LEDGER_TEST_DIRECTORY"))
		if l != nil {
			l.Close()
		}
		if !errors.Is(err, ErrLocked) {
			t.Fatalf("child acquired occupied ledger: %v", err)
		}
		return
	}
	_, dir := openTestLedger(t)
	cmd := exec.Command(os.Args[0], "-test.run=^TestExclusiveOSLock$")
	cmd.Env = append(os.Environ(), "OPENSLACK_LEDGER_LOCK_CHILD=1", "OPENSLACK_LEDGER_TEST_DIRECTORY="+dir)
	if out, err := cmd.CombinedOutput(); err != nil {
		t.Fatalf("OS lock: %v %s", err, out)
	}
}

func TestUnsafeStorageRejected(t *testing.T) {
	for _, mode := range []os.FileMode{0755, 0770} {
		dir := filepath.Join(t.TempDir(), "ledger")
		if err := os.Mkdir(dir, mode); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(dir, mode); err != nil {
			t.Fatal(err)
		}
		if l, err := Open(dir); err == nil {
			l.Close()
			t.Fatalf("accepted directory mode %o", mode)
		}
	}
	t.Run("directory symlink", func(t *testing.T) {
		base := t.TempDir()
		target := filepath.Join(base, "target")
		link := filepath.Join(base, "link")
		if err := os.Mkdir(target, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(target, link); err != nil {
			t.Fatal(err)
		}
		if l, err := Open(link); err == nil {
			l.Close()
			t.Fatal("accepted directory symlink")
		}
	})
	t.Run("ledger symlink", func(t *testing.T) {
		base := t.TempDir()
		dir := filepath.Join(base, "ledger")
		if err := os.Mkdir(dir, 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(base, "target"), nil, 0600); err != nil {
			t.Fatal(err)
		}
		if err := os.Symlink(filepath.Join(base, "target"), filepath.Join(dir, fileName)); err != nil {
			t.Fatal(err)
		}
		if l, err := Open(dir); err == nil {
			l.Close()
			t.Fatal("accepted file symlink")
		}
	})
	t.Run("mount policy", func(t *testing.T) {
		if _, err := Open("/mnt/c/ledger-test-no-create"); !errors.Is(err, ErrUnsafeStorage) {
			t.Fatalf("Windows mount not rejected before creation: %v", err)
		}
	})
}

func TestCorruptionNeverTruncatedOrRepaired(t *testing.T) {
	for _, mutation := range []string{"truncated", "sequence", "hash", "unknown", "duplicate", "transition"} {
		t.Run(mutation, func(t *testing.T) {
			l, dir := openTestLedger(t)
			if _, err := l.Reserve("permit", "op", digest, "subject", json.RawMessage(`{"request":"fixture"}`)); err != nil {
				t.Fatal(err)
			}
			l.Close()
			path := filepath.Join(dir, fileName)
			data, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			switch mutation {
			case "truncated":
				data = data[:len(data)-1]
			case "sequence":
				data = bytes.Replace(data, []byte(`"sequence":1`), []byte(`"sequence":2`), 1)
			case "hash":
				data = bytes.Replace(data, []byte(digest), []byte(strings.Repeat("b", 64)), 1)
			case "unknown":
				data = append([]byte(`{"unknown":true,`), data[1:]...)
			case "duplicate":
				data = append([]byte(`{"sequence":1,`), data[1:]...)
			case "transition":
				var rec Record
				if err := json.Unmarshal(data, &rec); err != nil {
					t.Fatal(err)
				}
				rec.State = Consumed
				rec.Receipt = json.RawMessage(`{}`)
				rec.Hash = recordHash(rec)
				data, _ = json.Marshal(rec)
				data = append(data, '\n')
			}
			if err := os.WriteFile(path, data, 0600); err != nil {
				t.Fatal(err)
			}
			if next, err := Open(dir); !errors.Is(err, ErrCorrupt) {
				if next != nil {
					next.Close()
				}
				t.Fatalf("corruption accepted: %v", err)
			}
			after, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			if !bytes.Equal(data, after) {
				t.Fatal("corrupt ledger auto-repaired")
			}
		})
	}
}

func TestStorageFailurePoisonsWriter(t *testing.T) {
	l, _ := openTestLedger(t)
	if err := l.file.Close(); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Reserve("permit", "op", digest, "subject", json.RawMessage(`{"request":"fixture"}`)); !errors.Is(err, ErrPoisoned) {
		t.Fatalf("missing poison: %v", err)
	}
	if _, err := l.Reserve("other", "other", digest, "subject", json.RawMessage(`{"request":"fixture"}`)); !errors.Is(err, ErrPoisoned) {
		t.Fatalf("poison not sticky: %v", err)
	}
}

func TestExternalReplacementPoisonsWriter(t *testing.T) {
	l, dir := openTestLedger(t)
	if err := os.Rename(filepath.Join(dir, fileName), filepath.Join(dir, "old")); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, fileName), nil, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := l.Reserve("permit", "op", digest, "subject", json.RawMessage(`{"request":"fixture"}`)); !errors.Is(err, ErrPoisoned) {
		t.Fatalf("replacement accepted: %v", err)
	}
}

func TestReceiptEncodingRejectedWithoutAppend(t *testing.T) {
	l, dir := openTestLedger(t)
	if _, err := l.Reserve("permit", "op", digest, "subject", json.RawMessage(`{"request":"fixture"}`)); err != nil {
		t.Fatal(err)
	}
	before, err := os.ReadFile(filepath.Join(dir, fileName))
	if err != nil {
		t.Fatal(err)
	}
	for _, receipt := range [][]byte{
		{'{', '"', 'a', '"', ':', '"', 0xff, '"', '}'},
		[]byte(`{"a":"\ud800"}`), []byte(`{"a":"\udc00"}`), []byte(`{"\ud800":1}`),
	} {
		if _, err := l.Finish("op", Consumed, receipt); !errors.Is(err, ErrInvalid) {
			t.Fatalf("accepted lossy encoding: %v", err)
		}
	}
	after, err := os.ReadFile(filepath.Join(dir, fileName))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(before, after) {
		t.Fatal("invalid receipt appended")
	}
	r, err := l.Finish("op", Consumed, json.RawMessage(`{"a":"\ud83d\ude00"}`))
	if err != nil || string(r.Receipt) != `{"a":"😀"}` {
		t.Fatalf("valid surrogate pair changed: %+v %v", r, err)
	}
}

func TestSyncFailurePoisonsAndRestartDoesNotReexecute(t *testing.T) {
	for _, phase := range []string{"file", "directory"} {
		t.Run(phase, func(t *testing.T) {
			l, dir := openTestLedger(t)
			fail := func() error { return syscall.EIO }
			if phase == "file" {
				l.syncFile = fail
			} else {
				l.syncDir = fail
			}
			if r, err := l.Reserve("permit", "op", digest, "subject", json.RawMessage(`{"request":"fixture"}`)); !errors.Is(err, ErrPoisoned) || r.Fresh {
				t.Fatalf("sync error allowed execution: %+v %v", r, err)
			}
			if _, _, err := l.Lookup("op"); !errors.Is(err, ErrPoisoned) {
				t.Fatalf("poison not sticky: %v", err)
			}
			if err := l.Close(); err != nil {
				t.Fatal(err)
			}
			reopened, err := Open(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			r, err := reopened.Reserve("permit", "op", digest, "subject", json.RawMessage(`{"request":"fixture"}`))
			if err != nil || r.Fresh || r.Record.State != Reserved {
				t.Fatalf("ambiguous durable record authorized replay: %+v %v", r, err)
			}
		})
	}
}

func TestPartialAppendPoisonsAndRestartRefuses(t *testing.T) {
	l, dir := openTestLedger(t)
	l.write = func(b []byte) (int, error) { return l.file.Write(b[:len(b)/2]) }
	if r, err := l.Reserve("permit", "op", digest, "subject", json.RawMessage(`{"request":"fixture"}`)); !errors.Is(err, ErrPoisoned) || r.Fresh {
		t.Fatalf("partial append accepted: %+v %v", r, err)
	}
	if err := l.Close(); err != nil {
		t.Fatal(err)
	}
	if reopened, err := Open(dir); !errors.Is(err, ErrCorrupt) {
		if reopened != nil {
			reopened.Close()
		}
		t.Fatalf("partial append not rejected: %v", err)
	}
}

func TestConcurrentSameRequestHasOneFreshReservation(t *testing.T) {
	l, _ := openTestLedger(t)
	var wg sync.WaitGroup
	var fresh atomic.Int32
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := l.Reserve("permit", "op", digest, "subject", json.RawMessage(`{"request":"fixture"}`))
			if err != nil {
				t.Error(err)
				return
			}
			if r.Fresh {
				fresh.Add(1)
			}
		}()
	}
	wg.Wait()
	if fresh.Load() != 1 {
		t.Fatalf("fresh reservations: %d", fresh.Load())
	}
}

func TestExistingFilePermissionsAndHardlinksRejected(t *testing.T) {
	for _, mode := range []os.FileMode{0644, 0400, 0700} {
		l, dir := openTestLedger(t)
		if err := l.Close(); err != nil {
			t.Fatal(err)
		}
		if err := os.Chmod(filepath.Join(dir, fileName), mode); err != nil {
			t.Fatal(err)
		}
		if reopened, err := Open(dir); !errors.Is(err, ErrUnsafeStorage) {
			if reopened != nil {
				reopened.Close()
			}
			t.Fatalf("accepted mode %o: %v", mode, err)
		}
	}
	l, dir := openTestLedger(t)
	if err := l.Close(); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(filepath.Join(dir, fileName), filepath.Join(dir, "link")); err != nil {
		t.Fatal(err)
	}
	if reopened, err := Open(dir); !errors.Is(err, ErrUnsafeStorage) {
		if reopened != nil {
			reopened.Close()
		}
		t.Fatalf("accepted hardlinked file: %v", err)
	}
}

func TestFilesystemAllowlist(t *testing.T) {
	for _, fs := range []int64{0x6969, 0xff534d42, 0x01021997, 0x65735546, 0x01021994, 0} {
		if localFilesystem(fs) {
			t.Fatalf("unsafe filesystem accepted: %x", fs)
		}
	}
}

func TestKilledWriterReservationIsNeverFresh(t *testing.T) {
	if os.Getenv("OPENSLACK_LEDGER_CRASH_CHILD") == "1" {
		l, err := Open(os.Getenv("OPENSLACK_LEDGER_TEST_DIRECTORY"))
		if err != nil {
			t.Fatal(err)
		}
		if r, err := l.Reserve("permit", "op", digest, "subject", json.RawMessage(`{"request":"fixture"}`)); err != nil || !r.Fresh {
			t.Fatalf("reserve before kill: %+v %v", r, err)
		}
		if os.Getenv("OPENSLACK_LEDGER_MARK_SEND") == "1" {
			if r, err := l.MarkSendAdmitted("op", digest, json.RawMessage(`{"commit":"fixture"}`)); err != nil || !r.Fresh {
				t.Fatalf("mark send: %+v %v", r, err)
			}
		}
		fmt.Fprintln(os.Stdout, "reservation-durable")
		for {
			time.Sleep(time.Hour)
		}
	}
	dir := filepath.Join(t.TempDir(), "ledger")
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestKilledWriterReservationIsNeverFresh$")
	cmd.Env = append(os.Environ(), "OPENSLACK_LEDGER_CRASH_CHILD=1", "OPENSLACK_LEDGER_TEST_DIRECTORY="+dir)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	if err := cmd.Start(); err != nil {
		t.Fatal(err)
	}
	defer func() { _ = cmd.Process.Kill() }()
	line, err := bufio.NewReader(stdout).ReadString('\n')
	if err != nil || line != "reservation-durable\n" {
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		t.Fatalf("child did not reserve: %q %v %s", line, err, stderr.String())
	}
	if err := cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	if err := cmd.Wait(); err == nil {
		t.Fatal("child was not killed")
	}
	l, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	r, err := l.Reserve("permit", "op", digest, "subject", json.RawMessage(`{"request":"fixture"}`))
	if err != nil || r.Fresh || r.Record.State != Reserved {
		t.Fatalf("crash renewed permission: %+v %v", r, err)
	}
	if r.Record.SendAdmitted != (os.Getenv("OPENSLACK_LEDGER_MARK_SEND") == "1") {
		t.Fatalf("crash lost send admission: %+v", r.Record)
	}
	if marked, err := l.MarkSendAdmitted("op", digest, json.RawMessage(`{"commit":"fixture"}`)); err != nil || marked.Fresh {
		t.Fatalf("crash renewed send: %+v %v", marked, err)
	}
}

func TestKilledSendAdmissionIsNeverFresh(t *testing.T) {
	t.Setenv("OPENSLACK_LEDGER_MARK_SEND", "1")
	TestKilledWriterReservationIsNeverFresh(t)
}

func TestIntentAndSendAdmissionDurability(t *testing.T) {
	l, dir := openTestLedger(t)
	intent := json.RawMessage(`{"target":{"sha":"abc"},"request":{"op":"one"}}`)
	r, err := l.Reserve("permit", "op", digest, "subject", intent)
	if err != nil || !r.Fresh || r.Record.SendAdmitted {
		t.Fatalf("reserve: %+v %v", r, err)
	}
	intent[0] = '!'
	r.Record.Intent[0] = '!'
	before, _, err := l.Lookup("op")
	if err != nil || before.Intent[0] != '{' {
		t.Fatalf("intent alias: %+v %v", before, err)
	}
	if _, err := l.Reserve("permit", "op", digest, "subject", json.RawMessage(`{"other":true}`)); !errors.Is(err, ErrConflict) {
		t.Fatalf("changed intent: %v", err)
	}
	if replay, err := l.Reserve("permit", "op", digest, "subject", json.RawMessage(`{ "request":{"op":"one"}, "target":{"sha":"abc"} }`)); err != nil || replay.Fresh {
		t.Fatalf("canonical replay: %+v %v", replay, err)
	}
	marked, err := l.MarkSendAdmitted("op", digest, json.RawMessage(`{"commit":"fixture"}`))
	if err != nil || !marked.Fresh || !marked.Record.SendAdmitted || marked.Record.Sequence != 2 {
		t.Fatalf("mark: %+v %v", marked, err)
	}
	if repeat, err := l.MarkSendAdmitted("op", digest, json.RawMessage(`{"commit":"fixture"}`)); err != nil || repeat.Fresh || repeat.Record.Sequence != 2 {
		t.Fatalf("repeat: %+v %v", repeat, err)
	}
	if _, err := l.MarkSendAdmitted("op", strings.Repeat("a", 64), json.RawMessage(`{"commit":"fixture"}`)); !errors.Is(err, ErrConflict) {
		t.Fatalf("digest drift: %v", err)
	}
	if err := l.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	if repeat, err := reopened.MarkSendAdmitted("op", digest, json.RawMessage(`{"commit":"fixture"}`)); err != nil || repeat.Fresh || !repeat.Record.SendAdmitted {
		t.Fatalf("reopen: %+v %v", repeat, err)
	}
	if _, err := reopened.Finish("op", Consumed, json.RawMessage(`{"result":"DELETED"}`)); err != nil {
		t.Fatal(err)
	}
	if _, err := reopened.MarkSendAdmitted("op", digest, json.RawMessage(`{"commit":"fixture"}`)); !errors.Is(err, ErrConflict) {
		t.Fatalf("terminal mark: %v", err)
	}
}

func TestIntentStrictJSON(t *testing.T) {
	l, _ := openTestLedger(t)
	for _, intent := range []string{`null`, `[]`, `{"a":1,"a":2}`, `{"a":{"b":1,"b":2}}`, `{"s":"\ud800"}`, strings.Repeat(" ", maxReceiptBytes+1)} {
		if _, err := l.Reserve("permit", "op", digest, "subject", json.RawMessage(intent)); !errors.Is(err, ErrInvalid) {
			t.Fatalf("accepted %q: %v", intent, err)
		}
	}
}

func TestConcurrentSendAdmissionHasOneFreshResult(t *testing.T) {
	l, _ := openTestLedger(t)
	if _, err := l.Reserve("permit", "op", digest, "subject", json.RawMessage(`{"request":"fixture"}`)); err != nil {
		t.Fatal(err)
	}
	var wg sync.WaitGroup
	var fresh atomic.Int32
	for i := 0; i < 32; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			r, err := l.MarkSendAdmitted("op", digest, json.RawMessage(`{"commit":"fixture"}`))
			if err != nil {
				t.Error(err)
				return
			}
			if r.Fresh {
				fresh.Add(1)
			}
		}()
	}
	wg.Wait()
	if fresh.Load() != 1 {
		t.Fatalf("fresh admissions: %d", fresh.Load())
	}
}

func TestSendAdmissionReplayRejectsRehashedInvalidTransitions(t *testing.T) {
	for _, mutation := range []string{"initial-admission", "double-admission", "changed-intent", "terminal-regression"} {
		t.Run(mutation, func(t *testing.T) {
			l, dir := openTestLedger(t)
			r, err := l.Reserve("permit", "op", digest, "subject", json.RawMessage(`{"request":"fixture"}`))
			if err != nil {
				t.Fatal(err)
			}
			first := r.Record
			second := first
			second.Sequence = 2
			second.PreviousHash = first.Hash
			second.SendAdmitted = true
			second.SendObservation = json.RawMessage(`{"commit":"fixture"}`)
			records := []Record{first, second}
			switch mutation {
			case "initial-admission":
				records = []Record{second}
				records[0].Sequence = 1
				records[0].PreviousHash = zeroHash
			case "double-admission":
				third := second
				third.Sequence = 3
				records = append(records, third)
			case "changed-intent":
				records[1].Intent = json.RawMessage(`{"request":"different"}`)
			case "terminal-regression":
				records[1].State = Consumed
				records[1].SendAdmitted = false
				records[1].SendObservation = nil
				records[1].Receipt = json.RawMessage(`{}`)
				third := second
				third.Sequence = 3
				records = append(records, third)
			}
			var data []byte
			for i := range records {
				if i > 0 {
					records[i].PreviousHash = records[i-1].Hash
				}
				records[i].Hash = recordHash(records[i])
				line, err := json.Marshal(records[i])
				if err != nil {
					t.Fatal(err)
				}
				data = append(data, line...)
				data = append(data, '\n')
			}
			_ = l.Close()
			if err := os.WriteFile(filepath.Join(dir, fileName), data, 0600); err != nil {
				t.Fatal(err)
			}
			if reopened, err := Open(dir); !errors.Is(err, ErrCorrupt) {
				if reopened != nil {
					reopened.Close()
				}
				t.Fatalf("invalid transition accepted: %v", err)
			}
		})
	}
}

func TestSendAdmissionSyncFailureNeverAuthorizes(t *testing.T) {
	for _, failure := range []string{"file", "directory"} {
		t.Run(failure, func(t *testing.T) {
			l, dir := openTestLedger(t)
			intent := json.RawMessage(`{"request":"fixture"}`)
			if _, err := l.Reserve("permit", "op", digest, "subject", intent); err != nil {
				t.Fatal(err)
			}
			fail := func() error { return errors.New("injected fsync failure") }
			if failure == "file" {
				l.syncFile = fail
			} else {
				l.syncDir = fail
			}
			if r, err := l.MarkSendAdmitted("op", digest, json.RawMessage(`{"commit":"fixture"}`)); !errors.Is(err, ErrPoisoned) || r.Fresh {
				t.Fatalf("sync failure authorized: %+v %v", r, err)
			}
			_ = l.Close()
			reopened, err := Open(dir)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.Close()
			if r, err := reopened.MarkSendAdmitted("op", digest, json.RawMessage(`{"commit":"fixture"}`)); err != nil || r.Fresh {
				t.Fatalf("replayed failure authorized: %+v %v", r, err)
			}
		})
	}
}

func TestV1LedgerRejectedWithoutRepair(t *testing.T) {
	l, dir := openTestLedger(t)
	if _, err := l.Reserve("permit", "op", digest, "subject", json.RawMessage(`{"request":"fixture"}`)); err != nil {
		t.Fatal(err)
	}
	_ = l.Close()
	path := filepath.Join(dir, fileName)
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	data = bytes.Replace(data, []byte(schema), []byte("openslack.cleanup-ledger.v1"), 1)
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	if reopened, err := Open(dir); !errors.Is(err, ErrCorrupt) {
		if reopened != nil {
			reopened.Close()
		}
		t.Fatalf("v1 accepted: %v", err)
	}
	after, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(data, after) {
		t.Fatalf("v1 modified: %v", err)
	}
}

func TestSendObservationOwnedImmutableAndStrict(t *testing.T) {
	l, dir := openTestLedger(t)
	if _, err := l.Reserve("permit", "op", digest, "subject", json.RawMessage(`{"intent":true}`)); err != nil {
		t.Fatal(err)
	}
	for _, raw := range []string{`null`, `[]`, `{"a":1,"a":2}`, `{"s":"\ud800"}`} {
		if _, err := l.MarkSendAdmitted("op", digest, json.RawMessage(raw)); !errors.Is(err, ErrInvalid) {
			t.Fatalf("invalid observation accepted: %v", err)
		}
	}
	observation := json.RawMessage(`{"commit":"final","hashes":{"registry":"abc"}}`)
	r, err := l.MarkSendAdmitted("op", digest, observation)
	if err != nil || !r.Fresh {
		t.Fatalf("%+v %v", r, err)
	}
	observation[0] = '!'
	r.Record.SendObservation[0] = '!'
	record, _, err := l.Lookup("op")
	if err != nil || record.SendObservation[0] != '{' {
		t.Fatal("observation aliased")
	}
	if _, err := l.MarkSendAdmitted("op", digest, json.RawMessage(`{"commit":"changed"}`)); !errors.Is(err, ErrConflict) {
		t.Fatal("observation rewritten")
	}
	finished, err := l.Finish("op", Consumed, json.RawMessage(`{"state":"DELETED"}`))
	if err != nil || !bytes.Equal(record.SendObservation, finished.SendObservation) {
		t.Fatal("finish changed observation")
	}
	_ = l.Close()
	reopened, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.Close()
	replayed, _, err := reopened.Lookup("op")
	if err != nil || !bytes.Equal(record.SendObservation, replayed.SendObservation) {
		t.Fatal("replay changed observation")
	}
}
