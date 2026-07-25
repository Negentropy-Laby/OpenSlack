package delivery

import (
	"errors"
	"net/http"
	"net/netip"
	"strings"
	"testing"
	"time"

	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/notificationstore"
	"github.com/Negentropy-Laby/OpenSlack/services/notification-delivery/internal/vendorregistry"
)

func TestClassifyClosedMatrix(t *testing.T) {
	cases := []struct {
		status int
		class  notificationstore.OutcomeClass
		reason string
	}{
		{200, notificationstore.OutcomeClassSuccess, ""},
		{299, notificationstore.OutcomeClassSuccess, ""},
		{408, notificationstore.OutcomeClassRetryableFailure, ""},
		{429, notificationstore.OutcomeClassRetryableFailure, ""},
		{503, notificationstore.OutcomeClassRetryableFailure, ""},
		{301, notificationstore.OutcomeClassPermanentFailure, ReasonNonRetryableHTTPStatus},
		{400, notificationstore.OutcomeClassPermanentFailure, ReasonNonRetryableHTTPStatus},
	}
	for _, tc := range cases {
		out := Classify(tc.status, nil, nil)
		if out.OutcomeClass != tc.class || out.Reason != tc.reason || out.HTTPStatus != tc.status {
			t.Fatalf("status %d: %+v", tc.status, out)
		}
	}
	out := Classify(0, NewTransportError(ErrorCodeDNSFailure), nil)
	if out.ResultKind != notificationstore.ResultKindTransportFailure || out.ErrorCode != ErrorCodeDNSFailure {
		t.Fatalf("transport classification: %+v", out)
	}
	out = Classify(0, NewPolicyError(ReasonDestinationRejected), nil)
	if out.ResultKind != notificationstore.ResultKindPolicyTermination || out.Reason != ReasonDestinationRejected {
		t.Fatalf("policy classification: %+v", out)
	}
	_ = errors.New("compile guard")
	_ = http.StatusOK
}

func TestApplyB01CutoffPreservesActualResult(t *testing.T) {
	cutoff := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	out := ApplyB01Cutoff(Outcome{
		ResultKind: notificationstore.ResultKindHTTPResponse, OutcomeClass: notificationstore.OutcomeClassRetryableFailure, HTTPStatus: 503,
	}, cutoff, cutoff)
	if out.ResultKind != notificationstore.ResultKindHTTPResponse || out.HTTPStatus != 503 || out.OutcomeClass != notificationstore.OutcomeClassPermanentFailure || out.Reason != ReasonDeadlineExceeded {
		t.Fatalf("B-01 outcome: %+v", out)
	}
}

func TestClassifyJSONAckV1ClosedMatrix(t *testing.T) {
	for _, code := range []string{"fatal_error", "internal_error", "ratelimited", "request_timeout", "service_unavailable"} {
		t.Run("retryable_"+code, func(t *testing.T) {
			hint := 30 * time.Second
			out := ClassifyResponse(vendorregistry.ResponsePolicyJSONAckV1, TransportResponse{
				StatusCode: http.StatusOK,
				AckBody:    []byte(`{"ok":false,"error":"` + code + `"}`),
			}, &hint)
			if out.ResultKind != notificationstore.ResultKindHTTPResponse || out.OutcomeClass != notificationstore.OutcomeClassRetryableFailure || out.ErrorCode != code || out.Reason != "" || out.RetryAfter == nil || *out.RetryAfter != hint {
				t.Fatalf("outcome=%+v", out)
			}
		})
	}

	success := ClassifyResponse(vendorregistry.ResponsePolicyJSONAckV1, TransportResponse{
		StatusCode: http.StatusOK,
		AckBody:    []byte(`{"ok":true,"error":{"arbitrary":"ignored"},"extra":[1,2,3]}`),
	}, nil)
	if success.OutcomeClass != notificationstore.OutcomeClassSuccess || success.ErrorCode != "" || success.Reason != "" {
		t.Fatalf("success outcome=%+v", success)
	}

	const sensitiveVendorCode = "workspace-secret-vendor-message"
	rejected := ClassifyResponse(vendorregistry.ResponsePolicyJSONAckV1, TransportResponse{
		StatusCode: http.StatusOK,
		AckBody:    []byte(`{"ok":false,"error":"` + sensitiveVendorCode + `"}`),
	}, nil)
	if rejected.OutcomeClass != notificationstore.OutcomeClassPermanentFailure || rejected.Reason != ReasonVendorRejected || rejected.ErrorCode != "" {
		t.Fatalf("rejected outcome=%+v", rejected)
	}
	if strings.Contains(rejected.Reason+rejected.ErrorCode, sensitiveVendorCode) {
		t.Fatal("raw vendor error escaped the classifier")
	}
}

func TestClassifyJSONAckV1MalformedAndOverflow(t *testing.T) {
	malformed := [][]byte{
		nil,
		[]byte(`[]`),
		[]byte(`{}`),
		[]byte(`{"ok":"true"}`),
		[]byte(`{"ok":false}`),
		[]byte(`{"ok":false,"error":1}`),
		[]byte(`{"ok":false,"error":""}`),
		[]byte(`{"ok":true,"ok":false}`),
		[]byte(`{"ok":true,"extra":1,"extra":2}`),
		[]byte(`{"ok":true} {"ok":true}`),
		[]byte(`{"ok":true} trailing`),
	}
	for i, body := range malformed {
		out := ClassifyResponse(vendorregistry.ResponsePolicyJSONAckV1, TransportResponse{StatusCode: http.StatusOK, AckBody: body}, nil)
		if out.OutcomeClass != notificationstore.OutcomeClassPermanentFailure || out.Reason != ReasonVendorProtocolError || out.ErrorCode != "" {
			t.Errorf("case %d outcome=%+v", i, out)
		}
	}
	overflow := ClassifyResponse(vendorregistry.ResponsePolicyJSONAckV1, TransportResponse{StatusCode: http.StatusOK, AckBodyOverflow: true}, nil)
	if overflow.Reason != ReasonVendorProtocolError || overflow.ErrorCode != "" {
		t.Fatalf("overflow outcome=%+v", overflow)
	}
}

func TestClassifyJSONAckV1Non2xxUsesHTTPStatusOnly(t *testing.T) {
	out := ClassifyResponse(vendorregistry.ResponsePolicyJSONAckV1, TransportResponse{
		StatusCode: http.StatusServiceUnavailable,
		AckBody:    []byte(`{"ok":true}`),
	}, nil)
	if out.OutcomeClass != notificationstore.OutcomeClassRetryableFailure || out.HTTPStatus != http.StatusServiceUnavailable || out.ErrorCode != "" {
		t.Fatalf("outcome=%+v", out)
	}
}

func TestApplyB01CutoffPreservesFrozenJSONAckCode(t *testing.T) {
	cutoff := time.Date(2026, 7, 22, 12, 0, 0, 0, time.UTC)
	out := ApplyB01Cutoff(Outcome{
		ResultKind: notificationstore.ResultKindHTTPResponse, OutcomeClass: notificationstore.OutcomeClassRetryableFailure,
		HTTPStatus: http.StatusOK, ErrorCode: "ratelimited",
	}, cutoff, cutoff)
	if out.OutcomeClass != notificationstore.OutcomeClassPermanentFailure || out.Reason != ReasonDeadlineExceeded || out.ErrorCode != "ratelimited" {
		t.Fatalf("B-01 outcome=%+v", out)
	}
}

func TestIsPublicRejectsSpecialPurposeRanges(t *testing.T) {
	for _, raw := range []string{
		"0.0.0.1", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254",
		"192.0.2.1", "192.168.1.1", "198.18.0.1", "198.51.100.1", "203.0.113.1",
		"224.0.0.1", "240.0.0.1", "::1", "::ffff:8.8.8.8", "2001:db8::1", "fc00::1", "fe80::1",
	} {
		if IsPublic(netip.MustParseAddr(raw)) {
			t.Errorf("%s must be rejected", raw)
		}
	}
	for _, raw := range []string{"8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"} {
		if !IsPublic(netip.MustParseAddr(raw)) {
			t.Errorf("%s must be public", raw)
		}
	}
}

func TestParseRetryAfterAndConfigBounds(t *testing.T) {
	now := time.Date(2026, 7, 22, 0, 0, 0, 0, time.UTC)
	if d := ParseRetryAfter("12", now); d == nil || *d != 12*time.Second {
		t.Fatalf("delta retry-after: %v", d)
	}
	if d := ParseRetryAfter(now.Add(time.Minute).Format(http.TimeFormat), now); d == nil || *d != time.Minute {
		t.Fatalf("date retry-after: %v", d)
	}
	if ParseRetryAfter("invalid", now) != nil {
		t.Fatal("invalid retry-after accepted")
	}
	if ParseRetryAfter("18446744074", now) != nil {
		t.Fatal("overflowing retry-after accepted")
	}
	if err := DefaultConfig().Validate(); err != nil {
		t.Fatalf("default config: %v", err)
	}
	cfg := DefaultConfig()
	cfg.LeaseTTL = cfg.HTTPHardTimeout
	if err := cfg.Validate(); err == nil {
		t.Fatal("short lease accepted")
	}
}

func TestRetryableHTTPStatusesPreserveRetryAfter(t *testing.T) {
	hint := 90 * time.Second
	for _, status := range []int{http.StatusRequestTimeout, http.StatusTooManyRequests, http.StatusInternalServerError, http.StatusServiceUnavailable, 599} {
		out := Classify(status, nil, &hint)
		if out.OutcomeClass != notificationstore.OutcomeClassRetryableFailure || out.RetryAfter == nil || *out.RetryAfter != hint {
			t.Errorf("status %d outcome=%+v", status, out)
		}
	}
	for _, status := range []int{http.StatusNoContent, http.StatusBadRequest, http.StatusFound} {
		if out := Classify(status, nil, &hint); out.RetryAfter != nil {
			t.Errorf("non-retryable status %d retained Retry-After: %+v", status, out)
		}
	}
}
