package effectshadowstore

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
)

var safeID = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$`)
var occurrenceID = regexp.MustCompile(`^WFOCCURRENCE-[0-9a-f]{64}$`)
var capability = regexp.MustCompile(`^[a-z][A-Za-z0-9_-]*(?:\.[a-z][A-Za-z0-9_-]*)+$`)
var hash64 = regexp.MustCompile(`^[0-9a-f]{64}$`)

func PrepareObservation(body []byte) (PreparedObservation, error) {
	if len(body) < 2 || len(body) > MaxRequestBytes || body[len(body)-1] != '\n' || (len(body) > 1 && body[len(body)-2] == '\n') || bytes.Contains(body, []byte{'\r'}) {
		return PreparedObservation{}, Failure(ErrorContentInvalid, "effect envelope framing is invalid", nil)
	}
	payload := body[:len(body)-1]
	if err := rejectDuplicateKeys(payload); err != nil {
		return PreparedObservation{}, Failure(ErrorContentInvalid, "effect envelope JSON is invalid", err)
	}
	var envelope Envelope
	decoder := json.NewDecoder(bytes.NewReader(payload))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&envelope); err != nil {
		return PreparedObservation{}, Failure(ErrorContentInvalid, "decode effect envelope", err)
	}
	if err := requireEOF(decoder); err != nil {
		return PreparedObservation{}, Failure(ErrorContentInvalid, "effect envelope contains trailing data", err)
	}
	if err := validateEnvelope(envelope); err != nil {
		return PreparedObservation{}, err
	}
	canonical, err := canonicaljson.Encode(envelope)
	if err != nil || !bytes.Equal(append(canonical, '\n'), body) {
		return PreparedObservation{}, Failure(ErrorContentInvalid, "effect envelope is not exact canonical JSON", err)
	}
	observationBytes, err := canonicaljson.Encode(envelope.Observation)
	if err != nil || len(observationBytes) > MaxObservationBytes {
		return PreparedObservation{}, Failure(ErrorContentInvalid, "canonicalize effect observation", err)
	}
	if envelope.ObservationHash != hashDomain("observation", observationBytes) {
		return PreparedObservation{}, Failure(ErrorContentInvalid, "effect observation hash is mismatched", nil)
	}
	envelopeDigest := sha256.Sum256(body)
	return PreparedObservation{Envelope: envelope, ExactBody: append([]byte(nil), body...), EnvelopeHash: hex.EncodeToString(envelopeDigest[:]), ObservationBytes: observationBytes}, nil
}

func validateEnvelope(e Envelope) error {
	if e.Schema != EnvelopeSchema || e.ContractVersion != ContractVersion || e.Authority != "typescript" || e.GoRole != "observer_only" || e.AuthorityClaim != "NO_AUTHORITY" || !e.NonAuthorizingObservation || e.SourceSequence < 1 || e.SourceSequence > MaxSourceSequence || e.Operation != e.Observation.Operation || e.SourceSequence != e.Observation.ApprovalRevision+1 {
		return Failure(ErrorInputInvalid, "effect envelope identity is invalid", nil)
	}
	if err := ValidateObservation(e.Observation); err != nil {
		return err
	}
	if !hash64.MatchString(e.ObservationHash) {
		return Failure(ErrorInputInvalid, "effect observation hash is invalid", nil)
	}
	return nil
}

func ValidateObservation(o Observation) error {
	if o.Schema != ObservationSchema || o.ContractVersion != ContractVersion || o.Authority != "typescript" || o.GoRole != "observer_only" || o.AuthorityClaim != "NO_AUTHORITY" || !o.NonAuthorizingObservation || o.GoEffectDecisionAuthority || o.GoEffectExecutionAuthority {
		return Failure(ErrorInputInvalid, "effect observer cannot claim authority", nil)
	}
	if !safeID.MatchString(o.WorkspaceID) || !safeID.MatchString(o.RunID) || !occurrenceID.MatchString(o.OccurrenceID) || !safeID.MatchString(o.ApprovalID) || !safeID.MatchString(o.CorrelationID) || !hash64.MatchString(o.ApprovalHash) || !hash64.MatchString(o.EffectHash) || o.EffectID != "workflow-effect:sha256:"+o.EffectHash || !hash64.MatchString(o.RequiredCapabilityHash) || !canonicalTime(o.ObservedAt) {
		return Failure(ErrorInputInvalid, "effect observation identity is invalid", nil)
	}
	created := o.Operation == OperationApprovalCreated && o.ApprovalRevision == 0 && o.ApprovalStatus == "pending" && o.ApprovalDecisionHash == nil && o.HumanDecision == nil && o.BindingHash == nil && o.Decision == nil && o.AuditEventID == nil && o.AuditStatus == nil
	decided := o.Operation == OperationApprovalDecided && o.ApprovalRevision == 1 && (o.ApprovalStatus == "approved" || o.ApprovalStatus == "rejected") && nonnilHash(o.ApprovalDecisionHash) && o.HumanDecision != nil && nonnilHash(o.BindingHash) && o.Decision != nil && *o.Decision == o.ApprovalStatus && o.AuditEventID != nil && safeID.MatchString(*o.AuditEventID) && o.AuditStatus != nil && *o.AuditStatus == "pending"
	recorded := o.Operation == OperationAuditRecorded && o.ApprovalRevision == 2 && (o.ApprovalStatus == "approved" || o.ApprovalStatus == "rejected") && nonnilHash(o.ApprovalDecisionHash) && o.HumanDecision != nil && nonnilHash(o.BindingHash) && o.Decision != nil && *o.Decision == o.ApprovalStatus && o.AuditEventID != nil && safeID.MatchString(*o.AuditEventID) && o.AuditStatus != nil && *o.AuditStatus == "recorded"
	if !created && !decided && !recorded {
		return Failure(ErrorInputInvalid, "effect operation and approval state disagree", nil)
	}
	if o.HumanDecision != nil {
		h := *o.HumanDecision
		if h.Schema != HumanSchema || h.Channel != "local_human_attestation_tty_v1" || !safeID.MatchString(h.PrincipalID) || !safeID.MatchString(h.WorkspaceID) || !capability.MatchString(h.Capability) || !safeID.MatchString(h.RunID) || !safeID.MatchString(h.ApprovalID) || !safeID.MatchString(h.CorrelationID) || (h.Decision != "approved" && h.Decision != "rejected") || !hash64.MatchString(h.ReasonHash) || !hash64.MatchString(h.BindingHash) || !hash64.MatchString(h.AttestationHash) || !canonicalTime(h.ApprovalExpiresAt) || !canonicalTime(h.IssuedAt) || !canonicalTime(h.ExpiresAt) || !canonicalTime(h.DecidedAt) {
			return Failure(ErrorInputInvalid, "effect human decision is invalid", nil)
		}
		if h.WorkspaceID != o.WorkspaceID || h.RunID != o.RunID || h.ApprovalID != o.ApprovalID || h.CorrelationID != o.CorrelationID || h.Decision != *o.Decision || h.BindingHash != *o.BindingHash || o.RequiredCapabilityHash != hashDomain("approval-required-capability", []byte(h.Capability)) || h.AttestationHash != hashCanonicalDomain("human-attestation", map[string]string{"bindingHash": h.BindingHash, "channel": h.Channel}) || (o.Operation == OperationApprovalDecided && h.DecidedAt != o.ObservedAt) {
			return Failure(ErrorInputInvalid, "effect human decision binding drifted", nil)
		}
		issued, _ := time.Parse(timeLayout, h.IssuedAt)
		decidedAt, _ := time.Parse(timeLayout, h.DecidedAt)
		expires, _ := time.Parse(timeLayout, h.ExpiresAt)
		approvalExpires, _ := time.Parse(timeLayout, h.ApprovalExpiresAt)
		if issued.After(decidedAt) || !decidedAt.Before(expires) || expires.After(approvalExpires) || expires.Sub(issued) > time.Minute {
			return Failure(ErrorInputInvalid, "effect human decision time binding drifted", nil)
		}
	}
	if o.AuditEventID != nil && *o.AuditEventID != auditEventID(o.RunID, o.ApprovalID) {
		return Failure(ErrorInputInvalid, "effect audit event identity drifted", nil)
	}
	return nil
}

// Compare verifies the exact three-step TypeScript approval/audit lifecycle.
// A mismatch is observed and permanently latched; it never affects authority.
func Compare(next Envelope, previous *Head) (string, string) {
	if previous != nil && previous.MismatchLatched {
		return "mismatched", "PRIOR_MISMATCH_LATCHED"
	}
	if previous == nil {
		if next.SourceSequence != 1 || next.Operation != OperationApprovalCreated {
			return "mismatched", "INITIAL_SEQUENCE_MISMATCH"
		}
		return "matched", ""
	}
	if previous.Observation == nil || next.SourceSequence != previous.SourceSequence+1 {
		return "mismatched", "SOURCE_SEQUENCE_MISMATCH"
	}
	prior, current := *previous.Observation, next.Observation
	if current.WorkspaceID != prior.WorkspaceID || current.RunID != prior.RunID || current.OccurrenceID != prior.OccurrenceID || current.ApprovalID != prior.ApprovalID || current.EffectID != prior.EffectID || current.EffectHash != prior.EffectHash || current.CorrelationID != prior.CorrelationID || current.RequiredCapabilityHash != prior.RequiredCapabilityHash || current.ApprovalRevision != prior.ApprovalRevision+1 {
		return "mismatched", "EFFECT_HEAD_DRIFT"
	}
	if previous.Operation == OperationApprovalCreated && next.Operation != OperationApprovalDecided {
		return "mismatched", "APPROVAL_TRANSITION_MISMATCH"
	}
	if previous.Operation == OperationApprovalDecided && next.Operation != OperationAuditRecorded {
		return "mismatched", "AUDIT_TRANSITION_MISMATCH"
	}
	if previous.Operation == OperationAuditRecorded {
		return "mismatched", "TERMINAL_SEQUENCE_EXCEEDED"
	}
	if prior.ApprovalDecisionHash != nil && (current.ApprovalDecisionHash == nil || *current.ApprovalDecisionHash != *prior.ApprovalDecisionHash || current.Decision == nil || prior.Decision == nil || *current.Decision != *prior.Decision || current.BindingHash == nil || prior.BindingHash == nil || *current.BindingHash != *prior.BindingHash || !equalHumanDecision(current.HumanDecision, prior.HumanDecision)) {
		return "mismatched", "DECISION_BINDING_DRIFT"
	}
	return "matched", ""
}

func ValidateStoredObservation(operation Operation, sequence int64, observation Observation, observationHash string) error {
	if operation != observation.Operation || sequence != observation.ApprovalRevision+1 || !hash64.MatchString(observationHash) {
		return Failure(ErrorContentInvalid, "stored effect observation binding is invalid", nil)
	}
	return ValidateObservation(observation)
}

func ValidateReceiptValue(v ReceiptValue) error {
	if v.Schema != ReceiptSchema || !IdempotencyKeyMatchesEnvelope(v.IdempotencyKey, v.EnvelopeHash) || !safeID.MatchString(v.ReceiptID) || !safeID.MatchString(v.WorkspaceID) || !safeID.MatchString(v.RunID) || !occurrenceID.MatchString(v.OccurrenceID) || !safeID.MatchString(v.ApprovalID) || v.SourceSequence < 1 || v.SourceSequence > MaxSourceSequence || !validOperation(v.Operation) || !hash64.MatchString(v.ObservationHash) || !hash64.MatchString(v.ServiceBuildHash) {
		return Failure(ErrorContentInvalid, "effect receipt identity is invalid", nil)
	}
	accepted := v.Status == "accepted" && (v.Parity == "matched" || v.Parity == "mismatched") && v.ObservationID != nil && safeID.MatchString(*v.ObservationID) && v.CommittedAt != nil && canonicalTime(*v.CommittedAt) && v.ReconciliationToken == nil && ((v.Parity == "matched") == (v.MismatchCode == nil))
	if accepted && v.MismatchCode != nil && !safeID.MatchString(*v.MismatchCode) {
		accepted = false
	}
	reconciliation := v.Status == "reconciliation_required" && v.Parity == "unknown" && v.ObservationID == nil && v.CommittedAt == nil && v.MismatchCode == nil && v.ReconciliationToken != nil && safeID.MatchString(*v.ReconciliationToken)
	if !accepted && !reconciliation {
		return Failure(ErrorContentInvalid, "effect receipt variant is invalid", nil)
	}
	return nil
}

func ValidateOutboxPayload(v OutboxPayload) error {
	if v.Schema != OutboxPayloadSchema || v.Authority != "typescript" || v.GoRole != "observer_only" || !v.NonAuthorizingObservation || v.GoEffectDecisionAuthority || v.GoEffectExecutionAuthority || !safeID.MatchString(v.EventID) || !safeID.MatchString(v.WorkspaceID) || !safeID.MatchString(v.RunID) || !occurrenceID.MatchString(v.OccurrenceID) || !safeID.MatchString(v.ApprovalID) || !safeID.MatchString(v.ObservationID) || !hash64.MatchString(v.ObservationHash) || !hash64.MatchString(v.BindingHash) || !safeID.MatchString(v.AuditEventID) || !canonicalTime(v.ObservedAt) || (v.ApprovalStatus != "approved" && v.ApprovalStatus != "rejected") || v.Decision != v.ApprovalStatus {
		return Failure(ErrorContentInvalid, "effect outbox payload identity is invalid", nil)
	}
	decision := v.EventType == OutboxEffectDecisionObserved && v.SourceSequence == 2 && v.Operation == OperationApprovalDecided
	audit := v.EventType == OutboxEffectAuditRecorded && v.SourceSequence == 3 && v.Operation == OperationAuditRecorded
	if !decision && !audit {
		return Failure(ErrorContentInvalid, "effect outbox event transition is invalid", nil)
	}
	if v.AuditEventID != auditEventID(v.RunID, v.ApprovalID) {
		return Failure(ErrorContentInvalid, "effect outbox audit identity drifted", nil)
	}
	return nil
}

func ValidateOutboxRead(v OutboxRead) error {
	if v.Schema != OutboxReadSchema || v.Status != "pending" || !safeID.MatchString(v.EventID) || !hash64.MatchString(v.PayloadHash) || !canonicalTime(v.RecordedAt) || v.EventID != v.Payload.EventID || v.EventType != v.Payload.EventType || v.WorkspaceID != v.Payload.WorkspaceID || v.RunID != v.Payload.RunID || v.OccurrenceID != v.Payload.OccurrenceID || v.ApprovalID != v.Payload.ApprovalID || v.SourceSequence != v.Payload.SourceSequence || v.Operation != v.Payload.Operation || v.ObservationID != v.Payload.ObservationID || v.ObservationHash != v.Payload.ObservationHash {
		return Failure(ErrorContentInvalid, "effect outbox read binding is invalid", nil)
	}
	return ValidateOutboxPayload(v.Payload)
}

func EncodeOutboxCursor(recordedAt time.Time, eventID string) (string, error) {
	if recordedAt.IsZero() || !safeID.MatchString(eventID) {
		return "", Failure(ErrorInputInvalid, "effect outbox cursor identity is invalid", nil)
	}
	stamp := recordedAt.UTC().Format(time.RFC3339Nano)
	return base64.RawURLEncoding.EncodeToString([]byte(stamp + "\n" + eventID)), nil
}

func DecodeOutboxCursor(value string) (time.Time, string, error) {
	if value == "" {
		return time.Time{}, "", nil
	}
	if len(value) > 512 {
		return time.Time{}, "", Failure(ErrorInputInvalid, "effect outbox cursor is too large", nil)
	}
	decoded, err := base64.RawURLEncoding.DecodeString(value)
	if err != nil || base64.RawURLEncoding.EncodeToString(decoded) != value {
		return time.Time{}, "", Failure(ErrorInputInvalid, "effect outbox cursor framing is invalid", err)
	}
	parts := bytes.Split(decoded, []byte{'\n'})
	if len(parts) != 2 || !safeID.MatchString(string(parts[1])) {
		return time.Time{}, "", Failure(ErrorInputInvalid, "effect outbox cursor identity is invalid", nil)
	}
	recordedAt, parseErr := time.Parse(time.RFC3339Nano, string(parts[0]))
	if parseErr != nil || recordedAt.Location() != time.UTC || recordedAt.Format(time.RFC3339Nano) != string(parts[0]) {
		return time.Time{}, "", Failure(ErrorInputInvalid, "effect outbox cursor time is invalid", parseErr)
	}
	return recordedAt, string(parts[1]), nil
}

func Fingerprint(method, path, key string, body []byte) string {
	digest := sha256.New()
	_, _ = fmt.Fprintf(digest, "%s\n%s\n%s\n", method, path, key)
	_, _ = digest.Write(body)
	return hex.EncodeToString(digest.Sum(nil))
}

func validIdempotency(v string) bool {
	return len(v) == len(IdempotencyPrefix)+64 && len(v) > 64 && v[:len(IdempotencyPrefix)] == IdempotencyPrefix && hash64.MatchString(v[len(IdempotencyPrefix):])
}
func ValidIdempotencyKey(v string) bool { return validIdempotency(v) }
func IdempotencyKeyMatchesEnvelope(v, envelopeHash string) bool {
	if !validIdempotency(v) || !hash64.MatchString(envelopeHash) {
		return false
	}
	want, err := hex.DecodeString(envelopeHash)
	if err != nil {
		return false
	}
	got, err := hex.DecodeString(v[len(IdempotencyPrefix):])
	return err == nil && subtle.ConstantTimeCompare(got, want) == 1
}
func ValidOccurrenceID(v string) bool        { return occurrenceID.MatchString(v) }
func ValidReconciliationToken(v string) bool { return safeID.MatchString(v) }
func validOperation(v Operation) bool {
	return v == OperationApprovalCreated || v == OperationApprovalDecided || v == OperationAuditRecorded
}
func nonnilHash(v *string) bool { return v != nil && hash64.MatchString(*v) }

const timeLayout = "2006-01-02T15:04:05.000Z"

func canonicalTime(v string) bool {
	t, err := time.Parse(timeLayout, v)
	return err == nil && t.UTC().Format(timeLayout) == v
}
func hashDomain(domain string, canonical []byte) string {
	h := sha256.New()
	_, _ = fmt.Fprintf(h, "openslack.workflow-effect-control.%s.v1%c", domain, byte(0))
	_, _ = h.Write(canonical)
	return hex.EncodeToString(h.Sum(nil))
}
func hashCanonicalDomain(domain string, value any) string {
	canonical, err := canonicaljson.Encode(value)
	if err != nil {
		return ""
	}
	return hashDomain(domain, canonical)
}
func auditEventID(runID, approvalID string) string {
	digest := sha256.Sum256([]byte(runID + "\x00" + approvalID + "\x00decision-revision-1"))
	return "WFAPPROVAL-AUDIT-" + hex.EncodeToString(digest[:])
}
func equalHumanDecision(left, right *HumanDecision) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	a, errA := canonicaljson.Encode(left)
	b, errB := canonicaljson.Encode(right)
	return errA == nil && errB == nil && bytes.Equal(a, b)
}
func requireEOF(d *json.Decoder) error {
	var x any
	if err := d.Decode(&x); err != io.EOF {
		if err == nil {
			return fmt.Errorf("multiple JSON values")
		}
		return err
	}
	return nil
}
func rejectDuplicateKeys(body []byte) error {
	d := json.NewDecoder(bytes.NewReader(body))
	d.UseNumber()
	var parse func(int) error
	parse = func(depth int) error {
		if depth > 24 {
			return fmt.Errorf("JSON depth exceeded")
		}
		t, err := d.Token()
		if err != nil {
			return err
		}
		delim, ok := t.(json.Delim)
		if !ok {
			return nil
		}
		switch delim {
		case '{':
			seen := map[string]struct{}{}
			for d.More() {
				k, err := d.Token()
				if err != nil {
					return err
				}
				key, ok := k.(string)
				if !ok {
					return fmt.Errorf("object key invalid")
				}
				if _, ok := seen[key]; ok {
					return fmt.Errorf("duplicate key %q", key)
				}
				seen[key] = struct{}{}
				if err := parse(depth + 1); err != nil {
					return err
				}
			}
			_, err = d.Token()
			return err
		case '[':
			for d.More() {
				if err := parse(depth + 1); err != nil {
					return err
				}
			}
			_, err = d.Token()
			return err
		default:
			return fmt.Errorf("unexpected delimiter")
		}
	}
	if err := parse(0); err != nil {
		return err
	}
	if d.Decode(&struct{}{}) != io.EOF {
		return fmt.Errorf("trailing JSON")
	}
	return nil
}
