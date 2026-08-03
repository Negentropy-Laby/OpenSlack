package runnerprotocol

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"runtime"
	"sort"
	"testing"
)

type manifestIdentity struct {
	Kinds                         []string `json:"kinds"`
	RequiredNullFields            []string `json:"requiredNullFields"`
	RequiredNonEmptyFields        []string `json:"requiredNonEmptyFields"`
	RequiredPositiveIntegerFields []string `json:"requiredPositiveSafeIntegerFields"`
	EmptyStringOrZeroSentinel     bool     `json:"emptyStringOrZeroSentinelAllowed"`
}

type manifestAuthority struct {
	ContractOwner                     string `json:"contractOwner"`
	JavaScriptRunnerRemains           bool   `json:"javascriptRunnerRemains"`
	WorkflowCodeAndAgentCallsRemainTS bool   `json:"workflowCodeAndAgentCallsRemainTypescript"`
	DurableAuthorityTransferred       bool   `json:"durableAuthorityTransferred"`
	RuntimeAdded                      bool   `json:"runtimeAdded"`
}

type manifestMessages struct {
	Kinds      []string `json:"kinds"`
	Directions struct {
		RunnerToControl []string `json:"runnerToControl"`
		ControlToRunner []string `json:"controlToRunner"`
	} `json:"directions"`
	DirectionVocabulary []string            `json:"directionVocabulary"`
	ReceiptableKinds    []string            `json:"receiptableKinds"`
	PayloadFields       map[string][]string `json:"payloadFields"`
}

type manifestAdvancement struct {
	HelloRequires                               string   `json:"helloRequires"`
	LeaseOfferRequiresOneOf                     []string `json:"leaseOfferRequiresOneOf"`
	ReceiptRequiredFor                          []string `json:"receiptRequiredFor"`
	AdvancingReceiptStatuses                    []string `json:"advancingReceiptStatuses"`
	StoppingReceiptStatus                       string   `json:"stoppingReceiptStatus"`
	ReceiptIsReceiptable                        bool     `json:"receiptIsReceiptable"`
	OneOutstandingWorkerEvent                   bool     `json:"oneOutstandingWorkerEvent"`
	LeaseAcceptReceiptBeforeJavaScriptExecution bool     `json:"leaseAcceptReceiptBeforeJavascriptExecution"`
	TerminalReceiptBeforeSuccessfulRunnerExit   bool     `json:"terminalReceiptBeforeSuccessfulRunnerExit"`
	CancelRequestPreemptsReceiptWait            bool     `json:"cancelRequestPreemptsReceiptWait"`
	CancelAckQueuedBehindOutstandingWorkerEvent bool     `json:"cancelAckQueuedBehindOutstandingWorkerEvent"`
	CancelValidityEvaluatedAtRunnerReceipt      bool     `json:"cancelValidityEvaluatedAtRunnerReceipt"`
	AppliedCancelAckMayFollowExpiry             bool     `json:"appliedCancelAckMayFollowExpiry"`
}

type manifestLeaseBoundary struct {
	SealedDescriptorOnly       bool     `json:"sealedDescriptorOnly"`
	DescriptorReferencePattern string   `json:"descriptorReferencePattern"`
	ForbiddenRawFields         []string `json:"forbiddenRawFields"`
	GenericExtensionAllowed    bool     `json:"genericExtensionAllowed"`
}

type manifestCanonicalization struct {
	ObjectKeyOrder        string `json:"objectKeyOrder"`
	WireEncoding          string `json:"wireEncoding"`
	Framing               string `json:"framing"`
	BOMAllowed            bool   `json:"bomAllowed"`
	CarriageReturnAllowed bool   `json:"carriageReturnAllowed"`
	HashAlgorithm         string `json:"hashAlgorithm"`
	HashHexLength         int    `json:"hashHexLength"`
}

type manifestAlgorithm struct {
	Schema  string   `json:"schema"`
	Formula string   `json:"formula"`
	Fields  []string `json:"fields"`
}

type manifestAlgorithms struct {
	MessageDigest      string            `json:"messageDigest"`
	IdempotencyKey     string            `json:"idempotencyKey"`
	RequestFingerprint manifestAlgorithm `json:"requestFingerprint"`
	ReceiptEventID     manifestAlgorithm `json:"receiptEventId"`
}

type manifestVocabularies struct {
	RuntimeName           string   `json:"runtimeName"`
	RuntimeVersionPattern string   `json:"runtimeVersionPattern"`
	Capabilities          []string `json:"capabilities"`
	LeaseRejectReasons    []string `json:"leaseRejectReasons"`
	HeartbeatStates       []string `json:"heartbeatStates"`
	EffectOutcomes        []string `json:"effectOutcomes"`
	CancelReasons         []string `json:"cancelReasons"`
	CancelAckStates       []string `json:"cancelAckStates"`
	TerminalStates        []string `json:"terminalStates"`
	TerminalReasons       []string `json:"terminalReasons"`
	ReceiptStatuses       []string `json:"receiptStatuses"`
	ReceiptErrorCodes     []string `json:"receiptErrorCodes"`
}

type manifestLimits struct {
	MaxMessageBytes      int64 `json:"maxMessageBytes"`
	MaxJSONDepth         int64 `json:"maxJsonDepth"`
	MaxJSONNodes         int64 `json:"maxJsonNodes"`
	MaxStringBytes       int64 `json:"maxStringBytes"`
	MaxIdentifierBytes   int64 `json:"maxIdentifierBytes"`
	MaxEffectKindBytes   int64 `json:"maxEffectKindBytes"`
	MaxCapabilities      int64 `json:"maxCapabilities"`
	MaxProtocolVersions  int64 `json:"maxProtocolVersions"`
	MaxConcurrentJobs    int64 `json:"maxConcurrentJobs"`
	MinHeartbeatInterval int64 `json:"minHeartbeatIntervalMs"`
	MaxHeartbeatInterval int64 `json:"maxHeartbeatIntervalMs"`
	MaxLeaseDuration     int64 `json:"maxLeaseDurationMs"`
	MaxSafeInteger       int64 `json:"maxSafeInteger"`
}

type manifestArtifact struct {
	Path       string `json:"path"`
	ByteLength int    `json:"byteLength"`
	SHA256     string `json:"sha256"`
}

type contractManifest struct {
	Schema             string                   `json:"schema"`
	ProtocolVersion    string                   `json:"protocolVersion"`
	Authority          string                   `json:"authority"`
	AuthorityBoundary  manifestAuthority        `json:"authorityBoundary"`
	EnvelopeFields     []string                 `json:"envelopeFields"`
	HandshakeIdentity  manifestIdentity         `json:"handshakeIdentity"`
	LeaseIdentity      manifestIdentity         `json:"leaseIdentity"`
	Messages           manifestMessages         `json:"messages"`
	AdvancementRules   manifestAdvancement      `json:"advancementRules"`
	LeaseOfferBoundary manifestLeaseBoundary    `json:"leaseOfferBoundary"`
	Canonicalization   manifestCanonicalization `json:"canonicalization"`
	Algorithms         manifestAlgorithms       `json:"algorithms"`
	Vocabularies       manifestVocabularies     `json:"vocabularies"`
	Limits             manifestLimits           `json:"limits"`
	ErrorCodes         []string                 `json:"errorCodes"`
	Vectors            struct {
		Positive int `json:"positive"`
		Receipts int `json:"receipts"`
		Negative int `json:"negative"`
	} `json:"vectors"`
	Artifacts map[string]manifestArtifact `json:"artifacts"`
}

func TestManifestFreezesGoContractAndAdvancementMatrix(t *testing.T) {
	decoder := json.NewDecoder(bytes.NewReader(ContractManifestBytes()))
	decoder.DisallowUnknownFields()
	var manifest contractManifest
	if err := decoder.Decode(&manifest); err != nil {
		t.Fatal(err)
	}
	if manifest.Schema != "openslack.workflow_runner_contract_manifest.v1" || manifest.ProtocolVersion != ProtocolVersion || manifest.Authority != Authority {
		t.Fatalf("unexpected manifest identity: %#v", manifest)
	}
	assertDeepEqual(t, "authority boundary", manifest.AuthorityBoundary, manifestAuthority{
		ContractOwner: "@openslack/workflows", JavaScriptRunnerRemains: true,
		WorkflowCodeAndAgentCallsRemainTS: true, DurableAuthorityTransferred: false, RuntimeAdded: false,
	})

	envelopeFields := []string{"protocolVersion", "kind", "workspaceId", "jobId", "workflowRunId", "attemptId", "leaseId", "fencingToken", "sequence", "eventId", "correlationId", "sentAt", "payload"}
	assertDeepEqual(t, "envelope fields", manifest.EnvelopeFields, envelopeFields)
	handshakeKinds := []string{"hello", "hello_ack"}
	identityFields := []string{"jobId", "workflowRunId", "attemptId", "leaseId", "fencingToken", "sequence"}
	assertDeepEqual(t, "handshake kinds", manifest.HandshakeIdentity.Kinds, handshakeKinds)
	assertDeepEqual(t, "handshake null identity", manifest.HandshakeIdentity.RequiredNullFields, identityFields)
	assertDeepEqual(t, "handshake nonempty", manifest.HandshakeIdentity.RequiredNonEmptyFields, []string{"workspaceId", "eventId", "correlationId", "sentAt"})
	assertDeepEqual(t, "lease nonempty", manifest.LeaseIdentity.RequiredNonEmptyFields, []string{"jobId", "workflowRunId", "attemptId", "leaseId"})
	assertDeepEqual(t, "lease integers", manifest.LeaseIdentity.RequiredPositiveIntegerFields, []string{"fencingToken", "sequence"})
	if manifest.LeaseIdentity.EmptyStringOrZeroSentinel {
		t.Fatal("empty or zero lease identity sentinel must remain forbidden")
	}

	kinds := []string{"hello", "hello_ack", "lease_offer", "lease_accept", "lease_reject", "heartbeat", "effect_intent", "effect_outcome", "cancel_request", "cancel_ack", "terminal", "event_receipt"}
	runnerKinds := []string{"hello", "lease_accept", "lease_reject", "heartbeat", "effect_intent", "effect_outcome", "cancel_ack", "terminal"}
	controlKinds := []string{"hello_ack", "lease_offer", "cancel_request", "event_receipt"}
	receiptable := []string{"lease_accept", "lease_reject", "heartbeat", "effect_intent", "effect_outcome", "cancel_ack", "terminal"}
	assertDeepEqual(t, "message kinds", manifest.Messages.Kinds, kinds)
	assertDeepEqual(t, "runner directions", manifest.Messages.Directions.RunnerToControl, runnerKinds)
	assertDeepEqual(t, "control directions", manifest.Messages.Directions.ControlToRunner, controlKinds)
	assertDeepEqual(t, "direction vocabulary", manifest.Messages.DirectionVocabulary, []string{"runner-to-control", "control-to-runner"})
	assertDeepEqual(t, "receiptable kinds", manifest.Messages.ReceiptableKinds, receiptable)
	assertDeepEqual(t, "payload fields", manifest.Messages.PayloadFields, expectedPayloadFields())

	expectedAdvancement := manifestAdvancement{
		HelloRequires: "hello_ack", LeaseOfferRequiresOneOf: []string{"lease_accept", "lease_reject"},
		ReceiptRequiredFor: receiptable, AdvancingReceiptStatuses: []string{"accepted", "duplicate"},
		StoppingReceiptStatus: "reconciliation_required", ReceiptIsReceiptable: false,
		OneOutstandingWorkerEvent: true, LeaseAcceptReceiptBeforeJavaScriptExecution: true,
		TerminalReceiptBeforeSuccessfulRunnerExit: true, CancelRequestPreemptsReceiptWait: true,
		CancelAckQueuedBehindOutstandingWorkerEvent: true, CancelValidityEvaluatedAtRunnerReceipt: true,
		AppliedCancelAckMayFollowExpiry: true,
	}
	assertDeepEqual(t, "advancement rules", manifest.AdvancementRules, expectedAdvancement)
	rules := ProtocolAdvancementRules()
	if rules.HelloRequires != KindHelloAck || !reflect.DeepEqual(rules.LeaseOfferRequiresOneOf, []Kind{KindLeaseAccept, KindLeaseReject}) ||
		!reflect.DeepEqual(rules.ReceiptRequiredFor, []Kind{KindLeaseAccept, KindLeaseReject, KindHeartbeat, KindEffectIntent, KindEffectOutcome, KindCancelAck, KindTerminal}) ||
		!reflect.DeepEqual(rules.AdvancingReceiptStatuses, []ReceiptStatus{ReceiptAccepted, ReceiptDuplicate}) ||
		rules.StoppingReceiptStatus != ReceiptReconciliationRequired || rules.ReceiptIsReceiptable ||
		!rules.OneOutstandingWorkerEvent || !rules.LeaseAcceptReceiptBeforeJavaScriptExecution ||
		!rules.TerminalReceiptBeforeSuccessfulRunnerExit || !rules.CancelRequestPreemptsReceiptWait ||
		!rules.CancelAckQueuedBehindOutstandingWorkerEvent || !rules.CancelValidityEvaluatedAtRunnerReceipt ||
		!rules.AppliedCancelAckMayFollowExpiry {
		t.Fatalf("Go advancement rules drifted: %#v", rules)
	}
	if CanReceiveEventReceipt(KindEventReceipt) || CanReceiveEventReceipt(KindLeaseOffer) || !CanReceiveEventReceipt(KindTerminal) ||
		!ReceiptAdvances(ReceiptAccepted) || !ReceiptAdvances(ReceiptDuplicate) || ReceiptAdvances(ReceiptReconciliationRequired) {
		t.Fatal("Go receipt asymmetry or advancement semantics drifted")
	}

	for _, kind := range kinds {
		direction, err := DirectionForKind(Kind(kind))
		if err != nil {
			t.Fatal(err)
		}
		expected := DirectionRunnerToControl
		if contains(controlKinds, kind) {
			expected = DirectionControlToRunner
		}
		if direction != expected {
			t.Fatalf("direction for %s = %s, want %s", kind, direction, expected)
		}
	}

	assertDeepEqual(t, "lease boundary", manifest.LeaseOfferBoundary, manifestLeaseBoundary{
		SealedDescriptorOnly: true, DescriptorReferencePattern: "^[A-Za-z0-9][A-Za-z0-9._:@-]{0,255}$",
		ForbiddenRawFields:      []string{"args", "prompt", "result", "transcript", "credential", "token", "secret", "command", "modulePath", "url"},
		GenericExtensionAllowed: false,
	})
	assertDeepEqual(t, "canonicalization", manifest.Canonicalization, manifestCanonicalization{
		ObjectKeyOrder: "ECMAScript UTF-16 code-unit lexicographic", WireEncoding: "UTF-8",
		Framing: "canonical JSON followed by exactly one LF", BOMAllowed: false, CarriageReturnAllowed: false,
		HashAlgorithm: "SHA-256", HashHexLength: 64,
	})
	assertDeepEqual(t, "algorithms", manifest.Algorithms, expectedAlgorithms())
	assertDeepEqual(t, "vocabularies", manifest.Vocabularies, expectedVocabularies())
	assertDeepEqual(t, "limits", manifest.Limits, manifestLimits{
		MaxMessageBytes: MaxEnvelopeBytes, MaxJSONDepth: MaxJSONDepth, MaxJSONNodes: MaxJSONNodes,
		MaxStringBytes: MaxStringBytes, MaxIdentifierBytes: MaxIdentifierBytes, MaxEffectKindBytes: MaxEffectKindBytes,
		MaxCapabilities: MaxCapabilities, MaxProtocolVersions: MaxProtocolVersions, MaxConcurrentJobs: MaxConcurrentJobs,
		MinHeartbeatInterval: MinHeartbeatIntervalMS, MaxHeartbeatInterval: MaxHeartbeatIntervalMS,
		MaxLeaseDuration: MaxLeaseDurationMS, MaxSafeInteger: MaxSafeInteger,
	})
	assertDeepEqual(t, "error codes", manifest.ErrorCodes, expectedErrorCodes())
	if manifest.Vectors.Positive != 12 || manifest.Vectors.Receipts != 7 || manifest.Vectors.Negative != 36 {
		t.Fatalf("manifest vector counts drifted: %#v", manifest.Vectors)
	}
	verifyManifestArtifacts(t, manifest.Artifacts)
}

func TestGeneratedBundleIsExactTypeScriptMirror(t *testing.T) {
	_, filename, _, ok := runtime.Caller(0)
	if !ok {
		t.Fatal("cannot locate parity test")
	}
	repositoryRoot := filepath.Clean(filepath.Join(filepath.Dir(filename), "..", "..", ".."))
	sourceRoot := filepath.Join(repositoryRoot, "packages", "workflows", "contracts", "workflow-runner", "v1")
	mirrorRoot := filepath.Join(filepath.Dir(filename), "generated", "v1")
	paths := []string{"manifest.json", "golden-vectors.json", "schemas/workflow-runner-message.v1.schema.json", "schemas/workflow-runner-prepared-message.v1.schema.json"}
	for _, path := range paths {
		source, err := os.ReadFile(filepath.Join(sourceRoot, filepath.FromSlash(path)))
		if err != nil {
			t.Fatal(err)
		}
		mirror, err := os.ReadFile(filepath.Join(mirrorRoot, filepath.FromSlash(path)))
		if err != nil {
			t.Fatal(err)
		}
		if !bytes.Equal(source, mirror) {
			t.Fatalf("generated mirror drifted from TypeScript authority: %s", path)
		}
	}
}

func TestMessageSchemasKeepEveryEnvelopeAndPayloadClosed(t *testing.T) {
	var messageSchema struct {
		OneOf []struct {
			AdditionalProperties *bool `json:"additionalProperties"`
			Properties           map[string]struct {
				AdditionalProperties *bool `json:"additionalProperties"`
			} `json:"properties"`
		} `json:"oneOf"`
	}
	if err := json.Unmarshal(MessageSchemaBytes(), &messageSchema); err != nil {
		t.Fatal(err)
	}
	if len(messageSchema.OneOf) != 12 {
		t.Fatalf("message schema alternatives = %d, want 12", len(messageSchema.OneOf))
	}
	for index, alternative := range messageSchema.OneOf {
		if alternative.AdditionalProperties == nil || *alternative.AdditionalProperties {
			t.Fatalf("message schema alternative %d is open", index)
		}
		payload, ok := alternative.Properties["payload"]
		if !ok || payload.AdditionalProperties == nil || *payload.AdditionalProperties {
			t.Fatalf("message schema payload %d is missing or open", index)
		}
	}
	var preparedSchema struct {
		AdditionalProperties *bool    `json:"additionalProperties"`
		Required             []string `json:"required"`
	}
	if err := json.Unmarshal(PreparedMessageSchemaBytes(), &preparedSchema); err != nil {
		t.Fatal(err)
	}
	if preparedSchema.AdditionalProperties == nil || *preparedSchema.AdditionalProperties || !reflect.DeepEqual(preparedSchema.Required, []string{"schema", "body", "messageDigest", "idempotencyKey", "requestFingerprint"}) {
		t.Fatalf("prepared schema is not closed and complete: %#v", preparedSchema)
	}
}

func verifyManifestArtifacts(t *testing.T, artifacts map[string]manifestArtifact) {
	t.Helper()
	expectedPaths := []string{"golden-vectors.json", "schemas/workflow-runner-message.v1.schema.json", "schemas/workflow-runner-prepared-message.v1.schema.json"}
	actualPaths := make([]string, 0, len(artifacts))
	for path := range artifacts {
		actualPaths = append(actualPaths, path)
	}
	sort.Strings(actualPaths)
	sort.Strings(expectedPaths)
	assertDeepEqual(t, "artifact inventory", actualPaths, expectedPaths)
	for path, artifact := range artifacts {
		var value []byte
		switch path {
		case "golden-vectors.json":
			value = GoldenVectorsBytes()
		case "schemas/workflow-runner-message.v1.schema.json":
			value = MessageSchemaBytes()
		case "schemas/workflow-runner-prepared-message.v1.schema.json":
			value = PreparedMessageSchemaBytes()
		default:
			t.Fatalf("unexpected artifact %q", path)
		}
		if artifact.Path != path || artifact.ByteLength != len(value) {
			t.Fatalf("artifact metadata drifted for %s: %#v length=%d", path, artifact, len(value))
		}
		digest := sha256.Sum256(value)
		if hex.EncodeToString(digest[:]) != artifact.SHA256 {
			t.Fatalf("artifact hash drifted for %s", path)
		}
	}
}

func expectedPayloadFields() map[string][]string {
	return map[string][]string{
		"hello":          {"runtimeName", "runtimeVersion", "runnerBuildHash", "supportedProtocolVersions", "capabilities", "maxConcurrentJobs"},
		"hello_ack":      {"controlBuildHash", "selectedProtocolVersion", "heartbeatIntervalMs", "leaseOfferTimeoutMs"},
		"lease_offer":    {"executionDescriptorRef", "executionDescriptorHash", "jobSpecHash", "workflowId", "workflowVersion", "workflowSourceHash", "manifestHash", "inputHash", "offeredAt", "expiresAt"},
		"lease_accept":   {"acceptedAt", "leaseExpiresAt"},
		"lease_reject":   {"rejectedAt", "reason"},
		"heartbeat":      {"observedAt", "leaseExpiresAt", "state", "lastReceiptSequence"},
		"effect_intent":  {"effectId", "effectKind", "effectHash", "capabilityHash", "requiresHumanDecision"},
		"effect_outcome": {"effectId", "status", "outcomeHash"},
		"cancel_request": {"cancelId", "requestedAt", "expiresAt", "reason"},
		"cancel_ack":     {"cancelId", "acknowledgedAt", "status"},
		"terminal":       {"status", "finishedAt", "resultHash", "terminalReason"},
		"event_receipt":  {"receivedEventId", "receivedKind", "receivedSequence", "receivedDigest", "receivedIdempotencyKey", "receivedFingerprint", "status", "controlBuildHash", "committedAt", "errorCode"},
	}
}

func expectedAlgorithms() manifestAlgorithms {
	return manifestAlgorithms{
		MessageDigest:  "lowerhex(SHA-256(exact canonical message body including one LF))",
		IdempotencyKey: "openslack.workflow-runner.v1.<messageDigest>",
		RequestFingerprint: manifestAlgorithm{
			Schema: FingerprintSchema, Formula: "sha256:lowerhex(SHA-256(canonical JSON fingerprint preimage without LF))",
			Fields: []string{"schema", "protocolVersion", "kind", "direction", "workspaceId", "jobId", "workflowRunId", "attemptId", "leaseId", "fencingToken", "sequence", "eventId", "correlationId", "messageDigest"},
		},
		ReceiptEventID: manifestAlgorithm{
			Schema: ReceiptIdentitySchema, Formula: "receipt.lowerhex(SHA-256(canonical JSON receipt identity without LF))",
			Fields: []string{"schema", "workspaceId", "eventId", "messageDigest", "status", "controlBuildHash", "committedAt", "errorCode"},
		},
	}
}

func expectedVocabularies() manifestVocabularies {
	return manifestVocabularies{
		RuntimeName: "node", RuntimeVersionPattern: semverPattern.String(),
		Capabilities:       []string{"cancel_ack", "effect_receipts", "lease_heartbeat"},
		LeaseRejectReasons: []string{"busy", "unsupported", "stale", "shutting_down"},
		HeartbeatStates:    []string{"running", "waiting_effect", "cancelling"},
		EffectOutcomes:     []string{"rejected", "executed", "failed", "reconciliation_required"},
		CancelReasons:      []string{"operator", "lease_expired", "shutdown", "superseded", "timeout"},
		CancelAckStates:    []string{"cancelling", "cancelled", "already_terminal"},
		TerminalStates:     []string{"completed", "failed", "cancelled", "timed_out", "reconciliation_required"},
		TerminalReasons:    []string{"workflow_failed", "process_crash", "cancelled_by_control", "timeout", "commit_outcome_unknown"},
		ReceiptStatuses:    []string{"accepted", "duplicate", "reconciliation_required"},
		ReceiptErrorCodes:  []string{string(ErrorCommitOutcomeUnknown), string(ErrorReconciliationRequired)},
	}
}

func expectedErrorCodes() []string {
	return []string{
		string(ErrorUnsupportedVersion), string(ErrorInvalidMessage), string(ErrorUnknownField), string(ErrorLimitExceeded),
		string(ErrorIdentityMismatch), string(ErrorHashMismatch), string(ErrorIdempotencyConflict), string(ErrorSequenceConflict),
		string(ErrorLeaseExpired), string(ErrorStaleFence), string(ErrorControlExpired), string(ErrorProcessCrash), string(ErrorTimeout),
		string(ErrorCommitOutcomeUnknown), string(ErrorReconciliationRequired),
	}
}

func assertDeepEqual(t *testing.T, label string, actual, expected any) {
	t.Helper()
	if !reflect.DeepEqual(actual, expected) {
		t.Fatalf("%s drifted\ngot:  %#v\nwant: %#v", label, actual, expected)
	}
}

func contains(values []string, expected string) bool {
	for _, value := range values {
		if value == expected {
			return true
		}
	}
	return false
}
