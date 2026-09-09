package authoritystore

import "strings"

// The wire alphabet is validated separately. This policy applies only to new runs.
func IsPortableRunID(value string) bool {
	if strings.Contains(value, ":") || strings.HasSuffix(value, ".") {
		return false
	}
	name := strings.ToLower(strings.SplitN(value, ".", 2)[0])
	if name == "con" || name == "prn" || name == "aux" || name == "nul" {
		return false
	}
	return !(len(name) == 4 && (strings.HasPrefix(name, "com") || strings.HasPrefix(name, "lpt")) && name[3] >= '1' && name[3] <= '9')
}
