// rc_wsman - module manifest (B1 engineering foundation).
//
// External dependencies are resolved to the accepted major versions listed in
// standards/technical-preferences.md.  The patch versions below are the ones
// selected by `go mod tidy` in the Go-equipped Docker image; they are recorded
// in go.sum so the exact resolution is reproducible.
module rc_wsman

go 1.26.5

require (
	github.com/getkin/kin-openapi v0.143.0
	github.com/go-chi/chi/v5 v5.2.0
	github.com/golang-migrate/migrate/v4 v4.18.1
	github.com/jackc/pgx/v5 v5.7.1
	gopkg.in/yaml.v3 v3.0.1
)

require (
	github.com/go-openapi/jsonpointer v0.22.5 // indirect
	github.com/go-openapi/swag/jsonname v0.25.5 // indirect
	github.com/hashicorp/errwrap v1.1.0 // indirect
	github.com/hashicorp/go-multierror v1.1.1 // indirect
	github.com/jackc/pgerrcode v0.0.0-20220416144525-469b46aa5efa // indirect
	github.com/jackc/pgpassfile v1.0.0 // indirect
	github.com/jackc/pgservicefile v0.0.0-20240606120523-5a60cdf6a761 // indirect
	github.com/jackc/puddle/v2 v2.2.2 // indirect
	github.com/kr/pretty v0.3.1 // indirect
	github.com/oasdiff/yaml v0.1.1 // indirect
	github.com/oasdiff/yaml3 v0.0.14 // indirect
	github.com/santhosh-tekuri/jsonschema/v6 v6.0.2 // indirect
	go.uber.org/atomic v1.7.0 // indirect
	golang.org/x/crypto v0.27.0 // indirect
	golang.org/x/sync v0.8.0 // indirect
	golang.org/x/text v0.18.0 // indirect
)
