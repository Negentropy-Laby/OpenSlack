package authoritybinding

import (
	"strconv"
)

const MaxSafeInteger int64 = 1<<53 - 1

func ValidBearerToken(value string) bool {
	if len(value) < 32 || len(value) > 4096 {
		return false
	}
	for index := 0; index < len(value); index++ {
		if value[index] < 0x21 || value[index] > 0x7e {
			return false
		}
	}
	return true
}

func ParseRoutingEpoch(value string) (int64, bool) {
	parsed, err := strconv.ParseInt(value, 10, 64)
	return parsed, err == nil && parsed >= 1 && parsed <= MaxSafeInteger && strconv.FormatInt(parsed, 10) == value
}
