/**
 * The image catalogue and `ensureImages`.
 *
 * Each catalogue image becomes a template VM (VMID 9000-9099) in the pool,
 * built from the vendor's cloud image:
 *
 * 1. fetch the vendor's published checksum list over HTTPS and take the
 *    image's hash from it;
 * 2. have Proxmox download the image into PROXMOX_IMPORT_STORAGE with that
 *    checksum (`download-url` verifies it and discards a mismatch before the
 *    file can be imported);
 * 3. create the template VM in the pool, importing the disk into
 *    PROXMOX_STORAGE, with a cloud-init drive and one NIC on the bridge;
 * 4. convert it to a template.
 *
 * Every step checks first, so running it again changes nothing.
 */

import type { ProxmoxClient } from "./client.js";
import { PROXMOX_ERRORS, fenceRefused, proxmoxError } from "./errors.js";

export interface CatalogueImage {
  imageId: string;
  templateVmid: number;
  /** The vendor's image URL. */
  url: string;
  /** The vendor's checksum list, published next to the image. */
  checksumsUrl: string;
  algorithm: "sha256" | "sha512";
  /** The image's file name as the checksum list names it. */
  fileName: string;
}

/**
 * C1 images. Debian publishes SHA512SUMS for its cloud images (no
 * SHA256SUMS); Ubuntu publishes SHA256SUMS.
 */
export const IMAGE_CATALOGUE: Readonly<Record<string, CatalogueImage>> = Object.freeze({
  "debian-12": {
    imageId: "debian-12",
    templateVmid: 9000,
    url: "https://cloud.debian.org/images/cloud/bookworm/latest/debian-12-genericcloud-amd64.qcow2",
    checksumsUrl: "https://cloud.debian.org/images/cloud/bookworm/latest/SHA512SUMS",
    algorithm: "sha512",
    fileName: "debian-12-genericcloud-amd64.qcow2",
  },
  "ubuntu-24.04": {
    imageId: "ubuntu-24.04",
    templateVmid: 9001,
    url: "https://cloud-images.ubuntu.com/noble/current/noble-server-cloudimg-amd64.img",
    checksumsUrl: "https://cloud-images.ubuntu.com/noble/current/SHA256SUMS",
    algorithm: "sha256",
    fileName: "noble-server-cloudimg-amd64.img",
  },
});

export const TEMPLATE_TAG = "sqc-template";

/** Fetch a small text file (the vendor checksum list). */
export type FetchText = (url: string) => Promise<string>;

const MAX_CHECKSUMS_BYTES = 1024 * 1024;

/** Global fetch with normal TLS verification, https only, size-capped. */
export const defaultFetchText: FetchText = async (url) => {
  if (!url.startsWith("https://")) throw new Error("checksum lists are fetched over https only");
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`checksum list answered ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_CHECKSUMS_BYTES) throw new Error("checksum list is too large");
  return text;
};

/** The hash a checksum list gives for a file, or null. Accepts `hash  name` and `hash *name`. */
export function checksumFor(list: string, fileName: string, algorithm: "sha256" | "sha512"): string | null {
  const length = algorithm === "sha256" ? 64 : 128;
  for (const line of list.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]+)\s+\*?(\S+)\s*$/.exec(line.trim());
    if (match && match[2] === fileName && match[1]!.length === length) return match[1]!.toLowerCase();
  }
  return null;
}

/** The import file name: the image id and the start of its hash, so a new vendor build gets a new file. */
export function importFileName(image: CatalogueImage, hash: string): string {
  return `sqc-${image.imageId}-${hash.slice(0, 16)}.qcow2`;
}

export interface VmResource {
  vmid: number;
  type?: string;
  name?: string;
  pool?: string;
  node?: string;
  tags?: string;
  status?: string;
  template?: number;
}

export interface EnsureImagesDeps {
  client: ProxmoxClient;
  /** Reads `/cluster/resources` and notes our pool's members. */
  resources: () => Promise<VmResource[]>;
  storage: string;
  importStorage: string;
  bridge: string;
  pool: string;
  fetchText: FetchText;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface EnsureImageResult {
  imageId: string;
  templateVmid: number;
  /** `present`: nothing to do; `created`: built now; `converted`: an earlier run's VM was finished. */
  action: "present" | "created" | "converted";
}

export async function ensureImages(
  deps: EnsureImagesDeps,
  catalogue: readonly CatalogueImage[] = Object.values(IMAGE_CATALOGUE),
): Promise<EnsureImageResult[]> {
  const { client } = deps;
  const results: EnsureImageResult[] = [];
  for (const image of catalogue) {
    const vms = await deps.resources();
    const existing = vms.find((vm) => vm.vmid === image.templateVmid);
    if (existing && existing.pool !== deps.pool) {
      // The VMID is taken by a VM outside our pool: never touch it.
      throw fenceRefused(`template VMID ${image.templateVmid} belongs to a VM outside PROXMOX_POOL`);
    }
    if (existing?.template === 1) {
      results.push({ imageId: image.imageId, templateVmid: image.templateVmid, action: "present" });
      continue;
    }
    if (existing) {
      // An earlier run created the VM but stopped before converting it.
      await client.task("POST", client.node(`/qemu/${image.templateVmid}/template`));
      results.push({ imageId: image.imageId, templateVmid: image.templateVmid, action: "converted" });
      continue;
    }

    let list: string;
    try {
      list = await deps.fetchText(image.checksumsUrl);
    } catch {
      throw proxmoxError(PROXMOX_ERRORS.imageChecksum, `The vendor checksum list for ${image.imageId} could not be fetched`, true);
    }
    const hash = checksumFor(list, image.fileName, image.algorithm);
    if (!hash) {
      throw proxmoxError(PROXMOX_ERRORS.imageChecksum, `The vendor checksum list does not list ${image.imageId}`);
    }
    const file = importFileName(image, hash);
    const content = (await client.get(client.node(`/storage/${deps.importStorage}/content`), { content: "import" })) as
      | Array<{ volid?: string }>
      | null;
    const volid = `${deps.importStorage}:import/${file}`;
    if (!(content ?? []).some((c) => c.volid === volid)) {
      deps.log?.("image.download", { imageId: image.imageId, algorithm: image.algorithm });
      await client.task("POST", client.node(`/storage/${deps.importStorage}/download-url`), {
        content: "import",
        filename: file,
        url: image.url,
        checksum: hash,
        "checksum-algorithm": image.algorithm,
        "verify-certificates": 1,
      });
    }
    await client.task("POST", client.node("/qemu"), {
      vmid: image.templateVmid,
      name: `sqc-tpl-${image.imageId.replace(/\./g, "-")}`,
      pool: deps.pool,
      ostype: "l26",
      cores: 1,
      memory: 1024,
      scsihw: "virtio-scsi-pci",
      scsi0: `${deps.storage}:0,import-from=${volid}`,
      ide2: `${deps.storage}:cloudinit`,
      boot: "order=scsi0",
      serial0: "socket",
      vga: "serial0",
      agent: "enabled=1",
      net0: `virtio,bridge=${deps.bridge},firewall=1`,
      tags: TEMPLATE_TAG,
      description: `SoftQraft Compute template ${image.imageId}`,
    });
    client.notePoolMember(image.templateVmid);
    await client.task("POST", client.node(`/qemu/${image.templateVmid}/template`));
    deps.log?.("image.template_ready", { imageId: image.imageId, templateVmid: image.templateVmid });
    results.push({ imageId: image.imageId, templateVmid: image.templateVmid, action: "created" });
  }
  return results;
}
