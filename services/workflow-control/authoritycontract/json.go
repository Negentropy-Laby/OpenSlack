package authoritycontract

import (
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/strictjson"
)

func parseStrictJSON(input []byte, maxDepth, maxNodes, maxStringBytes int) (any, error) {
	return strictjson.Parse(input, strictjson.Limits{
		MaxDepth:       maxDepth,
		MaxNodes:       maxNodes,
		MaxStringBytes: maxStringBytes,
		NumberPolicy:   strictjson.NumberInt64,
	})
}

func sortedObjectKeys(value map[string]any) []string {
	keys := make([]string, 0, len(value))
	for key := range value {
		keys = append(keys, key)
	}
	canonicaljson.SortStringsUTF16(keys)
	return keys
}
