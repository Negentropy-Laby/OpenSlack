//go:build linux

package main

import (
	"bufio"
	"context"
	"errors"
	"io"
	"net"
	"net/http"
	"reflect"
	"testing"
	"time"
)

func TestHTTPBudgetCoversWholeAdmissionWithoutChangingReadLimits(t *testing.T) {
	s := newHTTPServer(http.NotFoundHandler(), nil)
	if s.WriteTimeout != 75*time.Second || s.ReadTimeout != 10*time.Second || s.ReadHeaderTimeout != 5*time.Second || s.IdleTimeout != 10*time.Second || s.MaxHeaderBytes != 8192 {
		t.Fatalf("incorrect bounded HTTP budgets: %+v", s)
	}
}

type deadlineConn struct {
	net.Conn
	writes chan time.Time
}

func (c *deadlineConn) SetWriteDeadline(d time.Time) error {
	if !d.IsZero() {
		select {
		case c.writes <- d:
		default:
		}
	}
	return c.Conn.SetWriteDeadline(d)
}

type singleListener struct {
	conn     net.Conn
	accepted bool
	closed   chan struct{}
}

func (l *singleListener) Accept() (net.Conn, error) {
	if !l.accepted {
		l.accepted = true
		return l.conn, nil
	}
	<-l.closed
	return nil, net.ErrClosed
}
func (l *singleListener) Close() error {
	select {
	case <-l.closed:
	default:
		close(l.closed)
	}
	return nil
}
func (l *singleListener) Addr() net.Addr { return l.conn.LocalAddr() }

// Observe net/http applying the factory's deadline to a real connection. The
// old 15-second configuration fails the handler's deadline assertion; no long sleep
// or production timeout override is necessary to detect the regression.
func TestHTTPServerActuallyAppliesFullWriteBudget(t *testing.T) {
	serverConn, clientConn := net.Pipe()
	defer clientConn.Close()
	deadlines := make(chan time.Time, 4)
	l := &singleListener{conn: &deadlineConn{serverConn, deadlines}, closed: make(chan struct{})}
	h := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case d := <-deadlines:
			if remaining := time.Until(d); remaining < 70*time.Second || remaining > 75*time.Second {
				t.Errorf("response deadline cannot cover admission: %v", remaining)
			}
		case <-time.After(time.Second):
			t.Error("write deadline not applied")
		}
		w.WriteHeader(http.StatusAccepted)
		w.Write([]byte("accepted"))
	})
	s := newHTTPServer(h, nil)
	done := make(chan struct{})
	go func() { defer close(done); s.Serve(l) }()
	defer func() { s.Close(); <-done }()
	clientConn.SetDeadline(time.Now().Add(3 * time.Second))
	if _, err := io.WriteString(clientConn, "POST / HTTP/1.1\r\nHost: broker\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"); err != nil {
		t.Fatal(err)
	}
	res, err := http.ReadResponse(bufio.NewReader(clientConn), nil)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusAccepted {
		t.Fatal("response lost")
	}
}

type fakeServer struct {
	events *[]string
	fail   bool
}

func (s fakeServer) Shutdown(context.Context) error {
	*s.events = append(*s.events, "http-shutdown")
	if s.fail {
		return errors.New("timeout")
	}
	return nil
}
func (s fakeServer) Close() error { *s.events = append(*s.events, "http-close"); return nil }

type fakeHandler struct {
	events *[]string
	drains int
}

func (h *fakeHandler) StopAdmission() { *h.events = append(*h.events, "stop") }
func (h *fakeHandler) Drain(context.Context) error {
	*h.events = append(*h.events, "receipt-drain")
	h.drains++
	if h.drains == 1 {
		return errors.New("pending receipt")
	}
	return nil
}

type fakeWorker struct {
	events *[]string
	closes int
}

func (w *fakeWorker) Close() error {
	*w.events = append(*w.events, "worker-close")
	w.closes++
	if w.closes == 1 {
		return errors.New("group still present")
	}
	return nil
}

func TestShutdownKeepsLockUntilGroupAndReceiptDrained(t *testing.T) {
	events := []string{}
	h := &fakeHandler{events: &events}
	w := &fakeWorker{events: &events}
	shutdown(fakeServer{&events, true}, h, w, time.Second, func() { events = append(events, "lock-held-retry") })
	// In production runtime.Close is the next deferred call, not part of shutdown.
	events = append(events, "unlock")
	want := []string{"stop", "http-shutdown", "http-close", "worker-close", "lock-held-retry", "worker-close", "receipt-drain", "lock-held-retry", "receipt-drain", "unlock"}
	if !reflect.DeepEqual(events, want) {
		t.Fatalf("unsafe shutdown order: %v", events)
	}
}
func TestStatusOnlyShutdownDrainsWithoutWorker(t *testing.T) {
	events := []string{}
	h := &fakeHandler{events: &events, drains: 1}
	shutdown(fakeServer{events: &events}, h, nil, time.Second, func() { t.Fatal("unexpected retry") })
	if !reflect.DeepEqual(events, []string{"stop", "http-shutdown", "receipt-drain"}) {
		t.Fatal(events)
	}
}
