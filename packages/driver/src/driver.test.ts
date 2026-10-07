import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DriverError, DriverRegistry, FakeDriver, defaultDriverRegistry } from "./index.js";

const spec = { name: "web", imageId: "debian-12", vcpu: 2, memoryMb: 2048, diskGb: 20, sshPublicKeys: [] };
const input = (id: string) => ({
  instanceId: id,
  spec,
  privateIp: "10.30.0.10",
  network: { cidr: "10.30.0.0/24", gateway: "10.30.0.1" },
});

describe("FakeDriver", () => {
  it("runs the whole lifecycle", async () => {
    const d = new FakeDriver();
    await d.create(input("a"));
    assert.equal((await d.status("a")).power, "running");
    await d.stop("a");
    assert.equal((await d.status("a")).power, "stopped");
    await d.snapshot("a", "snap-1");
    await d.start("a");
    assert.deepEqual(await d.status("a"), { instanceId: "a", power: "running", snapshots: ["snap-1"] });
    await d.delete("a");
    assert.equal((await d.status("a")).power, "absent");
  });

  it("is idempotent for create and delete", async () => {
    const d = new FakeDriver();
    await d.create(input("a"));
    await d.create(input("a"));
    assert.equal(d.size, 1);
    await d.delete("a");
    await d.delete("a");
    assert.equal(d.size, 0);
  });

  it("fails start, stop and snapshot on a missing VM", async () => {
    const d = new FakeDriver();
    await assert.rejects(d.start("x"), DriverError);
    await assert.rejects(d.stop("x"), DriverError);
    await assert.rejects(d.snapshot("x", "s"), DriverError);
  });

  it("replays scripted failures in order, then succeeds", async () => {
    const d = new FakeDriver();
    d.failNext("create", new DriverError("boom", "scripted", true), 2);
    await assert.rejects(d.create(input("a")), /scripted/);
    await assert.rejects(d.create(input("a")), /scripted/);
    await d.create(input("a"));
    assert.equal(d.size, 1);
    assert.deepEqual(
      d.calls.map((c) => c.op),
      ["create", "create", "create"],
    );
  });

  it("refuses a VM beyond its capacity", async () => {
    const d = new FakeDriver({ capacity: { vcpu: 3, memoryMb: 8192, diskGb: 120 } });
    await d.create(input("a"));
    await assert.rejects(d.create(input("b")), (err: DriverError) => err.code === "host_full");
  });
});

describe("DriverRegistry", () => {
  it("ships only the fake driver in C1a", () => {
    const r = defaultDriverRegistry();
    assert.deepEqual(r.names(), ["fake"]);
    assert.equal(r.create("fake").name, "fake");
    assert.equal(r.has("proxmox"), false);
    assert.throws(() => r.create("proxmox"), /Unknown driver/);
  });

  it("rejects duplicate and invalid names", () => {
    const r = new DriverRegistry();
    r.register("fake", () => new FakeDriver());
    assert.throws(() => r.register("fake", () => new FakeDriver()), /already registered/);
    assert.throws(() => r.register("Bad Name", () => new FakeDriver()), /Driver names/);
  });
});
