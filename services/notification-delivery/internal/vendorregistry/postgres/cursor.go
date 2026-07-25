package postgres

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/vendorregistry"
)

type cursorSigner struct {
	key []byte
}

type cursorEnvelope struct {
	Operation         string   `json:"operation"`
	ScopeKind         string   `json:"scope_kind,omitempty"`
	VendorIDs         []string `json:"vendor_ids,omitempty"`
	OwningScopes      []string `json:"owning_scopes,omitempty"`
	Limit             int      `json:"limit"`
	VendorID          string   `json:"vendor_id,omitempty"`
	LastCreatedAt     string   `json:"last_created_at,omitempty"`
	LastVendorID      string   `json:"last_vendor_id,omitempty"`
	LastConfigVersion int64    `json:"last_config_version,omitempty"`
	SnapshotCap       int64    `json:"snapshot_cap,omitempty"`
	LastAuditSeq      int64    `json:"last_audit_seq,omitempty"`
	LastEventID       string   `json:"last_event_id,omitempty"`
}

func newCursorSigner() *cursorSigner {
	key := make([]byte, 32)
	if _, err := rand.Read(key); err != nil {
		panic(fmt.Sprintf("vendor cursor signer: %v", err))
	}
	return &cursorSigner{key: key}
}

func (s *cursorSigner) sign(env cursorEnvelope) (string, error) {
	payload, err := json.Marshal(env)
	if err != nil {
		return "", err
	}
	mac := hmac.New(sha256.New, s.key)
	_, _ = mac.Write(payload)
	signature := mac.Sum(nil)
	return base64.RawURLEncoding.EncodeToString(append(signature, payload...)), nil
}

func (s *cursorSigner) verify(raw string) (cursorEnvelope, error) {
	var env cursorEnvelope
	decoded, err := base64.RawURLEncoding.DecodeString(raw)
	if err != nil || len(decoded) <= sha256.Size {
		return env, errors.New("cursor malformed")
	}
	signature, payload := decoded[:sha256.Size], decoded[sha256.Size:]
	mac := hmac.New(sha256.New, s.key)
	_, _ = mac.Write(payload)
	if !hmac.Equal(signature, mac.Sum(nil)) {
		return env, errors.New("cursor signature mismatch")
	}
	dec := json.NewDecoder(strings.NewReader(string(payload)))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&env); err != nil {
		return env, err
	}
	return env, nil
}

func cursorScope(filter vendorregistry.ScopeFilter) (string, []string, []string) {
	vendorIDs := append([]string(nil), filter.VendorIDs...)
	owningScopes := append([]string(nil), filter.OwningScopes...)
	sort.Strings(vendorIDs)
	sort.Strings(owningScopes)
	return filter.Kind, vendorIDs, owningScopes
}

func cursorMatchesFilter(env cursorEnvelope, filter vendorregistry.ScopeFilter) bool {
	kind, vendorIDs, owningScopes := cursorScope(filter)
	return env.ScopeKind == kind && equalStrings(env.VendorIDs, vendorIDs) && equalStrings(env.OwningScopes, owningScopes)
}

func equalStrings(a, b []string) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i] != b[i] {
			return false
		}
	}
	return true
}
