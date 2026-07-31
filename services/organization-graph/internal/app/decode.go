package app

import (
	"errors"
	"fmt"
	"io"
	"math"
	"mime"
	"net/http"
	"strings"
	"unicode/utf8"

	graph "github.com/Negentropy-Laby/OpenSlack/services/organization-graph"
)

const (
	MaxRequestBodyBytes = int64(64 * 1024 * 1024)
	maxRequestJSONDepth = 32
	maxRequestJSONNodes = 2_000_000
)

type requestTooLargeError struct{}

func (requestTooLargeError) Error() string { return "request body exceeds its byte limit" }

type requestValidationError struct {
	message string
}

func (failure requestValidationError) Error() string { return failure.message }

func invalidRequest(format string, arguments ...any) error {
	return requestValidationError{message: fmt.Sprintf(format, arguments...)}
}

func readStrictJSON(request *http.Request) (graph.Value, error) {
	if request.ContentLength > MaxRequestBodyBytes {
		return nil, requestTooLargeError{}
	}
	if encoding := strings.TrimSpace(request.Header.Get("Content-Encoding")); encoding != "" && encoding != "identity" {
		return nil, invalidRequest("Content-Encoding is not supported")
	}
	mediaType, _, err := mime.ParseMediaType(request.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		return nil, invalidRequest("Content-Type must be application/json")
	}

	reader := io.LimitReader(request.Body, MaxRequestBodyBytes+1)
	body, err := io.ReadAll(reader)
	if err != nil {
		return nil, invalidRequest("request body could not be read")
	}
	if int64(len(body)) > MaxRequestBodyBytes {
		return nil, requestTooLargeError{}
	}
	if len(body) == 0 {
		return nil, invalidRequest("request body must contain one JSON object")
	}

	limits := graph.JSONLimits{
		MaxDepth:        graph.JSONLimit(maxRequestJSONDepth),
		MaxNodes:        graph.JSONLimit(maxRequestJSONNodes),
		MaxStringLength: graph.JSONLimit(graph.MaxPropertyStringCharacters),
	}
	value, err := graph.ParseCanonicalJSON(body, limits)
	if err != nil {
		var jsonFailure *graph.JSONError
		if errors.As(err, &jsonFailure) && jsonFailure.Code == graph.JSONLimitExceeded {
			return nil, requestTooLargeError{}
		}
		return nil, invalidRequest("request body is not strict JSON")
	}
	return value, nil
}

func strictObject(value graph.Value, required, optional []string) (graph.Object, error) {
	object, ok := value.(graph.Object)
	if !ok {
		return nil, invalidRequest("request body must be a JSON object")
	}
	allowed := make(map[string]struct{}, len(required)+len(optional))
	for _, name := range required {
		allowed[name] = struct{}{}
		if _, exists := object[name]; !exists {
			return nil, invalidRequest("request body is missing required field %s", name)
		}
	}
	for _, name := range optional {
		allowed[name] = struct{}{}
	}
	for name := range object {
		if _, exists := allowed[name]; !exists {
			return nil, invalidRequest("request body contains an unknown field")
		}
	}
	return object, nil
}

func requiredString(object graph.Object, name string) (string, error) {
	value, ok := object[name].(string)
	if !ok || !boundedIdentifier(value) {
		return "", invalidRequest("%s must be a non-empty bounded string", name)
	}
	return value, nil
}

func optionalString(object graph.Object, name string) (*string, error) {
	value, exists := object[name]
	if !exists || value == nil {
		return nil, nil
	}
	text, ok := value.(string)
	if !ok || !boundedIdentifier(text) {
		return nil, invalidRequest("%s must be a non-empty bounded string", name)
	}
	return &text, nil
}

func requiredNullableString(object graph.Object, name string) (*string, error) {
	value := object[name]
	if value == nil {
		return nil, nil
	}
	text, ok := value.(string)
	if !ok || !boundedIdentifier(text) {
		return nil, invalidRequest("%s must be a non-empty bounded string or null", name)
	}
	return &text, nil
}

func boundedIdentifier(value string) bool {
	if value == "" || !utf8.ValidString(value) {
		return false
	}
	units := 0
	for _, character := range value {
		if character <= 0x1f || character == 0x7f {
			return false
		}
		if character > 0xffff {
			units += 2
		} else {
			units++
		}
		if units > graph.MaxIdentifierCharacters {
			return false
		}
	}
	return true
}

func optionalStringArray(object graph.Object, name string) ([]string, error) {
	value, exists := object[name]
	if !exists {
		return nil, nil
	}
	array, ok := value.(graph.Array)
	if !ok {
		return nil, invalidRequest("%s must be an array of strings", name)
	}
	if len(array) > graph.MaxNodes {
		return nil, requestTooLargeError{}
	}
	result := make([]string, len(array))
	for index, item := range array {
		text, ok := item.(string)
		if !ok || !boundedIdentifier(text) {
			return nil, invalidRequest("%s[%d] must be a non-empty bounded string", name, index)
		}
		result[index] = text
	}
	return result, nil
}

func optionalInteger(object graph.Object, name string) (*int, error) {
	value, exists := object[name]
	if !exists {
		return nil, nil
	}
	number, ok := value.(float64)
	if !ok || math.Trunc(number) != number || number < -2_147_483_648 || number > 2_147_483_647 {
		return nil, invalidRequest("%s must be an integer", name)
	}
	result := int(number)
	return &result, nil
}

func optionalBoolean(object graph.Object, name string) (*bool, error) {
	value, exists := object[name]
	if !exists {
		return nil, nil
	}
	boolean, ok := value.(bool)
	if !ok {
		return nil, invalidRequest("%s must be a boolean", name)
	}
	return &boolean, nil
}

func decodeSnapshotRequest(value graph.Value) (expectedCursor *string, snapshot graph.Snapshot, canonical []byte, normalized graph.Value, err error) {
	object, err := strictObject(value, []string{"expectedCursor", "snapshot"}, nil)
	if err != nil {
		return nil, graph.Snapshot{}, nil, nil, err
	}
	expectedCursor, err = requiredNullableString(object, "expectedCursor")
	if err != nil {
		return nil, graph.Snapshot{}, nil, nil, err
	}
	snapshotValue, ok := object["snapshot"].(graph.Object)
	if !ok {
		return nil, graph.Snapshot{}, nil, nil, invalidRequest("snapshot must be a JSON object")
	}
	rawSnapshot, err := graph.CanonicalJSON(snapshotValue)
	if err != nil {
		return nil, graph.Snapshot{}, nil, nil, invalidRequest("snapshot cannot be canonicalized")
	}
	snapshot, err = graph.ParseSnapshot(rawSnapshot)
	if err != nil {
		return nil, graph.Snapshot{}, nil, nil, err
	}
	snapshot, err = graph.AssertSnapshotIntegrity(snapshot)
	if err != nil {
		return nil, graph.Snapshot{}, nil, nil, err
	}
	canonical, err = graph.SerializeSnapshot(snapshot)
	if err != nil {
		return nil, graph.Snapshot{}, nil, nil, err
	}
	canonicalValue, err := graph.ParseCanonicalJSON(canonical, graph.DefaultJSONLimits())
	if err != nil {
		return nil, graph.Snapshot{}, nil, nil, err
	}
	normalized = graph.Object{"expectedCursor": expectedCursorValue(expectedCursor), "snapshot": canonicalValue}
	return expectedCursor, snapshot, canonical, normalized, nil
}

func decodeDeltaRequest(value graph.Value) (expectedCursor string, target graph.Snapshot, targetBytes []byte, delta graph.Delta, deltaBytes []byte, normalized graph.Value, err error) {
	object, err := strictObject(value, []string{"expectedCursor", "targetSnapshot", "delta"}, nil)
	if err != nil {
		return "", graph.Snapshot{}, nil, graph.Delta{}, nil, nil, err
	}
	expectedCursor, err = requiredString(object, "expectedCursor")
	if err != nil {
		return "", graph.Snapshot{}, nil, graph.Delta{}, nil, nil, err
	}
	targetValue, ok := object["targetSnapshot"].(graph.Object)
	if !ok {
		return "", graph.Snapshot{}, nil, graph.Delta{}, nil, nil, invalidRequest("targetSnapshot must be a JSON object")
	}
	rawTarget, err := graph.CanonicalJSON(targetValue)
	if err != nil {
		return "", graph.Snapshot{}, nil, graph.Delta{}, nil, nil, invalidRequest("targetSnapshot cannot be canonicalized")
	}
	target, err = graph.ParseSnapshot(rawTarget)
	if err != nil {
		return "", graph.Snapshot{}, nil, graph.Delta{}, nil, nil, err
	}
	target, err = graph.AssertSnapshotIntegrity(target)
	if err != nil {
		return "", graph.Snapshot{}, nil, graph.Delta{}, nil, nil, err
	}
	targetBytes, err = graph.SerializeSnapshot(target)
	if err != nil {
		return "", graph.Snapshot{}, nil, graph.Delta{}, nil, nil, err
	}

	deltaValue, ok := object["delta"].(graph.Object)
	if !ok {
		return "", graph.Snapshot{}, nil, graph.Delta{}, nil, nil, invalidRequest("delta must be a JSON object")
	}
	rawDelta, err := graph.CanonicalJSON(deltaValue)
	if err != nil {
		return "", graph.Snapshot{}, nil, graph.Delta{}, nil, nil, invalidRequest("delta cannot be canonicalized")
	}
	delta, err = graph.ParseDelta(rawDelta)
	if err != nil {
		return "", graph.Snapshot{}, nil, graph.Delta{}, nil, nil, err
	}
	delta, err = graph.AssertDeltaIntegrity(delta)
	if err != nil {
		return "", graph.Snapshot{}, nil, graph.Delta{}, nil, nil, err
	}
	deltaBytes, err = graph.SerializeDelta(delta)
	if err != nil {
		return "", graph.Snapshot{}, nil, graph.Delta{}, nil, nil, err
	}

	targetCanonicalValue, err := graph.ParseCanonicalJSON(targetBytes, graph.DefaultJSONLimits())
	if err != nil {
		return "", graph.Snapshot{}, nil, graph.Delta{}, nil, nil, err
	}
	deltaCanonicalValue, err := graph.ParseCanonicalJSON(deltaBytes, graph.DefaultJSONLimits())
	if err != nil {
		return "", graph.Snapshot{}, nil, graph.Delta{}, nil, nil, err
	}
	normalized = graph.Object{
		"expectedCursor": expectedCursor,
		"targetSnapshot": targetCanonicalValue,
		"delta":          deltaCanonicalValue,
	}
	return expectedCursor, target, targetBytes, delta, deltaBytes, normalized, nil
}

func decodeQuery(value graph.Value) (graph.QueryInput, error) {
	object, err := strictObject(value, []string{"scenarioInstanceId"}, []string{
		"rootNodeIds", "nodeTypes", "edgeTypes", "statuses", "direction", "depth",
		"maxNodes", "maxEdges", "maxResponseBytes", "includeEvidence", "cursor",
	})
	if err != nil {
		return graph.QueryInput{}, err
	}
	result := graph.QueryInput{}
	if result.ScenarioInstanceID, err = requiredString(object, "scenarioInstanceId"); err != nil {
		return graph.QueryInput{}, err
	}
	if result.RootNodeIDs, err = optionalStringArray(object, "rootNodeIds"); err != nil {
		return graph.QueryInput{}, err
	}
	if result.NodeTypes, err = optionalStringArray(object, "nodeTypes"); err != nil {
		return graph.QueryInput{}, err
	}
	if result.EdgeTypes, err = optionalStringArray(object, "edgeTypes"); err != nil {
		return graph.QueryInput{}, err
	}
	if result.Statuses, err = optionalStringArray(object, "statuses"); err != nil {
		return graph.QueryInput{}, err
	}
	if direction, exists := object["direction"]; exists {
		text, ok := direction.(string)
		if !ok {
			return graph.QueryInput{}, invalidRequest("direction must be a string")
		}
		result.Direction = graph.Direction(text)
	}
	if result.Depth, err = optionalInteger(object, "depth"); err != nil {
		return graph.QueryInput{}, err
	}
	if result.MaxNodes, err = optionalInteger(object, "maxNodes"); err != nil {
		return graph.QueryInput{}, err
	}
	if result.MaxEdges, err = optionalInteger(object, "maxEdges"); err != nil {
		return graph.QueryInput{}, err
	}
	if result.MaxResponseBytes, err = optionalInteger(object, "maxResponseBytes"); err != nil {
		return graph.QueryInput{}, err
	}
	if result.IncludeEvidence, err = optionalBoolean(object, "includeEvidence"); err != nil {
		return graph.QueryInput{}, err
	}
	if result.Cursor, err = optionalString(object, "cursor"); err != nil {
		return graph.QueryInput{}, err
	}
	return result, nil
}

func decodeExplain(value graph.Value) (graph.ExplainInput, error) {
	object, err := strictObject(value, []string{"scenarioInstanceId", "targetId"}, []string{
		"rootNodeId", "direction", "depth",
	})
	if err != nil {
		return graph.ExplainInput{}, err
	}
	result := graph.ExplainInput{}
	if result.ScenarioInstanceID, err = requiredString(object, "scenarioInstanceId"); err != nil {
		return graph.ExplainInput{}, err
	}
	if result.TargetID, err = requiredString(object, "targetId"); err != nil {
		return graph.ExplainInput{}, err
	}
	if result.RootNodeID, err = optionalString(object, "rootNodeId"); err != nil {
		return graph.ExplainInput{}, err
	}
	if direction, exists := object["direction"]; exists {
		text, ok := direction.(string)
		if !ok {
			return graph.ExplainInput{}, invalidRequest("direction must be a string")
		}
		result.Direction = graph.Direction(text)
	}
	if result.Depth, err = optionalInteger(object, "depth"); err != nil {
		return graph.ExplainInput{}, err
	}
	return result, nil
}

func expectedCursorValue(value *string) graph.Value {
	if value == nil {
		return nil
	}
	return *value
}
