-- 003_instance_sizes: resize applies on completion, and usage is metered at
-- the size that applied when it was used (C1b review).
--
-- Additive. A resize request now records only a pending target (the
-- pending_* columns); the spec changes when the resize job succeeds. Every
-- applied size is kept in instance_sizes, effective from the moment it took
-- effect, so a late usage sample is metered at the size in force at its
-- sampledAt. Existing instances get one row: their current size from their
-- creation (nothing has been deployed, so no earlier resize is lost).

ALTER TABLE instances ADD COLUMN pending_vcpu integer CHECK (pending_vcpu > 0);
ALTER TABLE instances ADD COLUMN pending_memory_mb integer CHECK (pending_memory_mb > 0);
ALTER TABLE instances ADD COLUMN pending_disk_gb integer CHECK (pending_disk_gb > 0);
ALTER TABLE instances ADD CONSTRAINT instances_pending_size_complete CHECK (
  (pending_vcpu IS NULL) = (pending_memory_mb IS NULL) AND (pending_vcpu IS NULL) = (pending_disk_gb IS NULL)
);

CREATE TABLE instance_sizes (
  instance_id uuid NOT NULL REFERENCES instances (id),
  effective_from timestamptz NOT NULL,
  vcpu integer NOT NULL CHECK (vcpu > 0),
  memory_mb integer NOT NULL CHECK (memory_mb > 0),
  disk_gb integer NOT NULL CHECK (disk_gb > 0),
  PRIMARY KEY (instance_id, effective_from)
);

INSERT INTO instance_sizes (instance_id, effective_from, vcpu, memory_mb, disk_gb)
SELECT id, created_at, vcpu, memory_mb, disk_gb FROM instances;
