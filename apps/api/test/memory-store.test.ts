import { MemoryComputeStore } from "../src/store/index.js";
import { raceSuite } from "./races.js";
import { behaviourSuite } from "./suites.js";

behaviourSuite("memory store", async () => new MemoryComputeStore());
raceSuite("memory store", async () => new MemoryComputeStore(), { concurrent: false });
