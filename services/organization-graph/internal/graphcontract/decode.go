package graphcontract

import (
	"fmt"
	"sort"

	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphjson"
)

func ParseSnapshot(input []byte) (Snapshot, error) {
	value, err := graphjson.Parse(input, graphjson.Limits{})
	if err != nil {
		return Snapshot{}, err
	}
	return SnapshotFromValue(value)
}

func ParseDelta(input []byte) (Delta, error) {
	value, err := graphjson.Parse(input, graphjson.Limits{})
	if err != nil {
		return Delta{}, err
	}
	return DeltaFromValue(value)
}

func SnapshotFromValue(value graphjson.Value) (Snapshot, error) {
	object, err := exactObject(value, "$", []string{
		"schema", "cursor", "scenarioInstanceId", "generatedAt", "projectorVersion",
		"nodes", "edges", "completeness", "integrityHash",
	}, nil)
	if err != nil {
		return Snapshot{}, err
	}
	result := Snapshot{}
	if result.Schema, err = requiredString(object, "schema", "$"); err != nil {
		return result, err
	}
	if result.Schema != SnapshotSchema {
		return result, failure(ErrorSchemaInvalid, "$.schema", "has the wrong snapshot schema")
	}
	if result.ScenarioInstanceID, err = requiredCheckedString(
		object,
		"scenarioInstanceId",
		"$",
		MaxIdentifierCharacters,
		true,
		false,
	); err != nil {
		return result, err
	}
	if result.Nodes, err = nodesFromValue(
		object["nodes"],
		"$.nodes",
		result.ScenarioInstanceID,
		MaxSnapshotNodes,
	); err != nil {
		return result, err
	}
	if result.Edges, err = edgesFromValue(
		object["edges"],
		"$.edges",
		result.ScenarioInstanceID,
		MaxSnapshotEdges,
	); err != nil {
		return result, err
	}
	nodes := make(map[string]struct{}, len(result.Nodes))
	for _, node := range result.Nodes {
		if _, exists := nodes[node.ID]; exists {
			return result, failure(ErrorReferenceInvalid, "$.nodes", "contains duplicate ID "+node.ID)
		}
		nodes[node.ID] = struct{}{}
	}
	edges := make(map[string]struct{}, len(result.Edges))
	for _, edge := range result.Edges {
		if _, exists := edges[edge.ID]; exists {
			return result, failure(ErrorReferenceInvalid, "$.edges", "contains duplicate ID "+edge.ID)
		}
		edges[edge.ID] = struct{}{}
	}
	for index, edge := range result.Edges {
		path := fmt.Sprintf("$.edges[%d]", index)
		if _, exists := nodes[edge.From]; !exists {
			return result, failure(ErrorReferenceInvalid, path+".from", "does not identify a graph node")
		}
		if _, exists := nodes[edge.To]; !exists {
			return result, failure(ErrorReferenceInvalid, path+".to", "does not identify a graph node")
		}
	}
	if result.Cursor, err = requiredCheckedString(
		object,
		"cursor",
		"$",
		MaxIdentifierCharacters,
		true,
		false,
	); err != nil {
		return result, err
	}
	if result.GeneratedAt, err = requiredDateTime(object, "generatedAt", "$"); err != nil {
		return result, err
	}
	if result.ProjectorVersion, err = requiredCheckedString(
		object,
		"projectorVersion",
		"$",
		MaxIdentifierCharacters,
		true,
		false,
	); err != nil {
		return result, err
	}
	if result.Completeness, err = completenessFromValue(object["completeness"], "$.completeness"); err != nil {
		return result, err
	}
	if result.IntegrityHash, err = requiredString(object, "integrityHash", "$"); err != nil {
		return result, err
	}
	if !integrityPattern.MatchString(result.IntegrityHash) {
		return result, failure(
			ErrorSchemaInvalid,
			"$.integrityHash",
			"must be sha256 followed by 64 lowercase hex digits",
		)
	}
	return result, nil
}

func DeltaFromValue(value graphjson.Value) (Delta, error) {
	object, err := exactObject(value, "$", []string{
		"schema", "scenarioInstanceId", "fromCursor", "toCursor", "generatedAt",
		"upsertNodes", "closeNodeIds", "upsertEdges", "closeEdgeIds", "evidenceRefs", "integrityHash",
	}, nil)
	if err != nil {
		return Delta{}, err
	}
	result := Delta{}
	if result.Schema, err = requiredString(object, "schema", "$"); err != nil {
		return result, err
	}
	if result.Schema != DeltaSchema {
		return result, failure(ErrorSchemaInvalid, "$.schema", "has the wrong delta schema")
	}
	if result.ScenarioInstanceID, err = requiredCheckedString(
		object,
		"scenarioInstanceId",
		"$",
		MaxIdentifierCharacters,
		true,
		false,
	); err != nil {
		return result, err
	}
	if result.FromCursor, err = requiredCheckedString(
		object,
		"fromCursor",
		"$",
		MaxIdentifierCharacters,
		true,
		false,
	); err != nil {
		return result, err
	}
	if result.ToCursor, err = requiredCheckedString(
		object,
		"toCursor",
		"$",
		MaxIdentifierCharacters,
		true,
		false,
	); err != nil {
		return result, err
	}
	if result.FromCursor == result.ToCursor {
		return result, failure(ErrorReferenceInvalid, "$.toCursor", "must differ from fromCursor")
	}
	if result.UpsertNodes, err = nodesFromValue(
		object["upsertNodes"],
		"$.upsertNodes",
		result.ScenarioInstanceID,
		MaxSnapshotNodes,
	); err != nil {
		return result, err
	}
	if result.UpsertEdges, err = edgesFromValue(
		object["upsertEdges"],
		"$.upsertEdges",
		result.ScenarioInstanceID,
		MaxSnapshotEdges,
	); err != nil {
		return result, err
	}
	if result.CloseNodeIDs, err = refsFromValue(
		object["closeNodeIds"],
		"$.closeNodeIds",
		MaxSnapshotNodes,
	); err != nil {
		return result, err
	}
	if result.CloseEdgeIDs, err = refsFromValue(
		object["closeEdgeIds"],
		"$.closeEdgeIds",
		MaxSnapshotEdges,
	); err != nil {
		return result, err
	}
	upsertNodes := make(map[string]struct{}, len(result.UpsertNodes))
	for _, node := range result.UpsertNodes {
		if _, exists := upsertNodes[node.ID]; exists {
			return result, failure(ErrorReferenceInvalid, "$.upsertNodes", "contains duplicate ID "+node.ID)
		}
		upsertNodes[node.ID] = struct{}{}
	}
	upsertEdges := make(map[string]struct{}, len(result.UpsertEdges))
	for _, edge := range result.UpsertEdges {
		if _, exists := upsertEdges[edge.ID]; exists {
			return result, failure(ErrorReferenceInvalid, "$.upsertEdges", "contains duplicate ID "+edge.ID)
		}
		upsertEdges[edge.ID] = struct{}{}
	}
	if err = validateUniqueRefs(result.CloseNodeIDs, "$.closeNodeIds"); err != nil {
		return result, err
	}
	if err = validateUniqueRefs(result.CloseEdgeIDs, "$.closeEdgeIds"); err != nil {
		return result, err
	}
	for index, nodeID := range result.CloseNodeIDs {
		if _, exists := upsertNodes[nodeID]; exists {
			return result, failure(
				ErrorReferenceInvalid,
				fmt.Sprintf("$.closeNodeIds[%d]", index),
				"cannot close and upsert the same node",
			)
		}
	}
	for index, edgeID := range result.CloseEdgeIDs {
		if _, exists := upsertEdges[edgeID]; exists {
			return result, failure(
				ErrorReferenceInvalid,
				fmt.Sprintf("$.closeEdgeIds[%d]", index),
				"cannot close and upsert the same edge",
			)
		}
	}
	if result.GeneratedAt, err = requiredDateTime(object, "generatedAt", "$"); err != nil {
		return result, err
	}
	if result.EvidenceRefs, err = refsFromValue(
		object["evidenceRefs"],
		"$.evidenceRefs",
		MaxDeltaEvidenceRefs,
	); err != nil {
		return result, err
	}
	if result.IntegrityHash, err = requiredString(object, "integrityHash", "$"); err != nil {
		return result, err
	}
	if !integrityPattern.MatchString(result.IntegrityHash) {
		return result, failure(
			ErrorSchemaInvalid,
			"$.integrityHash",
			"must be sha256 followed by 64 lowercase hex digits",
		)
	}
	return result, nil
}

func exactObject(value graphjson.Value, path string, required, optional []string) (graphjson.Object, error) {
	object, ok := value.(graphjson.Object)
	if !ok {
		return nil, failure(ErrorSchemaInvalid, path, "must be an object")
	}
	allowed := map[string]struct{}{}
	for _, key := range append(append([]string{}, required...), optional...) {
		allowed[key] = struct{}{}
	}
	keys := make([]string, 0, len(object))
	for key := range object {
		keys = append(keys, key)
	}
	sort.Slice(keys, func(left, right int) bool { return graphjson.UTF16Less(keys[left], keys[right]) })
	for _, key := range keys {
		if _, ok := allowed[key]; !ok {
			return nil, failure(ErrorSchemaInvalid, path+"."+key, "is not an allowed property")
		}
	}
	for _, key := range required {
		if _, ok := object[key]; !ok {
			return nil, failure(ErrorSchemaInvalid, path+"."+key, "is required")
		}
	}
	return object, nil
}

func requiredString(object graphjson.Object, key, path string) (string, error) {
	value, ok := object[key].(string)
	if !ok {
		return "", failure(ErrorSchemaInvalid, path+"."+key, "must be a string")
	}
	return value, nil
}

func requiredCheckedString(
	object graphjson.Object,
	key, path string,
	maximum int,
	identifier, allowEmpty bool,
) (string, error) {
	value, err := requiredString(object, key, path)
	if err != nil {
		return "", err
	}
	if err := checkedString(value, path+"."+key, maximum, identifier, allowEmpty); err != nil {
		return "", err
	}
	return value, nil
}

func requiredDateTime(object graphjson.Object, key, path string) (string, error) {
	value, err := requiredString(object, key, path)
	if err != nil {
		return "", err
	}
	if err := checkedDateTime(value, path+"."+key); err != nil {
		return "", err
	}
	return value, nil
}

func optionalString(object graphjson.Object, key, path string) (*string, error) {
	value, exists := object[key]
	if !exists {
		return nil, nil
	}
	text, ok := value.(string)
	if !ok {
		return nil, failure(ErrorSchemaInvalid, path+"."+key, "must be a string")
	}
	return &text, nil
}

func optionalCheckedString(
	object graphjson.Object,
	key, path string,
	maximum int,
	identifier, allowEmpty bool,
) (*string, error) {
	value, err := optionalString(object, key, path)
	if err != nil || value == nil {
		return value, err
	}
	if err := checkedString(*value, path+"."+key, maximum, identifier, allowEmpty); err != nil {
		return nil, err
	}
	return value, nil
}

func optionalDateTime(object graphjson.Object, key, path string) (*string, error) {
	value, err := optionalString(object, key, path)
	if err != nil || value == nil {
		return value, err
	}
	if err := checkedDateTime(*value, path+"."+key); err != nil {
		return nil, err
	}
	return value, nil
}

func refsFromValue(value graphjson.Value, path string, maximum int) ([]string, error) {
	array, ok := value.(graphjson.Array)
	if !ok {
		return nil, failure(ErrorSchemaInvalid, path, "must be an array")
	}
	if len(array) > maximum {
		return nil, failure(ErrorBoundExceeded, path, fmt.Sprintf("must contain at most %d items", maximum))
	}
	result := make([]string, len(array))
	for index, item := range array {
		text, ok := item.(string)
		if !ok {
			return nil, failure(ErrorSchemaInvalid, fmt.Sprintf("%s[%d]", path, index), "must be a string")
		}
		itemPath := fmt.Sprintf("%s[%d]", path, index)
		if err := checkedString(text, itemPath, MaxBoundedStringCharacters, true, false); err != nil {
			return nil, err
		}
		if matchesSecret(text) {
			return nil, failure(ErrorPropertyUnsafe, itemPath, "must not contain credential material")
		}
		result[index] = text
	}
	return result, nil
}

func authorityFromValue(value graphjson.Value, path string) (AuthorityRef, error) {
	object, err := exactObject(value, path, []string{"provider", "objectType", "objectId", "version", "observedAt"}, nil)
	if err != nil {
		return AuthorityRef{}, err
	}
	result := AuthorityRef{}
	if result.Provider, err = requiredString(object, "provider", path); err != nil {
		return result, err
	}
	if _, ok := providers[result.Provider]; !ok {
		return result, failure(ErrorSchemaInvalid, path+".provider", "is not a recognized authority provider")
	}
	if result.ObjectType, err = requiredCheckedString(
		object,
		"objectType",
		path,
		MaxAuthorityObjectTypeCharacters,
		true,
		false,
	); err != nil {
		return result, err
	}
	if result.ObjectID, err = requiredCheckedString(
		object,
		"objectId",
		path,
		MaxBoundedStringCharacters,
		true,
		false,
	); err != nil {
		return result, err
	}
	if result.Version, err = requiredCheckedString(
		object,
		"version",
		path,
		MaxBoundedStringCharacters,
		true,
		false,
	); err != nil {
		return result, err
	}
	if result.ObservedAt, err = requiredDateTime(object, "observedAt", path); err != nil {
		return result, err
	}
	for _, field := range []struct{ value, name string }{
		{result.Provider, "provider"},
		{result.ObjectType, "objectType"},
		{result.ObjectID, "objectId"},
		{result.Version, "version"},
		{result.ObservedAt, "observedAt"},
	} {
		if matchesSecret(field.value) {
			return result, failure(
				ErrorPropertyUnsafe,
				path+"."+field.name,
				"must not contain credential material",
			)
		}
	}
	return result, nil
}

func actorsFromValue(value graphjson.Value, path string) ([]ActorRef, error) {
	array, ok := value.(graphjson.Array)
	if !ok {
		return nil, failure(ErrorSchemaInvalid, path, "must be an array")
	}
	if len(array) > MaxOwners {
		return nil, failure(ErrorBoundExceeded, path, fmt.Sprintf("must contain at most %d items", MaxOwners))
	}
	result := make([]ActorRef, len(array))
	for index, item := range array {
		itemPath := fmt.Sprintf("%s[%d]", path, index)
		object, err := exactObject(item, itemPath, []string{"id", "kind"}, []string{"displayName"})
		if err != nil {
			return nil, err
		}
		if result[index].Kind, err = requiredString(object, "kind", itemPath); err != nil {
			return nil, err
		}
		if result[index].Kind != "human" &&
			result[index].Kind != "agent" &&
			result[index].Kind != "system" {
			return nil, failure(
				ErrorSchemaInvalid,
				itemPath+".kind",
				"must be human, agent, or system",
			)
		}
		if result[index].ID, err = requiredCheckedString(
			object,
			"id",
			itemPath,
			MaxIdentifierCharacters,
			true,
			false,
		); err != nil {
			return nil, err
		}
		if result[index].DisplayName, err = optionalCheckedString(
			object,
			"displayName",
			itemPath,
			MaxBoundedStringCharacters,
			false,
			false,
		); err != nil {
			return nil, err
		}
	}
	return result, nil
}

func nodesFromValue(value graphjson.Value, path, scope string, maximum int) ([]Node, error) {
	array, ok := value.(graphjson.Array)
	if !ok {
		return nil, failure(ErrorSchemaInvalid, path, "must be an array")
	}
	if len(array) > maximum {
		return nil, failure(ErrorBoundExceeded, path, fmt.Sprintf("must contain at most %d items", maximum))
	}
	result := make([]Node, len(array))
	for index, item := range array {
		node, err := nodeFromValue(item, fmt.Sprintf("%s[%d]", path, index), scope)
		if err != nil {
			return nil, err
		}
		result[index] = node
	}
	return result, nil
}

func nodeFromValue(value graphjson.Value, path, scope string) (Node, error) {
	required := []string{
		"id", "type", "scenarioDefinitionId", "scenarioInstanceId", "title", "authorityRef",
		"owners", "properties", "sourceEventIds", "evidenceRefs", "projectorVersion", "validFrom",
	}
	object, err := exactObject(value, path, required, []string{"status", "validTo"})
	if err != nil {
		return Node{}, err
	}
	result := Node{}
	if result.ScenarioInstanceID, err = requiredCheckedString(
		object,
		"scenarioInstanceId",
		path,
		MaxIdentifierCharacters,
		true,
		false,
	); err != nil {
		return result, err
	}
	if result.ScenarioInstanceID != scope {
		return result, failure(ErrorScopeInvalid, path+".scenarioInstanceId", "does not match graph scope")
	}
	if result.ValidFrom, err = requiredDateTime(object, "validFrom", path); err != nil {
		return result, err
	}
	if result.ValidTo, err = optionalDateTime(object, "validTo", path); err != nil {
		return result, err
	}
	if result.ValidTo != nil {
		if err := checkedInterval(result.ValidFrom, *result.ValidTo, path+".validTo"); err != nil {
			return result, err
		}
	}
	if result.Owners, err = actorsFromValue(object["owners"], path+".owners"); err != nil {
		return result, err
	}
	var ok bool
	if result.Properties, ok = object["properties"].(graphjson.Object); !ok {
		return result, failure(ErrorSchemaInvalid, path+".properties", "must be an object")
	}
	if err := validateProperty(result.Properties, path+".properties", 1); err != nil {
		return result, err
	}
	if result.ID, err = requiredCheckedString(
		object,
		"id",
		path,
		MaxIdentifierCharacters,
		true,
		false,
	); err != nil {
		return result, err
	}
	if result.Type, err = requiredCheckedString(
		object,
		"type",
		path,
		MaxIdentifierCharacters,
		true,
		false,
	); err != nil {
		return result, err
	}
	if result.AuthorityRef, err = authorityFromValue(object["authorityRef"], path+".authorityRef"); err != nil {
		return result, err
	}
	if result.ProjectorVersion, err = requiredCheckedString(
		object,
		"projectorVersion",
		path,
		MaxIdentifierCharacters,
		true,
		false,
	); err != nil {
		return result, err
	}
	if matchesSecret(result.ProjectorVersion) {
		return result, failure(
			ErrorPropertyUnsafe,
			path+".projectorVersion",
			"must not contain credential material",
		)
	}
	expected, deriveErr := DeriveNodeID(result.ScenarioInstanceID, result.Type, result.AuthorityRef)
	if deriveErr != nil {
		return result, deriveErr
	}
	if result.ID != expected {
		return result, failure(
			ErrorReferenceInvalid,
			path+".id",
			"must equal the derived stable ID "+expected,
		)
	}
	if result.ScenarioDefinitionID, err = requiredCheckedString(
		object,
		"scenarioDefinitionId",
		path,
		MaxIdentifierCharacters,
		true,
		false,
	); err != nil {
		return result, err
	}
	if result.Title, err = requiredCheckedString(
		object,
		"title",
		path,
		MaxBoundedStringCharacters,
		false,
		false,
	); err != nil {
		return result, err
	}
	if result.Status, err = optionalCheckedString(
		object,
		"status",
		path,
		MaxIdentifierCharacters,
		false,
		false,
	); err != nil {
		return result, err
	}
	if result.SourceEventIDs, err = refsFromValue(
		object["sourceEventIds"],
		path+".sourceEventIds",
		MaxSourceEventIDs,
	); err != nil {
		return result, err
	}
	if result.EvidenceRefs, err = refsFromValue(
		object["evidenceRefs"],
		path+".evidenceRefs",
		MaxEvidenceRefs,
	); err != nil {
		return result, err
	}
	return result, nil
}

func edgesFromValue(value graphjson.Value, path, scope string, maximum int) ([]Edge, error) {
	array, ok := value.(graphjson.Array)
	if !ok {
		return nil, failure(ErrorSchemaInvalid, path, "must be an array")
	}
	if len(array) > maximum {
		return nil, failure(ErrorBoundExceeded, path, fmt.Sprintf("must contain at most %d items", maximum))
	}
	result := make([]Edge, len(array))
	for index, item := range array {
		edge, err := edgeFromValue(item, fmt.Sprintf("%s[%d]", path, index), scope)
		if err != nil {
			return nil, err
		}
		result[index] = edge
	}
	return result, nil
}

func edgeFromValue(value graphjson.Value, path, scope string) (Edge, error) {
	required := []string{
		"id", "type", "from", "to", "scenarioInstanceId", "sourceEventIds",
		"evidenceRefs", "projectorVersion", "validFrom",
	}
	object, err := exactObject(value, path, required, []string{"authorityRef", "validTo"})
	if err != nil {
		return Edge{}, err
	}
	result := Edge{}
	if result.ScenarioInstanceID, err = requiredCheckedString(
		object,
		"scenarioInstanceId",
		path,
		MaxIdentifierCharacters,
		true,
		false,
	); err != nil {
		return result, err
	}
	if result.ScenarioInstanceID != scope {
		return result, failure(ErrorScopeInvalid, path+".scenarioInstanceId", "does not match graph scope")
	}
	if result.ValidFrom, err = requiredDateTime(object, "validFrom", path); err != nil {
		return result, err
	}
	if result.ValidTo, err = optionalDateTime(object, "validTo", path); err != nil {
		return result, err
	}
	if result.ValidTo != nil {
		if err := checkedInterval(result.ValidFrom, *result.ValidTo, path+".validTo"); err != nil {
			return result, err
		}
	}
	for _, field := range []struct {
		key    string
		target *string
	}{
		{"id", &result.ID},
		{"type", &result.Type},
		{"from", &result.From},
		{"to", &result.To},
	} {
		*field.target, err = requiredCheckedString(
			object,
			field.key,
			path,
			MaxIdentifierCharacters,
			true,
			false,
		)
		if err != nil {
			return result, err
		}
	}
	if authorityValue, exists := object["authorityRef"]; exists {
		authority, decodeErr := authorityFromValue(authorityValue, path+".authorityRef")
		if decodeErr != nil {
			return result, decodeErr
		}
		result.AuthorityRef = &authority
	}
	if result.ProjectorVersion, err = requiredCheckedString(
		object,
		"projectorVersion",
		path,
		MaxIdentifierCharacters,
		true,
		false,
	); err != nil {
		return result, err
	}
	if matchesSecret(result.ProjectorVersion) {
		return result, failure(
			ErrorPropertyUnsafe,
			path+".projectorVersion",
			"must not contain credential material",
		)
	}
	expected, deriveErr := DeriveEdgeID(
		result.ScenarioInstanceID,
		result.Type,
		result.From,
		result.To,
		result.AuthorityRef,
	)
	if deriveErr != nil {
		return result, deriveErr
	}
	if result.ID != expected {
		return result, failure(
			ErrorReferenceInvalid,
			path+".id",
			"must equal the derived stable ID "+expected,
		)
	}
	if result.SourceEventIDs, err = refsFromValue(
		object["sourceEventIds"],
		path+".sourceEventIds",
		MaxSourceEventIDs,
	); err != nil {
		return result, err
	}
	if result.EvidenceRefs, err = refsFromValue(
		object["evidenceRefs"],
		path+".evidenceRefs",
		MaxEvidenceRefs,
	); err != nil {
		return result, err
	}
	return result, nil
}

func completenessFromValue(value graphjson.Value, path string) (Completeness, error) {
	object, err := exactObject(value, path, []string{"sourcesRequested", "sourcesObserved", "missingSources", "warnings"}, nil)
	if err != nil {
		return Completeness{}, err
	}
	result := Completeness{}
	fields := []struct {
		key    string
		target *[]string
	}{
		{"sourcesRequested", &result.SourcesRequested}, {"sourcesObserved", &result.SourcesObserved},
		{"missingSources", &result.MissingSources}, {"warnings", &result.Warnings},
	}
	for _, field := range fields {
		*field.target, err = refsFromValue(
			object[field.key],
			path+"."+field.key,
			MaxCompletenessItems,
		)
		if err != nil {
			return result, err
		}
	}
	return result, nil
}
