import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  AgentUsageSample,
  ConsoleTicket,
  CreateInstanceRequest,
  CreateEnrolmentTokenRequest,
  DEFAULT_DISK_GB,
  EnrolRequest,
  JOB_PAYLOADS,
  JOB_TYPES,
  JobCompleteRequest,
  ProvisionServiceInstanceRequest,
  ServiceInstanceId,
  Snapshot,
  HostCapacity,
  INSTANCE_STATES,
  Instance,
  InstanceAction,
  InstanceName,
  InstanceSpec,
  JobEnvelope,
} from "./index.js";

const KEY =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIB4Kp0Tj9nJ7mTq8z3mQxPzv8yq9V2Jm9b0Zb8t7L3Hx test@example";

const base = { name: "web-1", imageId: "debian-12", vcpu: 1, memoryMb: 512, diskGb: 10 };

describe("InstanceSpec", () => {
  it("accepts a minimal spec and defaults sshPublicKeys to []", () => {
    const spec = InstanceSpec.parse(base);
    assert.deepEqual(spec.sshPublicKeys, []);
  });

  it("accepts the pilot maximums", () => {
    assert.ok(
      InstanceSpec.safeParse({ ...base, vcpu: 4, memoryMb: 8192, diskGb: 120, sshPublicKeys: [KEY] })
        .success,
    );
  });

  for (const [field, value] of [
    ["vcpu", 0],
    ["vcpu", 5],
    ["vcpu", 1.5],
    ["memoryMb", 0],
    ["memoryMb", 256],
    ["memoryMb", 768],
    ["memoryMb", 8704],
    ["diskGb", 9],
    ["diskGb", 121],
    ["diskGb", 10.5],
  ] as const) {
    it(`rejects ${field}=${value}`, () => {
      assert.equal(InstanceSpec.safeParse({ ...base, [field]: value }).success, false);
    });
  }

  it("accepts every memory step of 512 between 512 and 8192", () => {
    for (let mb = 512; mb <= 8192; mb += 512) {
      assert.ok(InstanceSpec.safeParse({ ...base, memoryMb: mb }).success, String(mb));
    }
  });

  it("rejects unknown fields", () => {
    assert.equal(InstanceSpec.safeParse({ ...base, gpu: 1 }).success, false);
  });

  it("rejects bad ssh keys and too many keys", () => {
    assert.equal(InstanceSpec.safeParse({ ...base, sshPublicKeys: ["not a key"] }).success, false);
    assert.equal(
      InstanceSpec.safeParse({ ...base, sshPublicKeys: [`${KEY}\nssh-rsa AAAA`] }).success,
      false,
    );
    assert.equal(
      InstanceSpec.safeParse({ ...base, sshPublicKeys: Array(11).fill(KEY) }).success,
      false,
    );
  });
});

describe("InstanceName", () => {
  for (const name of ["a", "web", "web-1", "a1", "x".repeat(63)]) {
    it(`accepts ${name.slice(0, 12)}`, () => assert.ok(InstanceName.safeParse(name).success));
  }
  for (const name of [
    "",
    "1web",
    "-web",
    "web-",
    "Web",
    "web_1",
    "web.1",
    "web 1",
    "x".repeat(64),
    "wéb",
    "web;rm",
    "web\n",
  ]) {
    it(`rejects ${JSON.stringify(name.slice(0, 12))}`, () =>
      assert.equal(InstanceName.safeParse(name).success, false));
  }
});

describe("other contracts", () => {
  it("lists the ten instance states", () => {
    assert.deepEqual(
      [...INSTANCE_STATES],
      ["pending", "provisioning", "running", "stopping", "stopped", "starting", "resizing", "deleting", "deleted", "error"],
    );
  });

  it("parses an Instance", () => {
    const now = new Date().toISOString();
    const parsed = Instance.parse({
      id: "6f1c1d8e-8d0a-4c55-9a0e-0d6d9b8f2c11",
      serviceInstanceId: "si_22222222",
      spec: InstanceSpec.parse(base),
      state: "pending",
      pendingReason: "no_host_available",
      hostId: null,
      privateIp: null,
      createdAt: now,
      updatedAt: now,
    });
    assert.equal(parsed.state, "pending");
  });

  it("accepts start, stop and resize actions", () => {
    assert.ok(InstanceAction.safeParse({ action: "start" }).success);
    assert.ok(InstanceAction.safeParse({ action: "stop" }).success);
    assert.ok(InstanceAction.safeParse({ action: "resize", vcpu: 2 }).success);
    assert.ok(InstanceAction.safeParse({ action: "resize", memoryMb: 2048, diskGb: 32 }).success);
    assert.equal(InstanceAction.safeParse({ action: "delete" }).success, false);
    assert.equal(InstanceAction.safeParse({ action: "start", vcpu: 2 }).success, false);
  });

  it("refuses an empty or out-of-range resize", () => {
    assert.equal(InstanceAction.safeParse({ action: "resize" }).success, false);
    assert.equal(InstanceAction.safeParse({ action: "resize", vcpu: 5 }).success, false);
    assert.equal(InstanceAction.safeParse({ action: "resize", memoryMb: 1000 }).success, false);
    assert.equal(InstanceAction.safeParse({ action: "resize", diskGb: 121 }).success, false);
  });

  it("lets a create request leave diskGb out, and defaults to 16 GB elsewhere", () => {
    const { diskGb: _d, ...noDisk } = base;
    assert.ok(CreateInstanceRequest.safeParse(noDisk).success);
    assert.equal(CreateInstanceRequest.parse(noDisk).diskGb, undefined);
    assert.equal(InstanceSpec.safeParse(noDisk).success, false, "a stored spec always has a disk");
    assert.equal(DEFAULT_DISK_GB, 16);
  });

  it("accepts service instance ids as Media does", () => {
    for (const id of ["si_1", "0f6c2a1e-1b7a-4b55-9c1a-5d2f3e4a5b6c", "a.b:c-d_e"]) {
      assert.ok(ServiceInstanceId.safeParse(id).success, id);
    }
    for (const id of ["", "a/b", "a b", "x".repeat(129), "é"]) {
      assert.equal(ServiceInstanceId.safeParse(id).success, false, id);
    }
  });

  it("has a payload schema for every job type", () => {
    assert.deepEqual(Object.keys(JOB_PAYLOADS).sort(), [...JOB_TYPES].sort());
    assert.ok(JOB_PAYLOADS.resize.safeParse({ name: "web", vcpu: 2, memoryMb: 2048, diskGb: 32 }).success);
    assert.equal(JOB_PAYLOADS.resize.safeParse({ name: "web", vcpu: 2 }).success, false);
    assert.ok(JOB_PAYLOADS.snapshot_delete.safeParse({ snapshotName: "before-upgrade" }).success);
    assert.equal(JOB_PAYLOADS.snapshot.safeParse({ snapshotName: "Bad Name" }).success, false);
  });

  it("parses console tickets and job completion bodies", () => {
    const ticket = { protocol: "vnc", ticket: "PVEVNC:abc", expiresAt: "2026-10-07T10:01:00.000Z" };
    assert.ok(ConsoleTicket.safeParse(ticket).success);
    assert.equal(ConsoleTicket.safeParse({ ...ticket, ticket: "has space" }).success, false);
    assert.equal(ConsoleTicket.safeParse({ ...ticket, protocol: "rdp" }).success, false);
    assert.ok(JobCompleteRequest.safeParse({ attempt: 1 }).success);
    assert.ok(JobCompleteRequest.safeParse({ attempt: 1, result: ticket }).success);
    assert.equal(JobCompleteRequest.safeParse({ attempt: 1, result: { x: 1 } }).success, false);
  });

  it("parses snapshots", () => {
    const now = "2026-10-07T10:00:00.000Z";
    assert.ok(
      Snapshot.safeParse({
        id: "6f1c1d8e-8d0a-4c55-9a0e-0d6d9b8f2c11",
        instanceId: "6f1c1d8e-8d0a-4c55-9a0e-0d6d9b8f2c12",
        name: "nightly",
        state: "available",
        sizeGb: 16,
        createdAt: now,
        updatedAt: now,
      }).success,
    );
  });

  it("enrolment token requests take only a host name", () => {
    assert.ok(CreateEnrolmentTokenRequest.safeParse({}).success);
    assert.ok(CreateEnrolmentTokenRequest.safeParse({ hostName: "sq-node-01" }).success);
    assert.equal(CreateEnrolmentTokenRequest.safeParse({ ttlSeconds: 600 }).success, false);
  });

  it("parses a §3.1 provision body", () => {
    const body = {
      cloudOrganisationId: "11111111-1111-4111-8111-111111111111",
      cloudProjectId: "22222222-2222-4222-8222-222222222222",
      displayName: "Pilot",
      regionId: "eu-central",
    };
    assert.ok(ProvisionServiceInstanceRequest.safeParse(body).success);
    assert.equal(ProvisionServiceInstanceRequest.safeParse({ ...body, displayName: "x".repeat(121) }).success, false);
    assert.equal(ProvisionServiceInstanceRequest.safeParse({ ...body, cloudProjectId: "nope" }).success, false);
  });

  it("rejects a job envelope with an extra field", () => {
    const envelope = {
      id: "6f1c1d8e-8d0a-4c55-9a0e-0d6d9b8f2c11",
      hostId: "6f1c1d8e-8d0a-4c55-9a0e-0d6d9b8f2c12",
      type: "start",
      payload: { name: "web" },
      instanceId: "6f1c1d8e-8d0a-4c55-9a0e-0d6d9b8f2c13",
      attempt: 1,
      issuedAt: "2026-10-07T10:00:00.000Z",
      expiresAt: "2026-10-07T10:05:00.000Z",
    };
    assert.ok(JobEnvelope.safeParse(envelope).success);
    assert.equal(JobEnvelope.safeParse({ ...envelope, extra: 1 }).success, false);
  });

  it("bounds usage samples and capacity", () => {
    const sample = {
      instanceId: "6f1c1d8e-8d0a-4c55-9a0e-0d6d9b8f2c11",
      sampledAt: "2026-10-07T10:00:00.000Z",
      intervalSeconds: 60,
      powerState: "running",
    };
    assert.ok(AgentUsageSample.safeParse(sample).success);
    assert.equal(AgentUsageSample.safeParse({ ...sample, intervalSeconds: 3601 }).success, false);
    assert.equal(HostCapacity.safeParse({ vcpu: 0, memoryMb: 512, diskGb: 1 }).success, false);
  });

  it("requires a well-formed enrolment token", () => {
    const body = {
      token: `sqet_${"A".repeat(43)}`,
      name: "sq-node-01",
      driver: "fake",
      publicKey: "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----\n",
      capacity: { vcpu: 4, memoryMb: 8192, diskGb: 120 },
    };
    assert.ok(EnrolRequest.safeParse(body).success);
    assert.equal(EnrolRequest.safeParse({ ...body, token: "sqet_short" }).success, false);
    assert.equal(
      EnrolRequest.safeParse({ ...body, publicKey: "-----BEGIN PRIVATE KEY-----" }).success,
      false,
    );
  });
});
