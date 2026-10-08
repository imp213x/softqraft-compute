/**
 * Words for states, sizes, dates and hours. Never an internal state name,
 * id or code. Pure functions: the UI contract test calls them directly.
 */

/** Instance states in words, with a tone for the status dot and whether it is still changing. */
const INSTANCE_STATUS = Object.freeze({
  pending: { label: "Starting", tone: "busy", changing: true },
  provisioning: { label: "Starting", tone: "busy", changing: true },
  starting: { label: "Starting", tone: "busy", changing: true },
  running: { label: "Running", tone: "ok", changing: false },
  stopping: { label: "Stopping", tone: "busy", changing: true },
  stopped: { label: "Stopped", tone: "idle", changing: false },
  resizing: { label: "Resizing", tone: "busy", changing: true },
  deleting: { label: "Deleting", tone: "busy", changing: true },
  deleted: { label: "Deleted", tone: "idle", changing: false },
  error: { label: "Needs attention", tone: "bad", changing: false },
});

const UNKNOWN = Object.freeze({ label: "Checking", tone: "busy", changing: true });

export function instanceStatus(state) {
  return Object.hasOwn(INSTANCE_STATUS, state) ? INSTANCE_STATUS[state] : UNKNOWN;
}

/** True while any VM in the list is still changing, so the list keeps polling. */
export function anyChanging(instances) {
  return instances.some((i) => instanceStatus(i.state).changing);
}

const SNAPSHOT_STATUS = Object.freeze({
  creating: { label: "Saving", tone: "busy", changing: true },
  available: { label: "Ready", tone: "ok", changing: false },
  deleting: { label: "Deleting", tone: "busy", changing: true },
  deleted: { label: "Deleted", tone: "idle", changing: false },
  error: { label: "Needs attention", tone: "bad", changing: false },
});

export function snapshotStatus(state) {
  return Object.hasOwn(SNAPSHOT_STATUS, state) ? SNAPSHOT_STATUS[state] : UNKNOWN;
}

/** A host counts as online when it was seen in the last 5 minutes (as the API's health check). */
export const HOST_ONLINE_SECONDS = 300;

export function hostStatus(host, now = new Date()) {
  const seen = host.lastSeenAt ? Date.parse(host.lastSeenAt) : NaN;
  const recent = Number.isFinite(seen) && now.getTime() - seen <= HOST_ONLINE_SECONDS * 1000;
  switch (host.state) {
    case "enrolled":
      return { label: "Waiting to connect", tone: "busy" };
    case "active":
      return recent ? { label: "Online", tone: "ok" } : { label: "Not responding", tone: "bad" };
    case "draining":
      return { label: "Draining", tone: "busy" };
    case "disabled":
      return { label: "Disabled", tone: "bad" };
    default:
      return { label: "Checking", tone: "busy" };
  }
}

/** Which actions make sense for a host in this state. */
export function hostActions(host) {
  return {
    drain: host.state === "active" || host.state === "enrolled",
    disable: host.state !== "disabled",
    enable: host.state === "draining" || host.state === "disabled",
  };
}

export function gb(memoryMb) {
  const value = memoryMb / 1024;
  return Number.isInteger(value) ? String(value) : value.toFixed(1);
}

/** "Small", or "2 vCPU, 3 GB" when the size matches no preset. */
export function sizeName(spec, presets = []) {
  const match = presets.find((p) => p.vcpu === spec.vcpu && p.memoryMb === spec.memoryMb);
  return match ? match.name : `${spec.vcpu} vCPU, ${gb(spec.memoryMb)} GB`;
}

/** "1 vCPU · 1 GB memory · 16 GB disk" */
export function sizeDetail(size) {
  return `${size.vcpu} vCPU · ${gb(size.memoryMb)} GB memory · ${size.diskGb} GB disk`;
}

const IMAGE_NAMES = Object.freeze({ "ubuntu-24.04": "Ubuntu 24.04", "debian-12": "Debian 12" });

export function imageName(imageId, images = []) {
  if (Object.hasOwn(IMAGE_NAMES, imageId)) return IMAGE_NAMES[imageId];
  const image = images.find((i) => i.id === imageId);
  return image ? image.name : "Linux";
}

/** The login user of each image's cloud build. The Proxmox driver creates the same users (packages/driver-proxmox/src/images.ts). */
const SSH_USERS = Object.freeze({ "ubuntu-24.04": "ubuntu", "debian-12": "debian" });

export function sshCommand(instance) {
  if (!instance.privateIp) return null;
  const user = Object.hasOwn(SSH_USERS, instance.spec.imageId) ? SSH_USERS[instance.spec.imageId] : "root";
  return `ssh ${user}@${instance.privateIp}`;
}

export function formatDate(iso, locale) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(locale, { day: "numeric", month: "short", year: "numeric" });
}

export function formatDateTime(iso, locale) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString(locale, { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

export function formatTime(iso, locale) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
}

/** "just now", "4 minutes ago", "3 hours ago", "2 days ago" */
export function timeAgo(iso, now = new Date()) {
  const ms = now.getTime() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return "just now";
  const units = [
    [86400, "day"],
    [3600, "hour"],
    [60, "minute"],
  ];
  for (const [size, name] of units) {
    if (s >= size) {
      const n = Math.floor(s / size);
      return `${n} ${name}${n === 1 ? "" : "s"} ago`;
    }
  }
  return "just now";
}

/** Usage hours: one decimal under 100, whole numbers above. */
export function hours(value) {
  if (!Number.isFinite(value) || value <= 0) return "0";
  if (value < 0.1) return "< 0.1";
  return value < 100 ? value.toFixed(1) : Math.round(value).toLocaleString("en-GB");
}

/** Capacity used and free, one line per resource: "2 of 4 vCPU", "6 GB memory". */
export function capacity(host) {
  const used = host.allocated ?? { vcpu: 0, memoryMb: 0, diskGb: 0 };
  const cap = host.capacity;
  return {
    used: [
      `${used.vcpu} of ${cap.vcpu} vCPU`,
      `${gb(used.memoryMb)} of ${gb(cap.memoryMb)} GB memory`,
      `${used.diskGb} of ${cap.diskGb} GB disk`,
    ],
    free: [
      `${Math.max(0, cap.vcpu - used.vcpu)} vCPU`,
      `${gb(Math.max(0, cap.memoryMb - used.memoryMb))} GB memory`,
      `${Math.max(0, cap.diskGb - used.diskGb)} GB disk`,
    ],
  };
}
