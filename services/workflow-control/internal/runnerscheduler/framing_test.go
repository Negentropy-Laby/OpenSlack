package runnerscheduler

import (
	"bytes"
	"context"
	"io"
	"strings"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/runnerprotocol"
)

func TestRuntimeFrameReaderAcceptsOnlyExactCanonicalJSONL(t *testing.T) {
	message := testHello()
	body, err := runnerprotocol.CanonicalEnvelopeBytes(message)
	if err != nil {
		t.Fatal(err)
	}
	reader := newFrameReader(bytes.NewReader(body))
	decoded, exact, err := reader.Read()
	if err != nil {
		t.Fatal(err)
	}
	if decoded.EventID != message.EventID || !bytes.Equal(exact, body) {
		t.Fatal("canonical runner frame changed")
	}
	for name, value := range map[string][]byte{
		"bom":      append([]byte{0xef, 0xbb, 0xbf}, body...),
		"crlf":     append(append([]byte(nil), body[:len(body)-1]...), []byte("\r\n")...),
		"blank":    []byte("\n"),
		"partial":  body[:len(body)-1],
		"oversize": append(bytes.Repeat([]byte("x"), runnerprotocol.MaxEnvelopeBytes), byte('\n')),
	} {
		t.Run(name, func(t *testing.T) {
			if _, _, err := newFrameReader(bytes.NewReader(value)).Read(); err == nil {
				t.Fatal("invalid frame was accepted")
			}
		})
	}
}

func TestProtocolDecodePumpStopsWhenItsSessionIsCancelled(t *testing.T) {
	message := testHello()
	body, err := runnerprotocol.CanonicalEnvelopeBytes(message)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	destination := make(chan protocolDecodedFrame[runnerprotocol.Envelope])
	done := make(chan struct{})
	go func() {
		decodeProtocolFrames(ctx, newFrameReader(bytes.NewReader(body)), destination)
		close(done)
	}()
	cancel()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("cancelled protocol decoder remained blocked on frame delivery")
	}
}

func TestRuntimeFrameReaderPreservesFragmentedAndMultipleFrames(t *testing.T) {
	message := testHello()
	body, err := runnerprotocol.CanonicalEnvelopeBytes(message)
	if err != nil {
		t.Fatal(err)
	}
	source := &fragmentReader{body: append(append([]byte(nil), body...), body...), step: 3}
	reader := newFrameReader(source)
	for index := 0; index < 2; index++ {
		decoded, exact, err := reader.Read()
		if err != nil {
			t.Fatal(err)
		}
		if decoded.EventID != message.EventID || !bytes.Equal(exact, body) {
			t.Fatalf("frame %d drift", index)
		}
	}
}

type fragmentReader struct {
	body []byte
	step int
}

func (reader *fragmentReader) Read(destination []byte) (int, error) {
	if len(reader.body) == 0 {
		return 0, io.EOF
	}
	size := reader.step
	if size > len(reader.body) {
		size = len(reader.body)
	}
	if size > len(destination) {
		size = len(destination)
	}
	copy(destination, reader.body[:size])
	reader.body = reader.body[size:]
	return size, nil
}

func testHello() runnerprotocol.Envelope {
	return runnerprotocol.Envelope{ProtocolVersion: runnerprotocol.ProtocolVersion, Kind: runnerprotocol.KindHello, WorkspaceID: "workspace-1", JobID: nil, WorkflowRunID: nil, AttemptID: nil, LeaseID: nil, FencingToken: nil, Sequence: nil, EventID: "hello-1", CorrelationID: "correlation-1", SentAt: "2026-08-04T00:00:00.000Z", Payload: map[string]any{"runtimeName": "node", "runtimeVersion": "22.0.0", "runnerBuildHash": strings.Repeat("a", 64), "supportedProtocolVersions": []any{runnerprotocol.ProtocolVersion}, "capabilities": []any{"cancel_ack", "effect_receipts", "lease_heartbeat"}, "maxConcurrentJobs": int64(1)}}
}
