package network

import "testing"

func TestFixedGitHubProxyMatrix(t *testing.T) {
	for _, value := range []string{" api.github.com:443 ", " .API.GITHUB.COM:443 ", " .github.com:443 ", "GITHUB.COM", "*", "localhost, .github.com:443"} {
		if !GitHubBypassed(value) {
			t.Fatalf("bypass %q rejected", value)
		}
	}
	for _, value := range []string{"api.github.com:444", "github.com.evil", "evilgithub.com", "localhost", ""} {
		if GitHubBypassed(value) {
			t.Fatalf("bypass %q accepted", value)
		}
	}
	for _, value := range []string{"http://proxy", "http://proxy/", "http://proxy:80", "https://proxy:443/", "http://proxy:1", "http://proxy:65535"} {
		if _, ok := Proxy(value, ""); !ok {
			t.Fatalf("valid proxy %q rejected", value)
		}
	}
	for _, value := range []string{"http://proxy:0", "http://proxy:65536", "http://proxy:99999", "http://user:synthetic@proxy", "http://proxy/path", "http://proxy?", "http://proxy#", " http://proxy", "http://proxy\\other"} {
		if _, ok := Proxy(value, ""); ok {
			t.Fatalf("unsafe proxy %q accepted", value)
		}
	}
}
