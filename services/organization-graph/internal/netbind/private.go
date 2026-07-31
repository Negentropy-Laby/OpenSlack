// Package netbind resolves fail-closed private service listeners.
package netbind

import (
	"fmt"
	"net"
	"sort"
	"strconv"
)

// ResolvePrivateWildcard replaces an empty-host bind with the process's single
// unambiguous private interface address. It never returns a wildcard listener.
func ResolvePrivateWildcard(bind string) (string, error) {
	host, port, err := net.SplitHostPort(bind)
	if err != nil || host != "" || port == "" {
		return "", fmt.Errorf("private wildcard bind must contain an empty host and numeric port")
	}
	value, err := strconv.Atoi(port)
	if err != nil || value < 1 || value > 65535 {
		return "", fmt.Errorf("private wildcard bind must use a numeric TCP port from 1 to 65535")
	}

	interfaces, err := net.Interfaces()
	if err != nil {
		return "", fmt.Errorf("enumerate private interfaces: %w", err)
	}
	addresses := make([]net.IP, 0)
	for _, networkInterface := range interfaces {
		if networkInterface.Flags&net.FlagUp == 0 ||
			networkInterface.Flags&net.FlagLoopback != 0 {
			continue
		}
		interfaceAddresses, addressErr := networkInterface.Addrs()
		if addressErr != nil {
			return "", fmt.Errorf("enumerate addresses for interface %s: %w", networkInterface.Name, addressErr)
		}
		for _, interfaceAddress := range interfaceAddresses {
			var address net.IP
			switch candidate := interfaceAddress.(type) {
			case *net.IPNet:
				address = candidate.IP
			case *net.IPAddr:
				address = candidate.IP
			}
			if address != nil && address.IsPrivate() &&
				!address.IsLoopback() && !address.IsUnspecified() {
				addresses = append(addresses, append(net.IP(nil), address...))
			}
		}
	}

	address, err := selectPrivateAddress(addresses)
	if err != nil {
		return "", err
	}
	return net.JoinHostPort(address.String(), strconv.Itoa(value)), nil
}

func selectPrivateAddress(addresses []net.IP) (net.IP, error) {
	ipv4 := make(map[string]net.IP)
	ipv6 := make(map[string]net.IP)
	for _, address := range addresses {
		if address == nil || !address.IsPrivate() ||
			address.IsLoopback() || address.IsUnspecified() {
			continue
		}
		if value := address.To4(); value != nil {
			key := value.String()
			ipv4[key] = append(net.IP(nil), value...)
			continue
		}
		value := address.To16()
		if value != nil {
			key := value.String()
			ipv6[key] = append(net.IP(nil), value...)
		}
	}
	if len(ipv4) == 1 {
		for _, address := range ipv4 {
			return address, nil
		}
	}
	if len(ipv4) > 1 {
		return nil, fmt.Errorf("private wildcard bind is ambiguous across IPv4 addresses %v", sortedKeys(ipv4))
	}
	if len(ipv6) == 1 {
		for _, address := range ipv6 {
			return address, nil
		}
	}
	if len(ipv6) > 1 {
		return nil, fmt.Errorf("private wildcard bind is ambiguous across IPv6 addresses %v", sortedKeys(ipv6))
	}
	return nil, fmt.Errorf("private wildcard bind requires exactly one private non-loopback interface address")
}

func sortedKeys(values map[string]net.IP) []string {
	result := make([]string, 0, len(values))
	for value := range values {
		result = append(result, value)
	}
	sort.Strings(result)
	return result
}
