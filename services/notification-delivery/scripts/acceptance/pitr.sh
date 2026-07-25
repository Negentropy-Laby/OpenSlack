#!/usr/bin/env bash
set -euo pipefail

# Physical backup + encrypted export + point-in-time recovery drill.
# This script is fail-closed and only accepts the dedicated acceptance source.
: "${RUN_DESTRUCTIVE_ACCEPTANCE:?set RUN_DESTRUCTIVE_ACCEPTANCE=1 for the isolated drill}"
if [[ "${RUN_DESTRUCTIVE_ACCEPTANCE}" != "1" ]]; then
  echo "RUN_DESTRUCTIVE_ACCEPTANCE must equal 1" >&2
  exit 2
fi

source_container="${PITR_SOURCE_CONTAINER:-rcwsman_b6_acceptance-db-1}"
case "${source_container}" in
  rcwsman_*_acceptance-db-1|rcwsman_b6_acceptance-db-1) ;;
  *) echo "refusing non-acceptance source container: ${source_container}" >&2; exit 2 ;;
esac

postgres_image='postgres:18.4@sha256:3a82e1f56c8f0f5616a11103ac3d47e632c3938698946a7ad26da0df1334744a'
age_archive_url='https://github.com/FiloSottile/age/releases/download/v1.3.1/age-v1.3.1-linux-amd64.tar.gz'
age_archive_sha256='bdc69c09cbdd6cf8b1f333d372a1f58247b3a33146406333e30c0f26e8f51377'
run_id="$(date -u +%Y%m%dT%H%M%SZ)-$$"
work="/tmp/rc_wsman-pitr-${run_id}"
restore_volume="rc_wsman_pitr_restore_${run_id}"
archive_volume="rc_wsman_pitr_archive_${run_id}"
restore_container="rc_wsman_pitr_restore_${run_id}"

cleanup() {
  docker rm -f "${restore_container}" >/dev/null 2>&1 || true
  docker volume rm "${restore_volume}" "${archive_volume}" >/dev/null 2>&1 || true
  docker exec "${source_container}" rm -rf /tmp/rc_wsman-pitr-base >/dev/null 2>&1 || true
  rm -rf "${work}"
}
trap cleanup EXIT
mkdir -p "${work}/base" "${work}/archive" "${work}/decrypted"

fixture_id="pitr-${run_id,,}"
docker exec "${source_container}" psql -U rc_wsman -d rc_wsman -v ON_ERROR_STOP=1 -c "
  INSERT INTO principals (principal_id,kind,status,vendor_scope,owning_scope,capabilities,managed_principal_scope)
  VALUES ('${fixture_id}-principal','caller','active',ARRAY['${fixture_id}-vendor'],'pitr-scope',ARRAY['submit_notification'],ARRAY[]::text[]);
  INSERT INTO access_keys (key_id,principal_id,secret_hash,pepper_id,status)
  VALUES ('${fixture_id}-key','${fixture_id}-principal',digest('${fixture_id}-key-material','sha256'),'local-v1','active');
  INSERT INTO vendors (vendor_id,owning_scope,lifecycle,record_revision,current_config_version,activated_at)
  VALUES ('${fixture_id}-vendor','pitr-scope','active',1,2,now());
  INSERT INTO endpoint_versions (
    vendor_id,config_version,config_schema_version,canonical_url,method,hostname,port,
    transport_kind,auth_strategy,credential_ref_scheme,credential_ref_handle,credential_ref_version,
    transport_auth_headers,outbound_idempotency_mapping,endpoint_policy,created_by_actor
  ) VALUES (
    '${fixture_id}-vendor',1,1,'https://pitr.example/hook','POST','pitr.example',443,
    'https_public','bearer','env','PITR_VENDOR_TOKEN','v1','[]'::jsonb,
    '{\"mode\":\"none\"}'::jsonb,
    '{\"AllowedRequestHeaderNames\":[],\"ForbiddenRequestHeaderNames\":[],\"MaxRequestBodyBytes\":4096}'::jsonb,
    'pitr-operator'
  );
  INSERT INTO endpoint_versions (
    vendor_id,config_version,config_schema_version,canonical_url,method,hostname,port,
    transport_kind,auth_strategy,response_policy,credential_ref_scheme,credential_ref_handle,
    credential_ref_version,transport_auth_headers,outbound_idempotency_mapping,endpoint_policy,
    created_by_actor
  ) VALUES (
    '${fixture_id}-vendor',2,2,'https://pitr.example/webhook','POST','pitr.example',443,
    'https_public','none','http_status_v1',NULL,NULL,NULL,
    '[{\"Kind\":\"literal\",\"Name\":\"content-type\",\"Value\":\"application/json\"}]'::jsonb,
    '{\"mode\":\"headers\",\"source\":\"ingress_idempotency_key\",\"header_names\":[\"idempotency-key\",\"x-openslack-idempotency-key\"]}'::jsonb,
    '{\"AllowedRequestHeaderNames\":[\"content-type\",\"idempotency-key\",\"x-openslack-idempotency-key\"],\"ForbiddenRequestHeaderNames\":[],\"MaxRequestBodyBytes\":262144}'::jsonb,
    'pitr-operator'
  );
  INSERT INTO admin_command_receipts (receipt_id,actor_id,idempotency_key,command_fingerprint_hash,result)
  VALUES ('${fixture_id}-receipt','pitr-operator','${fixture_id}-idempotency',digest('${fixture_id}-command','sha256'),
    '{\"operation\":\"register\",\"vendor_id\":\"${fixture_id}-vendor\",\"lifecycle\":\"active\",\"record_revision\":1,\"current_config_version\":1}'::jsonb);
  INSERT INTO admin_audit_events (
    vendor_id,owning_scope,actor_id,authorization_basis,operation,outcome,
    expected_record_revision_before,record_revision_after,sanitized_request_digest,receipt_id
  ) VALUES (
    '${fixture_id}-vendor','pitr-scope','pitr-operator','all','register','success',0,1,
    'pitr-sanitized-digest','${fixture_id}-receipt'
  );
  INSERT INTO notifications (
    notification_id,caller_id,vendor_id,idempotency_key,request_fingerprint,payload_bytes,
    state,version,attempt_count,delivery_cycle_started_at,delivered_at,last_outcome_class
  ) VALUES (
    '${fixture_id}-notification','${fixture_id}-principal','${fixture_id}-vendor','${fixture_id}-notification-key',
    digest('${fixture_id}-request','sha256'),convert_to('pitr-fixture-payload','UTF8'),
    'delivered',3,1,now()-interval '1 minute',now(),'success'
  );
  INSERT INTO delivery_attempts (
    notification_id,attempt_seq,event_kind,claimed_at,actor_id,lease_id,lease_expires_at
  ) VALUES (
    '${fixture_id}-notification',1,'claimed',now()-interval '30 seconds','pitr-worker','pitr-lease',now()+interval '30 seconds'
  );
  INSERT INTO delivery_attempts (
    notification_id,attempt_seq,event_kind,outcome_class,result_kind,http_status,config_version,recorded_at
  ) VALUES (
    '${fixture_id}-notification',2,'outcome','success','http_response',204,2,now()
  );
" >/dev/null

docker exec "${source_container}" psql -U rc_wsman -d rc_wsman -v ON_ERROR_STOP=1 -c \
  "CREATE TABLE IF NOT EXISTS acceptance_pitr_markers (marker text PRIMARY KEY, created_at timestamptz NOT NULL DEFAULT clock_timestamp()); TRUNCATE acceptance_pitr_markers; INSERT INTO acceptance_pitr_markers(marker) VALUES ('before');" >/dev/null
docker exec "${source_container}" rm -rf /tmp/rc_wsman-pitr-base
docker exec -u postgres "${source_container}" pg_basebackup -U rc_wsman -D /tmp/rc_wsman-pitr-base -Fp -X stream -c fast
docker exec "${source_container}" psql -U rc_wsman -d rc_wsman -v ON_ERROR_STOP=1 -c \
  "INSERT INTO acceptance_pitr_markers(marker) VALUES ('target');" >/dev/null
target_time="$(docker exec "${source_container}" psql -U rc_wsman -d rc_wsman -Atc "SELECT clock_timestamp()")"
sleep 1
archive_before="$(docker exec "${source_container}" psql -U rc_wsman -d rc_wsman -Atc "SELECT COALESCE(last_archived_wal,'') FROM pg_stat_archiver")"
docker exec "${source_container}" psql -U rc_wsman -d rc_wsman -v ON_ERROR_STOP=1 -c \
  "INSERT INTO acceptance_pitr_markers(marker) VALUES ('after');" >/dev/null
docker exec "${source_container}" psql -U rc_wsman -d rc_wsman -v ON_ERROR_STOP=1 -c \
  "SELECT pg_switch_wal();" >/dev/null
for _ in $(seq 1 30); do
  archived="$(docker exec "${source_container}" psql -U rc_wsman -d rc_wsman -Atc "SELECT COALESCE(last_archived_wal,'') FROM pg_stat_archiver")"
  [[ -n "${archived}" && "${archived}" != "${archive_before}" ]] && break
  sleep 1
done
[[ -n "${archived:-}" && "${archived}" != "${archive_before}" ]] || { echo "WAL archive did not advance" >&2; exit 1; }

docker cp "${source_container}:/tmp/rc_wsman-pitr-base/." "${work}/base" >/dev/null
docker cp "${source_container}:/var/lib/postgresql/wal-archive/." "${work}/archive" >/dev/null
tar -C "${work}" -cf "${work}/physical-backup.tar" base archive

curl --retry 8 --retry-all-errors --connect-timeout 15 -fsSL "${age_archive_url}" -o "${work}/age.tar.gz"
printf '%s  %s\n' "${age_archive_sha256}" "${work}/age.tar.gz" | sha256sum -c - >/dev/null
tar -C "${work}" -xzf "${work}/age.tar.gz"
"${work}/age/age-keygen" -o "${work}/identity.txt" 2>/dev/null
recipient="$("${work}/age/age-keygen" -y "${work}/identity.txt")"
[[ -n "${recipient}" ]] || { echo "age recipient generation failed" >&2; exit 1; }
"${work}/age/age" -r "${recipient}" -o "${work}/physical-backup.tar.age" "${work}/physical-backup.tar"
rm -f "${work}/physical-backup.tar"
"${work}/age/age" -d -i "${work}/identity.txt" -o "${work}/decrypted/physical-backup.tar" "${work}/physical-backup.tar.age"
tar -C "${work}/decrypted" -xf "${work}/decrypted/physical-backup.tar"

docker volume create "${restore_volume}" >/dev/null
docker volume create "${archive_volume}" >/dev/null
docker run --rm -v "${restore_volume}:/restore" -v "${archive_volume}:/archive" -v "${work}/decrypted:/input:ro" alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce sh -ec '
  mkdir -p /restore/18/docker
  cp -a /input/base/. /restore/18/docker/
  cp -a /input/archive/. /archive/
  chown -R 999:999 /restore /archive
'
docker run --rm -e TARGET_TIME="${target_time}" -v "${restore_volume}:/restore" alpine:3.22@sha256:14358309a308569c32bdc37e2e0e9694be33a9d99e68afb0f5ff33cc1f695dce sh -ec '
  printf "%s\n" "restore_command = '\''cp /archive/%f %p'\''" "recovery_target_time = '\''${TARGET_TIME}'\''" "recovery_target_action = '\''promote'\''" >> /restore/18/docker/postgresql.auto.conf
  touch /restore/18/docker/recovery.signal
  chown -R 999:999 /restore
'
docker run -d --name "${restore_container}" -e POSTGRES_PASSWORD=rc_wsman \
  -v "${restore_volume}:/var/lib/postgresql" -v "${archive_volume}:/archive:ro" \
  "${postgres_image}" -c archive_mode=off >/dev/null
for _ in $(seq 1 60); do
	docker exec "${restore_container}" pg_isready -U rc_wsman -d rc_wsman >/dev/null 2>&1 && break
	if [[ "$(docker inspect -f '{{.State.Running}}' "${restore_container}" 2>/dev/null || true)" != "true" ]]; then
		docker logs "${restore_container}" >&2 || true
		echo "restore container exited before readiness" >&2
		exit 1
	fi
	sleep 1
done
docker exec "${restore_container}" pg_isready -U rc_wsman -d rc_wsman >/dev/null

markers="$(docker exec "${restore_container}" psql -U rc_wsman -d rc_wsman -Atc "SELECT string_agg(marker, ',' ORDER BY marker) FROM acceptance_pitr_markers")"
schema_version="$(docker exec "${restore_container}" psql -U rc_wsman -d rc_wsman -Atc "SELECT version || ':' || dirty FROM schema_migrations")"
[[ "${markers}" == "before,target" ]] || { echo "unexpected restored markers: ${markers}" >&2; exit 1; }
[[ "${schema_version}" == "9:false" ]] || { echo "unexpected schema version: ${schema_version}" >&2; exit 1; }
invariants="$(docker exec "${restore_container}" psql -U rc_wsman -d rc_wsman -v ON_ERROR_STOP=1 -Atc "
  SELECT
    EXISTS (SELECT 1 FROM notifications
      WHERE notification_id='${fixture_id}-notification' AND caller_id='${fixture_id}-principal'
        AND vendor_id='${fixture_id}-vendor' AND idempotency_key='${fixture_id}-notification-key'
        AND state='delivered' AND version=3 AND attempt_count=1 AND delivered_at IS NOT NULL
        AND last_outcome_class='success' AND octet_length(request_fingerprint)=32
        AND convert_from(payload_bytes,'UTF8')='pitr-fixture-payload'),
    EXISTS (SELECT 1 FROM vendors v
      WHERE v.vendor_id='${fixture_id}-vendor' AND v.lifecycle='active'
        AND v.record_revision=1 AND v.current_config_version=2
        AND (SELECT count(*) FROM endpoint_versions e WHERE e.vendor_id=v.vendor_id)=2
        AND EXISTS (SELECT 1 FROM endpoint_versions e
          WHERE e.vendor_id=v.vendor_id AND e.config_version=1
            AND e.config_schema_version=1 AND e.auth_strategy='bearer'
            AND e.response_policy='http_status_v1'
            AND e.credential_ref_scheme='env' AND e.credential_ref_handle='PITR_VENDOR_TOKEN')
        AND EXISTS (SELECT 1 FROM endpoint_versions e
          WHERE e.vendor_id=v.vendor_id AND e.config_version=2
            AND e.config_schema_version=2 AND e.auth_strategy='none'
            AND e.response_policy='http_status_v1'
            AND e.credential_ref_scheme IS NULL AND e.credential_ref_handle IS NULL
            AND e.credential_ref_version IS NULL
            AND e.outbound_idempotency_mapping->>'source'='ingress_idempotency_key'
            AND e.outbound_idempotency_mapping->'header_names' =
              '[\"idempotency-key\",\"x-openslack-idempotency-key\"]'::jsonb)),
    EXISTS (SELECT 1 FROM admin_audit_events a
      JOIN admin_command_receipts r ON r.receipt_id=a.receipt_id
      WHERE a.vendor_id='${fixture_id}-vendor' AND a.operation='register'
        AND a.outcome='success' AND a.audit_seq>0 AND a.record_revision_after=1),
    EXISTS (SELECT 1 FROM access_keys k
      WHERE k.key_id='${fixture_id}-key' AND k.principal_id='${fixture_id}-principal'
        AND k.status='active' AND k.pepper_id='local-v1' AND octet_length(k.secret_hash)=32),
    (SELECT string_agg(attempt_seq::text || ':' || event_kind || ':' ||
      COALESCE(config_version::text,'null'), ',' ORDER BY attempt_seq)
       FROM delivery_attempts WHERE notification_id='${fixture_id}-notification');
")"
[[ "${invariants}" == "t|t|t|t|1:claimed:null,2:outcome:2" ]] || { echo "restored business invariants failed: ${invariants}" >&2; exit 1; }
if docker exec "${restore_container}" psql -U rc_wsman -d rc_wsman -v ON_ERROR_STOP=1 -c \
  "UPDATE delivery_attempts SET reason='mutation-must-fail' WHERE notification_id='${fixture_id}-notification';" >/dev/null 2>&1; then
  echo "restored delivery_attempts append-only guard did not reject mutation" >&2
  exit 1
fi

printf 'PITR_PASS age=v1.3.1 target_time=%s archived_wal=%s markers=%s schema=%s fixture=%s invariants=notification,vendor_version,audit,access_key,attempt_config_version,attempt_append_only\n' \
  "${target_time}" "${archived}" "${markers}" "${schema_version}" "${fixture_id}"
