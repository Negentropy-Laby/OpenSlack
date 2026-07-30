package graphcontract

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strconv"
	"time"
	"unicode/utf8"

	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphjson"
)

var (
	integrityPattern    = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	dateTimePattern     = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|[+-](\d{2}):(\d{2}))$`)
	jsWhitespacePattern = `[\x09-\x0d\x20\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]`
	activePattern       = regexp.MustCompile(
		`(?:https?://|javascript:|data:text/html|<` + jsWhitespacePattern + `*script\b|<` +
			jsWhitespacePattern + `*iframe\b)`,
	)
	secretPattern = regexp.MustCompile(
		`(?:-----begin [a-z ]*private key-----|(?:github_pat_|gh[opusr]_|sk-)[a-z0-9_-]{12,}|` +
			`xox[baprs]-[a-z0-9-]{8,}|bearer` + jsWhitespacePattern +
			`+[a-z0-9._~+/=-]{12,}|aws_secret_access_key` + jsWhitespacePattern +
			`*=|openslack_[a-z0-9_]*secret` + jsWhitespacePattern + `*=)`,
	)
	secretKeyPattern = regexp.MustCompile(
		`(?:^|[_-])(?:password|passwd|secret|token|credential|private[_-]?key|` +
			`api[_-]?key|authorization|cookie)(?:$|[_-])`,
	)
)

var providers = map[string]struct{}{
	"github": {}, "openslack": {}, "demo_fixture": {}, "dingtalk": {}, "crm": {}, "erp": {}, "hr": {},
}

func asciiLower(value string) string {
	bytes := []byte(value)
	for index, current := range bytes {
		if current >= 'A' && current <= 'Z' {
			bytes[index] = current + ('a' - 'A')
		}
	}
	return string(bytes)
}

func matchesActive(value string) bool {
	return activePattern.MatchString(asciiLower(value))
}

func matchesSecret(value string) bool {
	return secretPattern.MatchString(asciiLower(value))
}

func matchesSecretKey(value string) bool {
	return secretKeyPattern.MatchString(asciiLower(value))
}

func checkedString(value, path string, maximum int, identifier, allowEmpty bool) error {
	length := graphjson.UTF16Len(value)
	if (!allowEmpty && length == 0) || length > maximum {
		return failure(ErrorBoundExceeded, path, fmt.Sprintf("must contain between 1 and %d characters", maximum))
	}
	if !utf8.ValidString(value) {
		return failure(ErrorSchemaInvalid, path, "contains invalid Unicode")
	}
	for _, character := range value {
		if character <= 0x1f || character == 0x7f {
			return failure(ErrorSchemaInvalid, path, "contains an unsafe control character")
		}
	}
	if identifier && matchesActive(value) {
		return failure(ErrorReferenceInvalid, path, "must be an identifier, not active content")
	}
	return nil
}

func checkedDateTime(value, path string) error {
	if err := checkedString(value, path, MaxDateTimeCharacters, false, false); err != nil {
		return err
	}
	match := dateTimePattern.FindStringSubmatch(value)
	if match == nil {
		return failure(ErrorSchemaInvalid, path, "must be an RFC 3339 date-time with an explicit zone")
	}
	if match[7] != "" {
		offsetHour, hourErr := strconv.Atoi(match[7])
		offsetMinute, minuteErr := strconv.Atoi(match[8])
		if hourErr != nil || minuteErr != nil || offsetHour > 23 || offsetMinute > 59 {
			return failure(ErrorSchemaInvalid, path, "must be an RFC 3339 date-time with an explicit zone")
		}
	}
	if _, err := time.Parse(time.RFC3339Nano, value); err != nil {
		return failure(ErrorSchemaInvalid, path, "must be an RFC 3339 date-time with an explicit zone")
	}
	return nil
}

func checkedInterval(validFrom, validTo, path string) error {
	from, err := time.Parse(time.RFC3339Nano, validFrom)
	if err != nil {
		return failure(ErrorSchemaInvalid, path, "contains an invalid validFrom date-time")
	}
	to, err := time.Parse(time.RFC3339Nano, validTo)
	if err != nil {
		return failure(ErrorSchemaInvalid, path, "contains an invalid validTo date-time")
	}
	if to.UnixMilli() < from.UnixMilli() {
		return failure(ErrorSchemaInvalid, path, "must not precede validFrom")
	}
	return nil
}

func validateAuthority(value AuthorityRef, path string) error {
	if _, ok := providers[value.Provider]; !ok {
		return failure(ErrorSchemaInvalid, path+".provider", "is not a recognized authority provider")
	}
	fields := []struct {
		value string
		name  string
		max   int
	}{
		{value.ObjectType, "objectType", MaxAuthorityObjectTypeCharacters},
		{value.ObjectID, "objectId", MaxBoundedStringCharacters},
		{value.Version, "version", MaxBoundedStringCharacters},
	}
	for _, field := range fields {
		if err := checkedString(field.value, path+"."+field.name, field.max, true, false); err != nil {
			return err
		}
	}
	if err := checkedDateTime(value.ObservedAt, path+".observedAt"); err != nil {
		return err
	}
	for _, field := range []struct{ value, name string }{
		{value.Provider, "provider"},
		{value.ObjectType, "objectType"},
		{value.ObjectID, "objectId"},
		{value.Version, "version"},
		{value.ObservedAt, "observedAt"},
	} {
		if matchesSecret(field.value) {
			return failure(ErrorPropertyUnsafe, path+"."+field.name, "must not contain credential material")
		}
	}
	return nil
}

func validateRefs(values []string, path string, maximum int) error {
	if len(values) > maximum {
		return failure(ErrorBoundExceeded, path, fmt.Sprintf("must contain at most %d items", maximum))
	}
	for index, value := range values {
		itemPath := fmt.Sprintf("%s[%d]", path, index)
		if err := checkedString(value, itemPath, MaxBoundedStringCharacters, true, false); err != nil {
			return err
		}
		if matchesSecret(value) {
			return failure(ErrorPropertyUnsafe, itemPath, "must not contain credential material")
		}
	}
	return nil
}

func validateProperty(value graphjson.Value, path string, depth int) error {
	if depth > MaxPropertyDepth {
		return failure(ErrorBoundExceeded, path, fmt.Sprintf("property nesting exceeds depth %d", MaxPropertyDepth))
	}
	switch current := value.(type) {
	case nil, bool:
		return nil
	case float64:
		if math.IsNaN(current) || math.IsInf(current, 0) {
			return failure(ErrorSchemaInvalid, path, "property numbers must be finite")
		}
	case string:
		if err := checkedString(current, path, MaxPropertyStringCharacters, false, true); err != nil {
			return err
		}
		if matchesSecret(current) || matchesActive(current) {
			return failure(ErrorPropertyUnsafe, path, "properties must not contain credentials, URLs, or active content")
		}
	case graphjson.Array:
		if len(current) > MaxPropertyItems {
			return failure(ErrorBoundExceeded, path, fmt.Sprintf("property arrays contain at most %d items", MaxPropertyItems))
		}
		for index, item := range current {
			if err := validateProperty(item, fmt.Sprintf("%s[%d]", path, index), depth+1); err != nil {
				return err
			}
		}
	case graphjson.Object:
		if len(current) > MaxPropertyKeys {
			return failure(ErrorBoundExceeded, path, fmt.Sprintf("property objects contain at most %d keys", MaxPropertyKeys))
		}
		keys := make([]string, 0, len(current))
		for key := range current {
			keys = append(keys, key)
		}
		sort.Slice(keys, func(left, right int) bool { return graphjson.UTF16Less(keys[left], keys[right]) })
		for _, key := range keys {
			item := current[key]
			keyPath := path + "." + key
			if key == "__proto__" || key == "prototype" || key == "constructor" || matchesSecretKey(key) {
				return failure(ErrorPropertyUnsafe, keyPath, "property key is not permitted")
			}
			if err := checkedString(key, keyPath, MaxAuthorityObjectTypeCharacters, false, false); err != nil {
				return err
			}
			if err := validateProperty(item, keyPath, depth+1); err != nil {
				return err
			}
		}
	default:
		return failure(ErrorSchemaInvalid, path, "properties must contain only JSON values")
	}
	return nil
}

func validateNode(value Node, path, scope string) error {
	if err := checkedString(
		value.ScenarioInstanceID,
		path+".scenarioInstanceId",
		MaxIdentifierCharacters,
		true,
		false,
	); err != nil {
		return err
	}
	if value.ScenarioInstanceID != scope {
		return failure(ErrorScopeInvalid, path+".scenarioInstanceId", "does not match graph scope")
	}
	if err := checkedDateTime(value.ValidFrom, path+".validFrom"); err != nil {
		return err
	}
	if value.ValidTo != nil {
		if err := checkedDateTime(*value.ValidTo, path+".validTo"); err != nil {
			return err
		}
		if err := checkedInterval(value.ValidFrom, *value.ValidTo, path+".validTo"); err != nil {
			return err
		}
	}
	if len(value.Owners) > MaxOwners {
		return failure(ErrorBoundExceeded, path+".owners", fmt.Sprintf("must contain at most %d items", MaxOwners))
	}
	for index, owner := range value.Owners {
		ownerPath := fmt.Sprintf("%s.owners[%d]", path, index)
		if owner.Kind != "human" && owner.Kind != "agent" && owner.Kind != "system" {
			return failure(ErrorSchemaInvalid, ownerPath+".kind", "must be human, agent, or system")
		}
		if err := checkedString(owner.ID, ownerPath+".id", MaxIdentifierCharacters, true, false); err != nil {
			return err
		}
		if owner.DisplayName != nil {
			if err := checkedString(*owner.DisplayName, ownerPath+".displayName", MaxBoundedStringCharacters, false, false); err != nil {
				return err
			}
		}
	}
	if value.Properties == nil {
		return failure(ErrorSchemaInvalid, path+".properties", "must be an object")
	}
	if err := validateProperty(value.Properties, path+".properties", 1); err != nil {
		return err
	}
	if err := checkedString(value.ID, path+".id", MaxIdentifierCharacters, true, false); err != nil {
		return err
	}
	if err := checkedString(value.Type, path+".type", MaxIdentifierCharacters, true, false); err != nil {
		return err
	}
	if err := validateAuthority(value.AuthorityRef, path+".authorityRef"); err != nil {
		return err
	}
	if err := checkedString(
		value.ProjectorVersion,
		path+".projectorVersion",
		MaxIdentifierCharacters,
		true,
		false,
	); err != nil {
		return err
	}
	if matchesSecret(value.ProjectorVersion) {
		return failure(ErrorPropertyUnsafe, path+".projectorVersion", "must not contain credential material")
	}
	expected, err := DeriveNodeID(value.ScenarioInstanceID, value.Type, value.AuthorityRef)
	if err != nil {
		return err
	}
	if value.ID != expected {
		return failure(ErrorReferenceInvalid, path+".id", "must equal the derived stable ID "+expected)
	}
	if err := checkedString(
		value.ScenarioDefinitionID,
		path+".scenarioDefinitionId",
		MaxIdentifierCharacters,
		true,
		false,
	); err != nil {
		return err
	}
	if err := checkedString(value.Title, path+".title", MaxBoundedStringCharacters, false, false); err != nil {
		return err
	}
	if value.Status != nil {
		if err := checkedString(*value.Status, path+".status", MaxIdentifierCharacters, false, false); err != nil {
			return err
		}
	}
	if err := validateRefs(value.SourceEventIDs, path+".sourceEventIds", MaxSourceEventIDs); err != nil {
		return err
	}
	if err := validateRefs(value.EvidenceRefs, path+".evidenceRefs", MaxEvidenceRefs); err != nil {
		return err
	}
	return nil
}

func validateEdge(value Edge, path, scope string) error {
	if err := checkedString(
		value.ScenarioInstanceID,
		path+".scenarioInstanceId",
		MaxIdentifierCharacters,
		true,
		false,
	); err != nil {
		return err
	}
	if value.ScenarioInstanceID != scope {
		return failure(ErrorScopeInvalid, path+".scenarioInstanceId", "does not match graph scope")
	}
	if err := checkedDateTime(value.ValidFrom, path+".validFrom"); err != nil {
		return err
	}
	if value.ValidTo != nil {
		if err := checkedDateTime(*value.ValidTo, path+".validTo"); err != nil {
			return err
		}
		if err := checkedInterval(value.ValidFrom, *value.ValidTo, path+".validTo"); err != nil {
			return err
		}
	}
	fields := []struct{ value, name string }{
		{value.ID, "id"}, {value.Type, "type"}, {value.From, "from"}, {value.To, "to"},
	}
	for _, field := range fields {
		if err := checkedString(field.value, path+"."+field.name, MaxIdentifierCharacters, true, false); err != nil {
			return err
		}
	}
	if value.AuthorityRef != nil {
		if err := validateAuthority(*value.AuthorityRef, path+".authorityRef"); err != nil {
			return err
		}
	}
	if err := checkedString(
		value.ProjectorVersion,
		path+".projectorVersion",
		MaxIdentifierCharacters,
		true,
		false,
	); err != nil {
		return err
	}
	if matchesSecret(value.ProjectorVersion) {
		return failure(ErrorPropertyUnsafe, path+".projectorVersion", "must not contain credential material")
	}
	expected, err := DeriveEdgeID(value.ScenarioInstanceID, value.Type, value.From, value.To, value.AuthorityRef)
	if err != nil {
		return err
	}
	if value.ID != expected {
		return failure(ErrorReferenceInvalid, path+".id", "must equal the derived stable ID "+expected)
	}
	if err := validateRefs(value.SourceEventIDs, path+".sourceEventIds", MaxSourceEventIDs); err != nil {
		return err
	}
	if err := validateRefs(value.EvidenceRefs, path+".evidenceRefs", MaxEvidenceRefs); err != nil {
		return err
	}
	return nil
}

func validateCompleteness(value Completeness, path string) error {
	fields := []struct {
		name string
		refs []string
	}{
		{"sourcesRequested", value.SourcesRequested},
		{"sourcesObserved", value.SourcesObserved},
		{"missingSources", value.MissingSources},
		{"warnings", value.Warnings},
	}
	for _, field := range fields {
		if err := validateRefs(field.refs, path+"."+field.name, MaxCompletenessItems); err != nil {
			return err
		}
	}
	return nil
}

func ValidateSnapshot(value Snapshot) error {
	if value.Schema != SnapshotSchema {
		return failure(ErrorSchemaInvalid, "$.schema", "has the wrong snapshot schema")
	}
	if err := checkedString(value.ScenarioInstanceID, "$.scenarioInstanceId", MaxIdentifierCharacters, true, false); err != nil {
		return err
	}
	if len(value.Nodes) > MaxSnapshotNodes {
		return failure(ErrorBoundExceeded, "$.nodes", "contains too many nodes")
	}
	for index, node := range value.Nodes {
		if err := validateNode(node, fmt.Sprintf("$.nodes[%d]", index), value.ScenarioInstanceID); err != nil {
			return err
		}
	}
	if len(value.Edges) > MaxSnapshotEdges {
		return failure(ErrorBoundExceeded, "$.edges", "contains too many edges")
	}
	for index, edge := range value.Edges {
		path := fmt.Sprintf("$.edges[%d]", index)
		if err := validateEdge(edge, path, value.ScenarioInstanceID); err != nil {
			return err
		}
	}
	nodes := make(map[string]struct{}, len(value.Nodes))
	for _, node := range value.Nodes {
		if _, exists := nodes[node.ID]; exists {
			return failure(ErrorReferenceInvalid, "$.nodes", "contains duplicate ID "+node.ID)
		}
		nodes[node.ID] = struct{}{}
	}
	edges := make(map[string]struct{}, len(value.Edges))
	for _, edge := range value.Edges {
		if _, exists := edges[edge.ID]; exists {
			return failure(ErrorReferenceInvalid, "$.edges", "contains duplicate ID "+edge.ID)
		}
		edges[edge.ID] = struct{}{}
	}
	for index, edge := range value.Edges {
		path := fmt.Sprintf("$.edges[%d]", index)
		if _, exists := nodes[edge.From]; !exists {
			return failure(ErrorReferenceInvalid, path+".from", "does not identify a graph node")
		}
		if _, exists := nodes[edge.To]; !exists {
			return failure(ErrorReferenceInvalid, path+".to", "does not identify a graph node")
		}
	}
	if err := checkedString(value.Cursor, "$.cursor", MaxIdentifierCharacters, true, false); err != nil {
		return err
	}
	if err := checkedDateTime(value.GeneratedAt, "$.generatedAt"); err != nil {
		return err
	}
	if err := checkedString(value.ProjectorVersion, "$.projectorVersion", MaxIdentifierCharacters, true, false); err != nil {
		return err
	}
	if err := validateCompleteness(value.Completeness, "$.completeness"); err != nil {
		return err
	}
	if !integrityPattern.MatchString(value.IntegrityHash) {
		return failure(ErrorSchemaInvalid, "$.integrityHash", "must be sha256 followed by 64 lowercase hex digits")
	}
	return nil
}

func ValidateDelta(value Delta) error {
	if value.Schema != DeltaSchema {
		return failure(ErrorSchemaInvalid, "$.schema", "has the wrong delta schema")
	}
	if err := checkedString(value.ScenarioInstanceID, "$.scenarioInstanceId", MaxIdentifierCharacters, true, false); err != nil {
		return err
	}
	if err := checkedString(value.FromCursor, "$.fromCursor", MaxIdentifierCharacters, true, false); err != nil {
		return err
	}
	if err := checkedString(value.ToCursor, "$.toCursor", MaxIdentifierCharacters, true, false); err != nil {
		return err
	}
	if value.FromCursor == value.ToCursor {
		return failure(ErrorReferenceInvalid, "$.toCursor", "must differ from fromCursor")
	}
	if len(value.UpsertNodes) > MaxSnapshotNodes {
		return failure(ErrorBoundExceeded, "$.upsertNodes", "contains too many nodes")
	}
	for index, node := range value.UpsertNodes {
		if err := validateNode(node, fmt.Sprintf("$.upsertNodes[%d]", index), value.ScenarioInstanceID); err != nil {
			return err
		}
	}
	if len(value.UpsertEdges) > MaxSnapshotEdges {
		return failure(ErrorBoundExceeded, "$.upsertEdges", "contains too many edges")
	}
	for index, edge := range value.UpsertEdges {
		if err := validateEdge(edge, fmt.Sprintf("$.upsertEdges[%d]", index), value.ScenarioInstanceID); err != nil {
			return err
		}
	}
	if len(value.CloseNodeIDs) > MaxSnapshotNodes {
		return failure(ErrorBoundExceeded, "$.closeNodeIds", "contains too many node IDs")
	}
	if err := validateRefs(value.CloseNodeIDs, "$.closeNodeIds", MaxSnapshotNodes); err != nil {
		return err
	}
	if len(value.CloseEdgeIDs) > MaxSnapshotEdges {
		return failure(ErrorBoundExceeded, "$.closeEdgeIds", "contains too many edge IDs")
	}
	if err := validateRefs(value.CloseEdgeIDs, "$.closeEdgeIds", MaxSnapshotEdges); err != nil {
		return err
	}
	upsertNodes := map[string]struct{}{}
	for _, node := range value.UpsertNodes {
		if _, exists := upsertNodes[node.ID]; exists {
			return failure(ErrorReferenceInvalid, "$.upsertNodes", "contains duplicate ID "+node.ID)
		}
		upsertNodes[node.ID] = struct{}{}
	}
	upsertEdges := map[string]struct{}{}
	for _, edge := range value.UpsertEdges {
		if _, exists := upsertEdges[edge.ID]; exists {
			return failure(ErrorReferenceInvalid, "$.upsertEdges", "contains duplicate ID "+edge.ID)
		}
		upsertEdges[edge.ID] = struct{}{}
	}
	if err := validateUniqueRefs(value.CloseNodeIDs, "$.closeNodeIds"); err != nil {
		return err
	}
	if err := validateUniqueRefs(value.CloseEdgeIDs, "$.closeEdgeIds"); err != nil {
		return err
	}
	for index, value := range value.CloseNodeIDs {
		if _, exists := upsertNodes[value]; exists {
			return failure(
				ErrorReferenceInvalid,
				fmt.Sprintf("$.closeNodeIds[%d]", index),
				"cannot close and upsert the same node",
			)
		}
	}
	for index, value := range value.CloseEdgeIDs {
		if _, exists := upsertEdges[value]; exists {
			return failure(
				ErrorReferenceInvalid,
				fmt.Sprintf("$.closeEdgeIds[%d]", index),
				"cannot close and upsert the same edge",
			)
		}
	}
	if err := checkedDateTime(value.GeneratedAt, "$.generatedAt"); err != nil {
		return err
	}
	if err := validateRefs(value.EvidenceRefs, "$.evidenceRefs", MaxDeltaEvidenceRefs); err != nil {
		return err
	}
	if !integrityPattern.MatchString(value.IntegrityHash) {
		return failure(ErrorSchemaInvalid, "$.integrityHash", "must be sha256 followed by 64 lowercase hex digits")
	}
	return nil
}

func validateUniqueRefs(values []string, path string) error {
	seen := map[string]struct{}{}
	for _, value := range values {
		if _, exists := seen[value]; exists {
			return failure(ErrorReferenceInvalid, path, "contains duplicate ID "+value)
		}
		seen[value] = struct{}{}
	}
	return nil
}
