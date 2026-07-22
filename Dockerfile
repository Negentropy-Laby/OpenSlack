# syntax=docker/dockerfile:1

# Multi-stage Dockerfile for rc_wsman.
#
# The `build` target compiles the server binary once a go.sum is present.
# The `app` target packages the compiled binary for production.
FROM golang:1.26.5@sha256:3aff6657219a4d9c14e27fb1d8976c49c29fddb70ba835014f477e1c70636647 AS builder

WORKDIR /src

# Copy only the module manifest first so dependency downloads are cacheable.
COPY go.mod ./
RUN go mod download

# Copy the rest of the source tree.  The actual build is intentionally left to
# the `build` target so that B1 development/test commands can run without a
# pre-existing go.sum.
COPY . .

# Build target: compiles the single production server binary.
FROM builder AS build
RUN CGO_ENABLED=0 go build -o /bin/server ./cmd/server

# Production image: minimal Debian base with CA certificates.
FROM debian:bookworm-slim@sha256:7b140f374b289a7c2befc338f42ebe6441b7ea838a042bbd5acbfca6ec875818 AS app

RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

COPY --from=build /bin/server /server
COPY migrations /migrations

USER nobody:nogroup
EXPOSE 8080

HEALTHCHECK --interval=5s --timeout=3s --start-period=10s --retries=12 \
    CMD ["curl", "--fail", "--silent", "--show-error", "http://127.0.0.1:8080/health/ready"]

ENTRYPOINT ["/server"]
