package budgetcontract

import (
	"math/big"
	"strings"
)

func validateRate(value any, path string) (string, error) {
	result, ok := value.(string)
	if !ok || len([]byte(result)) > MaxRateDecimalBytes || !ratePattern.MatchString(result) {
		return "", failure(ErrorInvalidDecimal, path, path+" must be a canonical decimal.")
	}
	parts := strings.SplitN(result, ".", 2)
	if len(parts) == 2 {
		if len(parts[1]) > MaxRateFractionDigits {
			return "", failure(ErrorLimitExceeded, path, path+" has too many fraction digits.")
		}
		if strings.HasSuffix(parts[1], "0") {
			return "", failure(ErrorInvalidDecimal, path, path+" must be a canonical decimal.")
		}
	}
	return result, nil
}

func rateParts(value, path string) (*big.Int, *big.Int, error) {
	validated, err := validateRate(value, path)
	if err != nil {
		return nil, nil, err
	}
	parts := strings.SplitN(validated, ".", 2)
	fraction := ""
	if len(parts) == 2 {
		fraction = parts[1]
	}
	denominator := new(big.Int).Exp(big.NewInt(10), big.NewInt(int64(len(fraction))), nil)
	whole, _ := new(big.Int).SetString(parts[0], 10)
	numerator := new(big.Int).Mul(whole, denominator)
	if fraction != "" {
		fractional, _ := new(big.Int).SetString(fraction, 10)
		numerator.Add(numerator, fractional)
	}
	return numerator, denominator, nil
}

func halfUp(numerator, denominator *big.Int, path string) (string, error) {
	twiceNumerator := new(big.Int).Mul(new(big.Int).Set(numerator), big.NewInt(2))
	twiceNumerator.Add(twiceNumerator, denominator)
	twiceDenominator := new(big.Int).Mul(new(big.Int).Set(denominator), big.NewInt(2))
	result := new(big.Int).Quo(twiceNumerator, twiceDenominator)
	if result.Cmp(maxInt64Value) > 0 {
		return "", failure(ErrorDecimalOverflow, path, path+" exceeds int64.")
	}
	return result.String(), nil
}

func USDToNanoUSD(value any) (string, error) {
	text, ok := value.(string)
	if !ok {
		return "", failure(ErrorInvalidDecimal, "$", "$ must be a canonical decimal.")
	}
	numerator, denominator, err := rateParts(text, "$")
	if err != nil {
		return "", err
	}
	numerator.Mul(numerator, big.NewInt(1_000_000_000))
	return halfUp(numerator, denominator, "$")
}

func ChargeNanoUSD(tokenQuantity any, rateNanoUSDPerToken any) (string, error) {
	tokens, err := ValidateDecimal(tokenQuantity, "$/tokens")
	if err != nil {
		return "", err
	}
	rate, ok := rateNanoUSDPerToken.(string)
	if !ok {
		return "", failure(ErrorInvalidDecimal, "$/rateNanoUsdPerToken", "$/rateNanoUsdPerToken must be a canonical decimal.")
	}
	numerator, denominator, err := rateParts(rate, "$/rateNanoUsdPerToken")
	if err != nil {
		return "", err
	}
	numerator.Mul(numerator, decimalBig(tokens))
	return halfUp(numerator, denominator, "$/nanoUsd")
}

type quantityValues struct{ tokens, nanoUSD, calls *big.Int }

func quantitiesBig(value Record) quantityValues {
	return quantityValues{decimalBig(value["tokens"]), decimalBig(value["nanoUsd"]), decimalBig(value["calls"])}
}

func makeQuantities(tokens, nanoUSD, calls *big.Int) (Record, error) {
	for _, value := range []*big.Int{tokens, nanoUSD, calls} {
		if value.Sign() < 0 || value.Cmp(maxInt64Value) > 0 {
			return nil, failure(ErrorDecimalOverflow, "$", "Quantity fold exceeds int64.")
		}
	}
	return Record{"tokens": tokens.String(), "nanoUsd": nanoUSD.String(), "calls": calls.String()}, nil
}

func zeroQuantities() Record { return Record{"tokens": "0", "nanoUsd": "0", "calls": "0"} }

func quantitiesEqual(left, right Record) bool {
	return left["tokens"] == right["tokens"] && left["nanoUsd"] == right["nanoUsd"] && left["calls"] == right["calls"]
}
