package delivery

import (
	"bufio"
	"context"
	"crypto/tls"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"rc_wsman/internal/vendorregistry"
)

func TestAddressPolicyRejectsMixedAndMappedAnswers(t *testing.T) {
	p, err := NewAddressPolicy(map[int]struct{}{443: {}}, DefaultConfig().DefaultForbiddenCIDRs)
	if err != nil {
		t.Fatal(err)
	}
	for _, addrs := range [][]netip.Addr{
		{netip.MustParseAddr("8.8.8.8"), netip.MustParseAddr("127.0.0.1")},
		{netip.MustParseAddr("::ffff:8.8.8.8")},
		{netip.MustParseAddr("3fff::1")},
		{netip.MustParseAddr("5f00::1")},
	} {
		if _, err := p.Evaluate("vendor.example", 443, addrs, nil); err == nil {
			t.Fatalf("accepted %+v", addrs)
		}
	}
	if got, err := p.Evaluate("vendor.example", 443, []netip.Addr{netip.MustParseAddr("8.8.8.8")}, nil); err != nil || got.String() != "8.8.8.8" {
		t.Fatalf("public answer: %v %v", got, err)
	}
}

func TestSafeTransportClassifiesCertificateFailureAsTLSFailure(t *testing.T) {
	server := httptest.NewTLSServer(http.HandlerFunc(func(http.ResponseWriter, *http.Request) {}))
	defer server.Close()
	dialer := &net.Dialer{}
	transport := NewSafeTransportWithDialer(func(ctx context.Context, network, _ string) (net.Conn, error) {
		return dialer.DialContext(ctx, network, server.Listener.Addr().String())
	})
	req, _ := http.NewRequest(http.MethodGet, "https://vendor.example/", nil)
	_, err := transport.Do(context.Background(), req, netip.MustParseAddr("8.8.8.8"), time.Second, vendorregistry.ResponsePolicyHTTPStatusV1)
	if !IsTransportError(err, ErrorCodeTLSFailure) {
		t.Fatalf("certificate failure=%v, want %s", err, ErrorCodeTLSFailure)
	}
}

func TestAddressPolicyPrivateExceptionIsTupleBoundAndNeverAllowsSpecialRanges(t *testing.T) {
	p, err := NewAddressPolicy(map[int]struct{}{443: {}}, DefaultConfig().DefaultForbiddenCIDRs)
	if err != nil {
		t.Fatal(err)
	}
	_, privateNet, _ := net.ParseCIDR("10.20.0.0/16")
	exception := &CIDRException{Hostname: "internal.example", Port: 443, Net: privateNet}
	if got, err := p.Evaluate("internal.example", 443, []netip.Addr{netip.MustParseAddr("10.20.1.2")}, exception); err != nil || got.String() != "10.20.1.2" {
		t.Fatalf("private exception: got=%v err=%v", got, err)
	}
	for name, candidate := range map[string]struct {
		host string
		port int
		addr string
		net  string
	}{
		"hostname mismatch": {"other.example", 443, "10.20.1.2", "10.20.0.0/16"},
		"port mismatch":     {"internal.example", 8443, "10.20.1.2", "10.20.0.0/16"},
		"outside cidr":      {"internal.example", 443, "10.21.1.2", "10.20.0.0/16"},
		"loopback":          {"internal.example", 443, "127.0.0.1", "127.0.0.0/8"},
		"cgnat":             {"internal.example", 443, "100.64.0.1", "100.64.0.0/10"},
		"public":            {"internal.example", 443, "8.8.8.8", "8.8.8.0/24"},
	} {
		t.Run(name, func(t *testing.T) {
			_, cidr, _ := net.ParseCIDR(candidate.net)
			exc := &CIDRException{Hostname: "internal.example", Port: 443, Net: cidr}
			if _, err := p.Evaluate(candidate.host, candidate.port, []netip.Addr{netip.MustParseAddr(candidate.addr)}, exc); err == nil {
				t.Fatal("unsafe private exception accepted")
			}
		})
	}
}

func TestSafeTransportDoesNotReadResponseBody(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	st := NewSafeTransportWithDialer(func(context.Context, string, string) (net.Conn, error) {
		return client, nil
	})
	st.base.DialTLSContext = func(context.Context, string, string) (net.Conn, error) { return client, nil }
	go func() {
		defer server.Close()
		br := bufio.NewReader(server)
		for {
			line, err := br.ReadString('\n')
			if err != nil {
				return
			}
			if line == "\r\n" {
				break
			}
		}
		_, _ = fmt.Fprint(server, "HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\n\r\nx")
		<-time.After(2 * time.Second)
	}()
	req, _ := http.NewRequest(http.MethodPost, "https://vendor.example/hook", strings.NewReader("{}"))
	start := time.Now()
	resp, err := st.Do(context.Background(), req, netip.MustParseAddr("8.8.8.8"), time.Second, vendorregistry.ResponsePolicyHTTPStatusV1)
	if err != nil || resp.StatusCode != 200 {
		t.Fatalf("response: %v %v", resp, err)
	}
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Fatalf("response body was read; elapsed %s", elapsed)
	}
}

func TestSafeTransportJSONAckBodyBoundaries(t *testing.T) {
	for _, tc := range []struct {
		name       string
		size       int
		overflow   bool
		storedSize int
	}{
		{name: "limit", size: maxJSONAckBodyBytes, storedSize: maxJSONAckBodyBytes},
		{name: "limit_plus_one", size: maxJSONAckBodyBytes + 1, overflow: true, storedSize: maxJSONAckBodyBytes},
	} {
		t.Run(tc.name, func(t *testing.T) {
			client, server := net.Pipe()
			defer client.Close()
			st := NewSafeTransportWithDialer(func(context.Context, string, string) (net.Conn, error) { return client, nil })
			go func() {
				defer server.Close()
				br := bufio.NewReader(server)
				for {
					line, err := br.ReadString('\n')
					if err != nil {
						return
					}
					if line == "\r\n" {
						break
					}
				}
				_, _ = fmt.Fprintf(server, "HTTP/1.1 200 OK\r\nContent-Length: %d\r\n\r\n", tc.size)
				_, _ = fmt.Fprint(server, strings.Repeat("x", tc.size))
			}()
			req, _ := http.NewRequest(http.MethodPost, "http://vendor.example/hook", strings.NewReader("{}"))
			resp, err := st.Do(context.Background(), req, netip.MustParseAddr("8.8.8.8"), time.Second, vendorregistry.ResponsePolicyJSONAckV1)
			if err != nil {
				t.Fatal(err)
			}
			if resp.AckBodyOverflow != tc.overflow || len(resp.AckBody) != tc.storedSize {
				t.Fatalf("response=%+v body_len=%d", resp, len(resp.AckBody))
			}
		})
	}
}

func TestSafeTransportJSONAckReadFailureIsRetryableTransportError(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	st := NewSafeTransportWithDialer(func(context.Context, string, string) (net.Conn, error) { return client, nil })
	go func() {
		defer server.Close()
		br := bufio.NewReader(server)
		for {
			line, err := br.ReadString('\n')
			if err != nil {
				return
			}
			if line == "\r\n" {
				break
			}
		}
		_, _ = fmt.Fprint(server, "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nx")
	}()
	req, _ := http.NewRequest(http.MethodPost, "http://vendor.example/hook", strings.NewReader("{}"))
	_, err := st.Do(context.Background(), req, netip.MustParseAddr("8.8.8.8"), time.Second, vendorregistry.ResponsePolicyJSONAckV1)
	if !IsTransportError(err, ErrorCodeConnectionFailure) {
		t.Fatalf("read failure=%v, want %s", err, ErrorCodeConnectionFailure)
	}
}

func TestSafeTransportJSONAckReadTimeoutIsRetryableTimeout(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	st := NewSafeTransportWithDialer(func(context.Context, string, string) (net.Conn, error) { return client, nil })
	go func() {
		br := bufio.NewReader(server)
		for {
			line, err := br.ReadString('\n')
			if err != nil {
				return
			}
			if line == "\r\n" {
				break
			}
		}
		_, _ = fmt.Fprint(server, "HTTP/1.1 200 OK\r\nContent-Length: 10\r\n\r\nx")
	}()
	req, _ := http.NewRequest(http.MethodPost, "http://vendor.example/hook", strings.NewReader("{}"))
	_, err := st.Do(context.Background(), req, netip.MustParseAddr("8.8.8.8"), 20*time.Millisecond, vendorregistry.ResponsePolicyJSONAckV1)
	if !IsTransportError(err, ErrorCodeTimeout) {
		t.Fatalf("read timeout=%v, want %s", err, ErrorCodeTimeout)
	}
}

func TestSafeTransportJSONAckDoesNotReadNon2xxBody(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	st := NewSafeTransportWithDialer(func(context.Context, string, string) (net.Conn, error) { return client, nil })
	go func() {
		defer server.Close()
		br := bufio.NewReader(server)
		for {
			line, err := br.ReadString('\n')
			if err != nil {
				return
			}
			if line == "\r\n" {
				break
			}
		}
		_, _ = fmt.Fprint(server, "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 1000000\r\n\r\nx")
		<-time.After(2 * time.Second)
	}()
	req, _ := http.NewRequest(http.MethodPost, "http://vendor.example/hook", strings.NewReader("{}"))
	start := time.Now()
	resp, err := st.Do(context.Background(), req, netip.MustParseAddr("8.8.8.8"), time.Second, vendorregistry.ResponsePolicyJSONAckV1)
	if err != nil || resp.StatusCode != http.StatusServiceUnavailable || len(resp.AckBody) != 0 {
		t.Fatalf("response=%+v err=%v", resp, err)
	}
	if elapsed := time.Since(start); elapsed > 500*time.Millisecond {
		t.Fatalf("non-2xx body was read; elapsed %s", elapsed)
	}
}

func TestSafeTransportDoesNotFollowRedirect(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	var dialCalls atomic.Int32
	st := NewSafeTransportWithDialer(func(context.Context, string, string) (net.Conn, error) {
		dialCalls.Add(1)
		return client, nil
	})
	go func() {
		defer server.Close()
		br := bufio.NewReader(server)
		for {
			line, err := br.ReadString('\n')
			if err != nil {
				return
			}
			if line == "\r\n" {
				break
			}
		}
		_, _ = fmt.Fprint(server, "HTTP/1.1 302 Found\r\nLocation: http://redirect.example/private\r\nContent-Length: 0\r\n\r\n")
	}()
	req, _ := http.NewRequest(http.MethodPost, "http://vendor.example/hook", strings.NewReader("{}"))
	resp, err := st.Do(context.Background(), req, netip.MustParseAddr("8.8.8.8"), time.Second, vendorregistry.ResponsePolicyHTTPStatusV1)
	if err != nil {
		t.Fatalf("redirect response: %v", err)
	}
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("status = %d", resp.StatusCode)
	}
	if got := dialCalls.Load(); got != 1 {
		t.Fatalf("redirect caused %d network requests, want 1", got)
	}
}

func TestSafeTransportIgnoresProxyEnvironment(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	t.Setenv("HTTPS_PROXY", "http://127.0.0.1:1")
	client, server := net.Pipe()
	defer client.Close()
	dialed := make(chan string, 1)
	st := NewSafeTransportWithDialer(func(_ context.Context, _ string, address string) (net.Conn, error) {
		dialed <- address
		return client, nil
	})
	go func() {
		defer server.Close()
		br := bufio.NewReader(server)
		for {
			line, err := br.ReadString('\n')
			if err != nil {
				return
			}
			if line == "\r\n" {
				break
			}
		}
		_, _ = fmt.Fprint(server, "HTTP/1.1 204 No Content\r\nContent-Length: 0\r\n\r\n")
	}()
	req, _ := http.NewRequest(http.MethodPost, "http://vendor.example/hook", strings.NewReader("{}"))
	resp, err := st.Do(context.Background(), req, netip.MustParseAddr("8.8.8.8"), time.Second, vendorregistry.ResponsePolicyHTTPStatusV1)
	if err != nil || resp.StatusCode != http.StatusNoContent {
		t.Fatalf("request through proxy-disabled transport: response=%v err=%v", resp, err)
	}
	select {
	case got := <-dialed:
		if got != "8.8.8.8:80" {
			t.Fatalf("dialed %q, want pinned target; proxy environment must be ignored", got)
		}
	default:
		t.Fatal("transport did not use injected pinned-IP dialer")
	}
}

func TestSafeTransportTimeoutIsClosedTransportFailure(t *testing.T) {
	client, server := net.Pipe()
	defer client.Close()
	defer server.Close()
	st := NewSafeTransportWithDialer(func(context.Context, string, string) (net.Conn, error) {
		return client, nil
	})
	req, _ := http.NewRequest(http.MethodPost, "http://vendor.example/hook", strings.NewReader("{}"))
	_, err := st.Do(context.Background(), req, netip.MustParseAddr("8.8.8.8"), 20*time.Millisecond, vendorregistry.ResponsePolicyHTTPStatusV1)
	if !IsTransportError(err, ErrorCodeTimeout) {
		t.Fatalf("timeout = %v, want %s", err, ErrorCodeTimeout)
	}
}

func TestSafeTransportPreservesTLSHostname(t *testing.T) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer listener.Close()
	serverName := make(chan string, 1)
	serverTLS := &tls.Config{
		MinVersion:         tls.VersionTLS12,
		GetConfigForClient: func(hello *tls.ClientHelloInfo) (*tls.Config, error) { serverName <- hello.ServerName; return nil, nil },
	}
	// We only need the ClientHello to prove SNI; the server then closes and the
	// request may fail its handshake.
	go func() {
		c, err := listener.Accept()
		if err == nil {
			tc := tls.Server(c, serverTLS)
			_ = tc.Handshake()
			_ = c.Close()
		}
	}()
	dialer := &net.Dialer{}
	st := newSafeTransport(func(ctx context.Context, network, _ string) (net.Conn, error) {
		return dialer.DialContext(ctx, network, listener.Addr().String())
	}, &tls.Config{MinVersion: tls.VersionTLS12, InsecureSkipVerify: true}) // test-only
	req, _ := http.NewRequest(http.MethodGet, "https://vendor.example/", nil)
	_, _ = st.Do(context.Background(), req, netip.MustParseAddr("8.8.8.8"), time.Second, vendorregistry.ResponsePolicyHTTPStatusV1)
	select {
	case got := <-serverName:
		if got != "vendor.example" {
			t.Fatalf("SNI = %q", got)
		}
	case <-time.After(time.Second):
		t.Fatal("no ClientHello observed")
	}
}
