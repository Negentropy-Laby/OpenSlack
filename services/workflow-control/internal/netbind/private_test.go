package netbind

import "testing"

func TestValidatePrivateBindings(t *testing.T) {
	for _, testCase := range []struct {
		bind, mode string
		valid      bool
	}{
		{"127.0.0.1:8080", "loopback", true},
		{"[::1]:8080", "loopback", true},
		{"10.0.0.2:8080", "internal", true},
		{"0.0.0.0:8080", "internal", true},
		{"8.8.8.8:8080", "internal", false},
		{"10.0.0.2:8080", "loopback", false},
		{"localhost:8080", "loopback", false},
		{":8080", "loopback", false},
		{"127.0.0.1:0", "loopback", false},
	} {
		_, err := Validate(testCase.bind, testCase.mode)
		if (err == nil) != testCase.valid {
			t.Fatalf("Validate(%q,%q) error=%v, valid=%v", testCase.bind, testCase.mode, err, testCase.valid)
		}
	}
}
