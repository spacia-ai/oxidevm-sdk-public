import { unavailableNodeApi } from "./node-capability.ts";

export const nodeV8Memory = Object.freeze({
  serialize: () => unavailableNodeApi("v8.serialize"),
  getHeapStatistics: () => unavailableNodeApi("v8.getHeapStatistics"),
  getHeapSpaceStatistics: () => unavailableNodeApi("v8.getHeapSpaceStatistics"),
  getHeapCodeStatistics: () => unavailableNodeApi("v8.getHeapCodeStatistics"),
  getHeapSnapshot: () => unavailableNodeApi("v8.getHeapSnapshot"),
  writeHeapSnapshot: () => unavailableNodeApi("v8.writeHeapSnapshot"),
  setHeapSnapshotNearHeapLimit: () => unavailableNodeApi("v8.setHeapSnapshotNearHeapLimit"),
  setFlagsFromString: () => unavailableNodeApi("v8.setFlagsFromString"),
});

export const processMemoryUsage = Object.assign(() => unavailableNodeApi("process.memoryUsage"), {
  rss: () => unavailableNodeApi("process.memoryUsage.rss"),
});
