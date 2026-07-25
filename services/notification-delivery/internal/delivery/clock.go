package delivery

import (
	"crypto/rand"
	"math/big"
	"time"
)

// Clock abstracts time reading for deterministic tests.
type Clock interface {
	Now() time.Time
}

// RealClock returns wall-clock time.
type RealClock struct{}

func (RealClock) Now() time.Time { return time.Now().UTC() }

// CryptoRNG wraps crypto/rand as the delivery.RNG interface declared in
// backoff.go. It is safe for concurrent use.
type CryptoRNG struct{}

func (CryptoRNG) Int63n(n int64) int64 {
	if n <= 0 {
		return 0
	}
	v, err := rand.Int(rand.Reader, big.NewInt(n))
	if err != nil {
		panic(err)
	}
	return v.Int64()
}
