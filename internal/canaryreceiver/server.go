// Package canaryreceiver implements the metadata-only webhook evidence receiver
// used by the notification-delivery Canary. Vendor request bodies are hashed in
// memory and discarded; only bounded reconciliation metadata is persisted.
package canaryreceiver

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"
)

const (
	MaxBodyBytes      int64 = 262144
	MaxRecordsPerRead       = 100
)

type Record struct {
	Schema                  string    `json:"schema"`
	RecordID                string    `json:"record_id"`
	RequestID               string    `json:"request_id"`
	IdempotencyKey          string    `json:"idempotency_key"`
	OpenSlackIdempotencyKey string    `json:"openslack_idempotency_key"`
	BodyDigest              string    `json:"body_digest"`
	BodySize                int       `json:"body_size"`
	ReceivedAt              time.Time `json:"received_at"`
}

type Server struct {
	storeDir string
	auditKey string
	now      func() time.Time
	randomID func() (string, error)
	mu       sync.Mutex
}

func New(storeDir, auditKey string) (*Server, error) {
	if strings.TrimSpace(auditKey) != auditKey || len(auditKey) < 32 || len(auditKey) > 512 {
		return nil, errors.New("canary receiver: audit key must contain 32-512 non-space bytes")
	}
	if err := ensureStoreDirectory(storeDir); err != nil {
		return nil, err
	}
	return &Server{
		storeDir: storeDir,
		auditKey: auditKey,
		now:      func() time.Time { return time.Now().UTC() },
		randomID: newRecordID,
	}, nil
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/receive", s.handleReceive)
	mux.HandleFunc("GET /v1/records", s.handleRecords)
	mux.HandleFunc("GET /health/ready", s.handleReady)
	return mux
}

func (s *Server) handleReceive(w http.ResponseWriter, r *http.Request) {
	if contentType := r.Header.Get("Content-Type"); contentType != "application/json" {
		http.Error(w, "unsupported media type", http.StatusUnsupportedMediaType)
		return
	}
	idempotencyKey := sanitizeIdentifier(r.Header.Get("Idempotency-Key"), 255)
	openSlackKey := sanitizeIdentifier(r.Header.Get("X-OpenSlack-Idempotency-Key"), 255)
	if idempotencyKey == "" || openSlackKey == "" || idempotencyKey != openSlackKey {
		http.Error(w, "invalid idempotency headers", http.StatusBadRequest)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, MaxBodyBytes+1))
	if err != nil {
		http.Error(w, "request unavailable", http.StatusBadRequest)
		return
	}
	if int64(len(body)) > MaxBodyBytes {
		http.Error(w, "request too large", http.StatusRequestEntityTooLarge)
		return
	}
	recordID, err := s.randomID()
	if err != nil {
		http.Error(w, "receiver unavailable", http.StatusServiceUnavailable)
		return
	}
	requestID := sanitizeIdentifier(r.Header.Get("X-Request-ID"), 128)
	if requestID == "" {
		requestID = recordID
	}
	digest := sha256.Sum256(body)
	record := Record{
		Schema:                  "rc_wsman.canary_webhook_record.v1",
		RecordID:                recordID,
		RequestID:               requestID,
		IdempotencyKey:          idempotencyKey,
		OpenSlackIdempotencyKey: openSlackKey,
		BodyDigest:              "sha256:" + hex.EncodeToString(digest[:]),
		BodySize:                len(body),
		ReceivedAt:              s.now().UTC(),
	}
	if err := s.persist(record); err != nil {
		http.Error(w, "receiver unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("X-Canary-Webhook-Request-ID", recordID)
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleRecords(w http.ResponseWriter, r *http.Request) {
	if !s.authorized(r.Header.Get("Authorization")) {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}
	if len(r.URL.Query()) != 1 || !r.URL.Query().Has("idempotency_key") {
		http.Error(w, "invalid query", http.StatusBadRequest)
		return
	}
	filter := r.URL.Query().Get("idempotency_key")
	filter = sanitizeIdentifier(filter, 255)
	if filter == "" {
		http.Error(w, "invalid query", http.StatusBadRequest)
		return
	}
	records, err := s.readRecords(filter)
	if err != nil {
		http.Error(w, "receiver unavailable", http.StatusServiceUnavailable)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, struct {
		Items []Record `json:"items"`
	}{Items: records})
}

func (s *Server) handleReady(w http.ResponseWriter, _ *http.Request) {
	writeJSON(w, http.StatusOK, struct {
		Ready bool `json:"ready"`
	}{Ready: true})
}

func (s *Server) authorized(value string) bool {
	const prefix = "Bearer "
	if !strings.HasPrefix(value, prefix) {
		return false
	}
	provided := strings.TrimPrefix(value, prefix)
	if len(provided) != len(s.auditKey) {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(provided), []byte(s.auditKey)) == 1
}

func (s *Server) persist(record Record) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	encoded, err := json.Marshal(record)
	if err != nil {
		return fmt.Errorf("encode record: %w", err)
	}
	encoded = append(encoded, '\n')
	path := filepath.Join(s.storeDir, record.RecordID+".json")
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return fmt.Errorf("create record: %w", err)
	}
	ok := false
	defer func() {
		_ = file.Close()
		if !ok {
			_ = os.Remove(path)
		}
	}()
	if _, err := file.Write(encoded); err != nil {
		return fmt.Errorf("write record: %w", err)
	}
	if err := file.Sync(); err != nil {
		return fmt.Errorf("sync record: %w", err)
	}
	if err := file.Close(); err != nil {
		return fmt.Errorf("close record: %w", err)
	}
	if err := syncDirectory(s.storeDir); err != nil {
		return err
	}
	ok = true
	return nil
}

func (s *Server) readRecords(filter string) ([]Record, error) {
	entries, err := os.ReadDir(s.storeDir)
	if err != nil {
		return nil, fmt.Errorf("read record directory: %w", err)
	}
	records := make([]Record, 0, len(entries))
	for _, entry := range entries {
		if entry.Type()&os.ModeSymlink != 0 || !entry.Type().IsRegular() ||
			!strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(s.storeDir, entry.Name()))
		if err != nil {
			return nil, fmt.Errorf("read record: %w", err)
		}
		var record Record
		decoder := json.NewDecoder(bytes.NewReader(data))
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&record); err != nil {
			return nil, fmt.Errorf("decode record: %w", err)
		}
		if decoder.Decode(&struct{}{}) != io.EOF {
			return nil, errors.New("record has trailing JSON")
		}
		if err := validateRecord(record, entry.Name()); err != nil {
			return nil, errors.New("record identity mismatch")
		}
		if record.IdempotencyKey == filter || record.OpenSlackIdempotencyKey == filter {
			records = append(records, record)
			if len(records) > MaxRecordsPerRead {
				return nil, errors.New("record query exceeds bounded result limit")
			}
		}
	}
	sort.Slice(records, func(i, j int) bool {
		if records[i].ReceivedAt.Equal(records[j].ReceivedAt) {
			return records[i].RecordID < records[j].RecordID
		}
		return records[i].ReceivedAt.Before(records[j].ReceivedAt)
	})
	return records, nil
}

func validateRecord(record Record, filename string) error {
	if record.Schema != "rc_wsman.canary_webhook_record.v1" ||
		record.RecordID+".json" != filename ||
		len(record.RecordID) != 32 || !isLowerHex(record.RecordID) ||
		sanitizeIdentifier(record.RequestID, 128) == "" ||
		sanitizeIdentifier(record.IdempotencyKey, 255) == "" ||
		record.IdempotencyKey != record.OpenSlackIdempotencyKey ||
		len(record.BodyDigest) != 71 ||
		!strings.HasPrefix(record.BodyDigest, "sha256:") ||
		!isLowerHex(strings.TrimPrefix(record.BodyDigest, "sha256:")) ||
		record.BodySize < 0 || int64(record.BodySize) > MaxBodyBytes ||
		record.ReceivedAt.IsZero() {
		return errors.New("invalid record")
	}
	return nil
}

func isLowerHex(value string) bool {
	if value == "" {
		return false
	}
	for _, char := range value {
		if (char < '0' || char > '9') && (char < 'a' || char > 'f') {
			return false
		}
	}
	return true
}

func ensureStoreDirectory(path string) error {
	if path == "" || !filepath.IsAbs(path) {
		return errors.New("canary receiver: store directory must be absolute")
	}
	if err := os.MkdirAll(path, 0o700); err != nil {
		return fmt.Errorf("create store directory: %w", err)
	}
	info, err := os.Lstat(path)
	if err != nil {
		return fmt.Errorf("inspect store directory: %w", err)
	}
	if info.Mode()&os.ModeSymlink != 0 || !info.IsDir() {
		return errors.New("canary receiver: store path must be a regular directory")
	}
	if err := os.Chmod(path, 0o700); err != nil {
		return fmt.Errorf("secure store directory: %w", err)
	}
	return nil
}

func syncDirectory(path string) error {
	dir, err := os.Open(path)
	if err != nil {
		return fmt.Errorf("open record directory: %w", err)
	}
	defer dir.Close()
	if err := dir.Sync(); err != nil {
		return fmt.Errorf("sync record directory: %w", err)
	}
	return nil
}

func newRecordID() (string, error) {
	var raw [16]byte
	if _, err := rand.Read(raw[:]); err != nil {
		return "", err
	}
	return hex.EncodeToString(raw[:]), nil
}

func sanitizeIdentifier(value string, max int) string {
	if len(value) == 0 || len(value) > max {
		return ""
	}
	for _, char := range value {
		if (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') ||
			(char >= '0' && char <= '9') || strings.ContainsRune("._:-", char) {
			continue
		}
		return ""
	}
	return value
}

func writeJSON(w http.ResponseWriter, status int, value any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(value)
}
