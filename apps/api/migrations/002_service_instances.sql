-- 002_service_instances: Compute as a federated provider of
-- cloud-federation-v1 (C1b).
--
-- Additive: no table or column is dropped. Instances, idempotency keys and
-- usage are re-keyed from the Cloud project id to the Cloud service
-- instance (contract §3.1); the project id now lives on the service
-- instance. The old project_id columns stay, nullable and unused.
--
-- The re-key needs these tables to be empty. That holds because Compute has
-- never been deployed (C1 pilot). The guard refuses to run otherwise rather
-- than guess a project-to-service-instance mapping.

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM instances)
     OR EXISTS (SELECT 1 FROM usage_samples)
     OR EXISTS (SELECT 1 FROM usage_records) THEN
    RAISE EXCEPTION '002_service_instances: instances or usage rows exist; re-keying them needs a written plan';
  END IF;
END $$;

-- §3.1 service instances. `id` is Cloud's service instance id.
CREATE TABLE service_instances (
  id text PRIMARY KEY CHECK (id ~ '^[A-Za-z0-9._:-]{1,128}$'),
  cloud_organisation_id uuid NOT NULL,
  cloud_project_id uuid NOT NULL,
  display_name text NOT NULL,
  region_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'disabled')),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX service_instances_project ON service_instances (cloud_project_id);

-- Instances belong to a service instance.
ALTER TABLE instances ADD COLUMN service_instance_id text NOT NULL REFERENCES service_instances (id);
ALTER TABLE instances ALTER COLUMN project_id DROP NOT NULL;
DROP INDEX instances_live_name;
DROP INDEX instances_project;
CREATE UNIQUE INDEX instances_live_name_by_service ON instances (service_instance_id, name) WHERE state <> 'deleted';
CREATE INDEX instances_service_instance ON instances (service_instance_id, created_at);
ALTER TABLE instances DROP CONSTRAINT instances_state_check;
ALTER TABLE instances ADD CONSTRAINT instances_state_check CHECK (state IN ('pending', 'provisioning',
  'running', 'stopping', 'stopped', 'starting', 'resizing', 'deleting', 'deleted', 'error'));

ALTER TABLE idempotency_keys DROP CONSTRAINT idempotency_keys_pkey;
ALTER TABLE idempotency_keys ADD COLUMN service_instance_id text NOT NULL REFERENCES service_instances (id);
ALTER TABLE idempotency_keys ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE idempotency_keys ADD PRIMARY KEY (service_instance_id, key);

ALTER TABLE usage_samples ADD COLUMN service_instance_id text NOT NULL REFERENCES service_instances (id);
ALTER TABLE usage_samples ALTER COLUMN project_id DROP NOT NULL;

ALTER TABLE usage_records DROP CONSTRAINT usage_records_pkey;
ALTER TABLE usage_records ADD COLUMN service_instance_id text NOT NULL REFERENCES service_instances (id);
ALTER TABLE usage_records ALTER COLUMN project_id DROP NOT NULL;
ALTER TABLE usage_records ADD PRIMARY KEY (service_instance_id, hour_start);

-- New job types, and the result a console job returns (a short-lived
-- ticket, handed to the browser once and then cleared).
ALTER TABLE jobs DROP CONSTRAINT jobs_type_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_type_check CHECK (type IN ('create', 'start', 'stop', 'delete',
  'snapshot', 'snapshot_delete', 'resize', 'console'));
ALTER TABLE jobs ADD COLUMN result jsonb;

-- Snapshots hold disk against the pool cap until they are deleted.
CREATE TABLE snapshots (
  id uuid PRIMARY KEY,
  instance_id uuid NOT NULL REFERENCES instances (id),
  name text NOT NULL CHECK (name ~ '^[a-z][a-z0-9-]{0,39}$'),
  state text NOT NULL CHECK (state IN ('creating', 'available', 'deleting', 'deleted', 'error')),
  size_gb integer NOT NULL CHECK (size_gb > 0),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX snapshots_live_name ON snapshots (instance_id, name) WHERE state <> 'deleted';
CREATE INDEX snapshots_instance ON snapshots (instance_id, created_at);

-- §3.2 principals. Display data only; `revoked_after` ends sessions (§3.3).
CREATE TABLE cloud_principals (
  subject text PRIMARY KEY,
  display_name text NOT NULL,
  email text NOT NULL,
  revoked_after timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

-- Grants and session tokens are stored only as SHA-256 hex hashes.
-- Console grants (§3.2) and operator grants (§8.2) live in separate tables.
CREATE TABLE console_launch_grants (
  grant_hash text PRIMARY KEY CHECK (grant_hash ~ '^[0-9a-f]{64}$'),
  service_instance_id text NOT NULL REFERENCES service_instances (id),
  subject text NOT NULL REFERENCES cloud_principals (subject),
  role text NOT NULL CHECK (role IN ('admin', 'developer', 'viewer')),
  return_path text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL
);
CREATE INDEX console_launch_grants_expiry ON console_launch_grants (expires_at);

CREATE TABLE console_sessions (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  subject text NOT NULL REFERENCES cloud_principals (subject),
  service_instance_id text NOT NULL REFERENCES service_instances (id),
  role text NOT NULL CHECK (role IN ('admin', 'developer', 'viewer')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL
);
CREATE INDEX console_sessions_subject ON console_sessions (subject);
CREATE INDEX console_sessions_expiry ON console_sessions (expires_at);

CREATE TABLE operator_launch_grants (
  grant_hash text PRIMARY KEY CHECK (grant_hash ~ '^[0-9a-f]{64}$'),
  subject text NOT NULL REFERENCES cloud_principals (subject),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'viewer')),
  return_path text NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  created_at timestamptz NOT NULL
);
CREATE INDEX operator_launch_grants_expiry ON operator_launch_grants (expires_at);

CREATE TABLE operator_sessions (
  id uuid PRIMARY KEY,
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  subject text NOT NULL REFERENCES cloud_principals (subject),
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'viewer')),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL
);
CREATE INDEX operator_sessions_subject ON operator_sessions (subject);
CREATE INDEX operator_sessions_expiry ON operator_sessions (expires_at);

-- Security events (auth.cloud_launch, auth.operator_launch,
-- auth.operator_reauth_required, fleet actions). Never holds a secret.
CREATE TABLE security_events (
  id uuid PRIMARY KEY,
  action text NOT NULL,
  subject text,
  service_instance_id text,
  session_id uuid,
  role text,
  detail jsonb,
  created_at timestamptz NOT NULL
);
CREATE INDEX security_events_created ON security_events (created_at);
