//go:build linux

package ledger

import (
	"bytes"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func workerFixture() WorkerEvidence {
	return WorkerEvidence{WorkerID: "worker", Mode: "execute", PermitID: "permit", OperationID: "operation", RequestDigest: strings.Repeat("a", 64), SubjectDigest: strings.Repeat("b", 64), BrokerID: "broker", Generation: "1", BrokerBootNonce: strings.Repeat("c", 64), PID: 1234, PGID: 1234, KernelBootID: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", StartTicks: 123}
}
func TestWorkerJournalRoundtripAndConflicts(t *testing.T) {
	dir := t.TempDir()
	os.Chmod(dir, 0700)
	l, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	w := workerFixture()
	if err = l.RegisterWorker(w); err != nil {
		t.Fatal(err)
	}
	if err = l.RegisterWorker(w); err != nil {
		t.Fatal(err)
	}
	changed := w
	changed.RequestDigest = strings.Repeat("d", 64)
	if err = l.RegisterWorker(changed); err == nil {
		t.Fatal("changed binding accepted")
	}
	l.Close()
	l, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	pending, err := l.UnfinishedWorkers()
	if err != nil || len(pending) != 1 || pending[0] != w {
		t.Fatalf("pending %v %v", pending, err)
	}
	if err = l.FinishWorker(w.WorkerID); err != nil {
		t.Fatal(err)
	}
	if err = l.FinishWorker(w.WorkerID); err != nil {
		t.Fatal(err)
	}
	if l.RegisterWorker(w) == nil {
		t.Fatal("finished worker reused")
	}
	l.Close()
	l, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	pending, err = l.UnfinishedWorkers()
	if err != nil || len(pending) != 0 {
		t.Fatal("terminal evidence not replayed")
	}
}
func TestWorkerJournalMissingTruncatedCorruptAndAliasRejected(t *testing.T) {
	for _, kind := range []string{"missing", "truncated", "corrupt", "symlink", "hardlink"} {
		t.Run(kind, func(t *testing.T) {
			dir := t.TempDir()
			os.Chmod(dir, 0700)
			l, err := Open(dir)
			if err != nil {
				t.Fatal(err)
			}
			if err = l.RegisterWorker(workerFixture()); err != nil {
				t.Fatal(err)
			}
			l.Close()
			path := filepath.Join(dir, workerFileName)
			raw, err := os.ReadFile(path)
			if err != nil {
				t.Fatal(err)
			}
			switch kind {
			case "missing":
				os.Remove(path)
			case "truncated":
				os.WriteFile(path, raw[:len(raw)-1], 0600)
			case "corrupt":
				raw[20] ^= 1
				os.WriteFile(path, raw, 0600)
			case "symlink":
				os.Rename(path, path+".saved")
				os.Symlink(path+".saved", path)
			case "hardlink":
				os.Link(path, path+".alias")
			}
			reopened, err := Open(dir)
			if err == nil {
				reopened.Close()
				t.Fatal("unsafe journal accepted")
			}
		})
	}
}
func TestWorkerJournalPoisonAfterExternalMutation(t *testing.T) {
	dir := t.TempDir()
	os.Chmod(dir, 0700)
	l, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	if err = l.RegisterWorker(workerFixture()); err != nil {
		t.Fatal(err)
	}
	f, err := os.OpenFile(filepath.Join(dir, workerFileName), os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	f.WriteString("\n")
	f.Close()
	if _, err = l.UnfinishedWorkers(); err == nil {
		t.Fatal("changed journal accepted")
	}
	if err = l.FinishWorker("worker"); !errors.Is(err, ErrPoisoned) {
		t.Fatalf("writer not poisoned %v", err)
	}
}

func TestMissingJournalPreservesHistoryAndCoherentBackupRestoresSpending(t *testing.T) {
	dir := t.TempDir()
	os.Chmod(dir, 0700)
	l, err := Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	intent := json.RawMessage(`{"request":"fixture"}`)
	if _, err = l.Reserve("permit", "operation", strings.Repeat("a", 64), "subject", intent); err != nil {
		t.Fatal(err)
	}
	if err = l.RegisterWorker(workerFixture()); err != nil {
		t.Fatal(err)
	}
	if err = l.FinishWorker("worker"); err != nil {
		t.Fatal(err)
	}
	if _, err = l.Finish("operation", Consumed, json.RawMessage(`{"result":"DELETED","attempted":true}`)); err != nil {
		t.Fatal(err)
	}
	if err = l.Close(); err != nil {
		t.Fatal(err)
	}
	historyPath := filepath.Join(dir, fileName)
	journalPath := filepath.Join(dir, workerFileName)
	history, err := os.ReadFile(historyPath)
	if err != nil {
		t.Fatal(err)
	}
	journal, err := os.ReadFile(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(journalPath); err != nil {
		t.Fatal(err)
	}
	if _, err = Open(dir); !errors.Is(err, ErrWorkerEvidenceMissing) {
		t.Fatalf("missing diagnostic: %v", err)
	}
	preserved, err := os.ReadFile(historyPath)
	if err != nil || !bytes.Equal(preserved, history) {
		t.Fatal("failed startup altered consumption history")
	}
	if _, err = os.Lstat(journalPath); !os.IsNotExist(err) {
		t.Fatal("missing journal was recreated")
	}
	if err = os.WriteFile(journalPath, journal, 0600); err != nil {
		t.Fatal(err)
	}
	l, err = Open(dir)
	if err != nil {
		t.Fatal(err)
	}
	defer l.Close()
	replay, err := l.Reserve("permit", "operation", strings.Repeat("a", 64), "subject", intent)
	if err != nil || replay.Fresh || replay.Record.State != Consumed {
		t.Fatalf("restored history authorized reuse: %v %v", replay, err)
	}
	if _, err = l.Reserve("permit", "other", strings.Repeat("a", 64), "subject", intent); !errors.Is(err, ErrConflict) {
		t.Fatal("spent permit could be reserved again")
	}
	pending, err := l.UnfinishedWorkers()
	if err != nil || len(pending) != 0 {
		t.Fatal("restored terminal worker changed")
	}
}
