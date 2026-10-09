// Package permit validates the cleanup contract. Validation alone does not
// authenticate a source: the broker must acquire the bundle from its fixed
// governance authority, independently of the requesting agent.
package permit

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"regexp"
	"strings"
	"time"
	"unicode/utf8"
)

const (
	Schema       = "openslack.cleanup_permit.v1"
	Action       = "pr.cleanup_branch_scoped.v1"
	PolicySchema = "openslack.cleanup_policy.v1"
	Basis        = "permit_only"
)

var (
	id       = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$`)
	recordID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$`)
	sha      = regexp.MustCompile(`^[0-9a-f]{40}$`)
	nonce    = regexp.MustCompile(`^[0-9a-f]{64}$`)
	decimal  = regexp.MustCompile(`^[1-9][0-9]{0,39}$`)
	repoName = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9_.-]*/[A-Za-z0-9][A-Za-z0-9_.-]*$`)
)

// Denial contains a safe reason code, never the source record or credentials.
type Denial struct{ Code string }

func (e *Denial) Error() string { return e.Code }
func deny(code string) error    { return &Denial{Code: code} }

type Subject struct {
	PrincipalID string `json:"principalId"`
	RuntimeUID  string `json:"runtimeUid"`
	RunID       string `json:"runId"`
}

type Target struct {
	WorkspaceID  string `json:"workspaceId"`
	Host         string `json:"host"`
	RepositoryID string `json:"repositoryId"`
	Repository   string `json:"repository"`
	PRNodeID     string `json:"prNodeId"`
	PRNumber     uint64 `json:"prNumber"`
	Ref          string `json:"ref"`
	ExpectedSHA  string `json:"expectedSha"`
}

type Instance struct {
	BrokerID   string `json:"brokerId"`
	Generation string `json:"generation"`
	BootNonce  string `json:"bootNonce"`
}

type Permit struct {
	Schema            string    `json:"schema"`
	ID                string    `json:"permitId"`
	Action            string    `json:"action"`
	IssuerTrustDomain string    `json:"issuerTrustDomain"`
	Subject           Subject   `json:"subject"`
	Target            Target    `json:"target"`
	TaskRef           string    `json:"taskRef"`
	Instance          Instance  `json:"instance"`
	NotBefore         time.Time `json:"notBefore"`
	ExpiresAt         time.Time `json:"expiresAt"`
	Revoked           bool      `json:"revoked"`
	MaxUses           uint32    `json:"maxUses"`
}

// Policy, registry and permit must be read at one pinned governance commit.
// A policy input here is data, not proof of that acquisition. The fixed-source
// reader and executor must never accept these records from a client request.
type Policy struct {
	Schema            string   `json:"schema"`
	Basis             string   `json:"basis"`
	Action            string   `json:"action"`
	IssuerTrustDomain string   `json:"issuerTrustDomain"`
	ActiveInstance    Instance `json:"activeInstance"`
}

// NewBootNonce is called on every process start, including backup restoration.
// A nonce is not an activation: the governed policy must separately name it.
func NewBootNonce() (string, error) {
	b := make([]byte, 32)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func ValidSubject(s Subject) bool {
	return id.MatchString(s.PrincipalID) && id.MatchString(s.RuntimeUID) && id.MatchString(s.RunID)
}

func validInstance(i Instance) bool {
	return id.MatchString(i.BrokerID) && decimal.MatchString(i.Generation) && nonce.MatchString(i.BootNonce)
}

func validTarget(t Target) bool {
	if !id.MatchString(t.WorkspaceID) || t.Host != "github.com" || !decimal.MatchString(t.RepositoryID) ||
		!repoName.MatchString(t.Repository) || !id.MatchString(t.PRNodeID) || t.PRNumber == 0 || t.PRNumber > 9007199254740991 || !sha.MatchString(t.ExpectedSHA) || t.ExpectedSHA == strings.Repeat("0", 40) {
		return false
	}
	if !strings.HasPrefix(t.Ref, "refs/heads/") || len(t.Ref) > 1024 || strings.HasSuffix(t.Ref, "/") ||
		strings.HasSuffix(t.Ref, ".") || strings.Contains(t.Ref, "..") || strings.Contains(t.Ref, "@{") ||
		strings.ContainsAny(t.Ref, " ~^:?*[\\\t\r\n") {
		return false
	}
	for _, part := range strings.Split(t.Ref, "/") {
		if part == "" || strings.HasPrefix(part, ".") || strings.HasSuffix(part, ".lock") {
			return false
		}
		for _, r := range part {
			if r < 32 || r == 127 {
				return false
			}
		}
	}
	return true
}

// Check binds a previously authenticated subject and observed resource to one
// activated process instance. It grants neither a reservation nor a Claim.
// It must be repeated at admission and the trusted final sending boundary.
func Check(p Permit, policy Policy, subject Subject, target Target, instance Instance, now time.Time) error {
	if p.Schema != Schema || p.Action != Action || !recordID.MatchString(p.ID) || p.MaxUses != 1 ||
		!id.MatchString(p.IssuerTrustDomain) || !ValidSubject(p.Subject) || !validTarget(p.Target) ||
		!validInstance(p.Instance) || !id.MatchString(p.TaskRef) || p.NotBefore.IsZero() || p.ExpiresAt.IsZero() || !p.NotBefore.Before(p.ExpiresAt) {
		return deny("PERMIT_INVALID")
	}
	if policy.Schema != PolicySchema || policy.Basis != Basis || policy.Action != Action ||
		policy.IssuerTrustDomain != p.IssuerTrustDomain {
		return deny("POLICY_MISMATCH")
	}
	if !validInstance(instance) || instance != p.Instance || policy.ActiveInstance != instance {
		return deny("BROKER_NOT_ACTIVATED")
	}
	if subject != p.Subject {
		return deny("SUBJECT_MISMATCH")
	}
	if target != p.Target {
		return deny("TARGET_MISMATCH")
	}
	if p.Revoked {
		return deny("PERMIT_REVOKED")
	}
	if now.IsZero() || now.Before(p.NotBefore) {
		return deny("PERMIT_NOT_YET_VALID")
	}
	if !now.Before(p.ExpiresAt) {
		return deny("PERMIT_EXPIRED")
	}
	return nil
}

// Decode rejects unknown/duplicate fields and trailing JSON. encoding/json's
// default last-key-wins behavior is inappropriate for authorization records.
func Decode(data []byte, out any) error {
	if len(data) == 0 || len(data) > 65536 || !utf8.Valid(data) {
		return deny("RECORD_INVALID")
	}
	d := json.NewDecoder(bytes.NewReader(data))
	if err := uniqueValue(d); err != nil {
		return deny("RECORD_INVALID")
	}
	if _, err := d.Token(); !errors.Is(err, io.EOF) {
		return deny("RECORD_INVALID")
	}
	d = json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	typ := reflect.TypeOf(out)
	if typ == nil || typ.Kind() != reflect.Pointer || typ.Elem().Kind() != reflect.Struct || exactFields(data, typ.Elem()) != nil {
		return deny("RECORD_INVALID")
	}
	if err := d.Decode(out); err != nil {
		return deny("RECORD_INVALID")
	}
	return nil
}

func exactFields(data []byte, typ reflect.Type) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(data, &fields); err != nil || fields == nil {
		return errors.New("object required")
	}
	if len(fields) != typ.NumField() {
		return errors.New("field set mismatch")
	}
	for i := 0; i < typ.NumField(); i++ {
		f := typ.Field(i)
		v, ok := fields[f.Tag.Get("json")]
		if !ok || bytes.Equal(bytes.TrimSpace(v), []byte("null")) {
			return errors.New("required field missing")
		}
		if f.Type.Kind() == reflect.Struct && f.Type != reflect.TypeOf(time.Time{}) {
			if err := exactFields(v, f.Type); err != nil {
				return err
			}
		}
	}
	return nil
}

func uniqueValue(d *json.Decoder) error {
	t, err := d.Token()
	if err != nil {
		return err
	}
	// encoding/json replaces unpaired UTF-16 surrogates. Refuse replacement
	// characters rather than authenticating a silently normalized target.
	if s, ok := t.(string); ok && strings.ContainsRune(s, utf8.RuneError) {
		return errors.New("invalid string")
	}
	delim, ok := t.(json.Delim)
	if !ok {
		return nil
	}
	switch delim {
	case '{':
		seen := map[string]bool{}
		for d.More() {
			k, err := d.Token()
			if err != nil {
				return err
			}
			key, ok := k.(string)
			if !ok || seen[key] {
				return errors.New("duplicate key")
			}
			seen[key] = true
			if err := uniqueValue(d); err != nil {
				return err
			}
		}
	case '[':
		for d.More() {
			if err := uniqueValue(d); err != nil {
				return err
			}
		}
	default:
		return errors.New("unexpected delimiter")
	}
	_, err = d.Token()
	return err
}
