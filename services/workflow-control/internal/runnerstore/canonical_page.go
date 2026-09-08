package runnerstore

import (
	"bytes"
	"errors"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/internal/canonicaljson"
)

// CanonicalArrayPage encodes each record once. The fixed envelope is measured
// separately; no growing candidate response is copied or re-encoded.
type CanonicalArrayPage struct {
	envelope          canonicaljson.Object
	field             string
	fixedBytes        int
	completeField     bool
	records           [][]byte
	recordBytes       int
	last              string
	limit             int
	continuationCount int
	sizes             []int
	cursors           []string
}

func NewCanonicalArrayPage(envelope canonicaljson.Object, field string, limit int) (*CanonicalArrayPage, error) {
	fixed := make(canonicaljson.Object, len(envelope)+1)
	for k, v := range envelope {
		fixed[k] = v
	}
	fixed[field] = []any{}
	fixed["nextCursor"] = nil
	raw, err := canonicaljson.Encode(fixed)
	if err != nil {
		return nil, err
	}
	_, complete := fixed["complete"]
	if len(raw)+1 > limit {
		return nil, Failure(ErrorLimitExceeded, "recovery envelope exceeds its byte contract", nil)
	}
	return &CanonicalArrayPage{envelope: fixed, field: field, fixedBytes: len(raw) + 1, completeField: complete, limit: limit}, nil
}

func (page *CanonicalArrayPage) Add(record any, cursor string) (bool, error) {
	raw, err := canonicaljson.Encode(record)
	if err != nil {
		return false, err
	}
	encodedCursor, err := canonicaljson.Encode(cursor)
	if err != nil {
		return false, err
	}
	size := page.fixedBytes + page.recordBytes + len(raw)
	if len(page.records) > 0 {
		size++
	}
	if size > page.limit {
		if len(page.records) == 0 {
			return false, Failure(ErrorLimitExceeded, "one recovery record exceeds the response contract", nil)
		}
		return false, nil
	}
	if len(page.records) > 0 {
		page.recordBytes++
	}
	page.records = append(page.records, raw)
	page.recordBytes += len(raw)
	page.last = cursor
	page.sizes = append(page.sizes, page.recordBytes)
	page.cursors = append(page.cursors, cursor)
	continuationBytes := size + len(encodedCursor) - 4
	if page.completeField && page.envelope["complete"] == true {
		continuationBytes++
	}
	if continuationBytes <= page.limit {
		page.continuationCount = len(page.records)
	}
	return true, nil
}

// Count is the number delivered by Finish; a terminal-only tail is retained
// only when this is the last page. Removing a tail is one slice operation.
func (page *CanonicalArrayPage) Count() int { return len(page.records) }

func (page *CanonicalArrayPage) Finish(more bool) ([]byte, *string, error) {
	var next *string
	if more {
		if page.continuationCount == 0 {
			return nil, nil, Failure(ErrorLimitExceeded, "one recovery record and its cursor exceed the response contract", nil)
		}
		page.records = page.records[:page.continuationCount]
		page.recordBytes = page.sizes[page.continuationCount-1]
		page.last = page.cursors[page.continuationCount-1]
		value := page.last
		next = &value
		page.envelope["nextCursor"] = value
		if page.completeField {
			page.envelope["complete"] = false
		}
	}
	fixed, err := canonicaljson.Encode(page.envelope)
	if err != nil {
		return nil, nil, err
	}
	marker := []byte(`"` + page.field + `":[]`)
	offset := bytes.Index(fixed, marker)
	if offset < 0 {
		return nil, nil, errors.New("canonical page has no record array")
	}
	offset += len(marker) - 1 // insert between '[' and ']'
	result := make([]byte, 0, len(fixed)+page.recordBytes+1)
	result = append(result, fixed[:offset]...)
	for i, raw := range page.records {
		if i > 0 {
			result = append(result, ',')
		}
		result = append(result, raw...)
	}
	result = append(result, fixed[offset:]...)
	result = append(result, '\n')
	if len(result) > page.limit {
		return nil, nil, Failure(ErrorLimitExceeded, "recovery response exceeds its byte contract", nil)
	}
	return result, next, nil
}
