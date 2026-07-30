package netbind

import (
	"net"
	"strings"
	"testing"
)

func TestSelectPrivateAddressPrefersOneUnambiguousIPv4(t *testing.T) {
	address, err := selectPrivateAddress([]net.IP{
		net.ParseIP("127.0.0.1"),
		net.ParseIP("fd00::4"),
		net.ParseIP("10.0.0.4"),
		net.ParseIP("10.0.0.4"),
		net.ParseIP("8.8.8.8"),
	})
	if err != nil {
		t.Fatal(err)
	}
	if address.String() != "10.0.0.4" {
		t.Fatalf("address = %q", address)
	}
}

func TestSelectPrivateAddressFailsClosedWhenPrivateIPv4IsAmbiguous(t *testing.T) {
	_, err := selectPrivateAddress([]net.IP{
		net.ParseIP("10.0.0.4"),
		net.ParseIP("172.18.0.2"),
	})
	if err == nil || !strings.Contains(err.Error(), "ambiguous") {
		t.Fatalf("selectPrivateAddress() error = %v", err)
	}
}

func TestSelectPrivateAddressFallsBackToOnePrivateIPv6(t *testing.T) {
	address, err := selectPrivateAddress([]net.IP{net.ParseIP("fd00::4")})
	if err != nil {
		t.Fatal(err)
	}
	if address.String() != "fd00::4" {
		t.Fatalf("address = %q", address)
	}
}

func TestResolvePrivateWildcardRejectsNonWildcardInput(t *testing.T) {
	if _, err := ResolvePrivateWildcard("10.0.0.4:8080"); err == nil {
		t.Fatal("non-wildcard input was accepted")
	}
}
