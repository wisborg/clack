/**
 * A test harness small enough to read in one sitting: tests register with
 * `test`, run in order, and the report goes back to the WebDriver session
 * that is waiting for it (see tools/internal/browsertest).
 *
 * It also listens for Content-Security-Policy violations from the moment the
 * test bundle starts. A test that provokes one on purpose claims it with
 * `expectViolation`; any violation left unclaimed when the run ends fails
 * the run, because it means Clack did something the strict policy forbids.
 */

export interface Result {
  name: string;
  passed: boolean;
  /** Why the test could not run in this engine; empty if it ran. */
  skipped: string;
  error: string;
  ms: number;
}

export interface Report {
  userAgent: string;
  results: Result[];
  error: string;
}

interface Test {
  name: string;
  fn: () => void | Promise<void>;
}

const tests: Test[] = [];

/** Registers a test. */
export function test(name: string, fn: () => void | Promise<void>): void {
  tests.push({ name, fn });
}

class Skip extends Error {}

/** Ends the current test as skipped: the engine cannot run it. */
export function skip(reason: string): never {
  throw new Skip(reason);
}

/** Fails the test with message unless cond holds. */
export function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    throw new Error(message);
  }
}

/** Fails the test unless actual is expected (by Object.is). */
export function assertEqual<T>(actual: T, expected: T, what: string): void {
  if (!Object.is(actual, expected)) {
    throw new Error(`${what}: got ${String(actual)}, want ${String(expected)}`);
  }
}

/** Fails the test unless fn throws an instance of type. */
export function assertThrows(fn: () => unknown, type: new (...args: never[]) => Error, what: string): void {
  try {
    fn();
  } catch (e) {
    if (e instanceof type) {
      return;
    }
    throw new Error(`${what}: threw ${describe(e)}, want a ${type.name}`);
  }
  throw new Error(`${what}: did not throw`);
}

export interface Violation {
  directive: string;
  blocked: string;
  sample: string;
}

const violations: Violation[] = [];

document.addEventListener("securitypolicyviolation", (e) => {
  violations.push({ directive: e.effectiveDirective, blocked: e.blockedURI, sample: e.sample });
});

/**
 * Waits for a violation of a directive starting with `directive`, removes
 * it from the record and returns it. Violation events are delivered
 * asynchronously, so this polls rather than looking once.
 */
export async function expectViolation(directive: string, timeoutMs = 2000): Promise<Violation> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const i = violations.findIndex((v) => v.directive.startsWith(directive));
    if (i >= 0) {
      return violations.splice(i, 1)[0]!;
    }
    if (performance.now() > deadline) {
      throw new Error(`no ${directive} violation within ${timeoutMs} ms`);
    }
    await sleep(20);
  }
}

/** A fresh element to put a test's DOM in; emptied after each test. */
export function fixture(): HTMLElement {
  const root = document.getElementById("fixtures");
  assert(root, "the test page has no #fixtures element");
  const el = document.createElement("div");
  root.append(el);
  return el;
}

const perTestTimeoutMs = 10_000;

/** Runs every registered test, then the check for unclaimed violations. */
export async function run(): Promise<Report> {
  const results: Result[] = [];
  for (const t of tests) {
    results.push(await runOne(t));
    document.getElementById("fixtures")?.replaceChildren();
  }
  results.push(
    await runOne({
      name: "no Content-Security-Policy violations went unclaimed",
      fn: async () => {
        // Give any violation from the last test time to be delivered.
        await sleep(100);
        if (violations.length > 0) {
          throw new Error(violations.map((v) => `${v.directive} blocked ${v.blocked || "(inline)"} ${v.sample}`).join("\n"));
        }
      },
    }),
  );
  return { userAgent: navigator.userAgent, results, error: "" };
}

async function runOne(t: Test): Promise<Result> {
  const start = performance.now();
  const result: Result = { name: t.name, passed: false, skipped: "", error: "", ms: 0 };
  try {
    await withTimeout(Promise.resolve().then(t.fn), perTestTimeoutMs);
    result.passed = true;
  } catch (e) {
    if (e instanceof Skip) {
      result.skipped = e.message;
    } else {
      result.error = describe(e);
    }
  }
  result.ms = performance.now() - start;
  return result;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

function describe(e: unknown): string {
  if (e instanceof Error) {
    return e.stack && e.stack.includes(e.message) ? e.stack : `${e.name}: ${e.message}\n${e.stack ?? ""}`;
  }
  return String(e);
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
