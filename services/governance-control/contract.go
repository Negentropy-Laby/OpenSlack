package governancecontrol

import (
	"bytes"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/hex"
	"errors"
	"fmt"
	"math"
	"regexp"
	"strconv"
	"unicode/utf16"

	"github.com/Negentropy-Laby/OpenSlack/services/governance-control/internal/canonicaljson"
)

type ErrorCode string

const (
	ErrorInvalid         ErrorCode = "GOVERNED_PLAN_INVALID"
	ErrorLimitExceeded   ErrorCode = "GOVERNED_PLAN_LIMIT_EXCEEDED"
	ErrorBindingMismatch ErrorCode = "GOVERNED_PLAN_BINDING_MISMATCH"
)

const (
	MaxDepth                   = 12
	MaxNodes                   = 10_000
	MaxContainerEntries        = 1_000
	MaxStringBytes             = 64 * 1024
	MaxObjectKeyBytes          = 256
	MaxActions                 = 32
	MaxEffects                 = 64
	MaxGoalBytes               = 4_096
	MaxEffectSummaryBytes      = 2_048
	MaxSummaryBytes            = 4_096
	MaxEvidenceRefBytes        = 2_048
	MinOpaqueBindingCharacters = 16
	MaxOpaqueBindingCharacters = 4_096
	MaxRecordBytes             = 1024 * 1024
)

const (
	AlgorithmCanonicalJSON        = "openslack.ecmascript_canonical_json.v1"
	AlgorithmGovernedValueHash    = "sha256(canonical_json_utf8)"
	AlgorithmOpaqueValueHash      = "sha256(ecmascript_string_utf8)"
	AlgorithmOpaqueHashComparison = "constant_time_sha256_bytes"
)

type ContractError struct {
	Code    ErrorCode `json:"code"`
	Path    string    `json:"path"`
	Message string    `json:"message"`
}

func (value *ContractError) Error() string {
	return fmt.Sprintf("%s at %s: %s", value.Code, value.Path, value.Message)
}

func fail(code ErrorCode, path, message string) error {
	return &ContractError{Code: code, Path: path, Message: message}
}

type State string

const (
	StatePending                State = "pending"
	StateExecuting              State = "executing"
	StateSucceeded              State = "succeeded"
	StateBlocked                State = "blocked"
	StateFailed                 State = "failed"
	StateReconciliationRequired State = "reconciliation_required"
	StateCancelled              State = "cancelled"
	StateExpired                State = "expired"
)

var transitions = map[State]map[State]struct{}{
	StatePending: {
		StateExecuting: {}, StateCancelled: {}, StateExpired: {},
	},
	StateExecuting: {
		StateSucceeded: {}, StateBlocked: {}, StateFailed: {}, StateReconciliationRequired: {},
	},
	StateSucceeded: {}, StateBlocked: {}, StateFailed: {}, StateReconciliationRequired: {},
	StateCancelled: {}, StateExpired: {},
}

func CanTransition(from, to State) bool {
	allowed, exists := transitions[from]
	if !exists {
		return false
	}
	_, exists = allowed[to]
	return exists
}

type Record struct {
	planID        string
	revision      int
	state         State
	kind          string
	goal          string
	actorID       string
	workspaceID   string
	correlationID string
	createdAt     string
	updatedAt     string
	expiresAt     string
	actionCount   int
	effectCount   int
	inputHash     string
	planHash      string
	execution     *execution
	root          canonicaljson.Object
}

type execution struct {
	executionID      string
	startedAt        string
	completedAt      string
	outcomeCount     int
	evidenceRefCount int
	blocker          string
	failure          string
}

type ExecutionReadModel struct {
	ExecutionID      string `json:"executionId"`
	StartedAt        string `json:"startedAt"`
	CompletedAt      string `json:"completedAt,omitempty"`
	OutcomeCount     int    `json:"outcomeCount"`
	EvidenceRefCount int    `json:"evidenceRefCount"`
	Blocker          string `json:"blocker,omitempty"`
	Failure          string `json:"failure,omitempty"`
}

type ReadModel struct {
	Schema                 string              `json:"schema"`
	PlanID                 string              `json:"planId"`
	Revision               int                 `json:"revision"`
	State                  State               `json:"state"`
	Kind                   string              `json:"kind"`
	Goal                   string              `json:"goal"`
	ActorID                string              `json:"actorId"`
	WorkspaceID            string              `json:"workspaceId"`
	CorrelationID          string              `json:"correlationId"`
	CreatedAt              string              `json:"createdAt"`
	UpdatedAt              string              `json:"updatedAt"`
	ExpiresAt              string              `json:"expiresAt"`
	ActionCount            int                 `json:"actionCount"`
	EffectCount            int                 `json:"effectCount"`
	InputHash              string              `json:"inputHash"`
	PlanHash               string              `json:"planHash"`
	ConfirmationBound      bool                `json:"confirmationBound"`
	ExecutionTerminal      bool                `json:"executionTerminal"`
	Final                  bool                `json:"final"`
	ReconciliationRequired bool                `json:"reconciliationRequired"`
	Execution              *ExecutionReadModel `json:"execution,omitempty"`
}

func Project(record Record) (ReadModel, error) {
	if record.root == nil {
		return ReadModel{}, fail(ErrorInvalid, "$", "Governed plan record has no validated canonical value.")
	}
	validated, err := validateRecord(record.root)
	if err != nil {
		return ReadModel{}, err
	}
	result := ReadModel{
		Schema: "openslack.governed_plan_read_model.v1", PlanID: validated.planID,
		Revision: validated.revision, State: validated.state, Kind: validated.kind, Goal: validated.goal,
		ActorID: validated.actorID, WorkspaceID: validated.workspaceID, CorrelationID: validated.correlationID,
		CreatedAt: validated.createdAt, UpdatedAt: validated.updatedAt, ExpiresAt: validated.expiresAt,
		ActionCount: validated.actionCount, EffectCount: validated.effectCount,
		InputHash: validated.inputHash, PlanHash: validated.planHash, ConfirmationBound: true,
		ExecutionTerminal:      validated.execution != nil && validated.execution.completedAt != "",
		Final:                  validated.state != StatePending && validated.state != StateExecuting,
		ReconciliationRequired: validated.state == StateReconciliationRequired,
	}
	if validated.execution != nil {
		result.Execution = &ExecutionReadModel{
			ExecutionID: validated.execution.executionID, StartedAt: validated.execution.startedAt,
			CompletedAt: validated.execution.completedAt, OutcomeCount: validated.execution.outcomeCount,
			EvidenceRefCount: validated.execution.evidenceRefCount,
			Blocker:          validated.execution.blocker, Failure: validated.execution.failure,
		}
	}
	return result, nil
}

var (
	identifierPattern  = regexp.MustCompile(`^[a-zA-Z0-9][a-zA-Z0-9._:@/-]{0,255}$`)
	kindPattern        = regexp.MustCompile(`^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$`)
	hashPattern        = regexp.MustCompile(`^[0-9a-f]{64}$`)
	planIDPattern      = regexp.MustCompile(`^GPLAN-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	executionIDPattern = regexp.MustCompile(`^GEXEC-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	timestampPattern   = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)
)

func parseValue(input []byte) (canonicaljson.Value, error) {
	value, err := canonicaljson.Parse(input, canonicaljson.Limits{
		MaxDepth: MaxDepth + 1, MaxNodes: MaxNodes, MaxStringLength: MaxStringBytes,
	})
	if err != nil {
		var structured *canonicaljson.Error
		if errors.As(err, &structured) && structured.Code == canonicaljson.ErrorLimit {
			return nil, fail(ErrorLimitExceeded, "$", structured.Message)
		}
		return nil, fail(ErrorInvalid, "$", err.Error())
	}
	if err := validateValueLimits(value, "$", 0, new(int)); err != nil {
		return nil, err
	}
	if _, err := canonicaljson.Encode(value); err != nil {
		return nil, fail(ErrorInvalid, "$", err.Error())
	}
	return value, nil
}

func validateValueLimits(value canonicaljson.Value, path string, depth int, nodes *int) error {
	*nodes++
	if *nodes > MaxNodes || depth > MaxDepth {
		return fail(ErrorLimitExceeded, path, "Governed JSON exceeds the host-owned structural limit.")
	}
	switch current := value.(type) {
	case string:
		if len([]byte(current)) > MaxStringBytes {
			return fail(ErrorLimitExceeded, path, "String exceeds the host-owned byte limit.")
		}
	case canonicaljson.Array:
		if len(current) > MaxContainerEntries {
			return fail(ErrorLimitExceeded, path, "Array exceeds the host-owned entry limit.")
		}
		for index, item := range current {
			if err := validateValueLimits(item, fmt.Sprintf("%s/%d", path, index), depth+1, nodes); err != nil {
				return err
			}
		}
	case canonicaljson.Object:
		if len(current) > MaxContainerEntries {
			return fail(ErrorLimitExceeded, path, "Object exceeds the host-owned entry limit.")
		}
		for key, item := range current {
			if len([]byte(key)) > MaxObjectKeyBytes {
				return fail(ErrorLimitExceeded, path+"/"+key, "Object key is too long.")
			}
			if err := validateValueLimits(item, path+"/"+key, depth+1, nodes); err != nil {
				return err
			}
		}
	}
	return nil
}

func ValidateRecordJSON(input []byte) (Record, error) {
	value, err := parseValue(input)
	if err != nil {
		return Record{}, err
	}
	root, ok := value.(canonicaljson.Object)
	if !ok {
		return Record{}, fail(ErrorInvalid, "$", "record must be an object.")
	}
	return validateRecord(root)
}

func ValidateCanonicalRecordBytes(input []byte) (Record, error) {
	if len(input) > MaxRecordBytes {
		return Record{}, fail(ErrorLimitExceeded, "$", "Governed plan record exceeds the byte limit.")
	}
	record, err := ValidateRecordJSON(input)
	if err != nil {
		return Record{}, err
	}
	canonical, err := CanonicalRecordBytes(record)
	if err != nil {
		return Record{}, err
	}
	if !bytes.Equal(canonical, input) {
		return Record{}, fail(ErrorInvalid, "$", "Governed plan record is not exact canonical JSON plus LF.")
	}
	return record, nil
}

func CanonicalRecordBytes(record Record) ([]byte, error) {
	if record.root == nil {
		return nil, fail(ErrorInvalid, "$", "Governed plan record has no validated canonical value.")
	}
	encoded, err := canonicaljson.Encode(record.root)
	if err != nil {
		return nil, fail(ErrorInvalid, "$", err.Error())
	}
	return append(encoded, '\n'), nil
}

func validateRecord(root canonicaljson.Object) (Record, error) {
	if err := exactKeys(root,
		[]string{"schema", "revision", "planId", "state", "createdAt", "updatedAt", "expiresAt", "canonicalPlan", "bindings", "confirmationTokenHash"},
		[]string{"execution"}, "$", "record"); err != nil {
		return Record{}, err
	}
	if schema, err := requiredString(root, "schema", nil, 64, "$", "schema"); err != nil || schema != "openslack.governed_plan.v1" {
		if err != nil {
			return Record{}, err
		}
		return Record{}, fail(ErrorInvalid, "$", "Governed plan record schema is invalid.")
	}
	revision, err := requiredInteger(root, "revision", 1, 9_007_199_254_740_991, "$")
	if err != nil {
		return Record{}, err
	}
	planID, err := requiredString(root, "planId", planIDPattern, 512, "$", "planId")
	if err != nil {
		return Record{}, err
	}
	stateText, err := requiredString(root, "state", nil, 64, "$", "state")
	if err != nil {
		return Record{}, err
	}
	state := State(stateText)
	if _, exists := transitions[state]; !exists {
		return Record{}, fail(ErrorInvalid, "$/state", "state is invalid.")
	}
	createdAt, err := requiredTimestamp(root, "createdAt", "$")
	if err != nil {
		return Record{}, err
	}
	updatedAt, err := requiredTimestamp(root, "updatedAt", "$")
	if err != nil {
		return Record{}, err
	}
	expiresAt, err := requiredTimestamp(root, "expiresAt", "$")
	if err != nil {
		return Record{}, err
	}
	planObject, err := requiredObject(root, "canonicalPlan", "$")
	if err != nil {
		return Record{}, err
	}
	plan, err := validatePlan(planObject)
	if err != nil {
		return Record{}, err
	}
	bindingsObject, err := requiredObject(root, "bindings", "$")
	if err != nil {
		return Record{}, err
	}
	bindings, err := validateBindings(bindingsObject)
	if err != nil {
		return Record{}, err
	}
	if _, err := requiredString(root, "confirmationTokenHash", hashPattern, 64, "$", "confirmationTokenHash"); err != nil {
		return Record{}, err
	}
	inputHash, err := hashValue(plan.input)
	if err != nil {
		return Record{}, err
	}
	if !OpaqueHashesEqual(inputHash, bindings.inputHash) {
		return Record{}, fail(ErrorBindingMismatch, "$", "Input hash does not match canonical input.")
	}
	planHash, err := hashValue(planObject)
	if err != nil {
		return Record{}, err
	}
	if !OpaqueHashesEqual(planHash, bindings.planHash) {
		return Record{}, fail(ErrorBindingMismatch, "$", "Plan hash does not match canonical plan.")
	}
	var execution *execution
	if value, exists := root["execution"]; exists {
		object, ok := value.(canonicaljson.Object)
		if !ok {
			return Record{}, fail(ErrorInvalid, "$/execution", "execution must be an object.")
		}
		execution, err = validateExecution(object)
		if err != nil {
			return Record{}, err
		}
	}
	if state == StatePending && execution != nil {
		return Record{}, fail(ErrorInvalid, "$", "Pending plan cannot have execution state.")
	}
	if state == StateExecuting && (execution == nil || execution.completedAt != "") {
		return Record{}, fail(ErrorInvalid, "$", "Executing plan must have an open execution.")
	}
	if (state == StateSucceeded || state == StateBlocked || state == StateFailed || state == StateReconciliationRequired) && (execution == nil || execution.completedAt == "") {
		return Record{}, fail(ErrorInvalid, "$", "Terminal execution state is incomplete.")
	}
	if (state == StateCancelled || state == StateExpired) && execution != nil {
		return Record{}, fail(ErrorInvalid, "$", "Non-executed terminal plan cannot have execution.")
	}
	return Record{
		planID: planID, revision: revision, state: state, kind: plan.kind, goal: plan.goal,
		actorID: bindings.actorID, workspaceID: bindings.workspaceID, correlationID: bindings.correlationID,
		createdAt: createdAt, updatedAt: updatedAt, expiresAt: expiresAt,
		actionCount: plan.actionCount, effectCount: plan.effectCount,
		inputHash: bindings.inputHash, planHash: bindings.planHash, execution: execution, root: root,
	}, nil
}

type validatedPlan struct {
	kind, goal               string
	input                    canonicaljson.Value
	actionCount, effectCount int
}

func validatePlan(value canonicaljson.Object) (validatedPlan, error) {
	if err := exactKeys(value, []string{"schema", "kind", "goal", "input", "actions", "effects"}, nil, "$/canonicalPlan", "canonicalPlan"); err != nil {
		return validatedPlan{}, err
	}
	schema, err := requiredString(value, "schema", nil, 64, "$/canonicalPlan", "schema")
	if err != nil || schema != "openslack.governed_action_plan.v1" {
		if err != nil {
			return validatedPlan{}, err
		}
		return validatedPlan{}, fail(ErrorInvalid, "$/canonicalPlan/schema", "Canonical plan schema is invalid.")
	}
	kind, err := requiredString(value, "kind", kindPattern, 512, "$/canonicalPlan", "kind")
	if err != nil {
		return validatedPlan{}, err
	}
	goal, err := requiredString(value, "goal", nil, MaxGoalBytes, "$/canonicalPlan", "goal")
	if err != nil {
		return validatedPlan{}, err
	}
	input, exists := value["input"]
	if !exists {
		return validatedPlan{}, fail(ErrorInvalid, "$/canonicalPlan", "canonicalPlan is missing field input.")
	}
	actions, err := requiredArray(value, "actions", "$/canonicalPlan")
	if err != nil {
		return validatedPlan{}, err
	}
	if len(actions) < 1 || len(actions) > MaxActions {
		return validatedPlan{}, fail(ErrorLimitExceeded, "$/canonicalPlan/actions", "Governed plan must contain between 1 and 32 actions.")
	}
	for index, item := range actions {
		action, ok := item.(canonicaljson.Object)
		if !ok {
			return validatedPlan{}, fail(ErrorInvalid, fmt.Sprintf("$/canonicalPlan/actions/%d", index), "action must be an object.")
		}
		if err := exactKeys(action, []string{"actionId", "input"}, nil, fmt.Sprintf("$/canonicalPlan/actions/%d", index), "action"); err != nil {
			return validatedPlan{}, err
		}
		if _, err := requiredString(action, "actionId", kindPattern, 512, "$/canonicalPlan/actions", "actionId"); err != nil {
			return validatedPlan{}, err
		}
	}
	effects, err := requiredArray(value, "effects", "$/canonicalPlan")
	if err != nil {
		return validatedPlan{}, err
	}
	if len(effects) > MaxEffects {
		return validatedPlan{}, fail(ErrorLimitExceeded, "$/canonicalPlan/effects", "Governed plan has too many effects.")
	}
	for index, item := range effects {
		effect, ok := item.(canonicaljson.Object)
		path := fmt.Sprintf("$/canonicalPlan/effects/%d", index)
		if !ok {
			return validatedPlan{}, fail(ErrorInvalid, path, "effect must be an object.")
		}
		if err := exactKeys(effect, []string{"type", "summary", "risk"}, []string{"target"}, path, "effect"); err != nil {
			return validatedPlan{}, err
		}
		if _, err := requiredString(effect, "type", kindPattern, 512, path, "type"); err != nil {
			return validatedPlan{}, err
		}
		if _, err := requiredString(effect, "summary", nil, MaxEffectSummaryBytes, path, "summary"); err != nil {
			return validatedPlan{}, err
		}
		risk, err := requiredString(effect, "risk", nil, 16, path, "risk")
		if err != nil || (risk != "low" && risk != "medium" && risk != "high") {
			if err != nil {
				return validatedPlan{}, err
			}
			return validatedPlan{}, fail(ErrorInvalid, path+"/risk", "risk is invalid.")
		}
		if _, exists := effect["target"]; exists {
			if _, err := requiredString(effect, "target", identifierPattern, 512, path, "target"); err != nil {
				return validatedPlan{}, err
			}
		}
	}
	return validatedPlan{kind: kind, goal: goal, input: input, actionCount: len(actions), effectCount: len(effects)}, nil
}

type validatedBindings struct{ actorID, workspaceID, correlationID, inputHash, planHash string }

func validateBindings(value canonicaljson.Object) (validatedBindings, error) {
	keys := []string{"actorId", "workspaceId", "correlationId", "inputHash", "planHash", "sourceVersionHash", "permissionSnapshotHash", "actionCatalogHash", "executorBindingHash", "buildNonceHash", "processNonceHash"}
	if err := exactKeys(value, keys, nil, "$/bindings", "bindings"); err != nil {
		return validatedBindings{}, err
	}
	actorID, err := requiredString(value, "actorId", identifierPattern, 512, "$/bindings", "actorId")
	if err != nil {
		return validatedBindings{}, err
	}
	workspaceID, err := requiredString(value, "workspaceId", identifierPattern, 512, "$/bindings", "workspaceId")
	if err != nil {
		return validatedBindings{}, err
	}
	correlationID, err := requiredString(value, "correlationId", identifierPattern, 512, "$/bindings", "correlationId")
	if err != nil {
		return validatedBindings{}, err
	}
	hashes := map[string]string{}
	for _, key := range keys[3:] {
		hashes[key], err = requiredString(value, key, hashPattern, 64, "$/bindings", key)
		if err != nil {
			return validatedBindings{}, err
		}
	}
	return validatedBindings{actorID: actorID, workspaceID: workspaceID, correlationID: correlationID, inputHash: hashes["inputHash"], planHash: hashes["planHash"]}, nil
}

func validateExecution(value canonicaljson.Object) (*execution, error) {
	path := "$/execution"
	if err := exactKeys(value, []string{"executionId", "ownerPid", "startedAt", "outcomes"}, []string{"completedAt", "blocker", "failure"}, path, "execution"); err != nil {
		return nil, err
	}
	executionID, err := requiredString(value, "executionId", executionIDPattern, 512, path, "executionId")
	if err != nil {
		return nil, err
	}
	if _, err := requiredInteger(value, "ownerPid", 1, 2_147_483_647, path); err != nil {
		return nil, err
	}
	startedAt, err := requiredTimestamp(value, "startedAt", path)
	if err != nil {
		return nil, err
	}
	completedAt := ""
	if _, exists := value["completedAt"]; exists {
		completedAt, err = requiredTimestamp(value, "completedAt", path)
		if err != nil {
			return nil, err
		}
	}
	outcomes, err := requiredArray(value, "outcomes", path)
	if err != nil {
		return nil, err
	}
	evidenceCount := 0
	for index, item := range outcomes {
		outcome, ok := item.(canonicaljson.Object)
		itemPath := fmt.Sprintf("%s/outcomes/%d", path, index)
		if !ok {
			return nil, fail(ErrorInvalid, itemPath, "outcome must be an object.")
		}
		if err := exactKeys(outcome, []string{"actionId", "status", "summary", "evidenceRefs"}, []string{"data"}, itemPath, "outcome"); err != nil {
			return nil, err
		}
		if _, err := requiredString(outcome, "actionId", kindPattern, 512, itemPath, "actionId"); err != nil {
			return nil, err
		}
		status, err := requiredString(outcome, "status", nil, 32, itemPath, "status")
		if err != nil || (status != "succeeded" && status != "blocked" && status != "failed") {
			if err != nil {
				return nil, err
			}
			return nil, fail(ErrorInvalid, itemPath+"/status", "status is invalid.")
		}
		if _, err := requiredString(outcome, "summary", nil, MaxSummaryBytes, itemPath, "summary"); err != nil {
			return nil, err
		}
		refs, err := requiredArray(outcome, "evidenceRefs", itemPath)
		if err != nil {
			return nil, err
		}
		for _, ref := range refs {
			text, ok := ref.(string)
			if !ok || text == "" || len([]byte(text)) > MaxEvidenceRefBytes {
				return nil, fail(ErrorInvalid, itemPath+"/evidenceRefs", "evidenceRef is invalid.")
			}
		}
		evidenceCount += len(refs)
	}
	blocker, failure := "", ""
	if _, exists := value["blocker"]; exists {
		blocker, err = requiredString(value, "blocker", nil, MaxSummaryBytes, path, "blocker")
		if err != nil {
			return nil, err
		}
	}
	if _, exists := value["failure"]; exists {
		failure, err = requiredString(value, "failure", nil, MaxSummaryBytes, path, "failure")
		if err != nil {
			return nil, err
		}
	}
	return &execution{executionID: executionID, startedAt: startedAt, completedAt: completedAt, outcomeCount: len(outcomes), evidenceRefCount: evidenceCount, blocker: blocker, failure: failure}, nil
}

func exactKeys(value canonicaljson.Object, required, optional []string, path, label string) error {
	allowed := map[string]struct{}{}
	for _, key := range append(append([]string{}, required...), optional...) {
		allowed[key] = struct{}{}
	}
	for key := range value {
		if _, exists := allowed[key]; !exists {
			return fail(ErrorInvalid, path, label+" contains unknown field "+key+".")
		}
	}
	for _, key := range required {
		if _, exists := value[key]; !exists {
			return fail(ErrorInvalid, path, label+" is missing field "+key+".")
		}
	}
	return nil
}

func requiredObject(value canonicaljson.Object, key, path string) (canonicaljson.Object, error) {
	current, exists := value[key]
	if !exists {
		return nil, fail(ErrorInvalid, path, "missing field "+key+".")
	}
	result, ok := current.(canonicaljson.Object)
	if !ok {
		return nil, fail(ErrorInvalid, path+"/"+key, key+" must be an object.")
	}
	return result, nil
}

func requiredArray(value canonicaljson.Object, key, path string) (canonicaljson.Array, error) {
	current, exists := value[key]
	if !exists {
		return nil, fail(ErrorInvalid, path, "missing field "+key+".")
	}
	result, ok := current.(canonicaljson.Array)
	if !ok {
		return nil, fail(ErrorInvalid, path+"/"+key, key+" must be an array.")
	}
	return result, nil
}

func requiredString(value canonicaljson.Object, key string, pattern *regexp.Regexp, maxBytes int, path, label string) (string, error) {
	current, exists := value[key]
	text, ok := current.(string)
	if !exists || !ok || text == "" || len([]byte(text)) > maxBytes || (pattern != nil && !pattern.MatchString(text)) {
		return "", fail(ErrorInvalid, path+"/"+key, label+" is invalid.")
	}
	return text, nil
}

func requiredInteger(value canonicaljson.Object, key string, minimum, maximum int, path string) (int, error) {
	current, exists := value[key]
	number, ok := current.(float64)
	if !exists || !ok || math.Trunc(number) != number || number < float64(minimum) || number > float64(maximum) {
		return 0, fail(ErrorInvalid, path+"/"+key, key+" is invalid.")
	}
	return int(number), nil
}

func requiredTimestamp(value canonicaljson.Object, key, path string) (string, error) {
	text, err := requiredString(value, key, timestampPattern, 24, path, key)
	if err != nil {
		return "", err
	}
	if !validECMAScriptTimestamp(text) {
		return "", fail(ErrorInvalid, path+"/"+key, key+" is not a valid timestamp.")
	}
	return text, nil
}

func validECMAScriptTimestamp(value string) bool {
	parts := [7]int{}
	ranges := [7][2]int{{0, 4}, {5, 7}, {8, 10}, {11, 13}, {14, 16}, {17, 19}, {20, 23}}
	for index, bounds := range ranges {
		parsed, err := strconv.Atoi(value[bounds[0]:bounds[1]])
		if err != nil {
			return false
		}
		parts[index] = parsed
	}
	month, day, hour, minute, second, millisecond := parts[1], parts[2], parts[3], parts[4], parts[5], parts[6]
	if month < 1 || month > 12 || day < 1 || day > 31 || hour < 0 || hour > 24 || minute < 0 || minute > 59 || second < 0 || second > 59 || millisecond < 0 || millisecond > 999 {
		return false
	}
	return hour != 24 || (minute == 0 && second == 0 && millisecond == 0)
}

func hashValue(value canonicaljson.Value) (string, error) {
	encoded, err := canonicaljson.Encode(value)
	if err != nil {
		return "", fail(ErrorInvalid, "$", err.Error())
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:]), nil
}

func HashGovernedJSON(input []byte) ([]byte, string, error) {
	value, err := parseValue(input)
	if err != nil {
		return nil, "", err
	}
	encoded, err := canonicaljson.Encode(value)
	if err != nil {
		return nil, "", fail(ErrorInvalid, "$", err.Error())
	}
	sum := sha256.Sum256(encoded)
	return encoded, hex.EncodeToString(sum[:]), nil
}

func HashOpaque(value string) (string, error) {
	units, valid := canonicaljson.UTF16CodeUnits(value, MaxOpaqueBindingCharacters)
	if !valid || len(units) < MinOpaqueBindingCharacters || len(units) > MaxOpaqueBindingCharacters {
		return "", fail(ErrorInvalid, "$", "Opaque binding value is outside allowed bounds.")
	}
	encoded := make([]byte, 0, len(value))
	for index := 0; index < len(units); index++ {
		current := units[index]
		if current >= 0xd800 && current <= 0xdbff && index+1 < len(units) && units[index+1] >= 0xdc00 && units[index+1] <= 0xdfff {
			encoded = append(encoded, string(utf16.DecodeRune(rune(current), rune(units[index+1])))...)
			index++
		} else if current >= 0xd800 && current <= 0xdfff {
			encoded = append(encoded, "\xef\xbf\xbd"...)
		} else {
			encoded = append(encoded, string(rune(current))...)
		}
	}
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:]), nil
}

func OpaqueHashesEqual(left, right string) bool {
	if !hashPattern.MatchString(left) || !hashPattern.MatchString(right) {
		return false
	}
	leftBytes, leftErr := hex.DecodeString(left)
	rightBytes, rightErr := hex.DecodeString(right)
	return leftErr == nil && rightErr == nil && subtle.ConstantTimeCompare(leftBytes, rightBytes) == 1
}
