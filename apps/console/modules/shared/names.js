/** Suggested names such as `swift-otter-12`: a lowercase DNS label, as the API requires. */

const ADJECTIVES = Object.freeze([
  "amber", "bold", "brave", "bright", "calm", "clear", "clever", "cosy", "crisp", "eager",
  "fair", "fast", "gentle", "glad", "grand", "happy", "keen", "kind", "lively", "lucky",
  "merry", "mild", "neat", "nimble", "noble", "quick", "quiet", "rapid", "sharp", "shiny",
  "silver", "smart", "snug", "solid", "steady", "sunny", "swift", "tidy", "vivid", "warm",
]);

const ANIMALS = Object.freeze([
  "badger", "bear", "beaver", "bison", "crane", "dolphin", "eagle", "falcon", "finch", "fox",
  "gecko", "hare", "heron", "ibis", "koala", "lark", "lemur", "lynx", "marten", "moose",
  "otter", "owl", "panda", "puffin", "quail", "raven", "robin", "seal", "sparrow", "stoat",
  "swan", "tiger", "wolf", "wren", "yak", "zebra",
]);

export const NAME_RE = /^[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/**
 * @param {() => number} [random] a source of numbers in [0, 1)
 * @param {Iterable<string>} [taken] names already in use
 */
export function suggestName(random = Math.random, taken = []) {
  const used = new Set(taken);
  for (let i = 0; i < 20; i += 1) {
    const adjective = ADJECTIVES[Math.floor(random() * ADJECTIVES.length)];
    const animal = ANIMALS[Math.floor(random() * ANIMALS.length)];
    const n = 10 + Math.floor(random() * 90);
    const name = `${adjective}-${animal}-${n}`;
    if (!used.has(name)) return name;
  }
  return `vm-${Date.now().toString(36)}`;
}

/** A suggested snapshot name, `snap-` and the local date and time: a lowercase label of at most 40 characters. */
export function suggestSnapshotName(now = new Date()) {
  const pad = (v) => String(v).padStart(2, "0");
  return `snap-${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}`;
}

export const SNAPSHOT_NAME_RE = /^[a-z][a-z0-9-]{0,39}$/;
