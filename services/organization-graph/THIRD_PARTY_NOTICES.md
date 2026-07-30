# Third-Party Notices — Organization Graph Service

This inventory covers the external Go modules reachable from the production
commands under `GOWORK=off go list -deps ./cmd/...`. Test-only modules are
recorded in `go.mod` and `go.sum` but are not part of this production-binary
inventory. The inventory is an unsigned repository input and does not establish
a release, registry publication, or completed legal review.

| Module | Version | License | Upstream license-file SHA-256 |
| --- | --- | --- | --- |
| `github.com/golang-migrate/migrate/v4` | `v4.18.1` | MIT | `4c250e1d2cb21c738d5ec785f6fb1e03cd1e9adecfab46feb9494847872455be` |
| `github.com/hashicorp/errwrap` | `v1.1.0` | MPL-2.0 | `bef1747eda88b9ed46e94830b0d978c3499dad5dfe38d364971760881901dadd` |
| `github.com/hashicorp/go-multierror` | `v1.1.1` | MPL-2.0 | `a830016911a348a54e89bd54f2f8b0d8fffdeac20aecfba8e36ebbf38a03f5ff` |
| `github.com/jackc/pgerrcode` | `v0.0.0-20220416144525-469b46aa5efa` | MIT and PostgreSQL | `ba651777b8362b30d778d60f7a0fcd1f01cdac79aa713d1a6f0a53bf5372fa2f` |
| `github.com/jackc/pgpassfile` | `v1.0.0` | MIT | `adb1663fda031df8f4344aa68f299fd87d80353e31339406742ded21dae65702` |
| `github.com/jackc/pgservicefile` | `v0.0.0-20240606120523-5a60cdf6a761` | MIT | `fc505773403fe869ed64cc2235cdd13988a427bb7e3a7e7004a3f4b27420f8fc` |
| `github.com/jackc/pgx/v5` | `v5.7.1` | MIT | `467f95e074fe23079a5623ed652619682692041b8551da27e3c2ddb9659a1507` |
| `github.com/jackc/puddle/v2` | `v2.2.2` | MIT | `2d50e98a4900b4d6457a38d39c1432fdc156fc2f7b365f2e33ec9344acbb0057` |
| `go.uber.org/atomic` | `v1.7.0` | MIT | `edbb5a4d165ac69376c765b551c0662ff42bea87e1f1eda85f42ac90c34b09d0` |
| `golang.org/x/crypto` | `v0.27.0` | BSD-3-Clause | `911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad` |
| `golang.org/x/sync` | `v0.8.0` | BSD-3-Clause | `911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad` |
| `golang.org/x/text` | `v0.18.0` | BSD-3-Clause | `911f8f5782931320f5b8d1160a76365b83aea6447ee6c04fa6d5591467db9dad` |

The canonical upstream license files are bound by the hashes above and by the
module versions in `go.sum`. The repository-wide Apache-2.0 license does not
replace those upstream terms. A distribution candidate must re-run dependency
and license verification against the exact candidate module graph.
