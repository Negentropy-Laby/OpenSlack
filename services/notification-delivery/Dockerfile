# syntax=docker/dockerfile:1.24.0@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89
# check=error=true

# Multi-stage Dockerfile for rc_wsman.
FROM golang:1.26.5@sha256:3aff6657219a4d9c14e27fb1d8976c49c29fddb70ba835014f477e1c70636647 AS builder

ENV GOTOOLCHAIN=local
WORKDIR /src
RUN --network=none test -s /etc/ssl/certs/ca-certificates.crt

# Bind the complete module graph before downloading dependencies.
COPY go.mod go.sum ./
RUN go mod download && go mod verify

# Keep the build context closed to reviewed Go sources.
COPY cmd ./cmd
COPY internal ./internal

# Compile every production binary twice with isolated caches, then require
# byte-identical outputs before they can enter a runtime image.
FROM builder AS build
RUN --network=none set -eu; \
    for pass in a b; do \
      output="/tmp/build-${pass}"; \
      cache="/tmp/go-cache-${pass}"; \
      mkdir -p "${output}" "${cache}"; \
      GOCACHE="${cache}" CGO_ENABLED=0 go build -mod=readonly -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o "${output}/server" ./cmd/server; \
      GOCACHE="${cache}" CGO_ENABLED=0 go build -mod=readonly -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o "${output}/bootstrap-openslack" ./cmd/bootstrap-openslack; \
      GOCACHE="${cache}" CGO_ENABLED=0 go build -mod=readonly -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o "${output}/canary-webhook-receiver" ./cmd/canary-webhook-receiver; \
      GOCACHE="${cache}" CGO_ENABLED=0 go build -mod=readonly -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o "${output}/container-healthcheck" ./cmd/container-healthcheck; \
    done; \
    cmp /tmp/build-a/server /tmp/build-b/server; \
    cmp /tmp/build-a/bootstrap-openslack /tmp/build-b/bootstrap-openslack; \
    cmp /tmp/build-a/canary-webhook-receiver /tmp/build-b/canary-webhook-receiver; \
    cmp /tmp/build-a/container-healthcheck /tmp/build-b/container-healthcheck; \
    install -m 0755 /tmp/build-a/server /tmp/build-a/bootstrap-openslack \
      /tmp/build-a/canary-webhook-receiver /tmp/build-a/container-healthcheck /usr/local/bin/

# Keep the runtime on the existing pinned base without mutable package installs.
FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818 AS app

COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --from=build /usr/local/bin/server /server
COPY --from=build /usr/local/bin/bootstrap-openslack /bootstrap-openslack
COPY --from=build /usr/local/bin/container-healthcheck /container-healthcheck
COPY migrations /migrations

USER 65534:65534
EXPOSE 8080

HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=12 \
    CMD ["/container-healthcheck", "app"]

ENTRYPOINT ["/server"]

FROM app AS canary-webhook-receiver
COPY --from=build /usr/local/bin/canary-webhook-receiver /canary-webhook-receiver
EXPOSE 8090
HEALTHCHECK --interval=5s --timeout=3s --start-period=5s --retries=12 \
    CMD ["/container-healthcheck", "canary"]
ENTRYPOINT ["/canary-webhook-receiver"]
