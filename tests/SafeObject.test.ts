import { expect, test } from "bun:test";
import { CSafeObject } from "../Common/CSafeObject.ts";
import { CPeImage } from "../Tools/OfficialSource.ts";

test("CSafeObject marks before its virtual hook and returns one only on the first, reentrancy-safe SetFree", () => {
  const events: number[][] = [];
  class TrackedObject extends CSafeObject {
    protected override SafeFree(): void {
      events.push([this.IsSetFree(), this.SetFree()]);
    }
  }
  const object = new TrackedObject();
  expect(object.IsSetFree()).toBe(0);
  expect(object.SetFree()).toBe(1);
  expect(object.IsSetFree()).toBe(1);
  expect(events).toEqual([[1, 0]]);
  expect(object.SetFree()).toBe(0);
  expect(events).toEqual([[1, 0]]);
});
test("a throwing free hook cannot clear the mark or cause a second free callback", () => {
  let calls = 0;
  class ThrowingObject extends CSafeObject {
    protected override SafeFree(): void {
      calls++;
      throw new Error("synthetic cleanup failure");
    }
  }
  const object = new ThrowingObject();
  expect(() => object.SetFree()).toThrow("synthetic cleanup failure");
  expect(object.IsSetFree()).toBe(1);
  expect(object.SetFree()).toBe(0);
  expect(calls).toBe(1);
});
test("actual FXGS PE anchors CUser+20 to CSafeObject's marked-free field, never to selfidx", () => {
  const pe = new CPeImage("FXGS/FxServer.exe");
  // lea edi,[esi+10h]; mov ecx,edi; call CSafeObject::CSafeObject (0042EB78).
  expect(pe.read(0x0041789a, 10).toString("hex")).toBe("8d7e108bcfe8d4720100");
  // IsSetFree: mov eax,[ecx+4]; ret. +16 base +4 member = CUser+20.
  expect(pe.read(0x00408de9, 4).toString("hex")).toBe("8b4104c3");
  // SetFree: push 1; lea eax,[esi+4]; push eax; call InterlockedExchange.
  expect(pe.read(0x0042eb8f, 12).toString("hex")).toBe(
    "6a018d460450ff1518b14800",
  );
});
