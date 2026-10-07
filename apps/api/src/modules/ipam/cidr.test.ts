import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { allocatableAddresses, cidrsOverlap, gatewayOf, intToIpv4, ipv4ToInt, parseCidr } from "./cidr.js";

describe("cidr", () => {
  it("round-trips addresses", () => {
    for (const a of ["0.0.0.0", "10.30.0.1", "255.255.255.255", "192.168.1.200"]) {
      assert.equal(intToIpv4(ipv4ToInt(a)), a);
    }
    for (const bad of ["10.30.0", "10.30.0.256", "10.030.0.1", "a.b.c.d", "10.30.0.1 "]) {
      assert.throws(() => ipv4ToInt(bad), bad);
    }
  });

  it("detects overlap", () => {
    const prod = parseCidr("10.20.0.0/24");
    assert.equal(cidrsOverlap(parseCidr("10.30.0.0/24"), prod), false);
    assert.equal(cidrsOverlap(parseCidr("10.20.1.0/24"), prod), false);
    assert.equal(cidrsOverlap(parseCidr("10.19.255.0/24"), prod), false);
    assert.equal(cidrsOverlap(parseCidr("10.20.0.0/16"), prod), true);
    assert.equal(cidrsOverlap(parseCidr("10.20.0.252/30"), prod), true);
  });

  it("reserves network, gateway and broadcast", () => {
    const c = parseCidr("10.30.0.0/29");
    assert.equal(gatewayOf(c), "10.30.0.1");
    assert.deepEqual([...allocatableAddresses(c)], ["10.30.0.2", "10.30.0.3", "10.30.0.4", "10.30.0.5", "10.30.0.6"]);
    assert.equal([...allocatableAddresses(parseCidr("10.30.0.0/24"))].length, 253);
  });
});
