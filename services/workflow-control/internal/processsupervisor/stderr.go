package processsupervisor

import "sync"

// StderrSnapshot is bounded diagnostic data. It is never protocol data or
// workflow evidence.
type StderrSnapshot struct {
	Bytes     []byte
	Truncated bool
	Total     uint64
}

type boundedStderr struct {
	mu     sync.Mutex
	buffer []byte
	next   int
	full   bool
	total  uint64
}

func newBoundedStderr(limit int) *boundedStderr {
	return &boundedStderr{buffer: make([]byte, 0, limit)}
}

func (buffer *boundedStderr) Write(value []byte) (int, error) {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	buffer.total += uint64(len(value))
	if cap(buffer.buffer) == 0 {
		return len(value), nil
	}
	for _, current := range value {
		if len(buffer.buffer) < cap(buffer.buffer) {
			buffer.buffer = append(buffer.buffer, current)
			continue
		}
		buffer.buffer[buffer.next] = current
		buffer.next = (buffer.next + 1) % len(buffer.buffer)
		buffer.full = true
	}
	return len(value), nil
}

func (buffer *boundedStderr) Snapshot() StderrSnapshot {
	buffer.mu.Lock()
	defer buffer.mu.Unlock()
	result := make([]byte, len(buffer.buffer))
	if buffer.full {
		copied := copy(result, buffer.buffer[buffer.next:])
		copy(result[copied:], buffer.buffer[:buffer.next])
	} else {
		copy(result, buffer.buffer)
	}
	return StderrSnapshot{
		Bytes: result, Truncated: buffer.total > uint64(len(buffer.buffer)), Total: buffer.total,
	}
}
