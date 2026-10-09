package network

import (
	"net/url"
	"strconv"
	"strings"
)

func Proxy(httpsProxy, noProxy string) (*url.URL, bool) {
	if len(httpsProxy) > 2048 || len(noProxy) > 2048 {
		return nil, false
	}
	for _, c := range noProxy {
		if c < 32 || c > 126 {
			return nil, false
		}
	}
	if httpsProxy == "" {
		return nil, true
	}
	u, e := url.Parse(httpsProxy)
	if e != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil ||
		(httpsProxy != u.Scheme+"://"+u.Host && httpsProxy != u.Scheme+"://"+u.Host+"/") {
		return nil, false
	}
	if u.Port() != "" {
		port, e := strconv.Atoi(u.Port())
		if e != nil || port < 1 || port > 65535 {
			return nil, false
		}
	}
	return u, true
}

func GitHubBypassed(noProxy string) bool {
	for _, item := range strings.Split(strings.ToLower(noProxy), ",") {
		domain := strings.TrimPrefix(strings.TrimSuffix(strings.TrimSpace(item), ":443"), ".")
		if domain == "*" || domain == "api.github.com" || domain == "github.com" {
			return true
		}
	}
	return false
}
