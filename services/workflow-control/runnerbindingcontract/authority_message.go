package runnerbindingcontract

import "github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"

// prepareAuthorityMessageBytes works around no transport authority: it
// validates through the existing v2 contract, then prepares the same neutral
// JSON object. The authority package's Message struct is an output type, not a
// valid input to its closed object validator.
func prepareAuthorityMessageBytes(input []byte) (authoritycontract.Message, authoritycontract.PreparedMessage, error) {
	message, err := authoritycontract.DecodeMessageJSON(input)
	if err != nil {
		return authoritycontract.Message{}, authoritycontract.PreparedMessage{}, err
	}
	parsed, err := parseStrictJSON(
		input,
		authoritycontract.MaxMessageBytes,
		authoritycontract.MaxJSONDepth,
		authoritycontract.MaxJSONNodes,
		authoritycontract.MaxStringBytes,
		authoritycontract.MaxSafeInteger,
	)
	if err != nil {
		return authoritycontract.Message{}, authoritycontract.PreparedMessage{}, err
	}
	prepared, err := authoritycontract.PrepareMessage(plainJSONValue(parsed))
	if err != nil {
		return authoritycontract.Message{}, authoritycontract.PreparedMessage{}, err
	}
	return message, prepared, nil
}

func prepareAuthorityMessageValue(value any) (authoritycontract.Message, authoritycontract.PreparedMessage, error) {
	canonical, err := canonicalJSON(value)
	if err != nil {
		return authoritycontract.Message{}, authoritycontract.PreparedMessage{}, err
	}
	return prepareAuthorityMessageBytes(canonical)
}

func plainJSONValue(value any) any {
	switch current := value.(type) {
	case Record:
		result := make(map[string]any, len(current))
		for key, child := range current {
			result[key] = plainJSONValue(child)
		}
		return result
	case map[string]any:
		result := make(map[string]any, len(current))
		for key, child := range current {
			result[key] = plainJSONValue(child)
		}
		return result
	case []any:
		result := make([]any, len(current))
		for index, child := range current {
			result[index] = plainJSONValue(child)
		}
		return result
	default:
		return value
	}
}
