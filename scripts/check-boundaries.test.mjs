import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { checkFile, checkManifest, importsOf } from "./check-boundaries.mjs";

describe("importsOf", () => {
  it("finds static, side-effect, re-export and dynamic imports", () => {
    const src = [
      'import a from "./a.js";',
      'import { b } from "../b/index.js";',
      'import type { C } from "./c.js";',
      'export { d } from "./d.js";',
      'export * from "./e.js";',
      'import "./f.js";',
      'const g = await import("./g.js");',
    ].join("\n");
    assert.deepEqual(importsOf(src), ["./a.js", "../b/index.js", "./c.js", "./d.js", "./e.js", "./f.js", "./g.js"]);
  });
});

describe("module boundaries", () => {
  const jobs = "apps/api/src/modules/jobs/index.ts";

  it("allows a module's own files and other modules' index", () => {
    assert.deepEqual(checkFile(jobs, 'import { x } from "./routes.js";\nimport type { H } from "../hosts/index.js";'), []);
  });

  it("refuses another module's internals", () => {
    const v = checkFile(jobs, 'import { x } from "../hosts/routes.js";');
    assert.equal(v.length, 1);
    assert.match(v[0], /internals of module "hosts"/);
  });

  it("refuses module internals from app code and tests", () => {
    assert.equal(checkFile("apps/api/src/app.ts", 'import "./modules/ipam/cidr.js";').length, 1);
    assert.equal(checkFile("apps/api/test/x.test.ts", 'import "../src/modules/ipam/cidr.js";').length, 1);
    assert.deepEqual(checkFile("apps/api/test/x.test.ts", 'import "../src/modules/ipam/index.js";'), []);
  });

  it("refuses store internals outside the store", () => {
    assert.equal(checkFile(jobs, 'import { PostgresComputeStore } from "../../store/postgres.js";').length, 1);
    assert.deepEqual(checkFile(jobs, 'import type { StoreTx } from "../../store/index.js";'), []);
    assert.deepEqual(checkFile("apps/api/src/store/index.ts", 'import "./postgres.js";'), []);
  });

  it("keeps lib free of modules and the store", () => {
    assert.equal(checkFile("apps/api/src/lib/http.ts", 'import "../modules/jobs/index.js";').length, 1);
    assert.equal(checkFile("apps/api/src/lib/http.ts", 'import "../store/index.js";').length, 1);
  });
});

describe("package boundaries", () => {
  it("refuses a package importing apps/ by path or name", () => {
    assert.equal(checkFile("packages/jobs/src/x.ts", 'import "../../../apps/api/src/app.js";').length, 1);
    assert.ok(checkFile("packages/jobs/src/x.ts", 'import "@softqraft/compute-api";').length >= 1);
  });

  it("refuses deep imports and cross-package paths", () => {
    assert.equal(checkFile("apps/api/src/app.ts", 'import "@softqraft/compute-jobs/src/envelope.js";').length, 1);
    assert.equal(checkFile("packages/jobs/src/x.ts", 'import "../../contracts/src/index.js";').length, 1);
    assert.deepEqual(checkFile("packages/jobs/src/x.ts", 'import "@softqraft/compute-contracts";'), []);
  });

  it("checks workspace dependencies per package", () => {
    assert.deepEqual(
      checkManifest("packages/jobs/package.json", {
        name: "@softqraft/compute-jobs",
        dependencies: { "@softqraft/compute-contracts": "workspace:*", zod: "^3" },
      }),
      [],
    );
    assert.equal(
      checkManifest("packages/contracts/package.json", {
        name: "@softqraft/compute-contracts",
        dependencies: { "@softqraft/compute-api": "workspace:*" },
      }).length,
      1,
    );
    assert.equal(checkManifest("packages/new/package.json", { name: "@softqraft/new" }).length, 1);
  });
});
