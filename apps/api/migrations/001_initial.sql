-- 001_initial: Compute control plane schema (C1a).
-- Migrations are numbered and additive. Never edit a migration after it has
-- been applied anywhere; add a new one instead.

CREATE TABLE quota_pool (
  id text PRIMARY KEY
);
-- The single pilot pool. Creates lock this row first, which serialises
-- capacity decisions (see store/types.ts).
INSERT INTO quota_pool (id) VALUES ('pilot');

CREATE TABLE hosts (
  id uuid PRIMARY KEY,
  name text NOT NULL UNIQUE,
  state text NOT NULL CHECK (state IN ('enrolled', 'active', 'draining', 'disabled')),
  driver text NOT NULL,
  capacity_vcpu integer NOT NULL CHECK (capacity_vcpu > 0),
  capacity_memory_mb integer NOT NULL CHECK (capacity_memory_mb > 0),
  capacity_disk_gb integer NOT NULL CHECK (capacity_disk_gb > 0),
  public_key_pem text NOT NULL,
  enrolled_at timestamptz NOT NULL,
  last_seen_at timestamptz
);

-- Enrolment tokens are stored only as SHA-256 hex hashes.
CREATE TABLE enrolment_tokens (
  token_hash text PRIMARY KEY CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  host_name text,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);

CREATE TABLE instances (
  id uuid PRIMARY KEY,
  project_id uuid NOT NULL,
  name text NOT NULL,
  spec jsonb NOT NULL,
  vcpu integer NOT NULL,
  memory_mb integer NOT NULL,
  disk_gb integer NOT NULL,
  state text NOT NULL CHECK (state IN ('pending', 'provisioning', 'running', 'stopping',
    'stopped', 'starting', 'deleting', 'deleted', 'error')),
  pending_reason text,
  host_id uuid REFERENCES hosts (id),
  private_ip inet,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX instances_live_name ON instances (project_id, name) WHERE state <> 'deleted';
CREATE INDEX instances_project ON instances (project_id, created_at);
CREATE INDEX instances_pending ON instances (created_at) WHERE state = 'pending';
CREATE INDEX instances_host_live ON instances (host_id) WHERE state <> 'deleted';

CREATE TABLE idempotency_keys (
  project_id uuid NOT NULL,
  key text NOT NULL,
  request_hash text NOT NULL,
  instance_id uuid NOT NULL REFERENCES instances (id),
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, key)
);

-- An address is held while its instance exists and released when the
-- instance is deleted. The partial unique index stops double allocation.
CREATE TABLE ip_allocations (
  address inet NOT NULL,
  instance_id uuid NOT NULL REFERENCES instances (id),
  held_at timestamptz NOT NULL,
  released_at timestamptz
);
CREATE UNIQUE INDEX ip_allocations_held ON ip_allocations (address) WHERE released_at IS NULL;
CREATE INDEX ip_allocations_instance ON ip_allocations (instance_id);

CREATE TABLE jobs (
  id uuid PRIMARY KEY,
  host_id uuid NOT NULL REFERENCES hosts (id),
  instance_id uuid NOT NULL REFERENCES instances (id),
  type text NOT NULL CHECK (type IN ('create', 'start', 'stop', 'delete', 'snapshot')),
  payload jsonb NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'leased', 'succeeded', 'failed')),
  attempt integer NOT NULL CHECK (attempt >= 0),
  max_attempts integer NOT NULL CHECK (max_attempts >= 1),
  lease_expires_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX jobs_queued ON jobs (host_id, created_at) WHERE state = 'queued';
CREATE INDEX jobs_leased ON jobs (lease_expires_at) WHERE state = 'leased';
CREATE INDEX jobs_instance ON jobs (instance_id, created_at);

-- Single-use nonces for Cloud-signed (scope 'cloud') and agent-signed
-- (scope 'host:<id>') requests.
CREATE TABLE nonces (
  scope text NOT NULL,
  nonce text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (scope, nonce)
);
CREATE INDEX nonces_expiry ON nonces (expires_at);

CREATE TABLE usage_samples (
  instance_id uuid NOT NULL REFERENCES instances (id),
  sampled_at timestamptz NOT NULL,
  host_id uuid NOT NULL REFERENCES hosts (id),
  project_id uuid NOT NULL,
  interval_seconds integer NOT NULL CHECK (interval_seconds BETWEEN 1 AND 3600),
  power_state text NOT NULL CHECK (power_state IN ('running', 'stopped')),
  vcpu integer NOT NULL,
  memory_mb integer NOT NULL,
  disk_gb integer NOT NULL,
  PRIMARY KEY (instance_id, sampled_at)
);

-- Usage per project per UTC hour, in exact integer seconds. The API turns
-- them into vCPU-hours and GB-hours. No prices (decision D7).
CREATE TABLE usage_records (
  project_id uuid NOT NULL,
  hour_start timestamptz NOT NULL,
  vcpu_seconds bigint NOT NULL DEFAULT 0,
  memory_mb_seconds bigint NOT NULL DEFAULT 0,
  disk_gb_seconds bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (project_id, hour_start)
);
