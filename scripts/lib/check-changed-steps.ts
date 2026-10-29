// @effect-diagnostics globalTimers:off - scheduling for the standalone check:changed script.
const GiB = 1024 ** 3;

export const positiveInteger = (value: string | undefined) => {
  const number = Number(value);
  return value !== undefined && Number.isInteger(number) && number > 0 ? number : undefined;
};

// A typecheck or test step can take several cores and gigabytes of memory, so
// allow one step per two cores and per 6 GiB of available memory.
export const defaultConcurrency = (cores: number, availableBytes: number) =>
  Math.max(1, Math.min(Math.floor(cores / 2), Math.floor(availableBytes / (6 * GiB))));

export const createLimiter = (concurrency: number) => {
  let active = 0;
  const queue: Array<() => void> = [];
  return async <A>(task: () => Promise<A>): Promise<A> => {
    if (active >= concurrency) await new Promise<void>((resolve) => queue.push(resolve));
    active++;
    try {
      return await task();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
};

export type StepOutcome = "pass" | "FAIL" | "TIMEOUT";

interface Child {
  stdout: NodeJS.ReadableStream | null;
  stderr: NodeJS.ReadableStream | null;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (status: number | null) => void): unknown;
}

// Collects a step's output and settles when it exits. Past timeoutMs it calls
// kill, which must end the whole process tree, and reports TIMEOUT whatever the
// exit status.
export const awaitStep = (child: Child, timeoutMs: number, kill: () => void) =>
  new Promise<{ outcome: StepOutcome; output: Buffer }>((resolve) => {
    const output: Array<Buffer> = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => output.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => output.push(chunk));
    // A failed spawn emits "error", then "close" with a nonzero code.
    child.on("error", (error) => output.push(Buffer.from(`${error.message}\n`)));
    child.on("close", (status) => {
      clearTimeout(timer);
      resolve({
        outcome: timedOut ? "TIMEOUT" : status === 0 ? "pass" : "FAIL",
        output: Buffer.concat(output),
      });
    });
  });
