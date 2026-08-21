package authoritycontract

var stateFields = []string{
	"schema", "contractVersion", "contractAuthority", "goRole", "authorityClaim",
	"workspaceId", "runId", "workflowId", "workflowVersion", "workflowSourceHash",
	"manifestHash", "inputHash", "route", "state", "revision", "resumeGeneration",
	"currentPhaseId", "currentPhaseIndex", "checkpointHead", "approvals", "budget",
	"reconciliationRequired", "updatedAt",
}

func DecodeStateJSON(input []byte) (State, error) {
	if len(input) > MaxStateBytes {
		return State{}, failure(ErrorLimitExceeded, "$", "state exceeds its byte limit")
	}
	value, err := parseStrictJSON(input, MaxJSONDepth, MaxJSONNodes, MaxStringBytes)
	if err != nil {
		return State{}, normalizeStrictJSONError(err)
	}
	return ValidateState(value)
}

func ValidateState(value any) (State, error) {
	root, err := closedRecord(value, stateFields, "$")
	if err != nil {
		return State{}, err
	}
	for _, constant := range []struct {
		field string
		want  string
	}{
		{"schema", StateSchema}, {"contractVersion", ContractVersion},
		{"contractAuthority", Authority}, {"goRole", GoRole}, {"authorityClaim", AuthorityClaim},
	} {
		if root[constant.field] != constant.want {
			return State{}, failure(ErrorInvalid, "$/"+constant.field, constant.field+" is invalid")
		}
	}
	workspaceID, err := requireIdentifier(root["workspaceId"], "$/workspaceId")
	if err != nil {
		return State{}, err
	}
	runID, err := requireIdentifier(root["runId"], "$/runId")
	if err != nil {
		return State{}, err
	}
	workflowID, err := requireIdentifier(root["workflowId"], "$/workflowId")
	if err != nil {
		return State{}, err
	}
	workflowVersion, err := requireIdentifier(root["workflowVersion"], "$/workflowVersion")
	if err != nil {
		return State{}, err
	}
	workflowSourceHash, err := requireHash(root["workflowSourceHash"], "$/workflowSourceHash")
	if err != nil {
		return State{}, err
	}
	manifestHash, err := requireHash(root["manifestHash"], "$/manifestHash")
	if err != nil {
		return State{}, err
	}
	inputHash, err := requireHash(root["inputHash"], "$/inputHash")
	if err != nil {
		return State{}, err
	}
	route, err := validateRoute(root["route"], "$/route")
	if err != nil {
		return State{}, err
	}
	state, err := requireEnum(root["state"], "$/state", runStates)
	if err != nil {
		return State{}, err
	}
	revision, err := requireInteger(root["revision"], "$/revision", 1)
	if err != nil {
		return State{}, err
	}
	resumeGeneration, err := requireInteger(root["resumeGeneration"], "$/resumeGeneration", 0)
	if err != nil {
		return State{}, err
	}
	currentPhaseID, err := nullableString(root["currentPhaseId"], "$/currentPhaseId", requireIdentifier)
	if err != nil {
		return State{}, err
	}
	currentPhaseIndex, err := nullableInteger(root["currentPhaseIndex"], "$/currentPhaseIndex", 0)
	if err != nil {
		return State{}, err
	}
	if (currentPhaseID == nil) != (currentPhaseIndex == nil) {
		return State{}, failure(ErrorIdentityMismatch, "$/currentPhaseIndex", "current phase id and index must both be null or both be present")
	}
	checkpoint, err := validateCheckpoint(root["checkpointHead"], revision, resumeGeneration)
	if err != nil {
		return State{}, err
	}
	approvals, err := validateApprovals(root["approvals"])
	if err != nil {
		return State{}, err
	}
	budget, err := validateBudget(root["budget"])
	if err != nil {
		return State{}, err
	}
	reconciliationRequired, err := requireBoolean(root["reconciliationRequired"], "$/reconciliationRequired")
	if err != nil {
		return State{}, err
	}
	if (state == RunReconciliationRequired) != reconciliationRequired {
		return State{}, failure(ErrorReconciliationRequired, "$/reconciliationRequired", "reconciliation flag must match the run state")
	}
	updatedAt, err := requireTimestamp(root["updatedAt"], "$/updatedAt")
	if err != nil {
		return State{}, err
	}

	result := State{
		Schema: StateSchema, ContractVersion: ContractVersion, ContractAuthority: Authority,
		GoRole: GoRole, AuthorityClaim: AuthorityClaim, WorkspaceID: workspaceID, RunID: runID,
		WorkflowID: workflowID, WorkflowVersion: workflowVersion, WorkflowSourceHash: workflowSourceHash,
		ManifestHash: manifestHash, InputHash: inputHash, Route: route, State: state,
		Revision: revision, ResumeGeneration: resumeGeneration, CurrentPhaseID: currentPhaseID,
		CurrentPhaseIndex: currentPhaseIndex, CheckpointHead: checkpoint, Approvals: approvals,
		Budget: budget, ReconciliationRequired: reconciliationRequired, UpdatedAt: updatedAt,
	}
	if err := requireCanonicalSize(result, MaxStateBytes, "$"); err != nil {
		return State{}, err
	}
	return result, nil
}

func validateRoute(value any, path string) (Route, error) {
	record, err := closedRecord(value, []string{"backend", "authority", "routingEpoch", "authorityBuildHash"}, path)
	if err != nil {
		return Route{}, err
	}
	backend, err := requireEnum(record["backend"], path+"/backend", []string{"ts-local", "go"})
	if err != nil {
		return Route{}, err
	}
	authority, err := requireEnum(record["authority"], path+"/authority", []string{"typescript", "workflow-control"})
	if err != nil {
		return Route{}, err
	}
	if (backend == "ts-local" && authority != "typescript") || (backend == "go" && authority != "workflow-control") {
		return Route{}, failure(ErrorIdentityMismatch, path+"/authority", "route backend and authority do not match")
	}
	routingEpoch, err := requireInteger(record["routingEpoch"], path+"/routingEpoch", 1)
	if err != nil {
		return Route{}, err
	}
	buildHash, err := requireHash(record["authorityBuildHash"], path+"/authorityBuildHash")
	if err != nil {
		return Route{}, err
	}
	return Route{Backend: backend, Authority: authority, RoutingEpoch: routingEpoch, AuthorityBuildHash: buildHash}, nil
}

// ValidateRoute exposes the frozen route vocabulary to adjacent runner
// admission code without duplicating backend/authority/hash rules.
func ValidateRoute(value any, path string) (Route, error) {
	return validateRoute(value, path)
}

// ValidateRouteJSON decodes one bounded neutral JSON value before applying the
// same frozen route validator. Adjacent contracts use it to normalize their
// in-memory numeric representation without copying route rules.
func ValidateRouteJSON(input []byte, path string) (Route, error) {
	if len(input) == 0 || len(input) > MaxStateBytes {
		return Route{}, failure(ErrorLimitExceeded, path, "route exceeds its byte limit")
	}
	value, err := parseStrictJSON(input, MaxJSONDepth, MaxJSONNodes, MaxStringBytes)
	if err != nil {
		return Route{}, normalizeStrictJSONError(err)
	}
	return validateRoute(value, path)
}

func validateCheckpoint(value any, revision, resumeGeneration int64) (*CheckpointHead, error) {
	if value == nil {
		return nil, nil
	}
	path := "$/checkpointHead"
	record, err := closedRecord(value, []string{
		"checkpointId", "phaseId", "phaseIndex", "commitPoint", "artifactRef", "artifactHash",
		"resultHash", "cacheKeyHash", "committedRevision", "resumeGeneration",
	}, path)
	if err != nil {
		return nil, err
	}
	checkpointID, err := requireIdentifier(record["checkpointId"], path+"/checkpointId")
	if err != nil {
		return nil, err
	}
	phaseID, err := requireIdentifier(record["phaseId"], path+"/phaseId")
	if err != nil {
		return nil, err
	}
	phaseIndex, err := requireInteger(record["phaseIndex"], path+"/phaseIndex", 0)
	if err != nil {
		return nil, err
	}
	if record["commitPoint"] != "after_phase_work" {
		return nil, failure(ErrorInvalid, path+"/commitPoint", "checkpoint commit point is invalid")
	}
	artifactRef, err := requireReference(record["artifactRef"], path+"/artifactRef")
	if err != nil {
		return nil, err
	}
	artifactHash, err := requireHash(record["artifactHash"], path+"/artifactHash")
	if err != nil {
		return nil, err
	}
	resultHash, err := nullableString(record["resultHash"], path+"/resultHash", requireHash)
	if err != nil {
		return nil, err
	}
	cacheKeyHash, err := nullableString(record["cacheKeyHash"], path+"/cacheKeyHash", requireHash)
	if err != nil {
		return nil, err
	}
	committedRevision, err := requireInteger(record["committedRevision"], path+"/committedRevision", 1)
	if err != nil {
		return nil, err
	}
	checkpointGeneration, err := requireInteger(record["resumeGeneration"], path+"/resumeGeneration", 0)
	if err != nil {
		return nil, err
	}
	if committedRevision > revision || checkpointGeneration > resumeGeneration {
		return nil, failure(ErrorStaleRevision, path, "Checkpoint head cannot come from a future run revision or resume generation.")
	}
	return &CheckpointHead{
		CheckpointID: checkpointID, PhaseID: phaseID, PhaseIndex: phaseIndex,
		CommitPoint: "after_phase_work", ArtifactRef: artifactRef, ArtifactHash: artifactHash,
		ResultHash: resultHash, CacheKeyHash: cacheKeyHash, CommittedRevision: committedRevision,
		ResumeGeneration: checkpointGeneration,
	}, nil
}

func validateApprovals(value any) (Approvals, error) {
	record, err := closedRecord(value, []string{"legacyRunGate", "effectV2"}, "$/approvals")
	if err != nil {
		return Approvals{}, err
	}
	legacy, err := closedRecord(record["legacyRunGate"], []string{"plane", "status", "revision", "effectDecisionAuthority"}, "$/approvals/legacyRunGate")
	if err != nil {
		return Approvals{}, err
	}
	if legacy["plane"] != "legacy_run_gate" || legacy["effectDecisionAuthority"] != false {
		return Approvals{}, failure(ErrorApprovalPlaneMismatch, "$/approvals/legacyRunGate", "Legacy run gate cannot authorize an effect.")
	}
	legacyStatus, err := requireEnum(legacy["status"], "$/approvals/legacyRunGate/status", approvalStatuses())
	if err != nil {
		return Approvals{}, err
	}
	legacyRevision, err := requireInteger(legacy["revision"], "$/approvals/legacyRunGate/revision", 0)
	if err != nil {
		return Approvals{}, err
	}

	effect, err := closedRecord(record["effectV2"], []string{"plane", "schema", "status", "revision", "approvalHash"}, "$/approvals/effectV2")
	if err != nil {
		return Approvals{}, err
	}
	if effect["plane"] != "workflow_effect_v2" || effect["schema"] != "openslack.workflow_effect_approval.v2" {
		return Approvals{}, failure(ErrorApprovalPlaneMismatch, "$/approvals/effectV2", "workflow effect approval plane is invalid")
	}
	effectStatus, err := requireEnum(effect["status"], "$/approvals/effectV2/status", approvalStatuses())
	if err != nil {
		return Approvals{}, err
	}
	effectRevision, err := requireInteger(effect["revision"], "$/approvals/effectV2/revision", 0)
	if err != nil {
		return Approvals{}, err
	}
	approvalHash, err := nullableString(effect["approvalHash"], "$/approvals/effectV2/approvalHash", requireHash)
	if err != nil {
		return Approvals{}, err
	}
	return Approvals{
		LegacyRunGate: LegacyRunGate{Plane: "legacy_run_gate", Status: legacyStatus, Revision: legacyRevision, EffectDecisionAuthority: false},
		EffectV2:      EffectV2Approval{Plane: "workflow_effect_v2", Schema: "openslack.workflow_effect_approval.v2", Status: effectStatus, Revision: effectRevision, ApprovalHash: approvalHash},
	}, nil
}

func approvalStatuses() []ApprovalStatus {
	return []ApprovalStatus{ApprovalPending, ApprovalApproved, ApprovalRejected, ApprovalExpired}
}

func validateBudget(value any) (Budget, error) {
	path := "$/budget"
	fields := []string{
		"policyHash", "tokenLimit", "costLimitNanoUsd", "callLimit", "reservedTokens",
		"settledTokens", "reservedCostNanoUsd", "settledCostNanoUsd", "reservedCalls", "settledCalls",
	}
	record, err := closedRecord(value, fields, path)
	if err != nil {
		return Budget{}, err
	}
	policyHash, err := requireHash(record["policyHash"], path+"/policyHash")
	if err != nil {
		return Budget{}, err
	}
	values := make(map[string]Quantity, len(fields)-1)
	for _, field := range fields[1:] {
		values[field], err = quantity(record[field], path+"/"+field)
		if err != nil {
			return Budget{}, err
		}
	}
	for _, bound := range [][2]string{
		{"reservedTokens", "tokenLimit"}, {"settledTokens", "reservedTokens"},
		{"reservedCostNanoUsd", "costLimitNanoUsd"}, {"settledCostNanoUsd", "reservedCostNanoUsd"},
		{"reservedCalls", "callLimit"}, {"settledCalls", "reservedCalls"},
	} {
		if !lessOrEqual(values[bound[0]], values[bound[1]]) {
			return Budget{}, failure(ErrorInvalid, path+"/"+bound[0], "budget value exceeds its bound")
		}
	}
	return Budget{
		PolicyHash: policyHash, TokenLimit: values["tokenLimit"], CostLimitNanoUSD: values["costLimitNanoUsd"],
		CallLimit: values["callLimit"], ReservedTokens: values["reservedTokens"], SettledTokens: values["settledTokens"],
		ReservedCostNanoUSD: values["reservedCostNanoUsd"], SettledCostNanoUSD: values["settledCostNanoUsd"],
		ReservedCalls: values["reservedCalls"], SettledCalls: values["settledCalls"],
	}, nil
}
