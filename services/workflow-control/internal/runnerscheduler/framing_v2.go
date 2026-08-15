package runnerscheduler

import (
	"bufio"
	"errors"
	"fmt"
	"io"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/authoritycontract"
)

type v2FrameReader struct{ reader *bufio.Reader }

func newV2FrameReader(source io.Reader) *v2FrameReader {
	return &v2FrameReader{reader: bufio.NewReaderSize(source, authoritycontract.MaxMessageBytes+1)}
}

func (reader *v2FrameReader) Read() (authoritycontract.Message, []byte, error) {
	line, err := reader.reader.ReadSlice('\n')
	if errors.Is(err, bufio.ErrBufferFull) {
		return authoritycontract.Message{}, nil, fmt.Errorf("runner v2 frame exceeds %d bytes", authoritycontract.MaxMessageBytes)
	}
	if err != nil {
		if errors.Is(err, io.EOF) && len(line) > 0 {
			return authoritycontract.Message{}, nil, fmt.Errorf("runner v2 stream ended with a partial frame")
		}
		return authoritycontract.Message{}, nil, err
	}
	message, err := authoritycontract.DecodeMessageJSON(line)
	if err != nil {
		return authoritycontract.Message{}, nil, err
	}
	return message, append([]byte(nil), line...), nil
}
