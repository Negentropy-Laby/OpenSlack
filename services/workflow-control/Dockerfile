# syntax=docker/dockerfile:1.24.0@sha256:87999aa3d42bdc6bea60565083ee17e86d1f3339802f543c0d03998580f9cb89
# check=error=true

FROM golang:1.26.5@sha256:3aff6657219a4d9c14e27fb1d8976c49c29fddb70ba835014f477e1c70636647 AS builder

ENV GOTOOLCHAIN=local
WORKDIR /src
RUN --network=none test -s /etc/ssl/certs/ca-certificates.crt

COPY go.mod go.sum ./
RUN go mod download && go mod verify

COPY cmd ./cmd
COPY internal ./internal
COPY authoritycontract ./authoritycontract
COPY budgetcontract ./budgetcontract
COPY runnerbindingcontract ./runnerbindingcontract
COPY runnerprotocol ./runnerprotocol
COPY workflowcontrol.go shadow_contract.go ./

FROM builder AS build
RUN --network=none set -eu; \
    for pass in a b; do \
      output="/tmp/build-${pass}"; \
      cache="/tmp/go-cache-${pass}"; \
      mkdir -p "${output}" "${cache}"; \
      GOCACHE="${cache}" CGO_ENABLED=0 go build -mod=readonly -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o "${output}/server" ./cmd/server; \
      GOCACHE="${cache}" CGO_ENABLED=0 go build -mod=readonly -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o "${output}/runner-server" ./cmd/runner-server; \
      GOCACHE="${cache}" CGO_ENABLED=0 go build -mod=readonly -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o "${output}/authority-server" ./cmd/authority-server; \
      GOCACHE="${cache}" CGO_ENABLED=0 go build -mod=readonly -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o "${output}/checkpoint-shadow-server" ./cmd/checkpoint-shadow-server; \
      GOCACHE="${cache}" CGO_ENABLED=0 go build -mod=readonly -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o "${output}/effect-shadow-server" ./cmd/effect-shadow-server; \
      GOCACHE="${cache}" CGO_ENABLED=0 go build -mod=readonly -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o "${output}/budget-authority-server" ./cmd/budget-authority-server; \
      GOCACHE="${cache}" CGO_ENABLED=0 go build -mod=readonly -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o "${output}/migrate" ./cmd/migrate; \
      GOCACHE="${cache}" CGO_ENABLED=0 go build -mod=readonly -trimpath -buildvcs=false -ldflags="-s -w -buildid=" -o "${output}/container-healthcheck" ./cmd/container-healthcheck; \
    done; \
    cmp /tmp/build-a/server /tmp/build-b/server; \
    cmp /tmp/build-a/runner-server /tmp/build-b/runner-server; \
    cmp /tmp/build-a/authority-server /tmp/build-b/authority-server; \
    cmp /tmp/build-a/checkpoint-shadow-server /tmp/build-b/checkpoint-shadow-server; \
    cmp /tmp/build-a/effect-shadow-server /tmp/build-b/effect-shadow-server; \
    cmp /tmp/build-a/budget-authority-server /tmp/build-b/budget-authority-server; \
    cmp /tmp/build-a/migrate /tmp/build-b/migrate; \
    cmp /tmp/build-a/container-healthcheck /tmp/build-b/container-healthcheck; \
    install -m 0755 /tmp/build-a/server /tmp/build-a/runner-server /tmp/build-a/authority-server /tmp/build-a/checkpoint-shadow-server /tmp/build-a/effect-shadow-server /tmp/build-a/budget-authority-server /tmp/build-a/migrate \
      /tmp/build-a/container-healthcheck /usr/local/bin/

FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818 AS app

COPY --from=builder /etc/ssl/certs/ca-certificates.crt /etc/ssl/certs/ca-certificates.crt
COPY --chmod=0444 LICENSE NOTICE THIRD_PARTY_NOTICES.md SBOM.cdx.json /usr/share/doc/openslack-workflow-control/
COPY --chmod=0444 integration/source-manifest.v2.json /usr/share/doc/openslack-workflow-control/source-manifest.v2.json
COPY --from=build /usr/local/bin/server /server
COPY --from=build /usr/local/bin/runner-server /runner-server
COPY --from=build /usr/local/bin/authority-server /authority-server
COPY --from=build /usr/local/bin/checkpoint-shadow-server /checkpoint-shadow-server
COPY --from=build /usr/local/bin/effect-shadow-server /effect-shadow-server
COPY --from=build /usr/local/bin/budget-authority-server /budget-authority-server
COPY --from=build /usr/local/bin/migrate /migrate
COPY --from=build /usr/local/bin/container-healthcheck /container-healthcheck
COPY migrations /migrations

USER 65534:65534
EXPOSE 8080

HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=12 \
    CMD ["/container-healthcheck"]

ENTRYPOINT ["/server"]
