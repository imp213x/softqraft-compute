/**
 * IPv4 CIDR arithmetic for the pilot network. Pure functions, no I/O.
 */

export interface Ipv4Cidr {
  /** Canonical text, for example `10.30.0.0/24`. */
  text: string;
  network: number;
  prefix: number;
  /** Number of addresses in the block, including network and broadcast. */
  size: number;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

export function ipv4ToInt(address: string): number {
  const match = IPV4_RE.exec(address);
  if (!match) throw new Error("Not an IPv4 address");
  let value = 0;
  for (let i = 1; i <= 4; i += 1) {
    const octet = Number(match[i]);
    if (octet > 255 || (match[i]!.length > 1 && match[i]!.startsWith("0"))) {
      throw new Error("Not an IPv4 address");
    }
    value = value * 256 + octet;
  }
  return value;
}

export function intToIpv4(value: number): string {
  return [24, 16, 8, 0].map((shift) => Math.floor(value / 2 ** shift) % 256).join(".");
}

/** Parse `a.b.c.d/n`. The address must be the network address of the block. */
export function parseCidr(text: string): Ipv4Cidr {
  const [address, prefixText, ...rest] = text.trim().split("/");
  if (!address || !prefixText || rest.length > 0 || !/^\d{1,2}$/.test(prefixText)) {
    throw new Error("CIDR must look like 10.30.0.0/24");
  }
  const prefix = Number(prefixText);
  if (prefix > 32) throw new Error("CIDR prefix must be 0-32");
  const network = ipv4ToInt(address);
  const size = 2 ** (32 - prefix);
  if (network % size !== 0) throw new Error("CIDR address must be the network address");
  return { text: `${intToIpv4(network)}/${prefix}`, network, prefix, size };
}

export function cidrsOverlap(a: Ipv4Cidr, b: Ipv4Cidr): boolean {
  return a.network < b.network + b.size && b.network < a.network + a.size;
}

const PRIVATE_RANGES = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16"].map(parseCidr);

export function isPrivateCidr(cidr: Ipv4Cidr): boolean {
  return PRIVATE_RANGES.some(
    (range) => cidr.network >= range.network && cidr.network + cidr.size <= range.network + range.size,
  );
}

/** Production network on sq-node-01. The pilot must never touch it. */
export const PRODUCTION_CIDR = "10.20.0.0/24";

/**
 * Validate the pilot CIDR at startup: RFC 1918, a prefix from /16 to /29,
 * and no overlap with production. Throws with a clear message otherwise.
 */
export function assertPilotCidr(text: string): Ipv4Cidr {
  const cidr = parseCidr(text);
  if (cidr.prefix < 16 || cidr.prefix > 29) {
    throw new Error("COMPUTE_PILOT_CIDR prefix must be between /16 and /29");
  }
  if (!isPrivateCidr(cidr)) {
    throw new Error("COMPUTE_PILOT_CIDR must be a private (RFC 1918) range");
  }
  if (cidrsOverlap(cidr, parseCidr(PRODUCTION_CIDR))) {
    throw new Error(`COMPUTE_PILOT_CIDR must not overlap the production network ${PRODUCTION_CIDR}`);
  }
  return cidr;
}

/** The gateway is the first usable address; instances get the rest, up to broadcast. */
export function gatewayOf(cidr: Ipv4Cidr): string {
  return intToIpv4(cidr.network + 1);
}

/** Addresses instances may use, lowest first: network + 2 to broadcast − 1. */
export function* allocatableAddresses(cidr: Ipv4Cidr): Generator<string> {
  for (let value = cidr.network + 2; value < cidr.network + cidr.size - 1; value += 1) {
    yield intToIpv4(value);
  }
}
