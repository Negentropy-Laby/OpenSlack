package budgetstore

import (
	"crypto/sha256"
	"encoding/hex"
	"strings"

	"github.com/Negentropy-Laby/OpenSlack/services/workflow-control/budgetcontract"
)

func ValidateQuantities(value Quantities) error {
	for path, current := range map[string]string{
		"$/tokens": value.Tokens, "$/nanoUsd": value.NanoUSD, "$/calls": value.Calls,
	} {
		if _, err := budgetcontract.ValidateDecimal(current, path); err != nil {
			return Failure(ErrorInputInvalid, "budget limit is invalid", err)
		}
	}
	return nil
}

func ValidateQualificationSeed(value QualificationSeed) error {
	decoded, err := hex.DecodeString(value.PolicyHash)
	if err != nil || len(decoded) != sha256.Size || hex.EncodeToString(decoded) != value.PolicyHash {
		return Failure(ErrorInputInvalid, "qualification budget seed policy hash is invalid", err)
	}
	if err := ValidateQuantities(value.Limit); err != nil {
		return Failure(ErrorInputInvalid, "qualification budget seed limit is invalid", err)
	}
	return nil
}

func ValidateReadIdentity(values ...string) error {
	for _, value := range values {
		if !validIdentifier(value) {
			return Failure(ErrorInputInvalid, "budget read identity is invalid", nil)
		}
	}
	return nil
}

func ValidateReceiptKey(value string) error {
	if !strings.HasPrefix(value, budgetcontract.IdempotencyPrefix) || len(value) != len(budgetcontract.IdempotencyPrefix)+64 {
		return Failure(ErrorInputInvalid, "budget receipt key is invalid", nil)
	}
	decoded, err := hex.DecodeString(value[len(budgetcontract.IdempotencyPrefix):])
	if err != nil || len(decoded) != sha256.Size || hex.EncodeToString(decoded) != value[len(budgetcontract.IdempotencyPrefix):] {
		return Failure(ErrorInputInvalid, "budget receipt key is invalid", err)
	}
	return nil
}

func validIdentifier(value string) bool {
	if len(value) < 1 || len([]byte(value)) > budgetcontract.MaxIdentifierBytes {
		return false
	}
	for index, current := range []byte(value) {
		if current >= 'A' && current <= 'Z' || current >= 'a' && current <= 'z' || current >= '0' && current <= '9' || index > 0 && strings.ContainsRune("._:@-", rune(current)) {
			continue
		}
		return false
	}
	return true
}
