/**
 * IPAM: private IPv4 addresses for pilot instances from COMPUTE_PILOT_CIDR.
 *
 * An address is held from instance creation until the instance is deleted,
 * so it is never reused while its instance still exists. The lowest free
 * address is chosen. The CIDR is checked at startup (never 10.20.0.0/24).
 */

import type { StoreTx } from "../../store/index.js";
import { allocatableAddresses, gatewayOf, type Ipv4Cidr } from "./cidr.js";

export {
  assertPilotCidr,
  cidrsOverlap,
  parseCidr,
  PRODUCTION_CIDR,
  type Ipv4Cidr,
} from "./cidr.js";

export interface Ipam {
  readonly network: { cidr: string; gateway: string };
  /** Hold the lowest free address for an instance. Null when the range is full. */
  allocate(tx: StoreTx, instanceId: string, now: Date): Promise<string | null>;
  release(tx: StoreTx, instanceId: string, now: Date): Promise<void>;
}

export function createIpam(deps: { cidr: Ipv4Cidr }): Ipam {
  const network = { cidr: deps.cidr.text, gateway: gatewayOf(deps.cidr) };
  return {
    network,
    async allocate(tx, instanceId, now) {
      const held = new Set(await tx.listHeldAddresses());
      for (const address of allocatableAddresses(deps.cidr)) {
        if (held.has(address)) continue;
        await tx.holdAddress(address, instanceId, now);
        return address;
      }
      return null;
    },
    async release(tx, instanceId, now) {
      await tx.releaseAddress(instanceId, now);
    },
  };
}
