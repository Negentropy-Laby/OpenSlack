//go:build linux

// Package ledger owns the broker's single-host, append-only permit spending log.
// It is not a distributed lock or an anti-rollback authority. A fresh broker boot
// must invalidate old permits independently. Callers MUST execute only after
// both Reserve and MarkSendAdmitted return Fresh=true, plus final authorization
// checks; a replayed reserved record never grants permission to retry a send.
package ledger

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"syscall"
	"unicode/utf8"
)

var (
	ErrLocked        = errors.New("cleanup ledger already locked")
	ErrUnsafeStorage = errors.New("cleanup ledger storage is unsafe or unsupported")
	ErrCorrupt       = errors.New("cleanup ledger is corrupt; recovery required")
	ErrConflict      = errors.New("cleanup ledger reservation conflict")
	ErrInvalid       = errors.New("invalid cleanup ledger input")
	ErrPoisoned      = errors.New("cleanup ledger writer poisoned; recovery required")
	ErrClosed        = errors.New("cleanup ledger closed")
)

type State string

const (
	Reserved               State = "reserved"
	Consumed               State = "consumed"
	ReconciliationRequired State = "reconciliation_required"
	fileName                     = "ledger.jsonl"
	schema                       = "openslack.cleanup-ledger.v2"
	maxReceiptBytes              = 16 << 10
	maxRecordBytes               = 64 << 10
	maxLedgerBytes               = 64 << 20
)

var (
	idPattern     = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`)
	digestPattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
	zeroHash      = strings.Repeat("0", 64)
)

// Record is an immutable snapshot. Intent and Receipt contain caller-supplied,
// non-secret structured evidence. The ledger validates JSON and immutability,
// not its truth; the broker must validate completeness and bind intent fields.
type Record struct {
	Schema          string          `json:"schema"`
	Sequence        uint64          `json:"sequence"`
	PreviousHash    string          `json:"previousHash"`
	PermitID        string          `json:"permitId"`
	OperationID     string          `json:"operationId"`
	RequestDigest   string          `json:"requestDigest"`
	Subject         string          `json:"subject"`
	State           State           `json:"state"`
	Intent          json.RawMessage `json:"intent"`
	SendAdmitted    bool            `json:"sendAdmitted"`
	SendObservation json.RawMessage `json:"sendObservation,omitempty"`
	Receipt         json.RawMessage `json:"receipt,omitempty"`
	Hash            string          `json:"hash,omitempty"`
}

type Reservation struct {
	Record Record
	Fresh  bool
}

// Ledger is safe for concurrent goroutines. OS flock excludes other cooperating
// processes. Broker-owned storage and OS isolation are required: a hostile same-
// UID process can defeat advisory locking and must not have access to this dir.
type Ledger struct {
	mu       sync.Mutex
	dirPath  string
	dir      *os.File
	file     *os.File
	stamp    syscall.Stat_t
	sequence uint64
	hash     string
	ops      map[string]Record
	permits  map[string]string
	fresh    map[string]bool
	poisoned error
	closed   bool
	write    func([]byte) (int, error)
	syncFile func() error
	syncDir  func() error
	workers  *workerJournal
}

// Open takes a nonblocking exclusive flock until Close. It may create only the
// final directory and ledger file; existing permissions are never repaired.
// Unsupported/network/FUSE/Windows filesystems are rejected, including /mnt.
// A partial last record or invalid chain rejects the entire log without repair.
func Open(dir string) (_ *Ledger, err error) {
	dirFile, err := openDirectory(dir, true)
	if err != nil {
		return nil, err
	}
	defer func() {
		if err != nil {
			_ = dirFile.Close()
		}
	}()
	probe, probeErr := syscall.Openat(int(dirFile.Fd()), fileName, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
	ledgerExisted := probeErr == nil
	if probeErr == nil {
		syscall.Close(probe)
	} else if !errors.Is(probeErr, syscall.ENOENT) {
		return nil, ErrUnsafeStorage
	}
	fd, err := syscall.Openat(int(dirFile.Fd()), fileName, syscall.O_RDWR|syscall.O_APPEND|syscall.O_CREAT|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0600)
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrUnsafeStorage, err)
	}
	f := os.NewFile(uintptr(fd), fileName)
	defer func() {
		if err != nil {
			_ = f.Close()
		}
	}()
	if err = checkFile(fd); err != nil {
		return nil, err
	}
	if err = syscall.Flock(fd, syscall.LOCK_EX|syscall.LOCK_NB); err != nil {
		if errors.Is(err, syscall.EWOULDBLOCK) {
			return nil, ErrLocked
		}
		return nil, fmt.Errorf("%w: %w", ErrUnsafeStorage, err)
	}
	l := &Ledger{dirPath: filepath.Clean(dir), dir: dirFile, file: f, hash: zeroHash,
		ops: make(map[string]Record), permits: make(map[string]string), fresh: make(map[string]bool), write: f.Write, syncFile: f.Sync, syncDir: dirFile.Sync}
	if err = syscall.Fstat(fd, &l.stamp); err != nil {
		return nil, err
	}
	if l.stamp.Size > maxLedgerBytes {
		return nil, ErrCorrupt
	}
	data, err := io.ReadAll(io.LimitReader(f, maxLedgerBytes+1))
	if err != nil {
		return nil, err
	}
	if len(data) > maxLedgerBytes || int64(len(data)) != l.stamp.Size {
		return nil, ErrCorrupt
	}
	if err = l.replay(data); err != nil {
		return nil, err
	}
	if err = l.openWorkers(ledgerExisted); err != nil {
		return nil, err
	}
	defer func() {
		if err != nil && l.workers != nil {
			_ = l.workers.file.Close()
		}
	}()
	if err = l.guard(); err != nil {
		return nil, err
	}
	// Covers creation durability. Directory fsync is also required after every
	// append; a sync failure never returns a fresh executable reservation.
	if err = f.Sync(); err != nil {
		return nil, err
	}
	if err = dirFile.Sync(); err != nil {
		return nil, err
	}
	return l, nil
}

func openDirectory(path string, create bool) (*os.File, error) {
	if !filepath.IsAbs(path) || filepath.Clean(path) == "/" || path == "/mnt" || strings.HasPrefix(filepath.Clean(path), "/mnt/") {
		return nil, ErrUnsafeStorage
	}
	for _, p := range strings.Split(path, "/") {
		if p == ".." {
			return nil, ErrUnsafeStorage
		}
	}
	parts := strings.Split(strings.TrimPrefix(filepath.Clean(path), "/"), "/")
	fd, err := syscall.Open("/", syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_CLOEXEC, 0)
	if err != nil {
		return nil, err
	}
	for i, part := range parts {
		var parent syscall.Stat_t
		if err := syscall.Fstat(fd, &parent); err != nil {
			syscall.Close(fd)
			return nil, err
		}
		if (parent.Uid != 0 && parent.Uid != uint32(os.Geteuid())) ||
			(parent.Mode&0022 != 0 && !(parent.Uid == 0 && parent.Mode&syscall.S_ISVTX != 0)) {
			syscall.Close(fd)
			return nil, ErrUnsafeStorage
		}
		next, openErr := syscall.Openat(fd, part, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		if errors.Is(openErr, syscall.ENOENT) && create && i == len(parts)-1 {
			var parentFS syscall.Statfs_t
			if err := syscall.Fstatfs(fd, &parentFS); err != nil {
				syscall.Close(fd)
				return nil, err
			}
			if !localFilesystem(parentFS.Type) {
				syscall.Close(fd)
				return nil, ErrUnsafeStorage
			}
			if err := syscall.Mkdirat(fd, part, 0700); err != nil && !errors.Is(err, syscall.EEXIST) {
				syscall.Close(fd)
				return nil, err
			}
			if err := syscall.Fsync(fd); err != nil {
				syscall.Close(fd)
				return nil, err
			}
			next, openErr = syscall.Openat(fd, part, syscall.O_RDONLY|syscall.O_DIRECTORY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC, 0)
		}
		syscall.Close(fd)
		if openErr != nil {
			return nil, fmt.Errorf("%w: %w", ErrUnsafeStorage, openErr)
		}
		fd = next
	}
	var st syscall.Stat_t
	var fs syscall.Statfs_t
	if err := syscall.Fstat(fd, &st); err != nil {
		syscall.Close(fd)
		return nil, err
	}
	if err := syscall.Fstatfs(fd, &fs); err != nil {
		syscall.Close(fd)
		return nil, err
	}
	if st.Uid != uint32(os.Geteuid()) || st.Mode&07777 != 0700 || !localFilesystem(fs.Type) {
		syscall.Close(fd)
		return nil, ErrUnsafeStorage
	}
	return os.NewFile(uintptr(fd), path), nil
}

func localFilesystem(kind int64) bool {
	// ext2/3/4, XFS, Btrfs, overlayfs, F2FS. A deployment must still verify
	// persistent backing storage; overlayfs itself does not prove persistence.
	switch uint64(kind) {
	case 0xef53, 0x58465342, 0x9123683e, 0x794c7630, 0xf2f52010:
		return true
	}
	return false
}

func checkFile(fd int) error {
	var st syscall.Stat_t
	if err := syscall.Fstat(fd, &st); err != nil {
		return err
	}
	if st.Mode&syscall.S_IFMT != syscall.S_IFREG || st.Mode&07777 != 0600 || st.Uid != uint32(os.Geteuid()) || st.Nlink != 1 {
		return ErrUnsafeStorage
	}
	return nil
}

func (l *Ledger) guard() error {
	if l.closed {
		return ErrClosed
	}
	if l.poisoned != nil {
		return l.poisoned
	}
	dir, err := openDirectory(l.dirPath, false)
	if err != nil {
		return l.poison(err)
	}
	defer dir.Close()
	var currentDir, ownedDir syscall.Stat_t
	if err := syscall.Fstat(int(dir.Fd()), &currentDir); err != nil {
		return l.poison(err)
	}
	if err := syscall.Fstat(int(l.dir.Fd()), &ownedDir); err != nil {
		return l.poison(err)
	}
	if currentDir.Dev != ownedDir.Dev || currentDir.Ino != ownedDir.Ino {
		return l.poison(ErrUnsafeStorage)
	}
	fd, err := syscall.Openat(int(dir.Fd()), fileName, syscall.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_CLOEXEC|syscall.O_NONBLOCK, 0)
	if err != nil {
		return l.poison(err)
	}
	defer syscall.Close(fd)
	if err := checkFile(fd); err != nil {
		return l.poison(err)
	}
	var actual, held syscall.Stat_t
	if err := syscall.Fstat(fd, &actual); err != nil {
		return l.poison(err)
	}
	if err := syscall.Fstat(int(l.file.Fd()), &held); err != nil {
		return l.poison(err)
	}
	if actual.Dev != held.Dev || actual.Ino != held.Ino || actual.Dev != l.stamp.Dev || actual.Ino != l.stamp.Ino ||
		actual.Size != l.stamp.Size || actual.Mtim != l.stamp.Mtim || actual.Ctim != l.stamp.Ctim {
		return l.poison(ErrUnsafeStorage)
	}
	if l.workers != nil {
		return l.guardWorkers()
	}
	return nil
}

func (l *Ledger) poison(err error) error {
	l.poisoned = fmt.Errorf("%w: %w", ErrPoisoned, err)
	return l.poisoned
}

func validateReservation(permit, operation, digest, subject string) bool {
	if !idPattern.MatchString(permit) || !idPattern.MatchString(operation) || !digestPattern.MatchString(digest) || len(subject) == 0 || len(subject) > 512 {
		return false
	}
	for _, r := range subject {
		if r < 0x21 || r > 0x7e {
			return false
		}
	}
	return true
}

func clone(r Record) Record {
	r.Receipt = bytes.Clone(r.Receipt)
	r.Intent = bytes.Clone(r.Intent)
	r.SendObservation = bytes.Clone(r.SendObservation)
	return r
}

// Reserve durably spends a permit before a possible effect. Only Fresh=true
// authorizes proceeding through final-send gates and MarkSendAdmitted.
func (l *Ledger) Reserve(permitID, operationID, requestDigest, subject string, intent json.RawMessage) (Reservation, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.guard(); err != nil {
		return Reservation{}, err
	}
	if !validateReservation(permitID, operationID, requestDigest, subject) {
		return Reservation{}, ErrInvalid
	}
	canonical, err := canonicalReceipt(intent)
	if err != nil {
		return Reservation{}, err
	}
	if old, ok := l.ops[operationID]; ok {
		if old.PermitID != permitID || old.RequestDigest != requestDigest || old.Subject != subject || !bytes.Equal(old.Intent, canonical) {
			return Reservation{}, ErrConflict
		}
		return Reservation{Record: clone(old), Fresh: false}, nil
	}
	if _, ok := l.permits[permitID]; ok {
		return Reservation{}, ErrConflict
	}
	r := Record{PermitID: permitID, OperationID: operationID, RequestDigest: requestDigest, Subject: subject, State: Reserved, Intent: canonical}
	r, err = l.append(r)
	if err != nil {
		return Reservation{}, err
	}
	l.fresh[operationID] = true
	return Reservation{Record: clone(r), Fresh: true}, nil
}

// MarkSendAdmitted durably records the single admission immediately before send.
// Fresh=true is issued only once, and only for a reservation created by this
// open writer. Replayed reservations never gain fresh send authority after crash.
func (l *Ledger) MarkSendAdmitted(operationID, requestDigest string, observation json.RawMessage) (Reservation, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.guard(); err != nil {
		return Reservation{}, err
	}
	if !idPattern.MatchString(operationID) || !digestPattern.MatchString(requestDigest) {
		return Reservation{}, ErrInvalid
	}
	canonical, err := canonicalReceipt(observation)
	if err != nil {
		return Reservation{}, err
	}
	old, ok := l.ops[operationID]
	if !ok || old.RequestDigest != requestDigest || old.State != Reserved {
		return Reservation{}, ErrConflict
	}
	if old.SendAdmitted || !l.fresh[operationID] {
		if old.SendAdmitted && !bytes.Equal(old.SendObservation, canonical) {
			return Reservation{}, ErrConflict
		}
		return Reservation{Record: clone(old), Fresh: false}, nil
	}
	delete(l.fresh, operationID)
	old.SendAdmitted = true
	old.SendObservation = canonical
	r, err := l.append(old)
	if err != nil {
		return Reservation{}, err
	}
	return Reservation{Record: clone(r), Fresh: true}, nil
}

// Finish persists a terminal receipt. ReconciliationRequired is terminal too:
// neither outcome releases a permit. An identical finish is idempotent.
func (l *Ledger) Finish(operationID string, state State, receipt json.RawMessage) (Record, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.guard(); err != nil {
		return Record{}, err
	}
	if state != Consumed && state != ReconciliationRequired {
		return Record{}, ErrInvalid
	}
	canonical, err := canonicalReceipt(receipt)
	if err != nil {
		return Record{}, err
	}
	old, ok := l.ops[operationID]
	if !ok {
		return Record{}, ErrConflict
	}
	if old.State != Reserved {
		if old.State != state || !bytes.Equal(old.Receipt, canonical) {
			return Record{}, ErrConflict
		}
		return clone(old), nil
	}
	old.State, old.Receipt = state, canonical
	delete(l.fresh, operationID)
	r, err := l.append(old)
	return clone(r), err
}

func (l *Ledger) Lookup(operationID string) (Record, bool, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	if err := l.guard(); err != nil {
		return Record{}, false, err
	}
	r, ok := l.ops[operationID]
	return clone(r), ok, nil
}

func recordHash(r Record) string {
	r.Hash = ""
	data, _ := json.Marshal(r)
	h := sha256.Sum256(append([]byte(schema+"\x00"), data...))
	return hex.EncodeToString(h[:])
}

func (l *Ledger) append(r Record) (Record, error) {
	r.Schema, r.Sequence, r.PreviousHash = schema, l.sequence+1, l.hash
	r.Hash = recordHash(r)
	data, err := json.Marshal(r)
	if err != nil {
		return Record{}, l.poison(err)
	}
	if len(data) > maxRecordBytes || l.stamp.Size+int64(len(data))+1 > maxLedgerBytes {
		return Record{}, l.poison(errors.New("ledger capacity exceeded"))
	}
	data = append(data, '\n')
	n, err := l.write(data)
	if err != nil {
		return Record{}, l.poison(err)
	}
	if n != len(data) {
		return Record{}, l.poison(io.ErrShortWrite)
	}
	if err := l.syncFile(); err != nil {
		return Record{}, l.poison(err)
	}
	if err := l.syncDir(); err != nil {
		return Record{}, l.poison(err)
	}
	if err := syscall.Fstat(int(l.file.Fd()), &l.stamp); err != nil {
		return Record{}, l.poison(err)
	}
	l.accept(r)
	return r, nil
}

func (l *Ledger) accept(r Record) {
	l.sequence, l.hash = r.Sequence, r.Hash
	l.ops[r.OperationID] = clone(r)
	l.permits[r.PermitID] = r.OperationID
}

func (l *Ledger) replay(data []byte) error {
	if len(data) == 0 {
		return nil
	}
	if data[len(data)-1] != '\n' {
		return ErrCorrupt
	}
	for _, line := range bytes.Split(data[:len(data)-1], []byte{'\n'}) {
		if len(line) == 0 || len(line) > maxRecordBytes {
			return ErrCorrupt
		}
		var r Record
		if json.Unmarshal(line, &r) != nil {
			return ErrCorrupt
		}
		encoded, err := json.Marshal(r)
		if err != nil || !bytes.Equal(encoded, line) {
			return ErrCorrupt
		}
		if r.Schema != schema || r.Sequence != l.sequence+1 || r.PreviousHash != l.hash || r.Hash != recordHash(r) ||
			!validateReservation(r.PermitID, r.OperationID, r.RequestDigest, r.Subject) {
			return ErrCorrupt
		}
		old, exists := l.ops[r.OperationID]
		intent, err := canonicalReceipt(r.Intent)
		if err != nil || !bytes.Equal(intent, r.Intent) {
			return ErrCorrupt
		}
		if r.SendAdmitted {
			observation, err := canonicalReceipt(r.SendObservation)
			if err != nil || !bytes.Equal(observation, r.SendObservation) {
				return ErrCorrupt
			}
		} else if len(r.SendObservation) != 0 {
			return ErrCorrupt
		}
		if exists && (old.PermitID != r.PermitID || old.RequestDigest != r.RequestDigest || old.Subject != r.Subject || !bytes.Equal(old.Intent, r.Intent)) {
			return ErrCorrupt
		}
		if r.State == Reserved {
			if len(r.Receipt) != 0 {
				return ErrCorrupt
			}
			if exists {
				if old.State != Reserved || old.SendAdmitted || !r.SendAdmitted {
					return ErrCorrupt
				}
			} else {
				if r.SendAdmitted {
					return ErrCorrupt
				}
				if _, used := l.permits[r.PermitID]; used {
					return ErrCorrupt
				}
			}
		} else {
			if r.State != Consumed && r.State != ReconciliationRequired {
				return ErrCorrupt
			}
			if !exists || old.State != Reserved || old.SendAdmitted != r.SendAdmitted || !bytes.Equal(old.SendObservation, r.SendObservation) {
				return ErrCorrupt
			}
			canonical, err := canonicalReceipt(r.Receipt)
			if err != nil || !bytes.Equal(canonical, r.Receipt) {
				return ErrCorrupt
			}
		}
		l.accept(r)
	}
	return nil
}

// Decode without duplicate keys at any depth, then encode a stable receipt.
func canonicalReceipt(raw []byte) ([]byte, error) {
	if len(raw) == 0 || len(raw) > maxReceiptBytes || !utf8.Valid(raw) {
		return nil, ErrInvalid
	}
	d := json.NewDecoder(bytes.NewReader(raw))
	d.UseNumber()
	v, err := jsonValue(d, 0)
	if err != nil {
		return nil, ErrInvalid
	}
	if _, ok := v.(map[string]any); !ok {
		return nil, ErrInvalid
	}
	if _, err := d.Token(); err != io.EOF {
		return nil, ErrInvalid
	}
	result, err := json.Marshal(v)
	if err != nil || len(result) > maxReceiptBytes {
		return nil, ErrInvalid
	}
	return result, nil
}

func jsonValue(d *json.Decoder, depth int) (any, error) {
	if depth > 32 {
		return nil, ErrInvalid
	}
	token, err := d.Token()
	if err != nil {
		return nil, err
	}
	if delim, ok := token.(json.Delim); ok {
		switch delim {
		case '{':
			object := map[string]any{}
			for d.More() {
				keyToken, err := d.Token()
				if err != nil {
					return nil, err
				}
				key, ok := keyToken.(string)
				if !ok || strings.ContainsRune(key, utf8.RuneError) {
					return nil, ErrInvalid
				}
				if _, exists := object[key]; exists {
					return nil, ErrInvalid
				}
				value, err := jsonValue(d, depth+1)
				if err != nil {
					return nil, err
				}
				object[key] = value
			}
			end, err := d.Token()
			if err != nil || end != json.Delim('}') {
				return nil, ErrInvalid
			}
			return object, nil
		case '[':
			array := []any{}
			for d.More() {
				v, err := jsonValue(d, depth+1)
				if err != nil {
					return nil, err
				}
				array = append(array, v)
			}
			end, err := d.Token()
			if err != nil || end != json.Delim(']') {
				return nil, ErrInvalid
			}
			return array, nil
		default:
			return nil, ErrInvalid
		}
	}
	if str, ok := token.(string); ok && strings.ContainsRune(str, utf8.RuneError) {
		return nil, ErrInvalid
	}
	return token, nil
}

func (l *Ledger) Close() error {
	l.mu.Lock()
	defer l.mu.Unlock()
	if l.closed {
		return nil
	}
	l.closed = true
	// close releases flock even when the writer was poisoned.
	var workerErr error
	if l.workers != nil {
		workerErr = l.workers.file.Close()
	}
	return errors.Join(workerErr, l.file.Close(), l.dir.Close())
}
