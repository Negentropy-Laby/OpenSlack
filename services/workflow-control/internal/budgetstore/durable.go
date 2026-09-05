package budgetstore

import (
	"bytes"
	"encoding/json"
	"io"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
)

const (
	DurableRecordSchema       = "openslack.workflow_control_budget_durable_record.v1"
	DurableWriter             = "workflow-control/budget-authority-server"
	DurableAuthorityMode      = "local-qualification-v1"
	ContractManifestSHA256    = "83e5f88e01cbeb5e301004c34ed7cad446b98a59812771a9bf3be562a0509b3b"
	MaxDurableAccountBytes    = 128 * 1024
	MaxDurableRecordBytes     = 512 * 1024
	RecordKindAccount         = "account"
	RecordKindReserveDecision = "reserve_decision"
	RecordKindReservation     = "reservation"
	RecordKindSettlement      = "settlement"
	RecordKindLedgerEntry     = "ledger_entry"
	RecordKindReceipt         = "receipt"
	RecordKindReconciliation  = "reconciliation"
)

// DurableRecord is the Go-owned, qualification-only persistence authority.
// OperationalProjection remains the frozen TypeScript-owned E1 validation
// projection and therefore does not itself claim Go write authority.
type DurableRecord struct {
	Schema                    string                `json:"schema"`
	Authority                 string                `json:"authority"`
	Writer                    string                `json:"writer"`
	AuthorityMode             string                `json:"authorityMode"`
	ProductionAuthority       bool                  `json:"productionAuthority"`
	ContractManifestSHA256    string                `json:"contractManifestSha256"`
	AuthorityBuildHash        string                `json:"authorityBuildHash"`
	RecordKind                string                `json:"recordKind"`
	OperationalProjection     budgetcontract.Record `json:"operationalProjection"`
	OperationalProjectionHash string                `json:"operationalProjectionHash"`
}

func NewDurableRecord(kind string, projection budgetcontract.Record, authorityBuildHash string) (DurableRecord, error) {
	validated, domain, err := validateProjection(kind, projection)
	if err != nil {
		return DurableRecord{}, Failure(ErrorContentInvalid, "validate durable budget operational projection", err)
	}
	hash, err := budgetcontract.HashValue(domain, validated)
	if err != nil {
		return DurableRecord{}, Failure(ErrorContentInvalid, "hash durable budget operational projection", err)
	}
	return ValidateDurableRecord(DurableRecord{
		Schema: DurableRecordSchema, Authority: Authority, Writer: DurableWriter,
		AuthorityMode: DurableAuthorityMode, ProductionAuthority: false,
		ContractManifestSHA256: ContractManifestSHA256, AuthorityBuildHash: authorityBuildHash,
		RecordKind: kind, OperationalProjection: validated, OperationalProjectionHash: hash,
	})
}

func ValidateDurableRecord(value DurableRecord) (DurableRecord, error) {
	if value.Schema != DurableRecordSchema || value.Authority != Authority || value.Writer != DurableWriter ||
		value.AuthorityMode != DurableAuthorityMode || value.ProductionAuthority ||
		(value.ContractManifestSHA256 != ContractManifestSHA256 && value.ContractManifestSHA256 != budgetcontract.PreviousManifestSHA256) ||
		!isLowerHash(value.AuthorityBuildHash) || !isLowerHash(value.OperationalProjectionHash) {
		return DurableRecord{}, Failure(ErrorContentInvalid, "durable budget authority envelope binding is invalid", nil)
	}
	projection, domain, err := validateProjection(value.RecordKind, value.OperationalProjection)
	if err != nil {
		return DurableRecord{}, Failure(ErrorContentInvalid, "durable budget operational projection is invalid", err)
	}
	want, err := budgetcontract.HashValue(domain, projection)
	projectionBuild := durableProjectionBuild(value.RecordKind, projection)
	if err != nil || want != value.OperationalProjectionHash || projectionBuild != "" && projectionBuild != value.AuthorityBuildHash {
		return DurableRecord{}, Failure(ErrorContentInvalid, "durable budget operational projection hash is invalid", err)
	}
	value.OperationalProjection = projection
	return value, nil
}

func durableProjectionBuild(kind string, projection budgetcontract.Record) string {
	var route budgetcontract.Record
	switch kind {
	case RecordKindAccount, RecordKindReservation:
		route, _ = projection["route"].(budgetcontract.Record)
	case RecordKindReserveDecision, RecordKindSettlement:
		request, _ := projection["request"].(budgetcontract.Record)
		route, _ = request["route"].(budgetcontract.Record)
	case RecordKindReceipt:
		build, _ := projection["serviceBuildHash"].(string)
		return build
	}
	if route == nil {
		return ""
	}
	build, _ := route["authorityBuildHash"].(string)
	return build
}

func EncodeDurableRecord(value DurableRecord) ([]byte, error) {
	validated, err := ValidateDurableRecord(value)
	if err != nil {
		return nil, err
	}
	exact, err := canonicaljson.Encode(validated)
	if err != nil {
		return nil, Failure(ErrorContentInvalid, "encode durable budget authority record", err)
	}
	limit := MaxDurableRecordBytes
	if validated.RecordKind == RecordKindAccount {
		limit = MaxDurableAccountBytes
	}
	if len(exact) < 1 || len(exact) > limit {
		return nil, Failure(ErrorContentInvalid, "durable budget authority record exceeds byte limit", nil)
	}
	return exact, nil
}

func DecodeDurableRecord(contents []byte) (DurableRecord, error) {
	if len(contents) < 1 || len(contents) > MaxDurableRecordBytes {
		return DurableRecord{}, Failure(ErrorIntegrity, "stored durable budget authority record framing is invalid", nil)
	}
	decoder := json.NewDecoder(bytes.NewReader(contents))
	decoder.DisallowUnknownFields()
	decoder.UseNumber()
	var value DurableRecord
	if err := decoder.Decode(&value); err != nil {
		return DurableRecord{}, Failure(ErrorIntegrity, "stored durable budget authority record is invalid", err)
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		return DurableRecord{}, Failure(ErrorIntegrity, "stored durable budget authority record has trailing content", err)
	}
	validated, err := ValidateDurableRecord(value)
	if err != nil {
		return DurableRecord{}, Failure(ErrorIntegrity, "stored durable budget authority record is invalid", err)
	}
	exact, err := EncodeDurableRecord(validated)
	if err != nil || !bytes.Equal(exact, contents) {
		return DurableRecord{}, Failure(ErrorIntegrity, "stored durable budget authority record is not canonical", err)
	}
	return validated, nil
}

func validateProjection(kind string, value any) (budgetcontract.Record, string, error) {
	switch kind {
	case RecordKindAccount:
		record, err := budgetcontract.ValidateAccount(value)
		return record, "account", err
	case RecordKindReserveDecision:
		record, err := budgetcontract.ValidateReserveDecision(value)
		return record, "reserve-decision", err
	case RecordKindReservation:
		record, err := budgetcontract.ValidateReservation(value)
		return record, "reservation", err
	case RecordKindSettlement:
		record, err := budgetcontract.ValidateSettlement(value)
		return record, "settlement", err
	case RecordKindLedgerEntry:
		record, err := budgetcontract.ValidateLedgerEntry(value)
		return record, "ledger-entry", err
	case RecordKindReceipt:
		record, err := budgetcontract.ValidateReceipt(value)
		return record, "receipt", err
	case RecordKindReconciliation:
		record, err := budgetcontract.ValidateReconciliation(value)
		return record, "reconciliation", err
	default:
		return nil, "", Failure(ErrorContentInvalid, "durable budget record kind is invalid", nil)
	}
}

func isLowerHash(value string) bool {
	if len(value) != 64 {
		return false
	}
	for _, current := range []byte(value) {
		if current < '0' || current > '9' && current < 'a' || current > 'f' {
			return false
		}
	}
	return true
}
