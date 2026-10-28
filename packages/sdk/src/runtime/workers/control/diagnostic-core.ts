import { createDiagnosticLongModeFixture } from "../../core-abi.js";
import type { Core } from "./core.js";
import { assertStatus, callNumber, readRecord, stage } from "./core.js";

export function loadDiagnosticLongMode(loaded: Core): bigint {
  const fixture = createDiagnosticLongModeFixture(readRecord(loaded, "cpu-state"));
  stage(loaded, fixture.cpuState);
  assertStatus(callNumber(loaded, "oxidevm_load_cpu_state", [fixture.cpuState.byteLength]));
  for (const region of fixture.memory) {
    stage(loaded, region.bytes);
    assertStatus(callNumber(loaded, "oxidevm_load_memory", [
      region.address,
      region.bytes.byteLength,
    ]));
  }
  return fixture.programAddress;
}
