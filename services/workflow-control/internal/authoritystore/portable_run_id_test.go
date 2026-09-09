package authoritystore

import "testing"

func TestPortableNewRunPolicy(t *testing.T) {
	for _, id := range []string{"run.valid", "run-1", "scope@run", "company", "com0", "lpt10"} {
		if !IsPortableRunID(id) {
			t.Fatalf("portable ID rejected: %q", id)
		}
	}
	for _, id := range []string{"run:historical", "run.", "CON", "aux.txt", "LPT9.log", "com1"} {
		if IsPortableRunID(id) {
			t.Fatalf("nonportable ID accepted: %q", id)
		}
	}
}
