// Package runnerscheduler executes the default-off GS8-B Go/TypeScript child
// protocol. It owns runner scheduling controls only, never Workflow RunStore
// state, checkpoints, approvals, or budgets.
package runnerscheduler

import (
	"bufio"
	"errors"
	"fmt"
	"io"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerprotocol"
)

type frameReader struct{ reader *bufio.Reader }

func newFrameReader(source io.Reader) *frameReader {
	return &frameReader{reader: bufio.NewReaderSize(source, runnerprotocol.MaxEnvelopeBytes+1)}
}

func (reader *frameReader) Read() (runnerprotocol.Envelope, []byte, error) {
	line, err := reader.reader.ReadSlice('\n')
	if errors.Is(err, bufio.ErrBufferFull) {
		return runnerprotocol.Envelope{}, nil, fmt.Errorf("runner frame exceeds %d bytes", runnerprotocol.MaxEnvelopeBytes)
	}
	if err != nil {
		if errors.Is(err, io.EOF) && len(line) > 0 {
			return runnerprotocol.Envelope{}, nil, fmt.Errorf("runner stream ended with a partial frame")
		}
		return runnerprotocol.Envelope{}, nil, err
	}
	if len(line) > runnerprotocol.MaxEnvelopeBytes {
		return runnerprotocol.Envelope{}, nil, fmt.Errorf("runner frame exceeds %d bytes", runnerprotocol.MaxEnvelopeBytes)
	}
	message, err := runnerprotocol.ValidateCanonicalEnvelopeBytes(line)
	if err != nil {
		return runnerprotocol.Envelope{}, nil, err
	}
	return message, append([]byte(nil), line...), nil
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
