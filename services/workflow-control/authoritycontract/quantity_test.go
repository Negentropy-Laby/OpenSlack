package authoritycontract

import (
	"errors"
	"math"
	"testing"
)

func TestCanonicalQuantityBoundary(t *testing.T) {
	for _, value := range []string{"0", "1", "9007199254740991", "9223372036854775807"} {
		quantity, err := ParseQuantity(value)
		if err != nil || string(quantity) != value {
			t.Fatalf("ParseQuantity(%q) = %q, %v", value, quantity, err)
		}
	}
	for _, value := range []string{"", "00", "01", "+1", "-1", "1.0", "1e3", "9223372036854775808"} {
		if _, err := ParseQuantity(value); !errors.Is(err, ErrInvalidQuantity) {
			t.Fatalf("ParseQuantity(%q) error = %v", value, err)
		}
	}
	if _, err := AddQuantities(Quantity("9223372036854775807"), Quantity("1")); !errors.Is(err, ErrInvalidQuantity) {
		t.Fatalf("overflow error = %v", err)
	}
	if _, err := SubtractQuantities(Quantity("0"), Quantity("1")); !errors.Is(err, ErrInvalidQuantity) {
		t.Fatalf("underflow error = %v", err)
	}
	maximum, err := QuantityFromInt64(math.MaxInt64)
	if err != nil || maximum != Quantity("9223372036854775807") {
		t.Fatalf("max quantity = %q, %v", maximum, err)
	}
}

func TestNanoUSDRoundingUsesDecimalHalfUp(t *testing.T) {
	tests := []struct {
		usd  string
		want Quantity
	}{
		{usd: "0", want: "0"},
		{usd: "1", want: "1000000000"},
		{usd: "1.2", want: "1200000000"},
		{usd: "0.0000000004", want: "0"},
		{usd: "0.0000000005", want: "1"},
		{usd: "1.234567894", want: "1234567894"},
		{usd: "1.234567895", want: "1234567895"},
		{usd: "9223372036.854775807", want: "9223372036854775807"},
	}
	for _, testCase := range tests {
		t.Run(testCase.usd, func(t *testing.T) {
			got, err := CostNanoUSD(testCase.usd)
			if err != nil || got != testCase.want {
				t.Fatalf("CostNanoUSD(%q) = %q, %v; want %q", testCase.usd, got, err, testCase.want)
			}
		})
	}
	for _, value := range []string{"", ".1", "01", "+1", "-1", "1e3", "9223372036.8547758075"} {
		if _, err := CostNanoUSD(value); !errors.Is(err, ErrInvalidQuantity) {
			t.Fatalf("CostNanoUSD(%q) error = %v", value, err)
		}
	}
	if CostUnit != "nano_usd" || CostScale != 9 || RoundingMode != "half_up_nonnegative" {
		t.Fatalf("cost contract drift: unit=%q scale=%d rounding=%q", CostUnit, CostScale, RoundingMode)
	}
}
