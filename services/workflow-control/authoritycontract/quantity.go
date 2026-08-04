package authoritycontract

import (
	"errors"
	"fmt"
	"math"
	"math/big"
	"regexp"
	"strconv"
	"strings"
)

const (
	CostUnit     = "nano_usd"
	CostScale    = 9
	RoundingMode = "half_up_nonnegative"
)

var (
	ErrInvalidQuantity = errors.New("invalid canonical authority quantity")
	quantityPattern    = regexp.MustCompile(`^(?:0|[1-9][0-9]*)$`)
	decimalUSDPattern  = regexp.MustCompile(`^(0|[1-9][0-9]*)(?:\.([0-9]+))?$`)
	tenToNine          = big.NewInt(1_000_000_000)
	maxInt64Big        = big.NewInt(math.MaxInt64)
)

// Quantity is the canonical non-negative int64 decimal representation used
// for durable token, call, reservation, and nano-USD values. JSON numbers and
// binary floating point are deliberately not accepted at this boundary.
type Quantity string

// ValidateDecimal mirrors the TypeScript v2 decimal contract and preserves
// its stable error code/path surface for golden-vector replay.
func ValidateDecimal(value any, path ...string) (Quantity, error) {
	location := "$"
	if len(path) > 0 {
		location = path[0]
	}
	text, ok := value.(string)
	if !ok || !quantityPattern.MatchString(text) {
		return "", failure(ErrorInvalidDecimal, location, location+" must be a canonical non-negative decimal integer string.")
	}
	result, err := ParseQuantity(text)
	if err != nil {
		return "", failure(ErrorDecimalOverflow, location, location+" exceeds signed 64-bit BIGINT.")
	}
	return result, nil
}

func ParseQuantity(value string) (Quantity, error) {
	if !quantityPattern.MatchString(value) {
		return "", fmt.Errorf("%w: %q is not canonical", ErrInvalidQuantity, value)
	}
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil || parsed < 0 {
		return "", fmt.Errorf("%w: %q exceeds int64", ErrInvalidQuantity, value)
	}
	return Quantity(value), nil
}

func (value Quantity) Int64() (int64, error) {
	validated, err := ParseQuantity(string(value))
	if err != nil {
		return 0, err
	}
	return strconv.ParseInt(string(validated), 10, 64)
}

func QuantityFromInt64(value int64) (Quantity, error) {
	if value < 0 {
		return "", fmt.Errorf("%w: quantity cannot be negative", ErrInvalidQuantity)
	}
	return Quantity(strconv.FormatInt(value, 10)), nil
}

func AddQuantities(left, right Quantity) (Quantity, error) {
	leftValue, err := left.Int64()
	if err != nil {
		return "", err
	}
	rightValue, err := right.Int64()
	if err != nil {
		return "", err
	}
	if rightValue > math.MaxInt64-leftValue {
		return "", fmt.Errorf("%w: addition exceeds int64", ErrInvalidQuantity)
	}
	return QuantityFromInt64(leftValue + rightValue)
}

func SubtractQuantities(left, right Quantity) (Quantity, error) {
	leftValue, err := left.Int64()
	if err != nil {
		return "", err
	}
	rightValue, err := right.Int64()
	if err != nil {
		return "", err
	}
	if rightValue > leftValue {
		return "", fmt.Errorf("%w: subtraction would be negative", ErrInvalidQuantity)
	}
	return QuantityFromInt64(leftValue - rightValue)
}

// CostNanoUSD converts a non-negative base-10 USD string to the frozen
// nano-USD authority unit. Digits beyond scale nine are rounded half up. The
// result is returned as a canonical int64 decimal string and never passes
// through binary floating point.
func CostNanoUSD(decimalUSD string) (Quantity, error) {
	matches := decimalUSDPattern.FindStringSubmatch(decimalUSD)
	if matches == nil {
		return "", fmt.Errorf("%w: USD value %q is not a non-negative decimal", ErrInvalidQuantity, decimalUSD)
	}
	whole := new(big.Int)
	if _, ok := whole.SetString(matches[1], 10); !ok {
		return "", fmt.Errorf("%w: USD whole amount is invalid", ErrInvalidQuantity)
	}
	result := new(big.Int).Mul(whole, tenToNine)
	fraction := matches[2]
	retained := fraction
	if len(retained) > CostScale {
		retained = retained[:CostScale]
	}
	retained += strings.Repeat("0", CostScale-len(retained))
	if retained != "" {
		fractionValue := new(big.Int)
		if _, ok := fractionValue.SetString(retained, 10); !ok {
			return "", fmt.Errorf("%w: USD fraction is invalid", ErrInvalidQuantity)
		}
		result.Add(result, fractionValue)
	}
	if len(fraction) > CostScale && fraction[CostScale] >= '5' {
		result.Add(result, big.NewInt(1))
	}
	if result.Sign() < 0 || result.Cmp(maxInt64Big) > 0 {
		return "", fmt.Errorf("%w: nano-USD value exceeds int64", ErrInvalidQuantity)
	}
	return ParseQuantity(result.String())
}
