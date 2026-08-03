// Package workflowcontrol provides the pure GS7-A Workflow Control contract
// validator and credential-free projector. It owns no runtime authority.
package workflowcontrol

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"reflect"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"
)

const (
	ObservationSchema = "openslack.workflow_control_observation.v1"
	ReadModelSchema   = "openslack.workflow_control_read_model.v1"
	Authority         = "typescript"
	GoRole            = "credential-free-read-model-only"
	EffectSchema      = "openslack.workflow_effect_approval.v2"

	MaxObservationBytes  = 256 * 1024
	MaxJSONDepth         = 16
	MaxJSONNodes         = 4_096
	MaxIdentifierBytes   = 256
	MaxWorkflowNameBytes = 512
	MaxPhaseNameBytes    = 512
	MaxPhaseCheckpoints  = 256
	MaxBudgetWarnings    = 256
	MaxCount             = 1_000_000
	MaxTokens            = int64(1<<53 - 1)
	MaxCostUSD           = 1_000_000_000
)

type ErrorCode string

const (
	ErrorInvalid               ErrorCode = "WORKFLOW_CONTROL_INVALID"
	ErrorUnknownField          ErrorCode = "WORKFLOW_CONTROL_UNKNOWN_FIELD"
	ErrorLimitExceeded         ErrorCode = "WORKFLOW_CONTROL_LIMIT_EXCEEDED"
	ErrorInvalidTransition     ErrorCode = "WORKFLOW_CONTROL_INVALID_TRANSITION"
	ErrorApprovalPlaneMismatch ErrorCode = "WORKFLOW_CONTROL_APPROVAL_PLANE_MISMATCH"
	ErrorSensitiveField        ErrorCode = "WORKFLOW_CONTROL_SENSITIVE_FIELD_FORBIDDEN"
)

type ContractError struct {
	Code    ErrorCode
	Path    string
	Message string
}

func (value *ContractError) Error() string {
	return fmt.Sprintf("%s at %s: %s", value.Code, value.Path, value.Message)
}

func fail(code ErrorCode, path, message string) error {
	return &ContractError{Code: code, Path: path, Message: message}
}

type RunState string

const (
	RunCreated               RunState = "created"
	RunPreviewed             RunState = "previewed"
	RunConfirmed             RunState = "confirmed"
	RunRunning               RunState = "running"
	RunPaused                RunState = "paused"
	RunPausedWaitingApproval RunState = "paused_waiting_approval"
	RunResuming              RunState = "resuming"
	RunCompleted             RunState = "completed"
	RunFailed                RunState = "failed"
	RunCancelled             RunState = "cancelled"
)

type ExecutionMode string

const (
	ModeValidate ExecutionMode = "validate"
	ModePreview  ExecutionMode = "preview"
	ModeDryRun   ExecutionMode = "dry-run"
	ModeExecute  ExecutionMode = "execute"
)

type CheckpointState string

const (
	CheckpointCompleted CheckpointState = "completed"
	CheckpointFailed    CheckpointState = "failed"
	CheckpointSkipped   CheckpointState = "skipped"
)

type ApprovalCounts struct {
	Pending  int `json:"pending"`
	Approved int `json:"approved"`
	Rejected int `json:"rejected"`
}

type LegacyRunGateApproval struct {
	Plane     string         `json:"plane"`
	Semantics string         `json:"semantics"`
	Counts    ApprovalCounts `json:"counts"`
}

type EffectApprovalSummary struct {
	Plane     string         `json:"plane"`
	Semantics string         `json:"semantics"`
	Schema    string         `json:"schema"`
	Counts    ApprovalCounts `json:"counts"`
}

type ApprovalObservation struct {
	LegacyRunGate LegacyRunGateApproval `json:"legacyRunGate"`
	EffectV2      EffectApprovalSummary `json:"effectV2"`
}

type PhaseObservation struct {
	Phase        string          `json:"phase"`
	ObservedAt   string          `json:"observedAt"`
	Status       CheckpointState `json:"status"`
	ResultHash   *string         `json:"resultHash"`
	CacheKeyHash *string         `json:"cacheKeyHash"`
}

type BudgetWarning struct {
	ObservedAt  string   `json:"observedAt"`
	Kind        string   `json:"kind"`
	TokensUsed  int64    `json:"tokensUsed"`
	TokenBudget int64    `json:"tokenBudget"`
	Percent     float64  `json:"percent"`
	CostUSD     *float64 `json:"costUsd"`
}

type BudgetObservation struct {
	Configured  bool            `json:"configured"`
	PolicyHash  *string         `json:"policyHash"`
	TokenBudget *int64          `json:"tokenBudget"`
	TokensUsed  int64           `json:"tokensUsed"`
	CostUSD     *float64        `json:"costUsd"`
	AgentCalls  int             `json:"agentCalls"`
	Warnings    []BudgetWarning `json:"warnings"`
}

type Observation struct {
	Schema       string              `json:"schema"`
	Authority    string              `json:"authority"`
	RunID        string              `json:"runId"`
	WorkflowName string              `json:"workflowName"`
	Mode         ExecutionMode       `json:"mode"`
	Status       RunState            `json:"status"`
	StartedAt    string              `json:"startedAt"`
	UpdatedAt    string              `json:"updatedAt"`
	ManifestHash string              `json:"manifestHash"`
	CurrentPhase *string             `json:"currentPhase"`
	Phases       []PhaseObservation  `json:"phases"`
	Approvals    ApprovalObservation `json:"approvals"`
	Budget       BudgetObservation   `json:"budget"`
}

type PhaseCounts struct {
	Total             int `json:"total"`
	Completed         int `json:"completed"`
	Failed            int `json:"failed"`
	Skipped           int `json:"skipped"`
	ResultHashBound   int `json:"resultHashBound"`
	CacheKeyHashBound int `json:"cacheKeyHashBound"`
}

type WarningCounts struct {
	Threshold int `json:"threshold"`
	Exceeded  int `json:"exceeded"`
}

type BudgetReadModel struct {
	Configured    bool          `json:"configured"`
	PolicyHash    *string       `json:"policyHash"`
	TokenBudget   *int64        `json:"tokenBudget"`
	TokensUsed    int64         `json:"tokensUsed"`
	CostUSD       *float64      `json:"costUsd"`
	AgentCalls    int           `json:"agentCalls"`
	WarningCounts WarningCounts `json:"warningCounts"`
}

type ReadModel struct {
	Schema            string              `json:"schema"`
	Authority         string              `json:"authority"`
	GoRole            string              `json:"goRole"`
	AuthorityEligible bool                `json:"authorityEligible"`
	RunID             string              `json:"runId"`
	WorkflowName      string              `json:"workflowName"`
	Mode              ExecutionMode       `json:"mode"`
	Status            RunState            `json:"status"`
	StartedAt         string              `json:"startedAt"`
	UpdatedAt         string              `json:"updatedAt"`
	ManifestHash      string              `json:"manifestHash"`
	CurrentPhase      *string             `json:"currentPhase"`
	Terminal          bool                `json:"terminal"`
	PhaseCounts       PhaseCounts         `json:"phaseCounts"`
	Approvals         ApprovalObservation `json:"approvals"`
	Budget            BudgetReadModel     `json:"budget"`
	QualificationGaps []string            `json:"qualificationGaps"`
	ObservationHash   string              `json:"observationHash"`
}

var (
	hashPattern               = regexp.MustCompile(`^[0-9a-f]{64}$`)
	safeIDPattern             = regexp.MustCompile(`^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$`)
	canonicalTimestampPattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)
	transitions               = map[RunState]map[RunState]struct{}{
		RunCreated:               setStates(RunPreviewed, RunConfirmed, RunRunning),
		RunPreviewed:             setStates(RunConfirmed, RunRunning),
		RunConfirmed:             setStates(RunRunning),
		RunRunning:               setStates(RunPaused, RunPausedWaitingApproval, RunResuming, RunCompleted, RunFailed, RunCancelled),
		RunPaused:                setStates(RunRunning),
		RunPausedWaitingApproval: setStates(RunResuming, RunCancelled),
		RunResuming:              setStates(RunRunning, RunFailed, RunCancelled),
		RunCompleted:             {}, RunFailed: {}, RunCancelled: {},
	}
	qualificationGaps = []string{
		"no-cas-or-revision", "no-lease", "no-fencing", "no-execution-abort",
		"no-durable-budget-authority", "resume-correctness-unqualified",
		"control-transition-bypass-exists",
	}
	sensitiveFields = map[string]struct{}{
		"args": {}, "result": {}, "detail": {}, "capability": {}, "decision": {},
		"evidence": {}, "attestationNonce": {}, "nonce": {}, "token": {}, "secret": {},
		"prompt": {}, "output": {},
	}
)

func setStates(values ...RunState) map[RunState]struct{} {
	result := make(map[RunState]struct{}, len(values))
	for _, value := range values {
		result[value] = struct{}{}
	}
	return result
}

func QualificationGaps() []string { return append([]string(nil), qualificationGaps...) }

func ValidateTransition(from, to RunState) error {
	if !validRunState(from) {
		return fail(ErrorInvalid, "$/from", "source state is outside the closed vocabulary")
	}
	if !validRunState(to) {
		return fail(ErrorInvalid, "$/to", "target state is outside the closed vocabulary")
	}
	if _, ok := transitions[from][to]; !ok {
		return fail(ErrorInvalidTransition, "$/transition", fmt.Sprintf("workflow control transition %s -> %s is not in the observed table", from, to))
	}
	return nil
}

func ValidateObservationJSON(input []byte) (Observation, error) {
	if len(input) > MaxObservationBytes {
		return Observation{}, fail(ErrorLimitExceeded, "$", "observation exceeds its byte limit")
	}
	if err := validateEscapedSurrogates(input); err != nil {
		return Observation{}, err
	}
	value, err := parseStrictJSON(input, MaxJSONDepth, MaxJSONNodes)
	if err != nil {
		return Observation{}, err
	}
	if path, ok := sensitivePath(value, "$", 0); ok {
		return Observation{}, fail(ErrorSensitiveField, path, "raw sensitive field is forbidden")
	}
	if err := validateObservationShape(value); err != nil {
		return Observation{}, err
	}

	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.DisallowUnknownFields()
	var observation Observation
	if err := decoder.Decode(&observation); err != nil {
		if strings.Contains(err.Error(), "unknown field") {
			return Observation{}, fail(ErrorUnknownField, "$", err.Error())
		}
		return Observation{}, fail(ErrorInvalid, "$", err.Error())
	}
	if err := requireEOF(decoder); err != nil {
		return Observation{}, fail(ErrorInvalid, "$", err.Error())
	}
	if err := ValidateObservation(observation); err != nil {
		return Observation{}, err
	}
	return observation, nil
}

func ValidateCanonicalObservationBytes(input []byte) (Observation, error) {
	observation, err := ValidateObservationJSON(input)
	if err != nil {
		return Observation{}, err
	}
	canonical, err := CanonicalObservationBytes(observation)
	if err != nil {
		return Observation{}, err
	}
	if !bytes.Equal(input, canonical) {
		return Observation{}, fail(ErrorInvalid, "$", "observation bytes are not canonical")
	}
	return observation, nil
}

func ValidateObservation(value Observation) error {
	if value.Schema != ObservationSchema {
		return fail(ErrorInvalid, "$/schema", "observation schema is unsupported")
	}
	if value.Authority != Authority {
		return fail(ErrorInvalid, "$/authority", "TypeScript must remain the authority")
	}
	if !safeIDPattern.MatchString(value.RunID) || len(value.RunID) > MaxIdentifierBytes {
		return fail(ErrorInvalid, "$/runId", "runId is invalid")
	}
	if !boundedText(value.WorkflowName, MaxWorkflowNameBytes) {
		return fail(ErrorInvalid, "$/workflowName", "workflowName is invalid")
	}
	if !validMode(value.Mode) {
		return fail(ErrorInvalid, "$/mode", "mode is outside the closed vocabulary")
	}
	if !validRunState(value.Status) {
		return fail(ErrorInvalid, "$/status", "status is outside the closed vocabulary")
	}
	started, err := canonicalTime(value.StartedAt)
	if err != nil {
		return fail(ErrorInvalid, "$/startedAt", err.Error())
	}
	updated, err := canonicalTime(value.UpdatedAt)
	if err != nil {
		return fail(ErrorInvalid, "$/updatedAt", err.Error())
	}
	if updated.Before(started) {
		return fail(ErrorInvalid, "$/updatedAt", "updatedAt cannot precede startedAt")
	}
	if !hashPattern.MatchString(value.ManifestHash) {
		return fail(ErrorInvalid, "$/manifestHash", "manifestHash is invalid")
	}
	if value.CurrentPhase != nil && !boundedText(*value.CurrentPhase, MaxPhaseNameBytes) {
		return fail(ErrorInvalid, "$/currentPhase", "currentPhase is invalid")
	}
	if len(value.Phases) > MaxPhaseCheckpoints {
		return fail(ErrorLimitExceeded, "$/phases", "phase checkpoint count exceeds its limit")
	}
	phaseNames := map[string]struct{}{}
	for index := range value.Phases {
		if err := validatePhase(value.Phases[index], index); err != nil {
			return err
		}
		if _, duplicate := phaseNames[value.Phases[index].Phase]; duplicate {
			return fail(ErrorInvalid, "$/phases", "phase names must be unique")
		}
		phaseNames[value.Phases[index].Phase] = struct{}{}
	}
	if err := validateApprovals(value.Approvals); err != nil {
		return err
	}
	return validateBudget(value.Budget)
}

func CanonicalObservationBytes(value Observation) ([]byte, error) {
	if err := ValidateObservation(value); err != nil {
		return nil, err
	}
	return canonicalJSON(value)
}

func HashObservation(value Observation) (string, error) {
	canonical, err := CanonicalObservationBytes(value)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(canonical)
	return hex.EncodeToString(digest[:]), nil
}

func ProjectReadModel(value Observation) (ReadModel, error) {
	if err := ValidateObservation(value); err != nil {
		return ReadModel{}, err
	}
	hash, err := HashObservation(value)
	if err != nil {
		return ReadModel{}, err
	}
	result := ReadModel{
		Schema: ReadModelSchema, Authority: Authority, GoRole: GoRole, AuthorityEligible: false,
		RunID: value.RunID, WorkflowName: value.WorkflowName, Mode: value.Mode, Status: value.Status,
		StartedAt: value.StartedAt, UpdatedAt: value.UpdatedAt, ManifestHash: value.ManifestHash,
		CurrentPhase: value.CurrentPhase, Terminal: isTerminal(value.Status),
		Approvals: value.Approvals, ObservationHash: hash, QualificationGaps: QualificationGaps(),
		Budget: BudgetReadModel{Configured: value.Budget.Configured, PolicyHash: value.Budget.PolicyHash,
			TokenBudget: value.Budget.TokenBudget, TokensUsed: value.Budget.TokensUsed,
			CostUSD: value.Budget.CostUSD, AgentCalls: value.Budget.AgentCalls},
	}
	result.PhaseCounts.Total = len(value.Phases)
	for _, phase := range value.Phases {
		switch phase.Status {
		case CheckpointCompleted:
			result.PhaseCounts.Completed++
		case CheckpointFailed:
			result.PhaseCounts.Failed++
		case CheckpointSkipped:
			result.PhaseCounts.Skipped++
		}
		if phase.ResultHash != nil {
			result.PhaseCounts.ResultHashBound++
		}
		if phase.CacheKeyHash != nil {
			result.PhaseCounts.CacheKeyHashBound++
		}
	}
	for _, warning := range value.Budget.Warnings {
		if warning.Kind == "threshold" {
			result.Budget.WarningCounts.Threshold++
		} else if warning.Kind == "exceeded" {
			result.Budget.WarningCounts.Exceeded++
		}
	}
	return result, nil
}

func CanonicalReadModelBytes(value ReadModel) ([]byte, error) { return canonicalJSON(value) }

func validatePhase(value PhaseObservation, index int) error {
	path := fmt.Sprintf("$/phases/%d", index)
	if !boundedText(value.Phase, MaxPhaseNameBytes) {
		return fail(ErrorInvalid, path+"/phase", "phase is invalid")
	}
	if _, err := canonicalTime(value.ObservedAt); err != nil {
		return fail(ErrorInvalid, path+"/observedAt", err.Error())
	}
	if value.Status != CheckpointCompleted && value.Status != CheckpointFailed && value.Status != CheckpointSkipped {
		return fail(ErrorInvalid, path+"/status", "checkpoint state is outside the closed vocabulary")
	}
	if value.ResultHash != nil && !hashPattern.MatchString(*value.ResultHash) {
		return fail(ErrorInvalid, path+"/resultHash", "result hash is invalid")
	}
	if value.CacheKeyHash != nil && !hashPattern.MatchString(*value.CacheKeyHash) {
		return fail(ErrorInvalid, path+"/cacheKeyHash", "cache key hash is invalid")
	}
	return nil
}

func validateApprovals(value ApprovalObservation) error {
	if value.LegacyRunGate.Plane != "legacy-run-gate" || value.LegacyRunGate.Semantics != "run-gate-only" {
		return fail(ErrorApprovalPlaneMismatch, "$/approvals/legacyRunGate", "legacy approvals are run gates only")
	}
	if value.EffectV2.Plane != "workflow-effect-v2" || value.EffectV2.Semantics != "effect-decision-only" || value.EffectV2.Schema != EffectSchema {
		return fail(ErrorApprovalPlaneMismatch, "$/approvals/effectV2", "effect decisions require workflow_effect_approval.v2")
	}
	if !validCounts(value.LegacyRunGate.Counts) || !validCounts(value.EffectV2.Counts) {
		return fail(ErrorInvalid, "$/approvals", "approval counts are invalid")
	}
	return nil
}

func validateBudget(value BudgetObservation) error {
	if !value.Configured && (value.PolicyHash != nil || value.TokenBudget != nil) {
		return fail(ErrorInvalid, "$/budget", "unconfigured budget cannot advertise policy or token limits")
	}
	if value.PolicyHash != nil && !hashPattern.MatchString(*value.PolicyHash) {
		return fail(ErrorInvalid, "$/budget/policyHash", "policy hash is invalid")
	}
	if value.TokenBudget != nil && (*value.TokenBudget < 0 || *value.TokenBudget > MaxTokens) {
		return fail(ErrorInvalid, "$/budget/tokenBudget", "token budget is invalid")
	}
	if value.TokensUsed < 0 || value.TokensUsed > MaxTokens {
		return fail(ErrorInvalid, "$/budget/tokensUsed", "tokens used is invalid")
	}
	if value.CostUSD != nil && (!finiteRange(*value.CostUSD, MaxCostUSD)) {
		return fail(ErrorInvalid, "$/budget/costUsd", "cost is invalid")
	}
	if value.AgentCalls < 0 || value.AgentCalls > MaxCount {
		return fail(ErrorInvalid, "$/budget/agentCalls", "agent call count is invalid")
	}
	if len(value.Warnings) > MaxBudgetWarnings {
		return fail(ErrorLimitExceeded, "$/budget/warnings", "warning count exceeds its limit")
	}
	for index, warning := range value.Warnings {
		path := fmt.Sprintf("$/budget/warnings/%d", index)
		if _, err := canonicalTime(warning.ObservedAt); err != nil {
			return fail(ErrorInvalid, path+"/observedAt", err.Error())
		}
		if warning.Kind != "threshold" && warning.Kind != "exceeded" {
			return fail(ErrorInvalid, path+"/kind", "warning kind is invalid")
		}
		if warning.TokensUsed < 0 || warning.TokensUsed > MaxTokens || warning.TokenBudget < 0 || warning.TokenBudget > MaxTokens {
			return fail(ErrorInvalid, path, "warning token values are invalid")
		}
		if !finiteRange(warning.Percent, MaxCount) {
			return fail(ErrorInvalid, path+"/percent", "warning percent is invalid")
		}
		if warning.CostUSD != nil && !finiteRange(*warning.CostUSD, MaxCostUSD) {
			return fail(ErrorInvalid, path+"/costUsd", "warning cost is invalid")
		}
	}
	return nil
}

func validCounts(value ApprovalCounts) bool {
	return value.Pending >= 0 && value.Pending <= MaxCount && value.Approved >= 0 && value.Approved <= MaxCount && value.Rejected >= 0 && value.Rejected <= MaxCount
}
func finiteRange(value float64, maximum float64) bool {
	return !math.IsNaN(value) && !math.IsInf(value, 0) && value >= 0 && value <= maximum
}
func boundedText(value string, maximum int) bool {
	return value != "" && utf8.ValidString(value) && len([]byte(value)) <= maximum
}
func validMode(value ExecutionMode) bool {
	return value == ModeValidate || value == ModePreview || value == ModeDryRun || value == ModeExecute
}
func validRunState(value RunState) bool { _, ok := transitions[value]; return ok }
func isTerminal(value RunState) bool {
	return value == RunCompleted || value == RunFailed || value == RunCancelled
}

func canonicalTime(value string) (time.Time, error) {
	if !canonicalTimestampPattern.MatchString(value) {
		return time.Time{}, errors.New("timestamp is not canonical RFC3339 milliseconds")
	}
	parsed, err := time.Parse("2006-01-02T15:04:05.000Z", value)
	if err != nil || parsed.UTC().Format("2006-01-02T15:04:05.000Z") != value {
		return time.Time{}, errors.New("timestamp is not canonical RFC3339 milliseconds")
	}
	return parsed, nil
}

func requireEOF(decoder *json.Decoder) error {
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		if err == nil {
			return errors.New("JSON contains trailing value")
		}
		return err
	}
	return nil
}

func validateObservationShape(value any) error {
	root, err := requireClosedObject(value, "$", []string{
		"schema", "authority", "runId", "workflowName", "mode", "status", "startedAt",
		"updatedAt", "manifestHash", "currentPhase", "phases", "approvals", "budget",
	})
	if err != nil {
		return err
	}
	if err := requireNonNull(root, "$", []string{
		"schema", "authority", "runId", "workflowName", "mode", "status", "startedAt",
		"updatedAt", "manifestHash", "phases", "approvals", "budget",
	}); err != nil {
		return err
	}
	phases, err := requireArray(root["phases"], "$/phases")
	if err != nil {
		return err
	}
	for index, phaseValue := range phases {
		phasePath := fmt.Sprintf("$/phases/%d", index)
		phase, err := requireClosedObject(phaseValue, phasePath, []string{
			"phase", "observedAt", "status", "resultHash", "cacheKeyHash",
		})
		if err != nil {
			return err
		}
		if err := requireNonNull(phase, phasePath, []string{"phase", "observedAt", "status"}); err != nil {
			return err
		}
	}
	approvals, err := requireClosedObject(root["approvals"], "$/approvals", []string{"legacyRunGate", "effectV2"})
	if err != nil {
		return err
	}
	if err := requireNonNull(approvals, "$/approvals", []string{"legacyRunGate", "effectV2"}); err != nil {
		return err
	}
	legacy, err := requireClosedObject(approvals["legacyRunGate"], "$/approvals/legacyRunGate", []string{"plane", "semantics", "counts"})
	if err != nil {
		return err
	}
	if err := requireNonNull(legacy, "$/approvals/legacyRunGate", []string{"plane", "semantics", "counts"}); err != nil {
		return err
	}
	legacyCounts, err := requireClosedObject(legacy["counts"], "$/approvals/legacyRunGate/counts", []string{"pending", "approved", "rejected"})
	if err != nil {
		return err
	}
	if err := requireNonNull(legacyCounts, "$/approvals/legacyRunGate/counts", []string{"pending", "approved", "rejected"}); err != nil {
		return err
	}
	effect, err := requireClosedObject(approvals["effectV2"], "$/approvals/effectV2", []string{"plane", "semantics", "schema", "counts"})
	if err != nil {
		return err
	}
	if err := requireNonNull(effect, "$/approvals/effectV2", []string{"plane", "semantics", "schema", "counts"}); err != nil {
		return err
	}
	effectCounts, err := requireClosedObject(effect["counts"], "$/approvals/effectV2/counts", []string{"pending", "approved", "rejected"})
	if err != nil {
		return err
	}
	if err := requireNonNull(effectCounts, "$/approvals/effectV2/counts", []string{"pending", "approved", "rejected"}); err != nil {
		return err
	}
	budget, err := requireClosedObject(root["budget"], "$/budget", []string{
		"configured", "policyHash", "tokenBudget", "tokensUsed", "costUsd", "agentCalls", "warnings",
	})
	if err != nil {
		return err
	}
	if err := requireNonNull(budget, "$/budget", []string{"configured", "tokensUsed", "agentCalls", "warnings"}); err != nil {
		return err
	}
	warnings, err := requireArray(budget["warnings"], "$/budget/warnings")
	if err != nil {
		return err
	}
	for index, warningValue := range warnings {
		warningPath := fmt.Sprintf("$/budget/warnings/%d", index)
		warning, err := requireClosedObject(warningValue, warningPath, []string{
			"observedAt", "kind", "tokensUsed", "tokenBudget", "percent", "costUsd",
		})
		if err != nil {
			return err
		}
		if err := requireNonNull(warning, warningPath, []string{"observedAt", "kind", "tokensUsed", "tokenBudget", "percent"}); err != nil {
			return err
		}
	}
	return nil
}

func requireClosedObject(value any, path string, required []string) (map[string]any, error) {
	record, ok := value.(map[string]any)
	if !ok {
		return nil, fail(ErrorInvalid, path, path+" must be a non-null object")
	}
	allowed := make(map[string]struct{}, len(required))
	for _, field := range required {
		allowed[field] = struct{}{}
		if _, present := record[field]; !present {
			return nil, fail(ErrorInvalid, path+"/"+field, "required field is missing")
		}
	}
	for field := range record {
		if _, present := allowed[field]; !present {
			return nil, fail(ErrorUnknownField, path+"/"+field, "unknown field")
		}
	}
	return record, nil
}

func requireArray(value any, path string) ([]any, error) {
	result, ok := value.([]any)
	if !ok {
		return nil, fail(ErrorInvalid, path, path+" must be a non-null array")
	}
	return result, nil
}

func requireNonNull(record map[string]any, path string, fields []string) error {
	for _, field := range fields {
		if record[field] == nil {
			return fail(ErrorInvalid, path+"/"+field, "required field cannot be null")
		}
	}
	return nil
}

func validateEscapedSurrogates(input []byte) error {
	inString := false
	for index := 0; index < len(input); index++ {
		switch input[index] {
		case '"':
			inString = !inString
		case '\\':
			if !inString || index+1 >= len(input) {
				continue
			}
			if input[index+1] != 'u' {
				index++
				continue
			}
			unit, ok := decodeHexUnit(input, index+2)
			if !ok {
				continue
			}
			index += 5
			if unit >= 0xd800 && unit <= 0xdbff {
				if index+6 >= len(input) || input[index+1] != '\\' || input[index+2] != 'u' {
					return fail(ErrorInvalid, "$", "JSON string contains an unpaired Unicode surrogate")
				}
				low, valid := decodeHexUnit(input, index+3)
				if !valid || low < 0xdc00 || low > 0xdfff {
					return fail(ErrorInvalid, "$", "JSON string contains an unpaired Unicode surrogate")
				}
				index += 6
			} else if unit >= 0xdc00 && unit <= 0xdfff {
				return fail(ErrorInvalid, "$", "JSON string contains an unpaired Unicode surrogate")
			}
		}
	}
	return nil
}

func decodeHexUnit(input []byte, start int) (uint16, bool) {
	if start+4 > len(input) {
		return 0, false
	}
	var value uint16
	for _, digit := range input[start : start+4] {
		value <<= 4
		switch {
		case digit >= '0' && digit <= '9':
			value |= uint16(digit - '0')
		case digit >= 'a' && digit <= 'f':
			value |= uint16(digit-'a') + 10
		case digit >= 'A' && digit <= 'F':
			value |= uint16(digit-'A') + 10
		default:
			return 0, false
		}
	}
	return value, true
}

func parseStrictJSON(input []byte, maxDepth, maxNodes int) (any, error) {
	if len(input) >= 3 && bytes.Equal(input[:3], []byte{0xef, 0xbb, 0xbf}) {
		return nil, fail(ErrorInvalid, "$", "UTF-8 BOM is forbidden")
	}
	if !utf8.Valid(input) {
		return nil, fail(ErrorInvalid, "$", "JSON is not valid UTF-8")
	}
	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.UseNumber()
	nodes := 0
	value, err := parseJSONValue(decoder, 1, maxDepth, maxNodes, &nodes, "$")
	if err != nil {
		return nil, err
	}
	if err := requireEOF(decoder); err != nil {
		return nil, fail(ErrorInvalid, "$", err.Error())
	}
	return value, nil
}

func parseJSONValue(decoder *json.Decoder, depth, maxDepth, maxNodes int, nodes *int, path string) (any, error) {
	if depth > maxDepth {
		return nil, fail(ErrorLimitExceeded, path, "JSON depth exceeds its limit")
	}
	*nodes++
	if *nodes > maxNodes {
		return nil, fail(ErrorLimitExceeded, path, "JSON node count exceeds its limit")
	}
	token, err := decoder.Token()
	if err != nil {
		return nil, fail(ErrorInvalid, path, err.Error())
	}
	if delimiter, ok := token.(json.Delim); ok {
		switch delimiter {
		case '{':
			result := map[string]any{}
			seen := map[string]struct{}{}
			for decoder.More() {
				keyToken, keyErr := decoder.Token()
				if keyErr != nil {
					return nil, fail(ErrorInvalid, path, keyErr.Error())
				}
				key, ok := keyToken.(string)
				if !ok {
					return nil, fail(ErrorInvalid, path, "object key is not a string")
				}
				if _, duplicate := seen[key]; duplicate {
					return nil, fail(ErrorInvalid, path+"/"+key, "duplicate JSON object key")
				}
				seen[key] = struct{}{}
				item, itemErr := parseJSONValue(decoder, depth+1, maxDepth, maxNodes, nodes, path+"/"+key)
				if itemErr != nil {
					return nil, itemErr
				}
				result[key] = item
			}
			if closeToken, closeErr := decoder.Token(); closeErr != nil || closeToken != json.Delim('}') {
				return nil, fail(ErrorInvalid, path, "object is not closed")
			}
			return result, nil
		case '[':
			result := []any{}
			for index := 0; decoder.More(); index++ {
				item, itemErr := parseJSONValue(decoder, depth+1, maxDepth, maxNodes, nodes, fmt.Sprintf("%s/%d", path, index))
				if itemErr != nil {
					return nil, itemErr
				}
				result = append(result, item)
			}
			if closeToken, closeErr := decoder.Token(); closeErr != nil || closeToken != json.Delim(']') {
				return nil, fail(ErrorInvalid, path, "array is not closed")
			}
			return result, nil
		default:
			return nil, fail(ErrorInvalid, path, "unexpected JSON delimiter")
		}
	}
	return token, nil
}

func sensitivePath(value any, path string, depth int) (string, bool) {
	if depth > 32 {
		return path, true
	}
	switch current := value.(type) {
	case map[string]any:
		for key, item := range current {
			if _, blocked := sensitiveFields[key]; blocked {
				return path + "/" + key, true
			}
			if found, ok := sensitivePath(item, path+"/"+key, depth+1); ok {
				return found, true
			}
		}
	case []any:
		for index, item := range current {
			if found, ok := sensitivePath(item, fmt.Sprintf("%s/%d", path, index), depth+1); ok {
				return found, true
			}
		}
	}
	return "", false
}

func canonicalJSON(value any) ([]byte, error) {
	var output bytes.Buffer
	if err := appendCanonical(&output, reflect.ValueOf(value)); err != nil {
		return nil, err
	}
	return output.Bytes(), nil
}

func appendCanonical(output *bytes.Buffer, value reflect.Value) error {
	if !value.IsValid() {
		output.WriteString("null")
		return nil
	}
	for value.Kind() == reflect.Interface || value.Kind() == reflect.Pointer {
		if value.IsNil() {
			output.WriteString("null")
			return nil
		}
		value = value.Elem()
	}
	switch value.Kind() {
	case reflect.Bool:
		output.WriteString(strconv.FormatBool(value.Bool()))
	case reflect.String:
		if err := appendJSONString(output, value.String()); err != nil {
			return err
		}
	case reflect.Int, reflect.Int8, reflect.Int16, reflect.Int32, reflect.Int64:
		output.WriteString(strconv.FormatInt(value.Int(), 10))
	case reflect.Uint, reflect.Uint8, reflect.Uint16, reflect.Uint32, reflect.Uint64:
		output.WriteString(strconv.FormatUint(value.Uint(), 10))
	case reflect.Float32, reflect.Float64:
		number, err := formatNumber(value.Float())
		if err != nil {
			return err
		}
		output.WriteString(number)
	case reflect.Slice, reflect.Array:
		output.WriteByte('[')
		for index := 0; index < value.Len(); index++ {
			if index > 0 {
				output.WriteByte(',')
			}
			if err := appendCanonical(output, value.Index(index)); err != nil {
				return err
			}
		}
		output.WriteByte(']')
	case reflect.Struct:
		type field struct {
			name  string
			value reflect.Value
		}
		fields := []field{}
		typeInfo := value.Type()
		for index := 0; index < value.NumField(); index++ {
			descriptor := typeInfo.Field(index)
			if !descriptor.IsExported() {
				continue
			}
			name := strings.Split(descriptor.Tag.Get("json"), ",")[0]
			if name == "-" {
				continue
			}
			if name == "" {
				name = descriptor.Name
			}
			fields = append(fields, field{name, value.Field(index)})
		}
		sort.Slice(fields, func(left, right int) bool { return utf16Less(fields[left].name, fields[right].name) })
		output.WriteByte('{')
		for index, current := range fields {
			if index > 0 {
				output.WriteByte(',')
			}
			if err := appendJSONString(output, current.name); err != nil {
				return err
			}
			output.WriteByte(':')
			if err := appendCanonical(output, current.value); err != nil {
				return err
			}
		}
		output.WriteByte('}')
	default:
		return fail(ErrorInvalid, "$", fmt.Sprintf("unsupported canonical value kind %s", value.Kind()))
	}
	return nil
}

func appendJSONString(output *bytes.Buffer, value string) error {
	if !utf8.ValidString(value) {
		return fail(ErrorInvalid, "$", "canonical JSON rejects invalid UTF-8")
	}
	const hexDigits = "0123456789abcdef"
	output.WriteByte('"')
	for _, character := range value {
		switch character {
		case '"':
			output.WriteString(`\"`)
		case '\\':
			output.WriteString(`\\`)
		case '\b':
			output.WriteString(`\b`)
		case '\t':
			output.WriteString(`\t`)
		case '\n':
			output.WriteString(`\n`)
		case '\f':
			output.WriteString(`\f`)
		case '\r':
			output.WriteString(`\r`)
		default:
			if character < 0x20 {
				output.WriteString(`\u00`)
				output.WriteByte(hexDigits[byte(character)>>4])
				output.WriteByte(hexDigits[byte(character)&0x0f])
			} else {
				output.WriteRune(character)
			}
		}
	}
	output.WriteByte('"')
	return nil
}

func utf16Less(left, right string) bool {
	leftUnits := utf16.Encode([]rune(left))
	rightUnits := utf16.Encode([]rune(right))
	limit := min(len(leftUnits), len(rightUnits))
	for index := 0; index < limit; index++ {
		if leftUnits[index] != rightUnits[index] {
			return leftUnits[index] < rightUnits[index]
		}
	}
	return len(leftUnits) < len(rightUnits)
}

func formatNumber(value float64) (string, error) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return "", fail(ErrorInvalid, "$", "canonical JSON rejects non-finite number")
	}
	if value == 0 {
		return "0", nil
	}
	absolute := math.Abs(value)
	if absolute >= 1e-6 && absolute < 1e21 {
		return strconv.FormatFloat(value, 'f', -1, 64), nil
	}
	result := strconv.FormatFloat(value, 'e', -1, 64)
	exponent := strings.LastIndexByte(result, 'e')
	prefix, suffix := result[:exponent+1], result[exponent+1:]
	sign := ""
	if strings.HasPrefix(suffix, "+") || strings.HasPrefix(suffix, "-") {
		sign, suffix = suffix[:1], suffix[1:]
	}
	suffix = strings.TrimLeft(suffix, "0")
	if suffix == "" {
		suffix = "0"
	}
	return prefix + sign + suffix, nil
}
