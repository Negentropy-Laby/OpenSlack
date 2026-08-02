package netbind

import "testing"

func TestValidatePrivateBind(t *testing.T) {
	for _, test := range []struct {
		name, bind, mode, expected string
		valid                      bool
	}{
		{name: "loopback", bind: "127.0.0.1:8080", mode: "loopback", expected: "127.0.0.1:8080", valid: true},
		{name: "private", bind: "10.2.3.4:8080", mode: "internal", expected: "10.2.3.4:8080", valid: true},
		{name: "wildcard internal", bind: ":8080", mode: "internal", expected: ":8080", valid: true},
		{name: "public", bind: "8.8.8.8:8080", mode: "internal"},
		{name: "hostname", bind: "localhost:8080", mode: "loopback"},
		{name: "wildcard loopback", bind: ":8080", mode: "loopback"},
		{name: "named port", bind: "127.0.0.1:http", mode: "loopback"},
		{name: "zero port", bind: "127.0.0.1:0", mode: "loopback"},
	} {
		t.Run(test.name, func(t *testing.T) {
			actual, err := Validate(test.bind, test.mode)
			if test.valid && (err != nil || actual != test.expected) {
				t.Fatalf("Validate() = %q, %v", actual, err)
			}
			if !test.valid && err == nil {
				t.Fatalf("Validate() accepted %q", actual)
			}
		})
	}
}
