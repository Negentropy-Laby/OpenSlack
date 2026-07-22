package postgres

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
)

// cursorSecretLen is the byte length of the HMAC key used to protect cursors.
const cursorSecretLen = 32

// cursorSigner signs and verifies opaque JSON cursors.
type cursorSigner struct {
	key []byte
}

// newCursorSigner returns a signer with a random key. It panics if randomness
// is unavailable, which is acceptable for a startup-time constructor.
func newCursorSigner() *cursorSigner {
	key := make([]byte, cursorSecretLen)
	if _, err := rand.Read(key); err != nil {
		panic(fmt.Sprintf("cursor signer: cannot read random: %v", err))
	}
	return &cursorSigner{key: key}
}

// cursorEnvelope is the JSON payload carried in a cursor.
type cursorEnvelope struct {
	Op             string         `json:"op"`
	Scope          []string       `json:"scope,omitempty"`
	Limit          int            `json:"limit"`
	SnapshotAt     string         `json:"snapshot_at,omitempty"` // RFC3339Nano
	LastDeadAt     string         `json:"last_dead_at,omitempty"`
	LastID         string         `json:"last_id,omitempty"`
	NotificationID string         `json:"notification_id,omitempty"`
	LastAttemptSeq int64          `json:"last_attempt_seq,omitempty"`
	LastAttemptID  string         `json:"last_attempt_id,omitempty"`
	Extra          map[string]any `json:"extra,omitempty"`
}

func (c *cursorSigner) sign(env cursorEnvelope) (string, error) {
	payload, err := json.Marshal(env)
	if err != nil {
		return "", fmt.Errorf("marshal cursor: %w", err)
	}
	mac := hmac.New(sha256.New, c.key)
	_, _ = mac.Write(payload)
	sig := base64.URLEncoding.EncodeToString(mac.Sum(nil))
	combined := sig + "." + base64.URLEncoding.EncodeToString(payload)
	return base64.URLEncoding.EncodeToString([]byte(combined)), nil
}

func (c *cursorSigner) verify(cursor string) (cursorEnvelope, error) {
	var env cursorEnvelope
	raw, err := base64.URLEncoding.DecodeString(cursor)
	if err != nil {
		return env, fmt.Errorf("decode cursor: %w", err)
	}
	parts := strings.SplitN(string(raw), ".", 2)
	if len(parts) != 2 {
		return env, errors.New("cursor format invalid")
	}
	sig, err := base64.URLEncoding.DecodeString(parts[0])
	if err != nil {
		return env, fmt.Errorf("decode signature: %w", err)
	}
	payload, err := base64.URLEncoding.DecodeString(parts[1])
	if err != nil {
		return env, fmt.Errorf("decode payload: %w", err)
	}
	mac := hmac.New(sha256.New, c.key)
	_, _ = mac.Write(payload)
	if !hmac.Equal(sig, mac.Sum(nil)) {
		return env, errors.New("cursor signature mismatch")
	}
	if err := json.Unmarshal(payload, &env); err != nil {
		return env, fmt.Errorf("unmarshal cursor: %w", err)
	}
	return env, nil
}

// withScope checks that the cursor's scope matches the supplied effective scope.
func (env cursorEnvelope) withScope(scope []string) bool {
	if len(env.Scope) != len(scope) {
		return false
	}
	want := make(map[string]struct{}, len(scope))
	for _, s := range scope {
		want[s] = struct{}{}
	}
	for _, s := range env.Scope {
		if _, ok := want[s]; !ok {
			return false
		}
	}
	return true
}
