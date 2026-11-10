import { createMemoryApiWorld } from "../support/memory-api-store";
import { describeApiStore } from "./store.contract";

describeApiStore("memory", async () => createMemoryApiWorld());
