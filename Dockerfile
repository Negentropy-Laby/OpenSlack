# syntax=docker/dockerfile:1

# Multi-stage Dockerfile for rc_wsman.
#
# The `builder` target is used by docker-compose for local development and test
# commands (go mod tidy, go vet, go test) from a shell without a Go toolchain.
# It copies the source tree and pre-downloads the module graph.
#
# The `build` target compiles the server binary once a go.sum is present.
# The `app` target packages the compiled binary for production.
FROM golang:1.26.5 AS builder

WORKDIR /src

# Copy only the module manifest first so dependency downloads are cacheable.
COPY go.mod ./
RUN go mod download

# Copy the rest of the source tree.  The actual build is intentionally left to
# the `build` target so that B1 development/test commands can run without a
# pre-existing go.sum.
COPY . .

# Build target: requires go.sum to be generated (e.g., by `go mod tidy`).
FROM builder AS build
RUN CGO_ENABLED=0 go build -o /bin/server ./cmd/server

# Production image: minimal Debian base with CA certificates.
FROM debian:bookworm-slim AS app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /bin/server /server

USER nobody:nogroup
EXPOSE 8080

ENTRYPOINT ["/server"]
