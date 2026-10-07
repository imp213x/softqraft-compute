import { MemoryComputeStore } from "../src/store/index.js";
import { behaviourSuite } from "./suites.js";

behaviourSuite("memory store", async () => new MemoryComputeStore());
