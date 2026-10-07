/**
 * Images: the pilot catalogue. It is fixed in code for C1; the host agent
 * maps each id to a template on its hypervisor (C1e).
 */

import type { FastifyInstance } from "fastify";
import type { Image } from "@softqraft/compute-contracts";

export const PILOT_IMAGES: readonly Image[] = Object.freeze([
  {
    id: "debian-12",
    name: "Debian 12 (bookworm)",
    osFamily: "linux",
    distribution: "debian",
    version: "12",
    minDiskGb: 10,
    status: "available",
  },
  {
    id: "ubuntu-24.04",
    name: "Ubuntu 24.04 LTS",
    osFamily: "linux",
    distribution: "ubuntu",
    version: "24.04",
    minDiskGb: 10,
    status: "available",
  },
]);

export interface Images {
  list(): readonly Image[];
  /** An image instances may be created from, or null. */
  getAvailable(id: string): Image | null;
}

export function createImages(catalogue: readonly Image[] = PILOT_IMAGES): Images {
  return {
    list: () => catalogue,
    getAvailable: (id) => catalogue.find((i) => i.id === id && i.status === "available") ?? null,
  };
}

/** `GET /console/v1/images`, inside the Console session guard. */
export function registerConsoleImageRoutes(app: FastifyInstance, images: Images): void {
  app.get("/console/v1/images", async () => ({ images: images.list() }));
}
