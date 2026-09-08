-- Derived read indexes only. Historical source records and their exact bytes stay unchanged.
BEGIN;

-- Fail promptly if a writer is active; operators retry through normal migration
-- dirty-state recovery. No write can fall between backfill and trigger install.
LOCK TABLE workflow_runner_jobs, workflow_runner_leases,
  workflow_runner_authority_bindings, workflow_runner_binding_settlements
  IN SHARE ROW EXCLUSIVE MODE NOWAIT;

CREATE TABLE workflow_runner_recovery_versions (
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  revision BIGINT NOT NULL CHECK (revision > 0),
  routing_epoch BIGINT,
  authority_build_hash BYTEA,
  route_conflict BOOLEAN NOT NULL,
  PRIMARY KEY (workspace_id, run_id)
);
CREATE TABLE workflow_runner_recovery_records (
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  record_key TEXT COLLATE "C" NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('attempt','binding','diagnostic','settlement')),
  binding_id TEXT REFERENCES workflow_runner_authority_bindings(binding_id) ON DELETE CASCADE,
  attempt_id TEXT REFERENCES workflow_runner_leases(attempt_id) ON DELETE CASCADE,
  lease_expires_at TIMESTAMPTZ,
  PRIMARY KEY (workspace_id, run_id, record_key),
  CHECK ((kind='attempt')=(attempt_id IS NOT NULL)),
  CHECK ((kind<>'attempt')=(binding_id IS NOT NULL))
);
CREATE INDEX workflow_runner_recovery_binding_page_idx ON workflow_runner_recovery_records
  (workspace_id,run_id,binding_id,record_key) WHERE binding_id IS NOT NULL;
CREATE INDEX workflow_runner_binding_keyset_idx ON workflow_runner_authority_bindings
  (workspace_id,run_id,binding_id COLLATE "C");

INSERT INTO workflow_runner_recovery_versions
SELECT workspace_id,workflow_run_id,1,min(routing_epoch),decode(min(encode(authority_build_hash,'hex')),'hex'),
  count(DISTINCT (routing_epoch,authority_build_hash))<>1 OR
  bool_or(authority_backend IS DISTINCT FROM 'go' OR workflow_authority IS DISTINCT FROM 'workflow-control')
FROM workflow_runner_jobs GROUP BY workspace_id,workflow_run_id;

INSERT INTO workflow_runner_recovery_records(workspace_id,run_id,record_key,kind,binding_id)
SELECT workspace_id,run_id,'binding.'||binding_id,'binding',binding_id FROM workflow_runner_authority_bindings
UNION ALL
SELECT b.workspace_id,b.run_id,'diagnostic.'||b.binding_id,'diagnostic',b.binding_id
FROM workflow_runner_authority_bindings b WHERE b.state<>'completed' AND NOT EXISTS
  (SELECT 1 FROM workflow_runner_binding_settlements s WHERE s.binding_id=b.binding_id)
UNION ALL
SELECT workspace_id,run_id,'settlement.'||binding_id,'settlement',binding_id FROM workflow_runner_binding_settlements;
INSERT INTO workflow_runner_recovery_records(workspace_id,run_id,record_key,kind,attempt_id,lease_expires_at)
SELECT l.workspace_id,j.workflow_run_id,'attempt.'||l.attempt_id,'attempt',l.attempt_id,l.lease_expires_at
FROM workflow_runner_leases l JOIN workflow_runner_jobs j USING(workspace_id,job_id)
WHERE l.state IN ('offered','active','cancelling');

-- Entries belong to the current top-level transaction and never survive commit.
-- Deferring the shared version write avoids taking it before source row locks.
CREATE TABLE workflow_runner_recovery_pending (
  transaction_id XID8 NOT NULL,
  workspace_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  routing_epoch BIGINT,
  authority_build_hash BYTEA,
  route_conflict BOOLEAN NOT NULL DEFAULT false,
  PRIMARY KEY(transaction_id,workspace_id,run_id)
);

CREATE FUNCTION workflow_runner_flush_recovery_versions() RETURNS trigger AS $$
DECLARE pending RECORD;
BEGIN
  FOR pending IN SELECT * FROM workflow_runner_recovery_pending
    WHERE transaction_id=pg_current_xact_id() ORDER BY workspace_id COLLATE "C",run_id COLLATE "C"
  LOOP
    -- SET CONSTRAINTS can force an early flush. Never wait for another version
    -- writer while holding source locks: a standard serialization retry is safe.
    IF NOT pg_try_advisory_xact_lock(hashtextextended(
      'recovery-version:'||TG_TABLE_SCHEMA||':'||octet_length(pending.workspace_id)||':'||
      pending.workspace_id||':'||pending.run_id,11)) THEN
      RAISE EXCEPTION USING ERRCODE='40001',CONSTRAINT='workflow_runner_recovery_version_retry',
        DETAIL='recovery-version:'||TG_TABLE_SCHEMA||':'||octet_length(pending.workspace_id)||':'||pending.workspace_id||':'||pending.run_id,
        MESSAGE='recovery metadata changed concurrently; retry transaction';
    END IF;
    INSERT INTO workflow_runner_recovery_versions AS v
      (workspace_id,run_id,revision,routing_epoch,authority_build_hash,route_conflict)
    VALUES(pending.workspace_id,pending.run_id,1,pending.routing_epoch,pending.authority_build_hash,pending.route_conflict)
    ON CONFLICT(workspace_id,run_id) DO UPDATE SET revision=v.revision+1,
      routing_epoch=COALESCE(v.routing_epoch,EXCLUDED.routing_epoch),
      authority_build_hash=COALESCE(v.authority_build_hash,EXCLUDED.authority_build_hash),
      route_conflict=v.route_conflict OR EXCLUDED.route_conflict OR
        (v.routing_epoch IS NOT NULL AND EXCLUDED.routing_epoch IS NOT NULL AND
         (v.routing_epoch IS DISTINCT FROM EXCLUDED.routing_epoch OR
          v.authority_build_hash IS DISTINCT FROM EXCLUDED.authority_build_hash));
  END LOOP;
  DELETE FROM workflow_runner_recovery_pending WHERE transaction_id=pg_current_xact_id();
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE CONSTRAINT TRIGGER workflow_runner_recovery_flush AFTER INSERT ON workflow_runner_recovery_pending
 DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION workflow_runner_flush_recovery_versions();

CREATE FUNCTION workflow_runner_refresh_recovery_version() RETURNS trigger AS $$
DECLARE w TEXT; r TEXT; b TEXT; a TEXT; source RECORD; epoch BIGINT; build BYTEA; conflict BOOLEAN:=false;
BEGIN
  IF TG_OP='DELETE' THEN source:=OLD; ELSE source:=NEW; END IF;
  w:=source.workspace_id;
  IF TG_TABLE_NAME='workflow_runner_jobs' THEN
    IF TG_OP='UPDATE' AND ROW(NEW.workspace_id,NEW.workflow_run_id,NEW.routing_epoch,
      NEW.authority_build_hash,NEW.authority_backend,NEW.workflow_authority) IS NOT DISTINCT FROM
      ROW(OLD.workspace_id,OLD.workflow_run_id,OLD.routing_epoch,
      OLD.authority_build_hash,OLD.authority_backend,OLD.workflow_authority) THEN RETURN NULL; END IF;
    r:=source.workflow_run_id;
    epoch:=source.routing_epoch; build:=source.authority_build_hash;
    conflict:=TG_OP='DELETE' OR source.authority_backend IS DISTINCT FROM 'go' OR
      source.workflow_authority IS DISTINCT FROM 'workflow-control';
  ELSIF TG_TABLE_NAME='workflow_runner_leases' THEN
    IF TG_OP='UPDATE' AND ROW(NEW.workspace_id,NEW.job_id,NEW.attempt_id,NEW.state,NEW.lease_expires_at)
      IS NOT DISTINCT FROM ROW(OLD.workspace_id,OLD.job_id,OLD.attempt_id,OLD.state,OLD.lease_expires_at)
      THEN RETURN NULL; END IF;
    SELECT workflow_run_id INTO STRICT r FROM workflow_runner_jobs WHERE workspace_id=w AND job_id=source.job_id;
    a:=source.attempt_id;
    IF TG_OP<>'DELETE' AND source.state IN ('offered','active','cancelling') THEN
      INSERT INTO workflow_runner_recovery_records(workspace_id,run_id,record_key,kind,attempt_id,lease_expires_at)
      VALUES(w,r,'attempt.'||a,'attempt',a,source.lease_expires_at)
      ON CONFLICT(workspace_id,run_id,record_key) DO UPDATE SET lease_expires_at=EXCLUDED.lease_expires_at;
    ELSE DELETE FROM workflow_runner_recovery_records WHERE workspace_id=w AND run_id=r AND record_key='attempt.'||a;
    END IF;
  ELSE
    r:=source.run_id; b:=source.binding_id;
    IF TG_OP='DELETE' THEN
      DELETE FROM workflow_runner_recovery_records WHERE workspace_id=w AND run_id=r AND binding_id=b;
    ELSE
      IF TG_TABLE_NAME='workflow_runner_binding_settlements' THEN
        INSERT INTO workflow_runner_recovery_records(workspace_id,run_id,record_key,kind,binding_id)
        VALUES(w,r,'settlement.'||b,'settlement',b);
      ELSE
        INSERT INTO workflow_runner_recovery_records(workspace_id,run_id,record_key,kind,binding_id)
        VALUES(w,r,'binding.'||b,'binding',b) ON CONFLICT DO NOTHING;
      END IF;
      IF EXISTS (SELECT 1 FROM workflow_runner_authority_bindings WHERE binding_id=b AND state<>'completed') AND NOT EXISTS
        (SELECT 1 FROM workflow_runner_binding_settlements WHERE binding_id=b) THEN
        INSERT INTO workflow_runner_recovery_records(workspace_id,run_id,record_key,kind,binding_id)
        VALUES(w,r,'diagnostic.'||b,'diagnostic',b) ON CONFLICT DO NOTHING;
      ELSE DELETE FROM workflow_runner_recovery_records WHERE workspace_id=w AND run_id=r AND record_key='diagnostic.'||b;
      END IF;
    END IF;
  END IF;
  INSERT INTO workflow_runner_recovery_pending AS p(transaction_id,workspace_id,run_id,routing_epoch,authority_build_hash,route_conflict)
    VALUES(pg_current_xact_id(),w,r,epoch,build,conflict)
  ON CONFLICT(transaction_id,workspace_id,run_id) DO UPDATE SET
    routing_epoch=COALESCE(p.routing_epoch,EXCLUDED.routing_epoch),
    authority_build_hash=COALESCE(p.authority_build_hash,EXCLUDED.authority_build_hash),
    route_conflict=p.route_conflict OR EXCLUDED.route_conflict OR
      (p.routing_epoch IS NOT NULL AND EXCLUDED.routing_epoch IS NOT NULL AND
       (p.routing_epoch IS DISTINCT FROM EXCLUDED.routing_epoch OR
        p.authority_build_hash IS DISTINCT FROM EXCLUDED.authority_build_hash));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER workflow_runner_recovery_jobs AFTER INSERT OR UPDATE OR DELETE ON workflow_runner_jobs
  FOR EACH ROW EXECUTE FUNCTION workflow_runner_refresh_recovery_version();
CREATE TRIGGER workflow_runner_recovery_bindings AFTER INSERT OR UPDATE OR DELETE ON workflow_runner_authority_bindings
  FOR EACH ROW EXECUTE FUNCTION workflow_runner_refresh_recovery_version();
CREATE TRIGGER workflow_runner_recovery_settlements AFTER INSERT ON workflow_runner_binding_settlements
  FOR EACH ROW EXECUTE FUNCTION workflow_runner_refresh_recovery_version();
CREATE TRIGGER workflow_runner_recovery_leases AFTER INSERT OR UPDATE OR DELETE ON workflow_runner_leases
  FOR EACH ROW EXECUTE FUNCTION workflow_runner_refresh_recovery_version();
ALTER TABLE workflow_runner_jobs ENABLE ALWAYS TRIGGER workflow_runner_recovery_jobs;
ALTER TABLE workflow_runner_authority_bindings ENABLE ALWAYS TRIGGER workflow_runner_recovery_bindings;
ALTER TABLE workflow_runner_binding_settlements ENABLE ALWAYS TRIGGER workflow_runner_recovery_settlements;
ALTER TABLE workflow_runner_leases ENABLE ALWAYS TRIGGER workflow_runner_recovery_leases;
ALTER TABLE workflow_runner_recovery_pending ENABLE ALWAYS TRIGGER workflow_runner_recovery_flush;
DO $$ DECLARE function_name text; owner_schema text:=current_schema(); BEGIN
 FOREACH function_name IN ARRAY ARRAY['workflow_runner_refresh_recovery_version','workflow_runner_flush_recovery_versions'] LOOP
  EXECUTE format('ALTER FUNCTION %I.%I() SET search_path TO pg_catalog,%I,pg_temp',owner_schema,function_name,owner_schema);
 END LOOP;
END $$;
COMMIT;
