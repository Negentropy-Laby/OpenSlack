package softwaredelivery

import (
	"fmt"
	"math"
	"regexp"
	"sort"
	"strings"
	"time"
	"unicode/utf16"
	"unicode/utf8"

	graph "github.com/Negentropy-Laby/OpenSlack/services/organization-graph"
)

var (
	dateTimePattern = regexp.MustCompile(`^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$`)
	activePattern   = regexp.MustCompile(`(?i)(?:https?://|javascript:|data:text/html|[<>])`)
	secretPattern   = regexp.MustCompile(
		`(?:-----begin [a-z ]*private key-----|(?:github_pat_|gh[opusr]_|sk-)[a-z0-9_-]{12,}|` +
			`xox[baprs]-[a-z0-9-]{8,}|bearer[\x09-\x0d\x20\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+[a-z0-9._~+/=-]{12,}|` +
			`aws_secret_access_key[\x09-\x0d\x20\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*=|` +
			`openslack_[a-z0-9_]*secret[\x09-\x0d\x20\x{00a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]*=)`,
	)
)

var evidenceFields = []string{
	"id", "authorityVersion", "observationKind", "observedAt", "sourceEventIds", "evidenceRefs",
}

func sortUTF16(values []string) {
	sort.Slice(values, func(left, right int) bool {
		return utf16Less(values[left], values[right])
	})
}

func utf16Less(left, right string) bool {
	leftUnits := utf16.Encode([]rune(left))
	rightUnits := utf16.Encode([]rune(right))
	limit := len(leftUnits)
	if len(rightUnits) < limit {
		limit = len(rightUnits)
	}
	for index := 0; index < limit; index++ {
		if leftUnits[index] == rightUnits[index] {
			continue
		}
		return leftUnits[index] < rightUnits[index]
	}
	return len(leftUnits) < len(rightUnits)
}

func (value evidence) observationID() string { return value.ID }

func failure(code graph.ContractErrorCode, path, message string) error {
	return &graph.ContractError{Code: code, Path: path, Message: message}
}

func record(value graph.Value, path string) (graph.Object, error) {
	object, ok := value.(graph.Object)
	if !ok {
		return nil, failure(graph.ContractSchemaInvalid, path, "must be an object.")
	}
	return object, nil
}

func exactKeys(object graph.Object, path string, required, optional []string) error {
	allowed := make(map[string]struct{}, len(required)+len(optional))
	for _, key := range required {
		allowed[key] = struct{}{}
	}
	for _, key := range optional {
		allowed[key] = struct{}{}
	}
	unexpected := make([]string, 0)
	for key := range object {
		if _, ok := allowed[key]; !ok {
			unexpected = append(unexpected, key)
		}
	}
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
	max        int
	identifier bool
}

func safeString(value graph.Value, path string, options stringOptions) (string, error) {
	result, ok := value.(string)
	if !ok || result == "" {
		return "", failure(graph.ContractSchemaInvalid, path, "must be a non-empty string.")
	}
	maximum := options.max
	if maximum == 0 {
		if options.identifier {
			maximum = 512
		} else {
			maximum = MaxTextBytes
		}
	}
	if len(result) > maximum {
		return "", failure(graph.ContractBoundExceeded, path, fmt.Sprintf("must be at most %d UTF-8 bytes.", maximum))
	}
	if !utf8.ValidString(result) {
		return "", failure(graph.ContractSchemaInvalid, path, "contains unsafe Unicode or control characters.")
	}
	for _, current := range result {
		if current <= 0x1f || current == 0x7f {
			return "", failure(graph.ContractSchemaInvalid, path, "contains unsafe Unicode or control characters.")
		}
	}
	if activePattern.MatchString(result) || secretPattern.MatchString(strings.ToLower(result)) {
		return "", failure(graph.ContractPropertyUnsafe, path, "contains active content, a URL, or credential material.")
	}
	if options.identifier {
		for _, current := range result {
			if ecmaScriptWhitespace(current) {
				return "", failure(graph.ContractReferenceInvalid, path, "must be an identifier without whitespace.")
			}
		}
	}
	return result, nil
}

func ecmaScriptWhitespace(value rune) bool {
	return (value >= '\u0009' && value <= '\u000d') || value == '\u0020' || value == '\u00a0' ||
		value == '\u1680' || (value >= '\u2000' && value <= '\u200a') || value == '\u2028' ||
		value == '\u2029' || value == '\u202f' || value == '\u205f' || value == '\u3000' || value == '\ufeff'
}

func enumeration(value graph.Value, path string, allowed ...string) (string, error) {
	result, ok := value.(string)
	if ok {
		for _, candidate := range allowed {
			if result == candidate {
				return result, nil
			}
		}
	}
	return "", failure(graph.ContractSchemaInvalid, path, "must be one of "+strings.Join(allowed, ", ")+".")
}

func booleanValue(value graph.Value, path string) (bool, error) {
	result, ok := value.(bool)
	if !ok {
		return false, failure(graph.ContractSchemaInvalid, path, "must be a boolean.")
	}
	return result, nil
}

func integer(value graph.Value, path string, minimum int64) (int64, error) {
	number, ok := value.(float64)
	if !ok || math.IsNaN(number) || math.IsInf(number, 0) || math.Trunc(number) != number ||
		number < float64(minimum) || number > 9_007_199_254_740_991 {
		return 0, failure(graph.ContractSchemaInvalid, path, fmt.Sprintf("must be a safe integer >= %d.", minimum))
	}
	return int64(number), nil
}

func boundedArray(value graph.Value, path string, maximum int) (graph.Array, error) {
	items, ok := value.(graph.Array)
	if !ok {
		return nil, failure(graph.ContractSchemaInvalid, path, "must be an array.")
	}
	if len(items) > maximum {
		return nil, failure(graph.ContractBoundExceeded, path, fmt.Sprintf("must contain at most %d items.", maximum))
	}
	return items, nil
}

func references(value graph.Value, path string, maximum, maxBytes int) ([]string, error) {
	items, err := boundedArray(value, path, maximum)
	if err != nil {
		return nil, err
	}
	result := make([]string, len(items))
	seen := make(map[string]struct{}, len(items))
	for index, item := range items {
		result[index], err = safeString(item, fmt.Sprintf("%s[%d]", path, index), stringOptions{max: maxBytes, identifier: true})
		if err != nil {
			return nil, err
		}
		if _, ok := seen[result[index]]; ok {
			return nil, failure(graph.ContractReferenceInvalid, fmt.Sprintf("%s[%d]", path, index), "duplicates reference "+result[index]+".")
		}
		seen[result[index]] = struct{}{}
	}
	return result, nil
}

func dateTime(value graph.Value, path string) (string, error) {
	result, err := safeString(value, path, stringOptions{max: 64, identifier: true})
	if err != nil {
		return "", err
	}
	match := dateTimePattern.FindStringSubmatch(result)
	if match == nil {
		return "", failure(graph.ContractSchemaInvalid, path, "must be a valid RFC 3339 date-time.")
	}
	if match[8] > "23" || match[9] > "59" {
		return "", failure(graph.ContractSchemaInvalid, path, "must be a valid RFC 3339 date-time.")
	}
	if _, err := time.Parse(time.RFC3339Nano, result); err != nil {
		return "", failure(graph.ContractSchemaInvalid, path, "must be a valid RFC 3339 date-time.")
	}
	return result, nil
}

func dateMillis(value string) int64 {
	parsed, _ := time.Parse(time.RFC3339Nano, value)
	return parsed.UnixMilli()
}

func assertNotBefore(earlier, later, path string) error {
	if dateMillis(later) < dateMillis(earlier) {
		return failure(graph.ContractSchemaInvalid, path, "must not precede "+earlier+".")
	}
	return nil
}

func optionalIdentifier(object graph.Object, key, path string) (*string, error) {
	value, ok := object[key]
	if !ok {
		return nil, nil
	}
	result, err := safeString(value, path+"."+key, stringOptions{identifier: true})
	if err != nil {
		return nil, err
	}
	return &result, nil
}

func observation(value graph.Value, path string, required, optional []string) (graph.Object, evidence, error) {
	object, err := record(value, path)
	if err != nil {
		return nil, evidence{}, err
	}
	allRequired := append(append([]string{}, evidenceFields...), required...)
	if err := exactKeys(object, path, allRequired, optional); err != nil {
		return nil, evidence{}, err
	}
	var result evidence
	if result.ID, err = safeString(object["id"], path+".id", stringOptions{identifier: true}); err != nil {
		return nil, evidence{}, err
	}
	if result.AuthorityVersion, err = safeString(object["authorityVersion"], path+".authorityVersion", stringOptions{identifier: true}); err != nil {
		return nil, evidence{}, err
	}
	if result.ObservationKind, err = enumeration(object["observationKind"], path+".observationKind", "live", "local_store", "cache", "synthetic"); err != nil {
		return nil, evidence{}, err
	}
	if result.ObservedAt, err = dateTime(object["observedAt"], path+".observedAt"); err != nil {
		return nil, evidence{}, err
	}
	if result.SourceEventIDs, err = references(object["sourceEventIds"], path+".sourceEventIds", 50, MaxTextBytes); err != nil {
		return nil, evidence{}, err
	}
	if result.EvidenceRefs, err = references(object["evidenceRefs"], path+".evidenceRefs", 50, MaxTextBytes); err != nil {
		return nil, evidence{}, err
	}
	return object, result, nil
}

func parseActorRef(value graph.Value, path string) (graph.ActorRef, error) {
	object, err := record(value, path)
	if err != nil {
		return graph.ActorRef{}, err
	}
	if err := exactKeys(object, path, []string{"id", "kind"}, []string{"displayName"}); err != nil {
		return graph.ActorRef{}, err
	}
	var result graph.ActorRef
	if result.ID, err = safeString(object["id"], path+".id", stringOptions{identifier: true}); err != nil {
		return graph.ActorRef{}, err
	}
	if result.Kind, err = enumeration(object["kind"], path+".kind", "human", "agent", "system"); err != nil {
		return graph.ActorRef{}, err
	}
	if displayName, ok := object["displayName"]; ok {
		value, err := safeString(displayName, path+".displayName", stringOptions{max: 512})
		if err != nil {
			return graph.ActorRef{}, err
		}
		result.DisplayName = &value
	}
	return result, nil
}

func parseRepository(value graph.Value, path string) (repositoryObservation, error) {
	object, evidence, err := observation(value, path, []string{"repositoryId", "fullName", "defaultBranch"}, nil)
	if err != nil {
		return repositoryObservation{}, err
	}
	result := repositoryObservation{evidence: evidence}
	if result.RepositoryID, err = safeString(object["repositoryId"], path+".repositoryId", stringOptions{identifier: true}); err != nil {
		return repositoryObservation{}, err
	}
	if result.FullName, err = safeString(object["fullName"], path+".fullName", stringOptions{identifier: true}); err != nil {
		return repositoryObservation{}, err
	}
	if result.DefaultBranch, err = safeString(object["defaultBranch"], path+".defaultBranch", stringOptions{identifier: true}); err != nil {
		return repositoryObservation{}, err
	}
	return result, nil
}

func parseActor(value graph.Value, path string) (actorObservation, error) {
	object, evidence, err := observation(value, path, []string{"authorityProvider", "actor"}, nil)
	if err != nil {
		return actorObservation{}, err
	}
	result := actorObservation{evidence: evidence}
	if result.AuthorityProvider, err = enumeration(object["authorityProvider"], path+".authorityProvider", "github", "openslack"); err != nil {
		return actorObservation{}, err
	}
	if result.Actor, err = parseActorRef(object["actor"], path+".actor"); err != nil {
		return actorObservation{}, err
	}
	return result, nil
}

func parseLabel(value graph.Value, path string) (label, error) {
	object, err := record(value, path)
	if err != nil {
		return label{}, err
	}
	if err := exactKeys(object, path, []string{"name", "category"}, nil); err != nil {
		return label{}, err
	}
	var result label
	if result.Name, err = safeString(object["name"], path+".name", stringOptions{max: 256}); err != nil {
		return label{}, err
	}
	if result.Category, err = enumeration(object["category"], path+".category", "state", "risk", "capability", "other"); err != nil {
		return label{}, err
	}
	return result, nil
}

func parseIssue(value graph.Value, path string) (issueObservation, error) {
	object, evidence, err := observation(value, path, []string{
		"repositoryId", "number", "title", "state", "labels", "assigneeIds",
		"assigneesComplete", "closureComplete", "createdAt", "updatedAt",
	}, []string{"closedAt"})
	if err != nil {
		return issueObservation{}, err
	}
	result := issueObservation{evidence: evidence}
	if result.RepositoryID, err = safeString(object["repositoryId"], path+".repositoryId", stringOptions{identifier: true}); err != nil {
		return issueObservation{}, err
	}
	if result.Number, err = integer(object["number"], path+".number", 1); err != nil {
		return issueObservation{}, err
	}
	if result.Title, err = safeString(object["title"], path+".title", stringOptions{}); err != nil {
		return issueObservation{}, err
	}
	if result.State, err = enumeration(object["state"], path+".state", "open", "closed"); err != nil {
		return issueObservation{}, err
	}
	labelValues, err := boundedArray(object["labels"], path+".labels", MaxLabelsPerIssue)
	if err != nil {
		return issueObservation{}, err
	}
	result.Labels = make([]label, len(labelValues))
	seenLabels := make(map[string]struct{}, len(labelValues))
	for index, item := range labelValues {
		itemPath := fmt.Sprintf("%s.labels[%d]", path, index)
		result.Labels[index], err = parseLabel(item, itemPath)
		if err != nil {
			return issueObservation{}, err
		}
		identity := result.Labels[index].Category + ":" + result.Labels[index].Name
		if _, ok := seenLabels[identity]; ok {
			return issueObservation{}, failure(graph.ContractReferenceInvalid, itemPath, "duplicates label identity "+identity+".")
		}
		seenLabels[identity] = struct{}{}
	}
	if result.AssigneeIDs, err = references(object["assigneeIds"], path+".assigneeIds", 50, 0); err != nil {
		return issueObservation{}, err
	}
	if result.AssigneesComplete, err = booleanValue(object["assigneesComplete"], path+".assigneesComplete"); err != nil {
		return issueObservation{}, err
	}
	if result.ClosureComplete, err = booleanValue(object["closureComplete"], path+".closureComplete"); err != nil {
		return issueObservation{}, err
	}
	if result.CreatedAt, err = dateTime(object["createdAt"], path+".createdAt"); err != nil {
		return issueObservation{}, err
	}
	if result.UpdatedAt, err = dateTime(object["updatedAt"], path+".updatedAt"); err != nil {
		return issueObservation{}, err
	}
	if err := assertNotBefore(result.CreatedAt, result.UpdatedAt, path+".updatedAt"); err != nil {
		return issueObservation{}, err
	}
	if closedAt, ok := object["closedAt"]; ok {
		parsed, err := dateTime(closedAt, path+".closedAt")
		if err != nil {
			return issueObservation{}, err
		}
		if err := assertNotBefore(result.CreatedAt, parsed, path+".closedAt"); err != nil {
			return issueObservation{}, err
		}
		result.ClosedAt = &parsed
	}
	if result.ClosureComplete && result.State == "closed" && result.ClosedAt == nil {
		return issueObservation{}, failure(graph.ContractSchemaInvalid, path+".closedAt", "is required for a closure-complete closed issue.")
	}
	if result.State == "open" && result.ClosedAt != nil {
		return issueObservation{}, failure(graph.ContractSchemaInvalid, path+".closedAt", "is not valid for an open issue.")
	}
	return result, nil
}

func parseClaim(value graph.Value, path string) (claimObservation, error) {
	object, evidence, err := observation(value, path,
		[]string{"issueId", "claimRef", "status", "agentActorId", "claimedAt", "expiresAt"},
		[]string{"targetSha"})
	if err != nil {
		return claimObservation{}, err
	}
	result := claimObservation{evidence: evidence}
	if result.IssueID, err = safeString(object["issueId"], path+".issueId", stringOptions{identifier: true}); err != nil {
		return claimObservation{}, err
	}
	if result.ClaimRef, err = safeString(object["claimRef"], path+".claimRef", stringOptions{identifier: true}); err != nil {
		return claimObservation{}, err
	}
	if result.TargetSHA, err = optionalIdentifier(object, "targetSha", path); err != nil {
		return claimObservation{}, err
	}
	if result.Status, err = enumeration(object["status"], path+".status", "active", "expired", "released"); err != nil {
		return claimObservation{}, err
	}
	if result.AgentActorID, err = safeString(object["agentActorId"], path+".agentActorId", stringOptions{identifier: true}); err != nil {
		return claimObservation{}, err
	}
	if result.ClaimedAt, err = dateTime(object["claimedAt"], path+".claimedAt"); err != nil {
		return claimObservation{}, err
	}
	if result.ExpiresAt, err = dateTime(object["expiresAt"], path+".expiresAt"); err != nil {
		return claimObservation{}, err
	}
	if err := assertNotBefore(result.ClaimedAt, result.ExpiresAt, path+".expiresAt"); err != nil {
		return claimObservation{}, err
	}
	return result, nil
}

func parseWorktree(value graph.Value, path string) (worktreeObservation, error) {
	object, evidence, err := observation(value, path,
		[]string{"issueId", "worktreeId", "branchName", "status", "createdAt"},
		[]string{"claimId", "agentRunId", "baseSha", "closedAt"})
	if err != nil {
		return worktreeObservation{}, err
	}
	result := worktreeObservation{evidence: evidence}
	if result.IssueID, err = safeString(object["issueId"], path+".issueId", stringOptions{identifier: true}); err != nil {
		return worktreeObservation{}, err
	}
	if result.ClaimID, err = optionalIdentifier(object, "claimId", path); err != nil {
		return worktreeObservation{}, err
	}
	if result.AgentRunID, err = optionalIdentifier(object, "agentRunId", path); err != nil {
		return worktreeObservation{}, err
	}
	if result.WorktreeID, err = safeString(object["worktreeId"], path+".worktreeId", stringOptions{identifier: true}); err != nil {
		return worktreeObservation{}, err
	}
	if result.BaseSHA, err = optionalIdentifier(object, "baseSha", path); err != nil {
		return worktreeObservation{}, err
	}
	if result.BranchName, err = safeString(object["branchName"], path+".branchName", stringOptions{identifier: true}); err != nil {
		return worktreeObservation{}, err
	}
	if result.Status, err = enumeration(object["status"], path+".status", "active", "preserved", "cleaned"); err != nil {
		return worktreeObservation{}, err
	}
	if result.CreatedAt, err = dateTime(object["createdAt"], path+".createdAt"); err != nil {
		return worktreeObservation{}, err
	}
	if closedAt, ok := object["closedAt"]; ok {
		parsed, err := dateTime(closedAt, path+".closedAt")
		if err != nil {
			return worktreeObservation{}, err
		}
		if err := assertNotBefore(result.CreatedAt, parsed, path+".closedAt"); err != nil {
			return worktreeObservation{}, err
		}
		result.ClosedAt = &parsed
	}
	if result.Status == "cleaned" && result.ClosedAt == nil {
		return worktreeObservation{}, failure(graph.ContractSchemaInvalid, path+".closedAt", "is required for a cleaned worktree.")
	}
	if result.Status == "active" && result.ClosedAt != nil {
		return worktreeObservation{}, failure(graph.ContractSchemaInvalid, path+".closedAt", "is not valid for an active worktree.")
	}
	return result, nil
}

func parseCommit(value graph.Value, path string) (commitObservation, error) {
	object, evidence, err := observation(value, path,
		[]string{"repositoryId", "sha", "issueIds", "authoredAt"}, []string{"worktreeId"})
	if err != nil {
		return commitObservation{}, err
	}
	result := commitObservation{evidence: evidence}
	if result.RepositoryID, err = safeString(object["repositoryId"], path+".repositoryId", stringOptions{identifier: true}); err != nil {
		return commitObservation{}, err
	}
	if result.SHA, err = safeString(object["sha"], path+".sha", stringOptions{identifier: true}); err != nil {
		return commitObservation{}, err
	}
	if result.IssueIDs, err = references(object["issueIds"], path+".issueIds", MaxRelationsPerItem, 0); err != nil {
		return commitObservation{}, err
	}
	if result.WorktreeID, err = optionalIdentifier(object, "worktreeId", path); err != nil {
		return commitObservation{}, err
	}
	if result.AuthoredAt, err = dateTime(object["authoredAt"], path+".authoredAt"); err != nil {
		return commitObservation{}, err
	}
	return result, nil
}

func parsePullRequest(value graph.Value, path string) (pullRequestObservation, error) {
	object, evidence, err := observation(value, path, []string{
		"repositoryId", "number", "title", "authorActorId", "state", "draft",
		"issueIds", "commitShas", "openedAt", "updatedAt",
	}, []string{"baseSha", "headSha"})
	if err != nil {
		return pullRequestObservation{}, err
	}
	result := pullRequestObservation{evidence: evidence}
	if result.RepositoryID, err = safeString(object["repositoryId"], path+".repositoryId", stringOptions{identifier: true}); err != nil {
		return pullRequestObservation{}, err
	}
	if result.Number, err = integer(object["number"], path+".number", 1); err != nil {
		return pullRequestObservation{}, err
	}
	if result.Title, err = safeString(object["title"], path+".title", stringOptions{}); err != nil {
		return pullRequestObservation{}, err
	}
	if result.AuthorActorID, err = safeString(object["authorActorId"], path+".authorActorId", stringOptions{identifier: true}); err != nil {
		return pullRequestObservation{}, err
	}
	if result.State, err = enumeration(object["state"], path+".state", "open", "closed", "merged"); err != nil {
		return pullRequestObservation{}, err
	}
	if result.Draft, err = booleanValue(object["draft"], path+".draft"); err != nil {
		return pullRequestObservation{}, err
	}
	if result.BaseSHA, err = optionalIdentifier(object, "baseSha", path); err != nil {
		return pullRequestObservation{}, err
	}
	if result.HeadSHA, err = optionalIdentifier(object, "headSha", path); err != nil {
		return pullRequestObservation{}, err
	}
	if result.IssueIDs, err = references(object["issueIds"], path+".issueIds", MaxRelationsPerItem, 0); err != nil {
		return pullRequestObservation{}, err
	}
	if result.CommitSHAs, err = references(object["commitShas"], path+".commitShas", MaxRelationsPerItem, 0); err != nil {
		return pullRequestObservation{}, err
	}
	if result.OpenedAt, err = dateTime(object["openedAt"], path+".openedAt"); err != nil {
		return pullRequestObservation{}, err
	}
	if result.UpdatedAt, err = dateTime(object["updatedAt"], path+".updatedAt"); err != nil {
		return pullRequestObservation{}, err
	}
	if err := assertNotBefore(result.OpenedAt, result.UpdatedAt, path+".updatedAt"); err != nil {
		return pullRequestObservation{}, err
	}
	return result, nil
}

func parseCheck(value graph.Value, path string) (checkObservation, error) {
	object, evidence, err := observation(value, path,
		[]string{"pullRequestId", "name", "status", "startedAt"},
		[]string{"conclusion", "headSha", "completedAt"})
	if err != nil {
		return checkObservation{}, err
	}
	result := checkObservation{evidence: evidence}
	if result.PullRequestID, err = safeString(object["pullRequestId"], path+".pullRequestId", stringOptions{identifier: true}); err != nil {
		return checkObservation{}, err
	}
	if result.Name, err = safeString(object["name"], path+".name", stringOptions{max: 512}); err != nil {
		return checkObservation{}, err
	}
	if result.Status, err = enumeration(object["status"], path+".status", "queued", "in_progress", "completed"); err != nil {
		return checkObservation{}, err
	}
	if conclusion, ok := object["conclusion"]; ok {
		parsed, err := enumeration(conclusion, path+".conclusion", "success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale", "startup_failure")
		if err != nil {
			return checkObservation{}, err
		}
		result.Conclusion = &parsed
	}
	if result.HeadSHA, err = optionalIdentifier(object, "headSha", path); err != nil {
		return checkObservation{}, err
	}
	if result.StartedAt, err = dateTime(object["startedAt"], path+".startedAt"); err != nil {
		return checkObservation{}, err
	}
	if completedAt, ok := object["completedAt"]; ok {
		parsed, err := dateTime(completedAt, path+".completedAt")
		if err != nil {
			return checkObservation{}, err
		}
		if err := assertNotBefore(result.StartedAt, parsed, path+".completedAt"); err != nil {
			return checkObservation{}, err
		}
		result.CompletedAt = &parsed
	}
	if result.Status == "completed" && (result.CompletedAt == nil || result.Conclusion == nil) {
		return checkObservation{}, failure(graph.ContractSchemaInvalid, path, "a completed check requires completedAt and conclusion.")
	}
	if result.Status != "completed" && (result.CompletedAt != nil || result.Conclusion != nil) {
		return checkObservation{}, failure(graph.ContractSchemaInvalid, path, "a non-completed check cannot carry completedAt or conclusion.")
	}
	return result, nil
}

func parseReview(value graph.Value, path string) (reviewObservation, error) {
	object, evidence, err := observation(value, path,
		[]string{"pullRequestId", "actorId", "actorKind", "state", "submittedAt"}, []string{"commitOid"})
	if err != nil {
		return reviewObservation{}, err
	}
	result := reviewObservation{evidence: evidence}
	if result.PullRequestID, err = safeString(object["pullRequestId"], path+".pullRequestId", stringOptions{identifier: true}); err != nil {
		return reviewObservation{}, err
	}
	if result.ActorID, err = safeString(object["actorId"], path+".actorId", stringOptions{identifier: true}); err != nil {
		return reviewObservation{}, err
	}
	if result.ActorKind, err = enumeration(object["actorKind"], path+".actorKind", "human", "agent", "system"); err != nil {
		return reviewObservation{}, err
	}
	if result.State, err = enumeration(object["state"], path+".state", "APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED"); err != nil {
		return reviewObservation{}, err
	}
	if result.CommitOID, err = optionalIdentifier(object, "commitOid", path); err != nil {
		return reviewObservation{}, err
	}
	if result.SubmittedAt, err = dateTime(object["submittedAt"], path+".submittedAt"); err != nil {
		return reviewObservation{}, err
	}
	return result, nil
}

func parseMerge(value graph.Value, path string) (mergeObservation, error) {
	object, evidence, err := observation(value, path,
		[]string{"pullRequestId", "actorId", "mergedAt"}, []string{"headSha", "mergeCommitSha"})
	if err != nil {
		return mergeObservation{}, err
	}
	result := mergeObservation{evidence: evidence}
	if result.PullRequestID, err = safeString(object["pullRequestId"], path+".pullRequestId", stringOptions{identifier: true}); err != nil {
		return mergeObservation{}, err
	}
	if result.HeadSHA, err = optionalIdentifier(object, "headSha", path); err != nil {
		return mergeObservation{}, err
	}
	if result.MergeCommitSHA, err = optionalIdentifier(object, "mergeCommitSha", path); err != nil {
		return mergeObservation{}, err
	}
	if result.ActorID, err = safeString(object["actorId"], path+".actorId", stringOptions{identifier: true}); err != nil {
		return mergeObservation{}, err
	}
	if result.MergedAt, err = dateTime(object["mergedAt"], path+".mergedAt"); err != nil {
		return mergeObservation{}, err
	}
	return result, nil
}

func parseWorkflowRun(value graph.Value, path string) (workflowRunObservation, error) {
	object, evidence, err := observation(value, path,
		[]string{"workflowId", "status", "issueIds", "pullRequestIds", "startedAt"}, []string{"completedAt"})
	if err != nil {
		return workflowRunObservation{}, err
	}
	result := workflowRunObservation{evidence: evidence}
	if result.WorkflowID, err = safeString(object["workflowId"], path+".workflowId", stringOptions{identifier: true}); err != nil {
		return workflowRunObservation{}, err
	}
	if result.Status, err = enumeration(object["status"], path+".status", "created", "previewed", "confirmed", "pending", "running", "paused", "paused_waiting_approval", "resuming", "completed", "failed", "cancelled"); err != nil {
		return workflowRunObservation{}, err
	}
	if result.IssueIDs, err = references(object["issueIds"], path+".issueIds", MaxRelationsPerItem, 0); err != nil {
		return workflowRunObservation{}, err
	}
	if result.PullRequestIDs, err = references(object["pullRequestIds"], path+".pullRequestIds", MaxRelationsPerItem, 0); err != nil {
		return workflowRunObservation{}, err
	}
	if result.StartedAt, err = dateTime(object["startedAt"], path+".startedAt"); err != nil {
		return workflowRunObservation{}, err
	}
	if completedAt, ok := object["completedAt"]; ok {
		parsed, err := dateTime(completedAt, path+".completedAt")
		if err != nil {
			return workflowRunObservation{}, err
		}
		if err := assertNotBefore(result.StartedAt, parsed, path+".completedAt"); err != nil {
			return workflowRunObservation{}, err
		}
		result.CompletedAt = &parsed
	}
	terminal := result.Status == "completed" || result.Status == "failed" || result.Status == "cancelled"
	if terminal != (result.CompletedAt != nil) {
		message := "is not valid for " + result.Status + "."
		if terminal {
			message = "is required for " + result.Status + "."
		}
		return workflowRunObservation{}, failure(graph.ContractSchemaInvalid, path+".completedAt", message)
	}
	return result, nil
}

func parseAgentRun(value graph.Value, path string) (agentRunObservation, error) {
	object, evidence, err := observation(value, path,
		[]string{"agentActorId", "status", "startedAt"}, []string{"workflowRunId", "worktreeId", "completedAt"})
	if err != nil {
		return agentRunObservation{}, err
	}
	result := agentRunObservation{evidence: evidence}
	if result.WorkflowRunID, err = optionalIdentifier(object, "workflowRunId", path); err != nil {
		return agentRunObservation{}, err
	}
	if result.AgentActorID, err = safeString(object["agentActorId"], path+".agentActorId", stringOptions{identifier: true}); err != nil {
		return agentRunObservation{}, err
	}
	if result.Status, err = enumeration(object["status"], path+".status", "pending", "running", "paused", "completed", "failed", "cancelled"); err != nil {
		return agentRunObservation{}, err
	}
	if result.WorktreeID, err = optionalIdentifier(object, "worktreeId", path); err != nil {
		return agentRunObservation{}, err
	}
	if result.StartedAt, err = dateTime(object["startedAt"], path+".startedAt"); err != nil {
		return agentRunObservation{}, err
	}
	if completedAt, ok := object["completedAt"]; ok {
		parsed, err := dateTime(completedAt, path+".completedAt")
		if err != nil {
			return agentRunObservation{}, err
		}
		if err := assertNotBefore(result.StartedAt, parsed, path+".completedAt"); err != nil {
			return agentRunObservation{}, err
		}
		result.CompletedAt = &parsed
	}
	terminal := result.Status == "completed" || result.Status == "failed" || result.Status == "cancelled"
	if terminal != (result.CompletedAt != nil) {
		message := "is not valid for " + result.Status + "."
		if terminal {
			message = "is required for " + result.Status + "."
		}
		return agentRunObservation{}, failure(graph.ContractSchemaInvalid, path+".completedAt", message)
	}
	return result, nil
}

func parsePRMSReport(value graph.Value, path string) (prmsReportObservation, error) {
	object, evidence, err := observation(value, path,
		[]string{"pullRequestId", "status", "blockerCount"}, []string{"baseSha", "headSha"})
	if err != nil {
		return prmsReportObservation{}, err
	}
	result := prmsReportObservation{evidence: evidence}
	if result.PullRequestID, err = safeString(object["pullRequestId"], path+".pullRequestId", stringOptions{identifier: true}); err != nil {
		return prmsReportObservation{}, err
	}
	if result.BaseSHA, err = optionalIdentifier(object, "baseSha", path); err != nil {
		return prmsReportObservation{}, err
	}
	if result.HeadSHA, err = optionalIdentifier(object, "headSha", path); err != nil {
		return prmsReportObservation{}, err
	}
	if result.Status, err = enumeration(object["status"], path+".status", "ready", "blocked", "needs_human_approval", "failed"); err != nil {
		return prmsReportObservation{}, err
	}
	if result.BlockerCount, err = integer(object["blockerCount"], path+".blockerCount", 0); err != nil {
		return prmsReportObservation{}, err
	}
	if result.Status == "ready" && result.BlockerCount != 0 {
		return prmsReportObservation{}, failure(graph.ContractSchemaInvalid, path, "a ready PRMS report must have blockerCount 0.")
	}
	return result, nil
}

func parseHandoff(value graph.Value, path string) (handoffObservation, error) {
	object, evidence, err := observation(value, path,
		[]string{"status", "fromActorId", "toActorId", "createdAt"},
		[]string{"issueId", "pullRequestId", "workflowRunId", "closedAt"})
	if err != nil {
		return handoffObservation{}, err
	}
	result := handoffObservation{evidence: evidence}
	if result.Status, err = enumeration(object["status"], path+".status", "open", "accepted", "closed"); err != nil {
		return handoffObservation{}, err
	}
	if result.FromActorID, err = safeString(object["fromActorId"], path+".fromActorId", stringOptions{identifier: true}); err != nil {
		return handoffObservation{}, err
	}
	if result.ToActorID, err = safeString(object["toActorId"], path+".toActorId", stringOptions{identifier: true}); err != nil {
		return handoffObservation{}, err
	}
	if result.IssueID, err = optionalIdentifier(object, "issueId", path); err != nil {
		return handoffObservation{}, err
	}
	if result.PullRequestID, err = optionalIdentifier(object, "pullRequestId", path); err != nil {
		return handoffObservation{}, err
	}
	if result.WorkflowRunID, err = optionalIdentifier(object, "workflowRunId", path); err != nil {
		return handoffObservation{}, err
	}
	if result.CreatedAt, err = dateTime(object["createdAt"], path+".createdAt"); err != nil {
		return handoffObservation{}, err
	}
	if closedAt, ok := object["closedAt"]; ok {
		parsed, parseErr := dateTime(closedAt, path+".closedAt")
		if parseErr != nil {
			return handoffObservation{}, parseErr
		}
		if err := assertNotBefore(result.CreatedAt, parsed, path+".closedAt"); err != nil {
			return handoffObservation{}, err
		}
		result.ClosedAt = &parsed
	}
	if (result.Status == "closed") != (result.ClosedAt != nil) {
		message := "is not valid for " + result.Status + "."
		if result.Status == "closed" {
			message = "is required for a closed handoff."
		}
		return handoffObservation{}, failure(graph.ContractSchemaInvalid, path+".closedAt", message)
	}
	return result, nil
}

func parseDecision(value graph.Value, path string) (decisionObservation, error) {
	object, evidence, err := observation(value, path,
		[]string{"topic", "status", "decidedByActorId", "createdAt"},
		[]string{"issueId", "pullRequestId", "workflowRunId", "supersededAt"})
	if err != nil {
		return decisionObservation{}, err
	}
	result := decisionObservation{evidence: evidence}
	if result.Topic, err = safeString(object["topic"], path+".topic", stringOptions{}); err != nil {
		return decisionObservation{}, err
	}
	if result.Status, err = enumeration(object["status"], path+".status", "active", "superseded"); err != nil {
		return decisionObservation{}, err
	}
	if result.DecidedByActorID, err = safeString(object["decidedByActorId"], path+".decidedByActorId", stringOptions{identifier: true}); err != nil {
		return decisionObservation{}, err
	}
	if result.IssueID, err = optionalIdentifier(object, "issueId", path); err != nil {
		return decisionObservation{}, err
	}
	if result.PullRequestID, err = optionalIdentifier(object, "pullRequestId", path); err != nil {
		return decisionObservation{}, err
	}
	if result.WorkflowRunID, err = optionalIdentifier(object, "workflowRunId", path); err != nil {
		return decisionObservation{}, err
	}
	if result.CreatedAt, err = dateTime(object["createdAt"], path+".createdAt"); err != nil {
		return decisionObservation{}, err
	}
	if supersededAt, ok := object["supersededAt"]; ok {
		parsed, parseErr := dateTime(supersededAt, path+".supersededAt")
		if parseErr != nil {
			return decisionObservation{}, parseErr
		}
		if err := assertNotBefore(result.CreatedAt, parsed, path+".supersededAt"); err != nil {
			return decisionObservation{}, err
		}
		result.SupersededAt = &parsed
	}
	if (result.Status == "superseded") != (result.SupersededAt != nil) {
		message := "is not valid for an active decision."
		if result.Status == "superseded" {
			message = "is required for a superseded decision."
		}
		return decisionObservation{}, failure(graph.ContractSchemaInvalid, path+".supersededAt", message)
	}
	return result, nil
}

type evidenced interface {
	observationID() string
}

func collection[T evidenced](
	value graph.Value,
	path string,
	parser func(graph.Value, string) (T, error),
	identity func(T) string,
) ([]T, error) {
	values, err := boundedArray(value, path, MaxObservationsPerKind)
	if err != nil {
		return nil, err
	}
	items := make([]T, len(values))
	seen := make(map[string]struct{}, len(values))
	evidenceIDs := make(map[string]struct{}, len(values))
	for index, value := range values {
		itemPath := fmt.Sprintf("%s[%d]", path, index)
		items[index], err = parser(value, itemPath)
		if err != nil {
			return nil, err
		}
		observationID := items[index].observationID()
		if _, ok := evidenceIDs[observationID]; ok {
			return nil, failure(graph.ContractReferenceInvalid, itemPath+".id", "duplicates observation identity "+observationID+".")
		}
		evidenceIDs[observationID] = struct{}{}
		sourceID := identity(items[index])
		if _, ok := seen[sourceID]; ok {
			return nil, failure(graph.ContractReferenceInvalid, itemPath, "duplicates source identity "+sourceID+".")
		}
		seen[sourceID] = struct{}{}
	}
	return items, nil
}

func batch[T evidenced](
	value graph.Value,
	path string,
	parser func(graph.Value, string) (T, error),
	identity func(T) string,
	maxItems int,
) (sourceBatch[T], error) {
	object, err := record(value, path)
	if err != nil {
		return sourceBatch[T]{}, err
	}
	status, err := enumeration(object["status"], path+".status", "observed", "incomplete", "missing")
	if err != nil {
		return sourceBatch[T]{}, err
	}
	if status == "missing" {
		if err := exactKeys(object, path, []string{"status", "items", "reasonCode"}, nil); err != nil {
			return sourceBatch[T]{}, err
		}
		if _, err := boundedArray(object["items"], path+".items", 0); err != nil {
			return sourceBatch[T]{}, err
		}
		reason, err := safeString(object["reasonCode"], path+".reasonCode", stringOptions{identifier: true})
		if err != nil {
			return sourceBatch[T]{}, err
		}
		return sourceBatch[T]{Status: status, Items: []T{}, ReasonCode: reason}, nil
	}
	if err := exactKeys(object, path, []string{"status", "items", "warningCodes"}, []string{"batchVersion", "observedAt"}); err != nil {
		return sourceBatch[T]{}, err
	}
	items, err := collection(object["items"], path+".items", parser, identity)
	if err != nil {
		return sourceBatch[T]{}, err
	}
	if len(items) > maxItems {
		return sourceBatch[T]{}, failure(graph.ContractBoundExceeded, path+".items", fmt.Sprintf("must contain at most %d items.", maxItems))
	}
	warnings, err := references(object["warningCodes"], path+".warningCodes", MaxCompletenessEntries, 0)
	if err != nil {
		return sourceBatch[T]{}, err
	}
	result := sourceBatch[T]{Status: status, Items: items, WarningCodes: warnings}
	if status == "observed" {
		batchVersion, versionOK := object["batchVersion"]
		observedAt, observedOK := object["observedAt"]
		if !versionOK || !observedOK {
			return sourceBatch[T]{}, failure(graph.ContractSchemaInvalid, path, "an observed batch requires batchVersion and observedAt.")
		}
		version, err := safeString(batchVersion, path+".batchVersion", stringOptions{identifier: true})
		if err != nil {
			return sourceBatch[T]{}, err
		}
		observed, err := dateTime(observedAt, path+".observedAt")
		if err != nil {
			return sourceBatch[T]{}, err
		}
		result.BatchVersion = &version
		result.ObservedAt = &observed
		return result, nil
	}
	if len(warnings) == 0 {
		return sourceBatch[T]{}, failure(graph.ContractSchemaInvalid, path+".warningCodes", "must explain an incomplete batch.")
	}
	batchVersion, versionOK := object["batchVersion"]
	observedAt, observedOK := object["observedAt"]
	if versionOK != observedOK {
		return sourceBatch[T]{}, failure(graph.ContractSchemaInvalid, path, "incomplete batchVersion and observedAt must either both be present or both be absent.")
	}
	if versionOK {
		version, err := safeString(batchVersion, path+".batchVersion", stringOptions{identifier: true})
		if err != nil {
			return sourceBatch[T]{}, err
		}
		observed, err := dateTime(observedAt, path+".observedAt")
		if err != nil {
			return sourceBatch[T]{}, err
		}
		result.BatchVersion = &version
		result.ObservedAt = &observed
	}
	return result, nil
}

func assertSemanticUnique[T any](items []T, path string, identity func(T) string) error {
	seen := make(map[string]struct{}, len(items))
	for index, item := range items {
		value := identity(item)
		if _, ok := seen[value]; ok {
			return failure(graph.ContractReferenceInvalid, fmt.Sprintf("%s[%d]", path, index), "duplicates semantic authority identity "+value+".")
		}
		seen[value] = struct{}{}
	}
	return nil
}

func assertAggregateBounds(sources sourceBatches) error {
	totalObservations := len(sources.Repository.Items) + len(sources.Actors.Items) + len(sources.Issues.Items) +
		len(sources.Claims.Items) + len(sources.Worktrees.Items) + len(sources.Commits.Items) +
		len(sources.PullRequests.Items) + len(sources.Checks.Items) + len(sources.Reviews.Items) +
		len(sources.Merges.Items) + len(sources.WorkflowRuns.Items) + len(sources.AgentRuns.Items) +
		len(sources.PRMSReports.Items) + len(sources.Handoffs.Items) + len(sources.Decisions.Items)
	if totalObservations > MaxTotalObservations {
		return failure(graph.ContractBoundExceeded, "$.sources", fmt.Sprintf("contains %d observations; maximum is %d.", totalObservations, MaxTotalObservations))
	}
	totalRelations := 0
	for _, item := range sources.Issues.Items {
		totalRelations += 1 + len(item.AssigneeIDs)
		if item.State == "closed" {
			totalRelations++
		}
	}
	totalRelations += len(sources.Claims.Items) * 2
	for _, item := range sources.Worktrees.Items {
		totalRelations++
		if item.ClaimID != nil {
			totalRelations++
		}
		if item.AgentRunID != nil {
			totalRelations++
		}
	}
	for _, item := range sources.Commits.Items {
		totalRelations += len(item.IssueIDs)
		if item.WorktreeID != nil {
			totalRelations++
		}
	}
	for _, item := range sources.PullRequests.Items {
		totalRelations += len(item.IssueIDs) + len(item.CommitSHAs)
	}
	for _, item := range sources.WorkflowRuns.Items {
		totalRelations += len(item.IssueIDs) + len(item.PullRequestIDs)
	}
	totalRelations += len(sources.Checks.Items) + len(sources.Reviews.Items) + len(sources.Merges.Items) + len(sources.PRMSReports.Items)
	for _, item := range sources.AgentRuns.Items {
		totalRelations++
		if item.WorkflowRunID != nil {
			totalRelations++
		}
		if item.WorktreeID != nil {
			totalRelations++
		}
	}
	for _, item := range sources.Handoffs.Items {
		totalRelations += 2
		if item.IssueID != nil {
			totalRelations++
		}
		if item.PullRequestID != nil {
			totalRelations++
		}
		if item.WorkflowRunID != nil {
			totalRelations++
		}
	}
	for _, item := range sources.Decisions.Items {
		if item.IssueID != nil {
			totalRelations++
		}
		if item.PullRequestID != nil {
			totalRelations++
		}
		if item.WorkflowRunID != nil {
			totalRelations++
		}
	}
	if totalRelations > MaxTotalRelations {
		return failure(graph.ContractBoundExceeded, "$.sources", fmt.Sprintf("contains %d relations; maximum is %d.", totalRelations, MaxTotalRelations))
	}
	return nil
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
		return sourceSnapshot{}, failure(graph.ContractBoundExceeded, "$", fmt.Sprintf("source exceeds %d bytes.", MaxSourceBytes))
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
	object, err := record(value, "$")
	if err != nil {
		return sourceSnapshot{}, err
	}
	if err := exactKeys(object, "$", []string{
		"schema", "scenarioDefinitionId", "scenarioInstanceId", "cursor", "generatedAt", "projectorVersion", "sources",
	}, nil); err != nil {
		return sourceSnapshot{}, err
	}
	if object["schema"] != SourceSchema {
		return sourceSnapshot{}, failure(graph.ContractSchemaInvalid, "$.schema", "must equal "+SourceSchema+".")
	}
	sourceObject, err := record(object["sources"], "$.sources")
	if err != nil {
		return sourceSnapshot{}, err
	}
	sourceNames := []string{
		"repository", "actors", "issues", "claims", "worktrees", "commits", "pullRequests", "checks",
		"reviews", "merges", "workflowRuns", "agentRuns", "prmsReports", "handoffs", "decisions",
	}
	if err := exactKeys(sourceObject, "$.sources", sourceNames, nil); err != nil {
		return sourceSnapshot{}, err
	}
	var sources sourceBatches
	if sources.Repository, err = batch(sourceObject["repository"], "$.sources.repository", parseRepository, func(item repositoryObservation) string { return item.RepositoryID }, 1); err != nil {
		return sourceSnapshot{}, err
	}
	if sources.Actors, err = batch(sourceObject["actors"], "$.sources.actors", parseActor, func(item actorObservation) string { return item.Actor.ID }, MaxObservationsPerKind); err != nil {
		return sourceSnapshot{}, err
	}
	if sources.Issues, err = batch(sourceObject["issues"], "$.sources.issues", parseIssue, func(item issueObservation) string { return item.ID }, MaxObservationsPerKind); err != nil {
		return sourceSnapshot{}, err
	}
	if sources.Claims, err = batch(sourceObject["claims"], "$.sources.claims", parseClaim, func(item claimObservation) string { return item.ClaimRef }, MaxObservationsPerKind); err != nil {
		return sourceSnapshot{}, err
	}
	if sources.Worktrees, err = batch(sourceObject["worktrees"], "$.sources.worktrees", parseWorktree, func(item worktreeObservation) string { return item.WorktreeID }, MaxObservationsPerKind); err != nil {
		return sourceSnapshot{}, err
	}
	if sources.Commits, err = batch(sourceObject["commits"], "$.sources.commits", parseCommit, func(item commitObservation) string { return item.SHA }, MaxObservationsPerKind); err != nil {
		return sourceSnapshot{}, err
	}
	if sources.PullRequests, err = batch(sourceObject["pullRequests"], "$.sources.pullRequests", parsePullRequest, func(item pullRequestObservation) string { return item.ID }, MaxObservationsPerKind); err != nil {
		return sourceSnapshot{}, err
	}
	if sources.Checks, err = batch(sourceObject["checks"], "$.sources.checks", parseCheck, func(item checkObservation) string { return item.ID }, MaxObservationsPerKind); err != nil {
		return sourceSnapshot{}, err
	}
	if sources.Reviews, err = batch(sourceObject["reviews"], "$.sources.reviews", parseReview, func(item reviewObservation) string { return item.ID }, MaxObservationsPerKind); err != nil {
		return sourceSnapshot{}, err
	}
	if sources.Merges, err = batch(sourceObject["merges"], "$.sources.merges", parseMerge, func(item mergeObservation) string { return item.ID }, MaxObservationsPerKind); err != nil {
		return sourceSnapshot{}, err
	}
	if sources.WorkflowRuns, err = batch(sourceObject["workflowRuns"], "$.sources.workflowRuns", parseWorkflowRun, func(item workflowRunObservation) string { return item.ID }, MaxObservationsPerKind); err != nil {
		return sourceSnapshot{}, err
	}
	if sources.AgentRuns, err = batch(sourceObject["agentRuns"], "$.sources.agentRuns", parseAgentRun, func(item agentRunObservation) string { return item.ID }, MaxObservationsPerKind); err != nil {
		return sourceSnapshot{}, err
	}
	if sources.PRMSReports, err = batch(sourceObject["prmsReports"], "$.sources.prmsReports", parsePRMSReport, func(item prmsReportObservation) string { return item.ID }, MaxObservationsPerKind); err != nil {
		return sourceSnapshot{}, err
	}
	if sources.Handoffs, err = batch(sourceObject["handoffs"], "$.sources.handoffs", parseHandoff, func(item handoffObservation) string { return item.ID }, MaxObservationsPerKind); err != nil {
		return sourceSnapshot{}, err
	}
	if sources.Decisions, err = batch(sourceObject["decisions"], "$.sources.decisions", parseDecision, func(item decisionObservation) string { return item.ID }, MaxObservationsPerKind); err != nil {
		return sourceSnapshot{}, err
	}
	pullRequestNumbers := make(map[string]struct{}, len(sources.PullRequests.Items))
	for index, item := range sources.PullRequests.Items {
		identity := fmt.Sprintf("%s#%d", item.RepositoryID, item.Number)
		if _, ok := pullRequestNumbers[identity]; ok {
			return sourceSnapshot{}, failure(
				graph.ContractReferenceInvalid,
				fmt.Sprintf("$.pullRequests[%d].number", index),
				"duplicates pull request identity "+identity+".",
			)
		}
		pullRequestNumbers[identity] = struct{}{}
	}
	if err := assertSemanticUnique(sources.Issues.Items, "$.sources.issues.items", func(item issueObservation) string { return fmt.Sprintf("%s#%d", item.RepositoryID, item.Number) }); err != nil {
		return sourceSnapshot{}, err
	}
	if err := assertSemanticUnique(sources.Merges.Items, "$.sources.merges.items", func(item mergeObservation) string {
		return item.PullRequestID + ":" + valueOr(item.HeadSHA, "missing-head")
	}); err != nil {
		return sourceSnapshot{}, err
	}
	if err := assertSemanticUnique(sources.PRMSReports.Items, "$.sources.prmsReports.items", func(item prmsReportObservation) string {
		return item.PullRequestID + ":" + valueOr(item.BaseSHA, "missing-base") + ":" + valueOr(item.HeadSHA, "missing-head")
	}); err != nil {
		return sourceSnapshot{}, err
	}
	if err := assertSemanticUnique(sources.Reviews.Items, "$.sources.reviews.items", func(item reviewObservation) string {
		return item.PullRequestID + ":" + item.ActorID + ":" + valueOr(item.CommitOID, "missing-head") + ":" + fmt.Sprint(dateMillis(item.SubmittedAt))
	}); err != nil {
		return sourceSnapshot{}, err
	}
	if err := assertAggregateBounds(sources); err != nil {
		return sourceSnapshot{}, err
	}
	projectorVersion, err := safeString(object["projectorVersion"], "$.projectorVersion", stringOptions{identifier: true})
	if err != nil {
		return sourceSnapshot{}, err
	}
	if projectorVersion != ProjectorID {
		return sourceSnapshot{}, failure(graph.ContractSchemaInvalid, "$.projectorVersion", "must equal the registered projector "+ProjectorID+".")
	}
	canonical, err := graph.CanonicalJSON(value)
	if err != nil {
		return sourceSnapshot{}, err
	}
	result := sourceSnapshot{Schema: SourceSchema, Sources: sources, ProjectorVersion: projectorVersion, canonicalBytes: len(canonical)}
	if result.ScenarioDefinitionID, err = safeString(object["scenarioDefinitionId"], "$.scenarioDefinitionId", stringOptions{identifier: true}); err != nil {
		return sourceSnapshot{}, err
	}
	if result.ScenarioInstanceID, err = safeString(object["scenarioInstanceId"], "$.scenarioInstanceId", stringOptions{identifier: true}); err != nil {
		return sourceSnapshot{}, err
	}
	if result.Cursor, err = safeString(object["cursor"], "$.cursor", stringOptions{identifier: true}); err != nil {
		return sourceSnapshot{}, err
	}
	if result.GeneratedAt, err = dateTime(object["generatedAt"], "$.generatedAt"); err != nil {
		return sourceSnapshot{}, err
	}
	return result, nil
}

func valueOr(value *string, fallback string) string {
	if value == nil {
		return fallback
	}
	return *value
}
