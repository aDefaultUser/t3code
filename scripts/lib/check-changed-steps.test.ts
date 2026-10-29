// @effect-diagnostics nodeBuiltinImport:off - drives the scheduler with fake child processes.
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import * as NodeEvents from "node:events";
import * as NodeStream from "node:stream";

import {
  awaitStep,
  createLimiter,
  defaultConcurrency,
  positiveInteger,
} from "./check-changed-steps.ts";

const GiB = 1024 ** 3;

describe("check:changed concurrency", () => {
  it("is bounded by the scarcer of cores and available memory, and at least 1", () => {
    expect(defaultConcurrency(32, 128 * GiB)).toBe(16);
    expect(defaultConcurrency(32, 20 * GiB)).toBe(3);
    expect(defaultConcurrency(4, 15 * GiB)).toBe(2);
    expect(defaultConcurrency(4, 2 * GiB)).toBe(1);
    expect(defaultConcurrency(1, 64 * GiB)).toBe(1);
  });

  it("accepts only positive integer overrides", () => {
    expect(positiveInteger("3")).toBe(3);
    for (const value of [undefined, "", "0", "-1", "1.5", "two"]) {
      expect(positiveInteger(value)).toBeUndefined();
    }
  });

  it("never runs more tasks than the limit, starts queued tasks in order, and frees a slot on failure", async () => {
    const limit = createLimiter(2);
    const gates = Array.from({ length: 4 }, () => Promise.withResolvers<void>());
    const started: Array<number> = [];
    const results = gates.map((gate, index) =>
      limit(async () => {
        started.push(index);
        await gate.promise;
        if (index === 0) throw new Error("step crashed");
        return index;
      }),
    );
    await Promise.resolve();
    expect(started).toEqual([0, 1]);

    gates[0]!.resolve();
    await expect(results[0]).rejects.toThrow("step crashed");
    expect(started).toEqual([0, 1, 2]);

    gates[2]!.resolve();
    await expect(results[2]).resolves.toBe(2);
    expect(started).toEqual([0, 1, 2, 3]);

    gates[1]!.resolve();
    gates[3]!.resolve();
    await expect(Promise.all(results.slice(1))).resolves.toEqual([1, 2, 3]);
  });
});

const fakeChild = () =>
  Object.assign(new NodeEvents.EventEmitter(), {
    stdout: new NodeStream.PassThrough(),
    stderr: new NodeStream.PassThrough(),
  });

describe("check:changed step timeout", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("reports exit status as pass or FAIL with the step's output", async () => {
    for (const [status, outcome] of [
      [0, "pass"],
      [2, "FAIL"],
    ] as const) {
      const child = fakeChild();
      const result = awaitStep(child, 1000, () => {});
      child.stdout.emit("data", Buffer.from("out "));
      child.stderr.emit("data", Buffer.from("err"));
      child.emit("close", status);
      await expect(result).resolves.toEqual({ outcome, output: Buffer.from("out err") });
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("kills the step at the deadline and reports TIMEOUT, not FAIL", async () => {
    const child = fakeChild();
    const kill = vi.fn(() => child.emit("close", null, "SIGKILL"));
    const result = awaitStep(child, 1000, kill);
    vi.advanceTimersByTime(999);
    expect(kill).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(kill).toHaveBeenCalledOnce();
    await expect(result).resolves.toMatchObject({ outcome: "TIMEOUT" });
  });
});
