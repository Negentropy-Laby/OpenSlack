package authoritystore

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"strconv"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
)

const maxSafeInteger = authoritycontract.MaxSafeInteger

var (
	identifierPattern  = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$`)
	hashPattern        = regexp.MustCompile(`^[0-9a-f]{64}$`)
	fingerprintPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	idempotencyPattern = regexp.MustCompile(`^openslack\.workflow-control-authority\.v2\.[0-9a-f]{64}$`)
)

func PrepareRequest(body []byte, callerID, workspaceID, routingEpoch, expectedBuild string) (PreparedRequest, error) {
	if len(body) == 0 || len(body) > MaxRequestBytes {
		return PreparedRequest{}, Failure(ErrorInputInvalid, "request body exceeds the byte limit", nil)
	}
	epoch, err := parseRoutingEpoch(routingEpoch)
	if !identifierPattern.MatchString(callerID) || !identifierPattern.MatchString(workspaceID) || err != nil || !hashPattern.MatchString(expectedBuild) {
		return PreparedRequest{}, Failure(ErrorInputInvalid, "authority request bindings are invalid", err)
	}

	decoder := json.NewDecoder(bytes.NewReader(body))
	decoder.DisallowUnknownFields()
	var envelope RequestEnvelope
	if err := decoder.Decode(&envelope); err != nil {
		return PreparedRequest{}, Failure(ErrorContentInvalid, "authority request is not closed JSON", err)
	}
	if err := requireEOF(decoder); err != nil {
		return PreparedRequest{}, Failure(ErrorContentInvalid, "authority request has trailing content", err)
	}
	canonical, err := canonicaljson.Encode(envelope)
	if err != nil || !bytes.Equal(append(canonical, '\n'), body) {
		return PreparedRequest{}, Failure(ErrorContentInvalid, "authority request is not exact canonical JSON plus LF", err)
	}
	if err := validateEnvelope(envelope, callerID, workspaceID, epoch, expectedBuild); err != nil {
		return PreparedRequest{}, err
	}
	recordBytes, err := canonicaljson.Encode(envelope.Record)
	if err != nil {
		return PreparedRequest{}, Failure(ErrorContentInvalid, "canonicalize target run record", err)
	}
	recordBytes = append(recordBytes, '\n')
	recordDigest := sha256.Sum256(recordBytes)
	requestDigest := sha256.Sum256(body)
	return PreparedRequest{
		Envelope: envelope, CallerID: callerID, ExpectedServiceBuild: expectedBuild,
		RecordBytes: recordBytes, RecordHash: hex.EncodeToString(recordDigest[:]),
		RequestHash: hex.EncodeToString(requestDigest[:]), ExactBody: append([]byte(nil), body...),
	}, nil
}

func validateEnvelope(value RequestEnvelope, callerID, workspaceID string, routingEpoch int64, expectedBuild string) error {
	if value.Operation != OperationAccept && value.Operation != OperationTransition {
		return Failure(ErrorContentInvalid, "authority operation is invalid", nil)
	}
	wantSchema := TransitionSchema
	if value.Operation == OperationAccept {
		wantSchema = AcceptSchema
	}
	if value.Schema != wantSchema || value.WorkspaceID != workspaceID || !identifierPattern.MatchString(value.RunID) || !identifierPattern.MatchString(value.CorrelationID) {
		return Failure(ErrorContentInvalid, "authority request schema or identity is invalid", nil)
	}
	if err := validateRoute(value.Route, routingEpoch, expectedBuild); err != nil {
		return err
	}
	record := value.Record
	if record.Schema != RunRecordSchema || record.WorkspaceID != value.WorkspaceID || record.RunID != value.RunID ||
		!identifierPattern.MatchString(record.WorkflowID) || !identifierPattern.MatchString(record.WorkflowVersion) ||
		!hashPattern.MatchString(record.WorkflowSourceHash) || !hashPattern.MatchString(record.ManifestHash) || !hashPattern.MatchString(record.InputHash) ||
		record.Route != value.Route || record.Revision != value.Expected.Revision+1 || record.Revision < 1 || record.Revision > maxSafeInteger {
		return Failure(ErrorContentInvalid, "target run record binding is invalid", nil)
	}
	if err := validateRoute(record.Route, routingEpoch, expectedBuild); err != nil {
		return err
	}
	if !validState(record.State) || !phasePair(record.CurrentPhaseID, record.CurrentPhaseIndex) || !phasePair(value.Expected.CurrentPhaseID, value.Expected.CurrentPhaseIndex) ||
		record.ResumeGeneration < 0 || record.ResumeGeneration > maxSafeInteger || value.Expected.ResumeGeneration < 0 || value.Expected.ResumeGeneration > maxSafeInteger {
		return Failure(ErrorContentInvalid, "run state, phase, or resume generation is invalid", nil)
	}
	if value.Operation == OperationAccept {
		if value.Expected.Revision != 0 || value.Expected.State != nil || value.Expected.CurrentPhaseID != nil || value.Expected.CurrentPhaseIndex != nil ||
			value.Expected.ResumeGeneration != 0 || record.State != authoritycontract.RunCreated || record.CurrentPhaseID != nil ||
			record.CurrentPhaseIndex != nil || record.ResumeGeneration != 0 {
			return Failure(ErrorConflict, "accept must create revision one in created state from an absent head", nil)
		}
		return nil
	}
	if value.Expected.Revision < 1 || value.Expected.Revision >= maxSafeInteger || value.Expected.State == nil || !validState(*value.Expected.State) {
		return Failure(ErrorConflict, "transition expected binding is invalid", nil)
	}
	if err := authoritycontract.ValidateTransition(*value.Expected.State, record.State); err != nil {
		return Failure(ErrorConflict, "run state transition is invalid", err)
	}
	if record.ResumeGeneration < value.Expected.ResumeGeneration || record.ResumeGeneration > value.Expected.ResumeGeneration+1 {
		return Failure(ErrorConflict, "resume generation must remain unchanged or advance exactly once", nil)
	}
	return nil
}

func validateRoute(value Route, routingEpoch int64, expectedBuild string) error {
	if value.Backend != Backend || value.Authority != Authority || value.RoutingEpoch != routingEpoch || value.AuthorityBuildHash != expectedBuild {
		return Failure(ErrorContentInvalid, "only the exact Go qualification route is accepted", nil)
	}
	return nil
}

func validState(value RunState) bool {
	for _, candidate := range authoritycontract.RunStates() {
		if value == candidate {
			return true
		}
	}
	return false
}

func phasePair(id *string, index *int64) bool {
	if (id == nil) != (index == nil) {
		return false
	}
	if id == nil {
		return true
	}
	return identifierPattern.MatchString(*id) && *index >= 0 && *index <= maxSafeInteger
}

func RequestFingerprint(method, path string, prepared PreparedRequest) string {
	digest := sha256.New()
	_, _ = digest.Write([]byte(method + "\n" + path + "\n" + prepared.CallerID + "\n" + prepared.Envelope.WorkspaceID + "\n" +
		strconv.FormatInt(prepared.Envelope.Route.RoutingEpoch, 10) + "\n" + prepared.ExpectedServiceBuild + "\n"))
	_, _ = digest.Write(prepared.ExactBody)
	return "sha256:" + hex.EncodeToString(digest.Sum(nil))
}

func RequestPath(operation Operation, runID string) string {
	if operation == OperationAccept {
		return "/v1/workflow-control/runs:accept"
	}
	if operation != OperationTransition || !identifierPattern.MatchString(runID) {
		return ""
	}
	return "/v1/workflow-control/runs/" + runID + ":transition"
}

func ExpectedIdempotencyKey(exactBody []byte) string {
	digest := sha256.Sum256(exactBody)
	return IdempotencyPrefix + hex.EncodeToString(digest[:])
}

func ValidateIdempotencyKey(value string) error {
	if !idempotencyPattern.MatchString(value) {
		return Failure(ErrorInputInvalid, "Idempotency-Key is not a bounded authority key", nil)
	}
	return nil
}

func ValidateReadIdentity(workspaceID, runID string) error {
	if !identifierPattern.MatchString(workspaceID) || !identifierPattern.MatchString(runID) {
		return Failure(ErrorInputInvalid, "authority read identity is invalid", nil)
	}
	return nil
}

func ValidateReceiptIdentity(workspaceID, key string) error {
	if !identifierPattern.MatchString(workspaceID) {
		return Failure(ErrorInputInvalid, "authority receipt workspace is invalid", nil)
	}
	return ValidateIdempotencyKey(key)
}

func ParseFingerprint(value string) ([sha256.Size]byte, error) {
	var result [sha256.Size]byte
	if !fingerprintPattern.MatchString(value) {
		return result, Failure(ErrorInputInvalid, "request fingerprint is invalid", nil)
	}
	raw, err := hex.DecodeString(value[len("sha256:"):])
	if err != nil || len(raw) != sha256.Size {
		return result, Failure(ErrorInputInvalid, "request fingerprint is invalid", err)
	}
	copy(result[:], raw)
	return result, nil
}

func parseRoutingEpoch(value string) (int64, error) {
	if value == "" || value[0] == '0' {
		return 0, fmt.Errorf("routing epoch is not canonical positive decimal")
	}
	for _, current := range value {
		if current < '0' || current > '9' {
			return 0, fmt.Errorf("routing epoch is not canonical positive decimal")
		}
	}
	epoch, err := strconv.ParseInt(value, 10, 64)
	if err != nil || epoch < 1 || epoch > maxSafeInteger {
		return 0, fmt.Errorf("routing epoch exceeds the safe integer range")
	}
	return epoch, nil
}

func requireEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return fmt.Errorf("multiple JSON values")
		}
		return err
	}
	return nil
}
