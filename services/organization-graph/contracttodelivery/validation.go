package contracttodelivery

import (
	"fmt"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	graph "github.com/Negentropy-Laby/OpenSlack/services/organization-graph"
	"github.com/Negentropy-Laby/OpenSlack/services/organization-graph/softwaredelivery"
)

var (
	dateTimePattern = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$`)
	activePattern   = regexp.MustCompile(`(?i)(?:https?://|javascript:|data:text/html|[<>])`)
	secretPattern   = regexp.MustCompile(`(?i)(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|(?:github_pat_|gh[opusr]_|sk-)[A-Za-z0-9_-]{12,}|xox[baprs]-[A-Za-z0-9-]{8,}|bearer[\x09-\x0d\x20\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+[A-Za-z0-9._~+/=-]{12,}|AWS_SECRET_ACCESS_KEY[\x09-\x0d\x20\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*=|OPENSLACK_[A-Z0-9_]*SECRET[\x09-\x0d\x20\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*=)`)
)

var businessSourceNames = []string{"customers", "contracts", "projects", "milestones", "acceptances", "outcomes"}

func failure(code graph.ContractErrorCode, path, message string) error {
	return &graph.ContractError{Code: code, Path: path, Message: message}
}

func utf16Less(left, right string) bool {
	leftUnits := utf16.Encode([]rune(left))
	rightUnits := utf16.Encode([]rune(right))
	limit := len(leftUnits)
	if len(rightUnits) < limit {
		limit = len(rightUnits)
	}
	for index := 0; index < limit; index++ {
		if leftUnits[index] != rightUnits[index] {
			return leftUnits[index] < rightUnits[index]
		}
	}
	return len(leftUnits) < len(rightUnits)
}

func sortUTF16(values []string) {
	sort.Slice(values, func(left, right int) bool { return utf16Less(values[left], values[right]) })
}

func record(value graph.Value, path string) (graph.Object, error) {
	object, ok := value.(graph.Object)
	if !ok {
		return nil, failure(graph.ContractSchemaInvalid, path, "must be an inert object.")
	}
	return object, nil
}

func exactKeys(object graph.Object, path string, required []string) error {
	allowed := make(map[string]struct{}, len(required))
	for _, key := range required {
		allowed[key] = struct{}{}
	}
	unexpected := make([]string, 0)
	for key := range object {
		if _, ok := allowed[key]; !ok {
			unexpected = append(unexpected, key)
		}
	}
	// JSON maps do not preserve insertion order. Sorting makes the shadow
	// deterministic; the frozen vectors use one unexpected key per case.
	sortUTF16(unexpected)
	if len(unexpected) > 0 {
		return failure(graph.ContractSchemaInvalid, path+"."+unexpected[0], "is not an allowed property.")
	}
	for _, key := range required {
		if _, ok := object[key]; !ok {
			return failure(graph.ContractSchemaInvalid, path+"."+key, "is required.")
		}
	}
	return nil
}

type stringOptions struct {
	identifier bool
	max        int
}

func safeString(value graph.Value, path string, options stringOptions) (string, error) {
	result, ok := value.(string)
	if !ok || result == "" {
		return "", failure(graph.ContractSchemaInvalid, path, "must be a non-empty string.")
	}
	maximum := options.max
	if maximum == 0 {
		maximum = MaxTextBytes
	}
	if len(result) > maximum {
		return "", failure(graph.ContractBoundExceeded, path, fmt.Sprintf("must be at most %d UTF-8 bytes.", maximum))
	}
	if !utf8.ValidString(result) {
		return "", failure(graph.ContractPropertyUnsafe, path, "contains unsafe content.")
	}
	unsafe := activePattern.MatchString(result) || secretPattern.MatchString(result)
	for _, current := range result {
		if current <= 0x1f || current == 0x7f || (options.identifier && ecmaScriptWhitespace(current)) {
			unsafe = true
			break
		}
	}
	if unsafe {
		return "", failure(graph.ContractPropertyUnsafe, path, "contains unsafe content.")
	}
	return result, nil
}

func ecmaScriptWhitespace(value rune) bool {
	return (value >= '\u0009' && value <= '\u000d') || value == '\u0020' || value == '\u00a0' ||
		value == '\u1680' || (value >= '\u2000' && value <= '\u200a') || value == '\u2028' ||
		value == '\u2029' || value == '\u202f' || value == '\u205f' || value == '\u3000' || value == '\ufeff'
}

func dateTime(value graph.Value, path string) (string, error) {
	result, err := safeString(value, path, stringOptions{identifier: true, max: 64})
	if err != nil {
		return "", err
	}
	match := dateTimePattern.FindStringSubmatch(result)
	if match == nil {
		return "", failure(graph.ContractSchemaInvalid, path, "must be a valid RFC 3339 date-time.")
	}
	number := func(index int) int {
		value, _ := strconv.Atoi(match[index])
		return value
	}
	year, month, day := number(1), number(2), number(3)
	hour, minute, second := number(4), number(5), number(6)
	offsetHour, offsetMinute := number(8), number(9)
	leap := year%4 == 0 && (year%100 != 0 || year%400 == 0)
	days := []int{31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31}
	if leap {
		days[1] = 29
	}
	if month < 1 || month > 12 || day < 1 || day > days[month-1] || hour > 23 || minute > 59 ||
		second > 59 || offsetHour > 23 || offsetMinute > 59 {
		return "", failure(graph.ContractSchemaInvalid, path, "must be a valid RFC 3339 date-time.")
	}
	if _, err := time.Parse(time.RFC3339Nano, result); err != nil {
		return "", failure(graph.ContractSchemaInvalid, path, "must be a valid RFC 3339 date-time.")
	}
	return result, nil
}

func denseArray(value graph.Value, path string, maximum int) (graph.Array, error) {
	items, ok := value.(graph.Array)
	if !ok {
		return nil, failure(graph.ContractSchemaInvalid, path, "must be an inert array.")
	}
	if len(items) > maximum {
		return nil, failure(graph.ContractBoundExceeded, path, fmt.Sprintf("must contain at most %d items.", maximum))
	}
	return items, nil
}

func references(value graph.Value, path string, minimum int) ([]string, error) {
	items, err := denseArray(value, path, 50)
	if err != nil {
		return nil, err
	}
	if len(items) < minimum {
		return nil, failure(graph.ContractSchemaInvalid, path, fmt.Sprintf("must contain at least %d item.", minimum))
	}
	result := make([]string, len(items))
	seen := make(map[string]struct{}, len(items))
	for index, item := range items {
		result[index], err = safeString(item, fmt.Sprintf("%s[%d]", path, index), stringOptions{identifier: true})
		if err != nil {
			return nil, err
		}
		if _, exists := seen[result[index]]; exists {
			return nil, failure(graph.ContractReferenceInvalid, path, "contains duplicate references.")
		}
		seen[result[index]] = struct{}{}
	}
	return result, nil
}

func parseStatus(value graph.Value, path string) (string, error) {
	result, ok := value.(string)
	if ok {
		for _, allowed := range []string{"active", "planned", "completed", "accepted", "realized", "pending"} {
			if result == allowed {
				return result, nil
			}
		}
	}
	return "", failure(graph.ContractSchemaInvalid, path, "must be one of active, planned, completed, accepted, realized, pending.")
}

func parseAuthority(value graph.Value, path string, providers []string) (graph.AuthorityRef, error) {
	object, err := record(value, path)
	if err != nil {
		return graph.AuthorityRef{}, err
	}
	if err := exactKeys(object, path, []string{"provider", "objectType", "objectId", "version", "observedAt"}); err != nil {
		return graph.AuthorityRef{}, err
	}
	provider, err := safeString(object["provider"], path+".provider", stringOptions{identifier: true, max: 64})
	if err != nil {
		return graph.AuthorityRef{}, err
	}
	allowed := false
	for _, candidate := range providers {
		allowed = allowed || provider == candidate
	}
	if !allowed {
		return graph.AuthorityRef{}, failure(graph.ContractSchemaInvalid, path+".provider", "is not allowed for this authority.")
	}
	result := graph.AuthorityRef{Provider: provider}
	if result.ObjectType, err = safeString(object["objectType"], path+".objectType", stringOptions{identifier: true, max: 128}); err != nil {
		return graph.AuthorityRef{}, err
	}
	if result.ObjectID, err = safeString(object["objectId"], path+".objectId", stringOptions{identifier: true, max: 512}); err != nil {
		return graph.AuthorityRef{}, err
	}
	if result.Version, err = safeString(object["version"], path+".version", stringOptions{identifier: true, max: 512}); err != nil {
		return graph.AuthorityRef{}, err
	}
	if result.ObservedAt, err = dateTime(object["observedAt"], path+".observedAt"); err != nil {
		return graph.AuthorityRef{}, err
	}
	return result, nil
}

func parseBridge(value graph.Value, path, expectedType string) (bridgeRef, error) {
	object, err := record(value, path)
	if err != nil {
		return bridgeRef{}, err
	}
	if err := exactKeys(object, path, []string{"targetType", "authorityRef"}); err != nil {
		return bridgeRef{}, err
	}
	targetType, err := safeString(object["targetType"], path+".targetType", stringOptions{identifier: true, max: 128})
	if err != nil {
		return bridgeRef{}, err
	}
	if targetType != expectedType {
		return bridgeRef{}, failure(graph.ContractReferenceInvalid, path+".targetType", "must equal "+expectedType+".")
	}
	authority, err := parseAuthority(object["authorityRef"], path+".authorityRef", []string{"github", "openslack", "demo_fixture"})
	return bridgeRef{TargetType: targetType, AuthorityRef: authority}, err
}

func parseEvidence(value graph.Value, path, objectType string, extras []string) (graph.Object, businessEvidence, error) {
	object, err := record(value, path)
	if err != nil {
		return nil, businessEvidence{}, err
	}
	required := append([]string{"id", "title", "status", "authorityRef", "sourceEventIds", "evidenceRefs"}, extras...)
	if err := exactKeys(object, path, required); err != nil {
		return nil, businessEvidence{}, err
	}
	var result businessEvidence
	if result.ID, err = safeString(object["id"], path+".id", stringOptions{identifier: true, max: 512}); err != nil {
		return nil, businessEvidence{}, err
	}
	if result.AuthorityRef, err = parseAuthority(object["authorityRef"], path+".authorityRef", []string{"demo_fixture"}); err != nil {
		return nil, businessEvidence{}, err
	}
	if result.AuthorityRef.ObjectType != objectType || result.AuthorityRef.ObjectID != result.ID {
		return nil, businessEvidence{}, failure(graph.ContractReferenceInvalid, path+".authorityRef", fmt.Sprintf("must bind %s authority to observation %s.", objectType, result.ID))
	}
	if result.Title, err = safeString(object["title"], path+".title", stringOptions{}); err != nil {
		return nil, businessEvidence{}, err
	}
	if result.Status, err = parseStatus(object["status"], path+".status"); err != nil {
		return nil, businessEvidence{}, err
	}
	if result.SourceEventIDs, err = references(object["sourceEventIds"], path+".sourceEventIds", 1); err != nil {
		return nil, businessEvidence{}, err
	}
	if result.EvidenceRefs, err = references(object["evidenceRefs"], path+".evidenceRefs", 1); err != nil {
		return nil, businessEvidence{}, err
	}
	return object, result, nil
}

func parseCustomer(value graph.Value, path string) (customerObservation, error) {
	_, evidence, err := parseEvidence(value, path, "customer", nil)
	return customerObservation{businessEvidence: evidence}, err
}

func parseContract(value graph.Value, path string) (contractObservation, error) {
	object, evidence, err := parseEvidence(value, path, "contract", []string{"customerId", "deliverable"})
	if err != nil {
		return contractObservation{}, err
	}
	result := contractObservation{businessEvidence: evidence}
	if result.CustomerID, err = safeString(object["customerId"], path+".customerId", stringOptions{identifier: true, max: 512}); err != nil {
		return contractObservation{}, err
	}
	if result.Deliverable, err = parseBridge(object["deliverable"], path+".deliverable", "reviewable_deliverable"); err != nil {
		return contractObservation{}, err
	}
	return result, nil
}

func parseProject(value graph.Value, path string) (projectObservation, error) {
	object, evidence, err := parseEvidence(value, path, "project", []string{"contractId", "workItem"})
	if err != nil {
		return projectObservation{}, err
	}
	result := projectObservation{businessEvidence: evidence}
	if result.ContractID, err = safeString(object["contractId"], path+".contractId", stringOptions{identifier: true, max: 512}); err != nil {
		return projectObservation{}, err
	}
	if result.WorkItem, err = parseBridge(object["workItem"], path+".workItem", "core.work_item"); err != nil {
		return projectObservation{}, err
	}
	return result, nil
}

func parseMilestone(value graph.Value, path string) (milestoneObservation, error) {
	object, evidence, err := parseEvidence(value, path, "milestone", []string{"projectId", "workItem"})
	if err != nil {
		return milestoneObservation{}, err
	}
	result := milestoneObservation{businessEvidence: evidence}
	if result.ProjectID, err = safeString(object["projectId"], path+".projectId", stringOptions{identifier: true, max: 512}); err != nil {
		return milestoneObservation{}, err
	}
	if result.WorkItem, err = parseBridge(object["workItem"], path+".workItem", "core.work_item"); err != nil {
		return milestoneObservation{}, err
	}
	return result, nil
}

func parseAcceptance(value graph.Value, path string) (acceptanceObservation, error) {
	object, evidence, err := parseEvidence(value, path, "acceptance", []string{"deliverable", "humanDecision", "acceptedTransition"})
	if err != nil {
		return acceptanceObservation{}, err
	}
	result := acceptanceObservation{businessEvidence: evidence}
	if result.Deliverable, err = parseBridge(object["deliverable"], path+".deliverable", "reviewable_deliverable"); err != nil {
		return acceptanceObservation{}, err
	}
	if result.HumanDecision, err = parseBridge(object["humanDecision"], path+".humanDecision", "human_decision"); err != nil {
		return acceptanceObservation{}, err
	}
	if result.AcceptedTransition, err = parseBridge(object["acceptedTransition"], path+".acceptedTransition", "accepted_transition"); err != nil {
		return acceptanceObservation{}, err
	}
	return result, nil
}

func parseOutcome(value graph.Value, path string) (outcomeObservation, error) {
	object, evidence, err := parseEvidence(value, path, "outcome", []string{"acceptanceId", "workItem", "softwareOutcome"})
	if err != nil {
		return outcomeObservation{}, err
	}
	result := outcomeObservation{businessEvidence: evidence}
	if result.AcceptanceID, err = safeString(object["acceptanceId"], path+".acceptanceId", stringOptions{identifier: true, max: 512}); err != nil {
		return outcomeObservation{}, err
	}
	if result.WorkItem, err = parseBridge(object["workItem"], path+".workItem", "core.work_item"); err != nil {
		return outcomeObservation{}, err
	}
	if result.SoftwareOutcome, err = parseBridge(object["softwareOutcome"], path+".softwareOutcome", "outcome"); err != nil {
		return outcomeObservation{}, err
	}
	return result, nil
}

func parseBatch[T any](
	value graph.Value,
	path string,
	parse func(graph.Value, string) (T, error),
	id func(T) string,
) (sourceBatch[T], error) {
	object, err := record(value, path)
	if err != nil {
		return sourceBatch[T]{}, err
	}
	if object["status"] == "missing" {
		if err := exactKeys(object, path, []string{"status", "items", "reasonCode"}); err != nil {
			return sourceBatch[T]{}, err
		}
		items, err := denseArray(object["items"], path+".items", 0)
		if err != nil {
			return sourceBatch[T]{}, err
		}
		if len(items) != 0 {
			return sourceBatch[T]{}, failure(graph.ContractSchemaInvalid, path+".items", "must be empty when the source is missing.")
		}
		reason, err := safeString(object["reasonCode"], path+".reasonCode", stringOptions{identifier: true, max: 256})
		return sourceBatch[T]{Status: "missing", Items: []T{}, ReasonCode: reason}, err
	}
	status, ok := object["status"].(string)
	if !ok || (status != "observed" && status != "incomplete") {
		return sourceBatch[T]{}, failure(graph.ContractSchemaInvalid, path+".status", "must be observed, incomplete, or missing.")
	}
	if err := exactKeys(object, path, []string{"status", "batchVersion", "observedAt", "items", "warningCodes"}); err != nil {
		return sourceBatch[T]{}, err
	}
	items, err := denseArray(object["items"], path+".items", MaxObservationsPerKind)
	if err != nil {
		return sourceBatch[T]{}, err
	}
	result := sourceBatch[T]{Status: status, Items: make([]T, len(items))}
	seen := make(map[string]struct{}, len(items))
	for index, item := range items {
		result.Items[index], err = parse(item, fmt.Sprintf("%s.items[%d]", path, index))
		if err != nil {
			return sourceBatch[T]{}, err
		}
		if _, exists := seen[id(result.Items[index])]; exists {
			return sourceBatch[T]{}, failure(graph.ContractReferenceInvalid, path+".items", "contains duplicate observation IDs.")
		}
		seen[id(result.Items[index])] = struct{}{}
	}
	if result.BatchVersion, err = safeString(object["batchVersion"], path+".batchVersion", stringOptions{identifier: true, max: 512}); err != nil {
		return sourceBatch[T]{}, err
	}
	if result.ObservedAt, err = dateTime(object["observedAt"], path+".observedAt"); err != nil {
		return sourceBatch[T]{}, err
	}
	if result.WarningCodes, err = references(object["warningCodes"], path+".warningCodes", 0); err != nil {
		return sourceBatch[T]{}, err
	}
	return result, nil
}

func validateJSONContainers(value graph.Value, path string, depth, nodes int) (int, error) {
	nodes++
	if nodes > MaxSourceJSONNodes {
		return nodes, failure(graph.ContractBoundExceeded, path, fmt.Sprintf("source exceeds %d JSON nodes.", MaxSourceJSONNodes))
	}
	if depth > 32 {
		return nodes, failure(graph.ContractBoundExceeded, path, "exceeds source nesting depth 32.")
	}
	switch current := value.(type) {
	case graph.Array:
		if len(current) > MaxSourceArrayItems {
			return nodes, failure(graph.ContractBoundExceeded, path, fmt.Sprintf("array exceeds %d items.", MaxSourceArrayItems))
		}
		for index, item := range current {
			var err error
			nodes, err = validateJSONContainers(item, fmt.Sprintf("%s[%d]", path, index), depth+1, nodes)
			if err != nil {
				return nodes, err
			}
		}
	case graph.Object:
		if len(current) > MaxSourceProperties {
			return nodes, failure(graph.ContractBoundExceeded, path, fmt.Sprintf("object exceeds %d properties.", MaxSourceProperties))
		}
		keys := make([]string, 0, len(current))
		for key := range current {
			keys = append(keys, key)
		}
		sortUTF16(keys)
		for _, key := range keys {
			var err error
			nodes, err = validateJSONContainers(current[key], path+"."+key, depth+1, nodes)
			if err != nil {
				return nodes, err
			}
		}
	}
	return nodes, nil
}

func parseSource(input []byte) (sourceSnapshot, error) {
	if len(input) > MaxSourceBytes {
		return sourceSnapshot{}, failure(graph.ContractBoundExceeded, "$", fmt.Sprintf("source exceeds %d JSON bytes.", MaxSourceBytes))
	}
	value, err := graph.ParseCanonicalJSON(input, graph.JSONLimits{
		MaxDepth:        graph.JSONLimit(33),
		MaxNodes:        graph.JSONLimit(MaxSourceJSONNodes),
		MaxStringLength: graph.JSONLimit(MaxSourceBytes),
	})
	if err != nil {
		return sourceSnapshot{}, err
	}
	if _, err := validateJSONContainers(value, "$", 0, 0); err != nil {
		return sourceSnapshot{}, err
	}
	canonical, err := graph.CanonicalJSON(value)
	if err != nil {
		return sourceSnapshot{}, err
	}
	if len(canonical) > MaxSourceBytes {
		return sourceSnapshot{}, failure(graph.ContractBoundExceeded, "$", fmt.Sprintf("contains %d bytes; maximum is %d.", len(canonical), MaxSourceBytes))
	}
	object, err := record(value, "$")
	if err != nil {
		return sourceSnapshot{}, err
	}
	if err := exactKeys(object, "$", []string{
		"schema", "scenarioDefinitionId", "scenarioInstanceId", "cursor", "generatedAt", "projectorVersion", "softwareDelivery", "business",
	}); err != nil {
		return sourceSnapshot{}, err
	}
	if object["schema"] != SourceSchema {
		return sourceSnapshot{}, failure(graph.ContractSchemaInvalid, "$.schema", "must equal "+SourceSchema+".")
	}
	result := sourceSnapshot{Schema: SourceSchema}
	if result.ScenarioDefinitionID, err = safeString(object["scenarioDefinitionId"], "$.scenarioDefinitionId", stringOptions{identifier: true, max: 128}); err != nil {
		return sourceSnapshot{}, err
	}
	if result.ScenarioInstanceID, err = safeString(object["scenarioInstanceId"], "$.scenarioInstanceId", stringOptions{identifier: true, max: 512}); err != nil {
		return sourceSnapshot{}, err
	}
	if result.Cursor, err = safeString(object["cursor"], "$.cursor", stringOptions{identifier: true, max: 512}); err != nil {
		return sourceSnapshot{}, err
	}
	if result.GeneratedAt, err = dateTime(object["generatedAt"], "$.generatedAt"); err != nil {
		return sourceSnapshot{}, err
	}
	if result.ProjectorVersion, err = safeString(object["projectorVersion"], "$.projectorVersion", stringOptions{identifier: true, max: 128}); err != nil {
		return sourceSnapshot{}, err
	}
	result.SoftwareDeliveryJSON, err = graph.CanonicalJSON(object["softwareDelivery"])
	if err != nil {
		return sourceSnapshot{}, err
	}
	if err := softwaredelivery.Validate(result.SoftwareDeliveryJSON); err != nil {
		return sourceSnapshot{}, err
	}
	nested, _ := object["softwareDelivery"].(graph.Object)
	if result.ScenarioDefinitionID != ScenarioID {
		return sourceSnapshot{}, failure(graph.ContractScopeInvalid, "$.scenarioDefinitionId", "must equal "+ScenarioID+".")
	}
	if result.ProjectorVersion != ProjectorID {
		return sourceSnapshot{}, failure(graph.ContractSchemaInvalid, "$.projectorVersion", "must equal "+ProjectorID+".")
	}
	if nested["scenarioDefinitionId"] != result.ScenarioDefinitionID || nested["scenarioInstanceId"] != result.ScenarioInstanceID ||
		nested["cursor"] != result.Cursor || nested["generatedAt"] != result.GeneratedAt {
		return sourceSnapshot{}, failure(graph.ContractScopeInvalid, "$.softwareDelivery", "must share the outer scenario definition, instance, cursor, and generated time.")
	}
	if nested["projectorVersion"] != softwaredelivery.ProjectorID {
		return sourceSnapshot{}, failure(graph.ContractSchemaInvalid, "$.softwareDelivery.projectorVersion", "must equal "+softwaredelivery.ProjectorID+".")
	}

	businessObject, err := record(object["business"], "$.business")
	if err != nil {
		return sourceSnapshot{}, err
	}
	if err := exactKeys(businessObject, "$.business", businessSourceNames); err != nil {
		return sourceSnapshot{}, err
	}
	if result.Business.Customers, err = parseBatch(businessObject["customers"], "$.business.customers", parseCustomer, func(item customerObservation) string { return item.ID }); err != nil {
		return sourceSnapshot{}, err
	}
	if result.Business.Contracts, err = parseBatch(businessObject["contracts"], "$.business.contracts", parseContract, func(item contractObservation) string { return item.ID }); err != nil {
		return sourceSnapshot{}, err
	}
	if result.Business.Projects, err = parseBatch(businessObject["projects"], "$.business.projects", parseProject, func(item projectObservation) string { return item.ID }); err != nil {
		return sourceSnapshot{}, err
	}
	if result.Business.Milestones, err = parseBatch(businessObject["milestones"], "$.business.milestones", parseMilestone, func(item milestoneObservation) string { return item.ID }); err != nil {
		return sourceSnapshot{}, err
	}
	if result.Business.Acceptances, err = parseBatch(businessObject["acceptances"], "$.business.acceptances", parseAcceptance, func(item acceptanceObservation) string { return item.ID }); err != nil {
		return sourceSnapshot{}, err
	}
	if result.Business.Outcomes, err = parseBatch(businessObject["outcomes"], "$.business.outcomes", parseOutcome, func(item outcomeObservation) string { return item.ID }); err != nil {
		return sourceSnapshot{}, err
	}

	observations := make([]businessEvidence, 0)
	for _, item := range result.Business.Customers.Items {
		observations = append(observations, item.businessEvidence)
	}
	for _, item := range result.Business.Contracts.Items {
		observations = append(observations, item.businessEvidence)
	}
	for _, item := range result.Business.Projects.Items {
		observations = append(observations, item.businessEvidence)
	}
	for _, item := range result.Business.Milestones.Items {
		observations = append(observations, item.businessEvidence)
	}
	for _, item := range result.Business.Acceptances.Items {
		observations = append(observations, item.businessEvidence)
	}
	for _, item := range result.Business.Outcomes.Items {
		observations = append(observations, item.businessEvidence)
	}
	if len(observations) > MaxTotalObservations {
		return sourceSnapshot{}, failure(graph.ContractBoundExceeded, "$.business", fmt.Sprintf("contains %d observations; maximum is %d.", len(observations), MaxTotalObservations))
	}
	ids := make(map[string]struct{}, len(observations))
	authorities := make(map[string]struct{}, len(observations))
	for index, item := range observations {
		if _, exists := ids[item.ID]; exists {
			return sourceSnapshot{}, failure(graph.ContractReferenceInvalid, "$.business", "contains duplicate observation IDs.")
		}
		ids[item.ID] = struct{}{}
		identity := strings.Join([]string{item.AuthorityRef.Provider, item.AuthorityRef.ObjectType, item.AuthorityRef.ObjectID}, ":")
		if _, exists := authorities[identity]; exists {
			return sourceSnapshot{}, failure(graph.ContractReferenceInvalid, "$.business", "contains duplicate authority identities.")
		}
		authorities[identity] = struct{}{}
		observed, _ := time.Parse(time.RFC3339Nano, item.AuthorityRef.ObservedAt)
		generated, _ := time.Parse(time.RFC3339Nano, result.GeneratedAt)
		if observed.After(generated) {
			return sourceSnapshot{}, failure(graph.ContractSchemaInvalid, fmt.Sprintf("$.business.observations[%d].authorityRef.observedAt", index), "must not be later than the source generated time.")
		}
	}
	relations := len(result.Business.Contracts.Items)*2 + len(result.Business.Projects.Items)*2 +
		len(result.Business.Milestones.Items)*2 + len(result.Business.Acceptances.Items)*3 + len(result.Business.Outcomes.Items)*3
	if relations > MaxTotalRelations {
		return sourceSnapshot{}, failure(graph.ContractBoundExceeded, "$.business", fmt.Sprintf("contains %d relationship references; maximum is %d.", relations, MaxTotalRelations))
	}
	return result, nil
}
