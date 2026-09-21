//go:build linux

package ledger

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"regexp"
	"sort"
	"syscall"
)

const workerFileName = "workers.jsonl"
const workerSchema = "openslack.cleanup_worker_ledger.v1"

var kernelBootID = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
var workerGeneration = regexp.MustCompile(`^[1-9][0-9]{0,39}$`)

// WorkerEvidence binds a process group before the worker may receive its start
// signal. KernelBootID differs from the permit's broker boot nonce. A caller
// must prove the entire group absent, not merely the leader, before FinishWorker.
type WorkerEvidence struct {
	WorkerID        string `json:"workerId"`
	Mode            string `json:"mode"`
	PermitID        string `json:"permitId"`
	OperationID     string `json:"operationId"`
	RequestDigest   string `json:"requestDigest"`
	SubjectDigest   string `json:"subjectDigest"`
	BrokerID        string `json:"brokerId"`
	Generation      string `json:"generation"`
	BrokerBootNonce string `json:"brokerBootNonce"`
	PID             int    `json:"pid"`
	PGID            int    `json:"pgid"`
	KernelBootID    string `json:"kernelBootId"`
	StartTicks      uint64 `json:"startTicks"`
}

type workerRecord struct {
	Schema       string         `json:"schema"`
	Sequence     uint64         `json:"sequence"`
	PreviousHash string         `json:"previousHash"`
	Evidence     WorkerEvidence `json:"evidence"`
	Finished     bool           `json:"finished"`
	Hash         string         `json:"hash,omitempty"`
}

type workerJournal struct {
	file     *os.File
	stamp    syscall.Stat_t
	sequence uint64
	hash     string
	records  map[string]workerRecord
}

func validWorker(w WorkerEvidence) bool {
	return idPattern.MatchString(w.WorkerID) && (w.Mode == "preflight" || w.Mode == "execute") && idPattern.MatchString(w.PermitID) &&
		(w.OperationID == "" && w.Mode == "preflight" || idPattern.MatchString(w.OperationID)) && digestPattern.MatchString(w.RequestDigest) && digestPattern.MatchString(w.SubjectDigest) &&
		idPattern.MatchString(w.BrokerID) && workerGeneration.MatchString(w.Generation) && digestPattern.MatchString(w.BrokerBootNonce) &&
		w.PID > 1 && w.PGID == w.PID && kernelBootID.MatchString(w.KernelBootID) && w.StartTicks > 0
}

func workerHash(r workerRecord) string {
	r.Hash = ""
	b, _ := json.Marshal(r)
	sum := sha256.Sum256(append([]byte(workerSchema+"\x00"), b...))
	return hex.EncodeToString(sum[:])
}

func (l *Ledger) openWorkers(ledgerExisted bool) error {
	flags := syscall.O_RDWR | syscall.O_APPEND | syscall.O_NOFOLLOW | syscall.O_CLOEXEC | syscall.O_NONBLOCK
	if !ledgerExisted {
		flags |= syscall.O_CREAT | syscall.O_EXCL
	}
	fd, err := syscall.Openat(int(l.dir.Fd()), workerFileName, flags, 0600)
	if err != nil {
		return ErrCorrupt
	}
	f := os.NewFile(uintptr(fd), workerFileName)
	good := false
	defer func() {
		if !good {
			f.Close()
		}
	}()
	if checkFile(fd) != nil {
		return ErrUnsafeStorage
	}
	j := &workerJournal{file: f, hash: zeroHash, records: map[string]workerRecord{}}
	if syscall.Fstat(fd, &j.stamp) != nil || j.stamp.Size > maxLedgerBytes {
		return ErrCorrupt
	}
	b, err := io.ReadAll(io.LimitReader(f, maxLedgerBytes+1))
	if err != nil || int64(len(b)) != j.stamp.Size || len(b) > maxLedgerBytes {
		return ErrCorrupt
	}
	if len(b) > 0 {
		if b[len(b)-1] != '\n' {
			return ErrCorrupt
		}
		for _, line := range bytes.Split(b[:len(b)-1], []byte{'\n'}) {
			var r workerRecord
			if len(line) > maxRecordBytes || json.Unmarshal(line, &r) != nil {
				return ErrCorrupt
			}
			encoded, _ := json.Marshal(r)
			if !bytes.Equal(encoded, line) || r.Schema != workerSchema || r.Sequence != j.sequence+1 || r.PreviousHash != j.hash || r.Hash != workerHash(r) || !validWorker(r.Evidence) {
				return ErrCorrupt
			}
			previous, exists := j.records[r.Evidence.WorkerID]
			if !exists && r.Finished || exists && (previous.Finished || !r.Finished || previous.Evidence != r.Evidence) {
				return ErrCorrupt
			}
			j.records[r.Evidence.WorkerID] = r
			j.sequence = r.Sequence
			j.hash = r.Hash
		}
	}
	if f.Sync() != nil || l.dir.Sync() != nil {
		return ErrUnsafeStorage
	}
	l.workers = j
	good = true
	return nil
}

func (l *Ledger) guardWorkers() error {
	j := l.workers
	fd, err := syscall.Openat(int(l.dir.Fd()), workerFileName, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
	if err != nil {
		return l.poison(ErrUnsafeStorage)
	}
	defer syscall.Close(fd)
	if checkFile(fd) != nil {
		return l.poison(ErrUnsafeStorage)
	}
	var named, held syscall.Stat_t
	if syscall.Fstat(fd, &named) != nil || syscall.Fstat(int(j.file.Fd()), &held) != nil || named.Dev != held.Dev || named.Ino != held.Ino || named.Dev != j.stamp.Dev || named.Ino != j.stamp.Ino || named.Size != j.stamp.Size || named.Ctim != j.stamp.Ctim || named.Mtim != j.stamp.Mtim {
		return l.poison(ErrUnsafeStorage)
	}
	return nil
}

func (l *Ledger) appendWorker(e WorkerEvidence, finished bool) error {
	j := l.workers
	r := workerRecord{Schema: workerSchema, Sequence: j.sequence + 1, PreviousHash: j.hash, Evidence: e, Finished: finished}
	r.Hash = workerHash(r)
	b, _ := json.Marshal(r)
	b = append(b, '\n')
	if len(b) > maxRecordBytes || j.stamp.Size+int64(len(b)) > maxLedgerBytes {
		return l.poison(errors.New("worker ledger capacity exceeded"))
	}
	n, err := j.file.Write(b)
	if err != nil {
		return l.poison(err)
	}
	if n != len(b) {
		return l.poison(io.ErrShortWrite)
	}
	if err := j.file.Sync(); err != nil {
		return l.poison(err)
	}
	if err := l.syncDir(); err != nil {
		return l.poison(err)
	}
	if syscall.Fstat(int(j.file.Fd()), &j.stamp) != nil {
		return l.poison(ErrUnsafeStorage)
	}
	j.sequence = r.Sequence
	j.hash = r.Hash
	j.records[e.WorkerID] = r
	return nil
}

func (l *Ledger) RegisterWorker(e WorkerEvidence) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.guard(); err != nil {
		return err
	}
	if !validWorker(e) {
		return ErrInvalid
	}
	if old, ok := l.workers.records[e.WorkerID]; ok {
		if old.Evidence != e || old.Finished {
			return ErrConflict
		}
		return nil
	}
	return l.appendWorker(e, false)
}

// FinishWorker records a caller-proved absent process group, never removes it
// from history. It does not release or renew the operation's spending permit.
func (l *Ledger) FinishWorker(workerID string) error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.guard(); err != nil {
		return err
	}
	old, ok := l.workers.records[workerID]
	if !ok {
		return ErrConflict
	}
	if old.Finished {
		return nil
	}
	return l.appendWorker(old.Evidence, true)
}

func (l *Ledger) UnfinishedWorkers() ([]WorkerEvidence, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.guard(); err != nil {
		return nil, err
	}
	result := []WorkerEvidence{}
	for _, r := range l.workers.records {
		if !r.Finished {
			result = append(result, r.Evidence)
		}
	}
	sort.Slice(result, func(i, j int) bool { return result[i].WorkerID < result[j].WorkerID })
	return result, nil
}
