-- 004_ssh_keys: saved SSH public keys per service instance (C1d console).
--
-- Additive. The Create screen remembers a key after its first use. Only
-- public keys are stored: ed25519, and RSA of at least 3072 bits (the API
-- checks the key itself; the table checks the shape). One fingerprint once
-- per service instance.

CREATE TABLE ssh_keys (
  id uuid PRIMARY KEY,
  service_instance_id text NOT NULL REFERENCES service_instances (id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  type text NOT NULL CHECK (type IN ('ssh-ed25519', 'ssh-rsa')),
  bits integer NOT NULL CHECK (bits > 0),
  fingerprint text NOT NULL CHECK (fingerprint ~ '^SHA256:[A-Za-z0-9+/]{43}$'),
  public_key text NOT NULL CHECK (length(public_key) <= 8192),
  created_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX ssh_keys_fingerprint_by_service ON ssh_keys (service_instance_id, fingerprint);
