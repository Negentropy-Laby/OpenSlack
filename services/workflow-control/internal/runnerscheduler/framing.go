// Package runnerscheduler executes the default-off GS8-B Go/TypeScript child
// protocol. It owns runner scheduling controls only, never Workflow RunStore
// state, checkpoints, approvals, or budgets.
package runnerscheduler

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerprotocol"
)

type protocolDecodedFrame[T any] struct {
	message T
	exact   []byte
	err     error
}

type protocolFrameReader[T any] struct {
	reader *bufio.Reader
	max    int
	label  string
	decode func([]byte) (T, error)
}

func newProtocolFrameReader[T any](source io.Reader, max int, label string, decode func([]byte) (T, error)) *protocolFrameReader[T] {
	return &protocolFrameReader[T]{reader: bufio.NewReaderSize(source, max+1), max: max, label: label, decode: decode}
}

func (reader *protocolFrameReader[T]) Read() (T, []byte, error) {
	var zero T
	line, err := reader.reader.ReadSlice('\n')
	if errors.Is(err, bufio.ErrBufferFull) {
		return zero, nil, fmt.Errorf("%s frame exceeds %d bytes", reader.label, reader.max)
	}
	if err != nil {
		if errors.Is(err, io.EOF) && len(line) > 0 {
			return zero, nil, fmt.Errorf("%s stream ended with a partial frame", reader.label)
		}
		return zero, nil, err
	}
	if len(line) > reader.max {
		return zero, nil, fmt.Errorf("%s frame exceeds %d bytes", reader.label, reader.max)
	}
	message, err := reader.decode(line)
	if err != nil {
		return zero, nil, err
	}
	return message, append([]byte(nil), line...), nil
}

func decodeProtocolFrames[T any](ctx context.Context, reader *protocolFrameReader[T], destination chan<- protocolDecodedFrame[T]) {
	defer close(destination)
	for {
		message, exact, err := reader.Read()
		select {
		case destination <- protocolDecodedFrame[T]{message: message, exact: exact, err: err}:
		case <-ctx.Done():
			return
		}
		if err != nil {
			return
		}
	}
}

func newFrameReader(source io.Reader) *protocolFrameReader[runnerprotocol.Envelope] {
	return newProtocolFrameReader(source, runnerprotocol.MaxEnvelopeBytes, "runner", runnerprotocol.ValidateCanonicalEnvelopeBytes)
}

func writeFrame(destination io.Writer, body []byte) error {
	if len(body) == 0 || len(body) > runnerprotocol.MaxEnvelopeBytes {
		return fmt.Errorf("control frame size is invalid")
	}
	written := 0
	for written < len(body) {
		n, err := destination.Write(body[written:])
		written += n
		if err != nil {
			return err
		}
		if n == 0 {
			return io.ErrShortWrite
		}
	}
	return nil
}
