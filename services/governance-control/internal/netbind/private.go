// Package netbind validates private service listener addresses.
package netbind

import (
	"fmt"
	"net"
	"strconv"
)

func Validate(bind, mode string) (string, error) {
	host, port, err := net.SplitHostPort(bind)
	if err != nil || port == "" {
		return "", fmt.Errorf("HTTP bind must contain an IP literal and port")
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 1 || portNumber > 65535 {
		return "", fmt.Errorf("HTTP bind port must be between 1 and 65535")
	}
	if host == "" {
		if mode != "internal" {
			return "", fmt.Errorf("wildcard bind requires internal network mode")
		}
		return net.JoinHostPort(host, port), nil
	}
	ip := net.ParseIP(host)
	if ip == nil {
		return "", fmt.Errorf("HTTP bind host must be an IP literal")
	}
	if mode == "loopback" && !ip.IsLoopback() {
		return "", fmt.Errorf("loopback mode requires a loopback address")
	}
	if mode == "internal" && !(ip.IsLoopback() || ip.IsPrivate() || ip.IsUnspecified() || ip.IsLinkLocalUnicast()) {
		return "", fmt.Errorf("internal mode rejects public bind addresses")
	}
	return net.JoinHostPort(host, port), nil
}
