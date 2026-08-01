package graphquery

import (
	"bytes"
	"crypto/hmac"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"math"
	"regexp"
	"sort"

	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphcontract"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/internal/graphjson"
)

const (
	DefaultCursorTTLMS            = int64(5 * 60 * 1000)
	MinCursorTTLMS                = int64(1)
	MaxCursorTTLMS                = int64(60 * 60 * 1000)
	MinResponseBytes              = 1024
	CursorCharacters              = 512
	CursorSecretMinBytes          = 32
	CursorSecretMaxBytes          = 1024
	CursorPayloadDepth            = 4
	CursorPayloadNodes            = 16
	CursorPayloadStringCharacters = 256
	maxSafeInteger                = int64(9007199254740991)
)

var cursorPattern = regexp.MustCompile(`^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{43}$`)

type normalizedQuery struct {
	scenarioInstanceID string
	rootNodeIDs        []string
	nodeTypes          []string
	edgeTypes          []string
	statuses           []string
	direction          Direction
	depth              int
	maxNodes           int
	maxEdges           int
	maxResponseBytes   int
	includeEvidence    bool
}

type cursorPayload struct {
	queryHash    string
	snapshotHash string
	offset       int
	expiresAt    int64
}

type traversal struct {
	nodes []graphcontract.Node
	edges []graphcontract.Edge
	paths map[string]RelationshipPath
}

type adjacencyStep struct {
	edge graphcontract.Edge
	next string
}

func compareLess(left, right string) bool { return graphjson.UTF16Less(left, right) }

func boundedString(value, name string) (string, error) {
	if graphjson.UTF16Len(value) == 0 ||
		graphjson.UTF16Len(value) > graphcontract.MaxIdentifierCharacters ||
		!graphjson.ValidString(value) {
		return "", failure(ErrorInvalid, name+" must be a non-empty bounded identifier.")
	}
	for _, character := range value {
		if character <= 0x1f || character == 0x7f {
			return "", failure(ErrorInvalid, name+" must be a non-empty bounded identifier.")
		}
	}
	return value, nil
}

func stringSet(values []string, name string, maximum int) ([]string, error) {
	if len(values) > maximum {
		return nil, failure(ErrorInvalid, name+" contains too many identifiers.")
	}
	seen := map[string]struct{}{}
	result := make([]string, 0, len(values))
	for index, value := range values {
		checked, err := boundedString(value, name+"["+itoa(index)+"]")
		if err != nil {
			return nil, err
		}
		if _, exists := seen[checked]; exists {
			continue
		}
		seen[checked] = struct{}{}
		result = append(result, checked)
	}
	sort.Slice(result, func(left, right int) bool { return compareLess(result[left], result[right]) })
	return result, nil
}

func integer(value *int, fallback, minimum, maximum int, name string) (int, error) {
	if value == nil {
		return fallback, nil
	}
	if *value < minimum || *value > maximum {
		return 0, failure(ErrorInvalid, name+" is outside its bounded range.")
	}
	return *value, nil
}

func normalize(input Input) (normalizedQuery, error) {
	var result normalizedQuery
	var err error
	if result.scenarioInstanceID, err = boundedString(input.ScenarioInstanceID, "scenarioInstanceId"); err != nil {
		return result, err
	}
	if result.rootNodeIDs, err = stringSet(input.RootNodeIDs, "rootNodeIds", graphcontract.MaxNodes); err != nil {
		return result, err
	}
	if result.nodeTypes, err = stringSet(input.NodeTypes, "nodeTypes", graphcontract.MaxQueryFilterItems); err != nil {
		return result, err
	}
	if result.edgeTypes, err = stringSet(input.EdgeTypes, "edgeTypes", graphcontract.MaxQueryFilterItems); err != nil {
		return result, err
	}
	if result.statuses, err = stringSet(input.Statuses, "statuses", graphcontract.MaxQueryFilterItems); err != nil {
		return result, err
	}
	result.direction = input.Direction
	if result.direction == "" {
		result.direction = Outgoing
	}
	if result.direction != Outgoing && result.direction != Incoming && result.direction != Both {
		return result, failure(ErrorInvalid, "direction must be outgoing, incoming, or both.")
	}
	if result.depth, err = integer(input.Depth, 1, 0, graphcontract.MaxDepth, "depth"); err != nil {
		return result, err
	}
	if result.maxNodes, err = integer(input.MaxNodes, graphcontract.MaxNodes, 1, graphcontract.MaxNodes, "maxNodes"); err != nil {
		return result, err
	}
	if result.maxEdges, err = integer(input.MaxEdges, graphcontract.MaxEdges, 1, graphcontract.MaxEdges, "maxEdges"); err != nil {
		return result, err
	}
	if result.maxResponseBytes, err = integer(input.MaxResponseBytes, graphcontract.MaxResponseBytes, MinResponseBytes, graphcontract.MaxResponseBytes, "maxResponseBytes"); err != nil {
		return result, err
	}
	if input.IncludeEvidence != nil {
		result.includeEvidence = *input.IncludeEvidence
	}
	if input.Cursor != nil {
		if _, err := boundedString(*input.Cursor, "cursor"); err != nil {
			return result, err
		}
	}
	return result, nil
}

func normalizedValue(value normalizedQuery) graphjson.Object {
	return graphjson.Object{
		"scenarioInstanceId": value.scenarioInstanceID, "rootNodeIds": stringsValue(value.rootNodeIDs),
		"nodeTypes": stringsValue(value.nodeTypes), "edgeTypes": stringsValue(value.edgeTypes),
		"statuses": stringsValue(value.statuses), "direction": string(value.direction),
		"depth": float64(value.depth), "maxNodes": float64(value.maxNodes), "maxEdges": float64(value.maxEdges),
		"maxResponseBytes": float64(value.maxResponseBytes), "includeEvidence": value.includeEvidence,
	}
}

func normalizedHash(value normalizedQuery) (string, error) {
	encoded, err := graphjson.Encode(normalizedValue(value))
	if err != nil {
		return "", err
	}
	hash := sha256.Sum256(encoded)
	return "sha256:" + hex.EncodeToString(hash[:]), nil
}

func GraphQueryHash(input Input) (string, error) {
	query, err := normalize(input)
	if err != nil {
		return "", err
	}
	return normalizedHash(query)
}

func cursorValue(value cursorPayload) graphjson.Object {
	return graphjson.Object{
		"version": float64(1), "queryHash": value.queryHash, "snapshotHash": value.snapshotHash,
		"offset": float64(value.offset), "expiresAt": float64(value.expiresAt),
	}
}

func encodeCursor(value cursorPayload, secret []byte) (string, error) {
	encodedJSON, err := graphjson.Encode(cursorValue(value))
	if err != nil {
		return "", err
	}
	encoded := base64.RawURLEncoding.EncodeToString(encodedJSON)
	mac := hmac.New(sha256.New, secret)
	written, err := mac.Write([]byte(encoded))
	if err != nil || written != len(encoded) {
		return "", failure(ErrorInvalid, "Graph query cursor signing failed.")
	}
	signature := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	return encoded + "." + signature, nil
}

func decodeCursor(value string, secret []byte) (cursorPayload, error) {
	if len(value) > CursorCharacters || !cursorPattern.MatchString(value) {
		return cursorPayload{}, failure(ErrorCursorInvalid, "Graph query cursor is malformed.")
	}
	dot := 0
	for value[dot] != '.' {
		dot++
	}
	encoded, suppliedSignature := value[:dot], value[dot+1:]
	mac := hmac.New(sha256.New, secret)
	written, err := mac.Write([]byte(encoded))
	if err != nil || written != len(encoded) {
		return cursorPayload{}, failure(ErrorCursorInvalid, "Graph query cursor authentication failed.")
	}
	expected := base64.RawURLEncoding.EncodeToString(mac.Sum(nil))
	if len(suppliedSignature) != len(expected) || subtle.ConstantTimeCompare([]byte(suppliedSignature), []byte(expected)) != 1 {
		return cursorPayload{}, failure(ErrorCursorInvalid, "Graph query cursor is not authentic.")
	}
	payloadBytes, err := base64.RawURLEncoding.Strict().DecodeString(encoded)
	if err != nil {
		return cursorPayload{}, failure(ErrorCursorInvalid, "Graph query cursor payload is invalid.")
	}
	payloadValue, err := graphjson.Parse(payloadBytes, graphjson.Limits{
		MaxDepth:        graphjson.Limit(CursorPayloadDepth),
		MaxNodes:        graphjson.Limit(CursorPayloadNodes),
		MaxStringLength: graphjson.Limit(CursorPayloadStringCharacters),
	})
	if err != nil {
		return cursorPayload{}, failure(ErrorCursorInvalid, "Graph query cursor payload is invalid.")
	}
	canonicalPayload, err := graphjson.Encode(payloadValue)
	if err != nil || !bytes.Equal(canonicalPayload, payloadBytes) {
		return cursorPayload{}, failure(ErrorCursorInvalid, "Graph query cursor payload is invalid.")
	}
	object, ok := payloadValue.(graphjson.Object)
	if !ok || len(object) != 5 {
		return cursorPayload{}, failure(ErrorCursorInvalid, "Graph query cursor payload is invalid.")
	}
	version, versionOK := object["version"].(float64)
	queryHash, queryOK := object["queryHash"].(string)
	snapshotHash, snapshotOK := object["snapshotHash"].(string)
	offset, offsetOK := safeInteger(object["offset"])
	expiresAt, expiryOK := safeInteger(object["expiresAt"])
	if !versionOK || version != 1 || !queryOK || !snapshotOK || !offsetOK || !expiryOK ||
		offset < 0 ||
		offset > int64(graphcontract.MaxSnapshotNodes+graphcontract.MaxSnapshotEdges) ||
		expiresAt < 0 ||
		!hasExactKeys(object, []string{"expiresAt", "offset", "queryHash", "snapshotHash", "version"}) {
		return cursorPayload{}, failure(ErrorCursorInvalid, "Graph query cursor payload is invalid.")
	}
	return cursorPayload{queryHash: queryHash, snapshotHash: snapshotHash, offset: int(offset), expiresAt: expiresAt}, nil
}

func safeInteger(value graphjson.Value) (int64, bool) {
	number, ok := value.(float64)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) || math.Trunc(number) != number ||
		number <= -9007199254740992 || number >= 9007199254740992 {
		return 0, false
	}
	return int64(number), true
}

func hasExactKeys(object graphjson.Object, expected []string) bool {
	if len(object) != len(expected) {
		return false
	}
	for _, key := range expected {
		if _, exists := object[key]; !exists {
			return false
		}
	}
	return true
}

func buildAdjacency(edges []graphcontract.Edge, direction Direction) map[string][]adjacencyStep {
	result := map[string][]adjacencyStep{}
	for _, edge := range edges {
		if direction == Outgoing || direction == Both {
			result[edge.From] = append(result[edge.From], adjacencyStep{edge: edge, next: edge.To})
		}
		if direction == Incoming || (direction == Both && edge.To != edge.From) {
			result[edge.To] = append(result[edge.To], adjacencyStep{edge: edge, next: edge.From})
		}
	}
	for nodeID := range result {
		sort.Slice(result[nodeID], func(left, right int) bool {
			if result[nodeID][left].edge.ID == result[nodeID][right].edge.ID {
				return compareLess(result[nodeID][left].next, result[nodeID][right].next)
			}
			return compareLess(result[nodeID][left].edge.ID, result[nodeID][right].edge.ID)
		})
	}
	return result
}

func contains(values []string, value string) bool {
	for _, candidate := range values {
		if candidate == value {
			return true
		}
	}
	return false
}

func matchingEdge(edge graphcontract.Edge, query normalizedQuery) bool {
	return len(query.edgeTypes) == 0 || contains(query.edgeTypes, edge.Type)
}

func matchingNode(node graphcontract.Node, query normalizedQuery) bool {
	if len(query.nodeTypes) != 0 && !contains(query.nodeTypes, node.Type) {
		return false
	}
	return len(query.statuses) == 0 || (node.Status != nil && contains(query.statuses, *node.Status))
}

func traverse(snapshot graphcontract.Snapshot, query normalizedQuery) (traversal, error) {
	nodeMap := make(map[string]graphcontract.Node, len(snapshot.Nodes))
	for _, node := range snapshot.Nodes {
		nodeMap[node.ID] = node
	}
	allowedEdges := make([]graphcontract.Edge, 0, len(snapshot.Edges))
	for _, edge := range snapshot.Edges {
		if matchingEdge(edge, query) {
			allowedEdges = append(allowedEdges, edge)
		}
	}
	paths := map[string]RelationshipPath{}
	if len(query.rootNodeIDs) == 0 {
		nodes := make([]graphcontract.Node, 0, len(snapshot.Nodes))
		ids := map[string]struct{}{}
		for _, node := range snapshot.Nodes {
			if matchingNode(node, query) {
				nodes = append(nodes, node)
				ids[node.ID] = struct{}{}
				paths[node.ID] = RelationshipPath{NodeID: node.ID, NodeIDs: []string{node.ID}, EdgeIDs: []string{}}
			}
		}
		edges := make([]graphcontract.Edge, 0, len(allowedEdges))
		for _, edge := range allowedEdges {
			_, from := ids[edge.From]
			_, to := ids[edge.To]
			if from && to {
				edges = append(edges, edge)
			}
		}
		return traversal{nodes: nodes, edges: edges, paths: paths}, nil
	}
	type queued struct {
		id    string
		depth int
	}
	queue := make([]queued, 0)
	visited := map[string]struct{}{}
	for _, root := range query.rootNodeIDs {
		if _, exists := nodeMap[root]; !exists {
			return traversal{}, failure(ErrorTargetNotFound, "Graph query root "+root+" does not exist.")
		}
		visited[root] = struct{}{}
		paths[root] = RelationshipPath{NodeID: root, NodeIDs: []string{root}, EdgeIDs: []string{}}
		queue = append(queue, queued{id: root})
	}
	adjacency := buildAdjacency(allowedEdges, query.direction)
	steps := 0
	for len(queue) > 0 {
		current := queue[0]
		queue = queue[1:]
		if current.depth >= query.depth {
			continue
		}
		for _, step := range adjacency[current.id] {
			steps++
			if steps > graphcontract.MaxTraversalSteps {
				return traversal{}, failure(ErrorInvalid, "Graph traversal exceeds its bounded adjacency steps.")
			}
			if _, exists := visited[step.next]; exists {
				continue
			}
			if _, exists := nodeMap[step.next]; !exists {
				continue
			}
			parent := paths[current.id]
			nextNodes := append(append([]string{}, parent.NodeIDs...), step.next)
			nextEdges := append(append([]string{}, parent.EdgeIDs...), step.edge.ID)
			visited[step.next] = struct{}{}
			paths[step.next] = RelationshipPath{NodeID: step.next, NodeIDs: nextNodes, EdgeIDs: nextEdges}
			queue = append(queue, queued{id: step.next, depth: current.depth + 1})
		}
	}
	nodes := make([]graphcontract.Node, 0, len(visited))
	returned := map[string]struct{}{}
	for id := range visited {
		node := nodeMap[id]
		if matchingNode(node, query) {
			nodes = append(nodes, node)
			returned[id] = struct{}{}
		}
	}
	sort.Slice(nodes, func(left, right int) bool { return compareLess(nodes[left].ID, nodes[right].ID) })
	edges := make([]graphcontract.Edge, 0)
	for _, edge := range allowedEdges {
		_, from := returned[edge.From]
		_, to := returned[edge.To]
		if from && to {
			edges = append(edges, edge)
		}
	}
	sort.Slice(edges, func(left, right int) bool { return compareLess(edges[left].ID, edges[right].ID) })
	return traversal{nodes: nodes, edges: edges, paths: paths}, nil
}

type resultItem struct {
	node *graphcontract.Node
	edge *graphcontract.Edge
}

func responseSize(result *Result) (int, error) {
	previous, current := -1, 0
	for current != previous {
		previous = current
		result.Truncation.ResponseBytes = current
		encoded, err := graphjson.Encode(ResultValue(*result))
		if err != nil {
			return 0, err
		}
		current = len(encoded)
	}
	result.Truncation.ResponseBytes = current
	encoded, err := graphjson.Encode(ResultValue(*result))
	if err != nil {
		return 0, err
	}
	return len(encoded), nil
}

func buildResult(snapshot graphcontract.Snapshot, hash string, query normalizedQuery, walked traversal, offset int, secret []byte, expiresAt int64) (Result, error) {
	items := make([]resultItem, 0, len(walked.nodes)+len(walked.edges))
	for index := range walked.nodes {
		items = append(items, resultItem{node: &walked.nodes[index]})
	}
	for index := range walked.edges {
		items = append(items, resultItem{edge: &walked.edges[index]})
	}
	if offset < 0 || offset > len(items) {
		return Result{}, failure(ErrorCursorInvalid, "Graph query cursor is beyond the deterministic result set.")
	}
	selected := make([]resultItem, 0)
	nodeCount, edgeCount, index := 0, 0, offset
	for index < len(items) {
		item := items[index]
		if item.node != nil && nodeCount >= query.maxNodes {
			break
		}
		if item.edge != nil && edgeCount >= query.maxEdges {
			break
		}
		selected = append(selected, item)
		if item.node != nil {
			nodeCount++
		} else {
			edgeCount++
		}
		index++
	}
	byteLimit := false
	makeResult := func() (Result, error) {
		result := Result{
			ScenarioInstanceID: snapshot.ScenarioInstanceID, SnapshotCursor: snapshot.Cursor,
			QueryHash: hash, Completeness: snapshot.Completeness,
			Nodes: []graphcontract.Node{}, Edges: []graphcontract.Edge{}, Paths: []RelationshipPath{},
		}
		for _, item := range selected {
			if item.node != nil {
				node := *item.node
				if !query.includeEvidence {
					node.SourceEventIDs = []string{}
					node.EvidenceRefs = []string{}
				}
				result.Nodes = append(result.Nodes, node)
				if path, exists := walked.paths[node.ID]; exists {
					result.Paths = append(result.Paths, path)
				}
			} else {
				edge := *item.edge
				if !query.includeEvidence {
					edge.SourceEventIDs = []string{}
					edge.EvidenceRefs = []string{}
				}
				result.Edges = append(result.Edges, edge)
			}
		}
		nextOffset := offset + len(selected)
		result.Truncation = Truncation{
			Truncated: nextOffset < len(items), ByteLimit: byteLimit, Paginated: offset > 0,
		}
		if nextOffset < len(items) {
			next := items[nextOffset]
			result.Truncation.NodeLimit = next.node != nil && nodeCount >= query.maxNodes
			result.Truncation.EdgeLimit = next.edge != nil && edgeCount >= query.maxEdges
			cursor, err := encodeCursor(cursorPayload{
				queryHash: hash, snapshotHash: snapshot.IntegrityHash, offset: nextOffset, expiresAt: expiresAt,
			}, secret)
			if err != nil {
				return Result{}, err
			}
			result.NextCursor = &cursor
		}
		return result, nil
	}
	result, err := makeResult()
	if err != nil {
		return Result{}, err
	}
	size, err := responseSize(&result)
	for err == nil && size > query.maxResponseBytes && len(selected) > 0 {
		removed := selected[len(selected)-1]
		selected = selected[:len(selected)-1]
		if removed.node != nil {
			nodeCount--
		} else {
			edgeCount--
		}
		index--
		byteLimit = true
		result, err = makeResult()
		if err == nil {
			size, err = responseSize(&result)
		}
	}
	if err != nil {
		return Result{}, err
	}
	if size > query.maxResponseBytes {
		return Result{}, failure(ErrorInvalid, "maxResponseBytes is too small for the bounded query envelope.")
	}
	if len(selected) == 0 && index < len(items) {
		if byteLimit {
			return Result{}, failure(ErrorInvalid, "A graph query item exceeds maxResponseBytes, so pagination cannot make forward progress.")
		}
		return Result{}, failure(ErrorInvalid, "Query limits cannot make forward progress.")
	}
	return result, nil
}

func Query(snapshotValue graphcontract.Snapshot, input Input, options Options) (Result, error) {
	snapshot, err := graphcontract.AssertSnapshotIntegrity(snapshotValue)
	if err != nil {
		return Result{}, err
	}
	query, err := normalize(input)
	if err != nil {
		return Result{}, err
	}
	if snapshot.ScenarioInstanceID != query.scenarioInstanceID {
		return Result{}, failure(ErrorInvalid, "Query scenario does not match the graph snapshot scope.")
	}
	if len(options.CursorSecret) < CursorSecretMinBytes || len(options.CursorSecret) > CursorSecretMaxBytes {
		return Result{}, failure(ErrorInvalid, "cursorSecret must contain between 32 and 1024 bytes.")
	}
	if len(options.PreviousCursorSecret) != 0 &&
		(len(options.PreviousCursorSecret) < CursorSecretMinBytes || len(options.PreviousCursorSecret) > CursorSecretMaxBytes) {
		return Result{}, failure(ErrorInvalid, "previousCursorSecret must be empty or contain between 32 and 1024 bytes.")
	}
	if len(options.PreviousCursorSecret) != 0 && bytes.Equal(options.CursorSecret, options.PreviousCursorSecret) {
		return Result{}, failure(ErrorInvalid, "previousCursorSecret must differ from cursorSecret.")
	}
	if options.NowMS < 0 || options.NowMS > maxSafeInteger {
		return Result{}, failure(ErrorInvalid, "now must be a valid timestamp.")
	}
	ttl := DefaultCursorTTLMS
	if options.CursorTTLMS != nil {
		ttl = *options.CursorTTLMS
	}
	if ttl < MinCursorTTLMS || ttl > MaxCursorTTLMS {
		return Result{}, failure(ErrorInvalid, "cursorTtlMs is outside its bounded range.")
	}
	if input.Cursor == nil && options.NowMS > maxSafeInteger-ttl {
		return Result{}, failure(ErrorInvalid, "now plus cursorTtlMs must remain a safe integer.")
	}
	hash, err := normalizedHash(query)
	if err != nil {
		return Result{}, err
	}
	offset, expiresAt := 0, options.NowMS+ttl
	if input.Cursor != nil {
		cursor, decodeErr := decodeCursor(*input.Cursor, options.CursorSecret)
		if decodeErr != nil && len(options.PreviousCursorSecret) != 0 {
			if previousCursor, previousErr := decodeCursor(*input.Cursor, options.PreviousCursorSecret); previousErr == nil {
				cursor, decodeErr = previousCursor, nil
			}
		}
		if decodeErr != nil {
			return Result{}, decodeErr
		}
		if cursor.expiresAt <= options.NowMS {
			return Result{}, failure(ErrorCursorExpired, "Graph query cursor has expired.")
		}
		if cursor.queryHash != hash || cursor.snapshotHash != snapshot.IntegrityHash {
			return Result{}, failure(ErrorCursorMismatch, "Graph query cursor is bound to a different query or snapshot.")
		}
		offset, expiresAt = cursor.offset, cursor.expiresAt
	}
	walked, err := traverse(snapshot, query)
	if err != nil {
		return Result{}, err
	}
	return buildResult(snapshot, hash, query, walked, offset, options.CursorSecret, expiresAt)
}

func itoa(value int) string {
	if value == 0 {
		return "0"
	}
	buffer := [20]byte{}
	position := len(buffer)
	for value > 0 {
		position--
		buffer[position] = byte('0' + value%10)
		value /= 10
	}
	return string(buffer[position:])
}
