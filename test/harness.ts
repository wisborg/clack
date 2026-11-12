/**
 * A test harness small enough to read in one sitting: tests register with
 * `test`, run in order, and the report goes back to the WebDriver session
 * that is waiting for it (see tools/internal/browsertest). A test may ask
 * that session, as it runs, for the visitor's own pointer and keys
 * (`input`; test/input.ts has the words for it).
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
  /**
   * Whether the page was hidden at any time during the run. A hidden page's
   * timers and animations are throttled or stopped (Safari, when its window
   * is behind a full-screen app or on another desktop), so timeouts that
   * follow say more about the window than about the code.
   */
  hidden: boolean;
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
export function assertThrows(fn: () => unknown, type: new (...args: never[]) => Error, what: string, message?: RegExp): void {
  try {
    fn();
  } catch (e) {
    if (e instanceof type && (!message || message.test(e.message))) {
      return;
    }
    throw new Error(`${what}: threw ${describe(e)}, want a ${type.name}${message ? ` matching ${message}` : ""}`);
  }
  throw new Error(`${what}: did not throw`);
}

export interface Violation {
  directive: string;
  blocked: string;
  sample: string;
  /** Order of arrival, so a test can tell its own violations from older ones. */
  seq: number;
}

let wasHidden = document.visibilityState === "hidden";
document.addEventListener("visibilitychange", (e) => {
  // The browser's own events only: a test may send one of its own.
  if (e.isTrusted && document.visibilityState === "hidden") wasHidden = true;
});

const violations: Violation[] = [];
let nextSeq = 0;
/** The first sequence number the running test may claim. */
let testStartSeq = 0;

document.addEventListener("securitypolicyviolation", (e) => {
  violations.push({ directive: e.effectiveDirective, blocked: e.blockedURI, sample: e.sample, seq: nextSeq++ });
});

/**
 * Waits for a violation of a directive starting with `directive`, raised
 * since the current test began, removes it from the record and returns it.
 * A violation from before the test is never claimed: it belongs to whatever
 * caused it, and is left for the final check to report. Violation events
 * are delivered asynchronously, so this polls rather than looking once.
 */
export async function expectViolation(directive: string, timeoutMs = 2000): Promise<Violation> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    const i = violations.findIndex((v) => v.seq >= testStartSeq && v.directive.startsWith(directive));
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

// ---- The visitor's input, from the driver ----------------------------------

/** One of the WebDriver protocol's actions (the "Actions" section of its spec). */
export type Action =
  | { type: "pause"; duration?: number }
  | { type: "pointerMove"; x: number; y: number; origin?: "viewport" | "pointer"; duration?: number }
  | { type: "pointerDown" | "pointerUp"; button: number }
  | { type: "keyDown" | "keyUp"; value: string };

/** An input source and what it does: a mouse, a pen, a finger, or keys. */
export interface InputSource {
  type: "pointer" | "key" | "none";
  id: string;
  parameters?: { pointerType: "mouse" | "pen" | "touch" };
  actions: Action[];
}

/** What the page asks of the driver (drive in tools/internal/browsertest): one at a time. */
type ToDriver = { input: InputSource[] } | { release: true } | { focus: true } | { report: Report };

/** Asked, and not yet collected by the driver. */
const outbox: ToDriver[] = [];
/** The driver, waiting for what is asked next. */
let collect: ((m: ToDriver) => void) | null = null;
/** The test, waiting for the driver to say it did what was asked. */
let answered: ((error: string) => void) | null = null;
/** What was last asked, until the driver has answered it, failed or not. */
let inFlight: Promise<void> = Promise.resolve();
/** Whether the running test gave input: let go of after it; and moved the pointer: put out of the way after it. */
let gaveInput = false;
let movedPointer = false;

/** This page's run, named in every message (clackNext). */
const runName = Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, "0")).join("");

function send(m: ToDriver): void {
  if (collect) {
    const c = collect;
    collect = null;
    c(m);
  } else {
    outbox.push(m);
  }
}

function ask(m: ToDriver): Promise<void> {
  if (answered) return Promise.reject(new Error("input asked for while the driver is still giving the last"));
  const asked = new Promise<void>((resolve, reject) => {
    answered = (error) => (error ? reject(new Error(`the driver could not give the input: ${error}`)) : resolve());
    send(m);
  });
  inFlight = asked.catch(() => undefined);
  return asked;
}

/** The pointer the tests move: one source, with the same id and parameters every time, as the driver requires. */
export function mouse(actions: Action[]): InputSource {
  return { type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions };
}

/**
 * Has the driver perform sources, as the visitor's own input: trusted
 * events, which the browser acts on as on a visitor's -- :hover, how focus
 * came (:focus-visible), Tab moving it -- as no event a script makes can
 * have it. What is still pressed when the test ends is let go of then.
 */
export function input(sources: InputSource[]): Promise<void> {
  gaveInput = true;
  movedPointer ||= sources.some((s) => s.type === "pointer");
  return ask({ input: sources });
}

/**
 * Has the driver give the page's window the focus, if it has not: for a
 * test of what focus does, since without it focusing fires no focus events.
 * Headless Firefox loses it a moment after it starts; a Safari window the
 * visitor has left behind another has lost it too. Waits a moment for it to
 * come, and returns whether it did.
 */
export async function focusWindow(): Promise<boolean> {
  if (document.hasFocus()) return true;
  try {
    await ask({ focus: true });
  } catch (e) {
    // A driver that cannot, as a window that will not; anything else --
    // a driver gone wrong, input still under way -- is a failure.
    if (e instanceof Error && e.message.includes("unsupported operation")) return false;
    throw e;
  }
  const deadline = performance.now() + 1000;
  while (!document.hasFocus() && performance.now() < deadline) await sleep(20);
  return document.hasFocus();
}

/**
 * Starts the run, for the driver to follow: it calls clackNext with its
 * answer to what was last asked (null at first; "" when done, or why it
 * could not), and is given what is asked next -- input, or the report.
 */
export function start(): void {
  window.clackNext = (answer: string | null, run: string | null): Promise<unknown> => {
    // Another run's answer: this page is not the one that asked -- it was
    // reloaded, and its run started afresh, perhaps asking already. Said,
    // rather than take the answer for its own and run again from the first
    // test, with what the first run found lost.
    if (run !== null && run !== runName) return Promise.resolve({ gone: true });
    if (answer !== null && answered) {
      const a = answered;
      answered = null;
      a(answer);
    }
    return new Promise<ToDriver>((resolve) => {
      const m = outbox.shift();
      if (m) resolve(m);
      else collect = resolve;
    }).then((m) => ({ ...m, run: runName }));
  };
  run().then(
    (report) => send({ report }),
    (e: unknown) => send({ report: { userAgent: navigator.userAgent, hidden: wasHidden, results: [], error: wellFormed(describe(e)) } }),
  );
}

declare global {
  interface Window {
    clackNext?: (answer: string | null, run: string | null) => Promise<unknown>;
  }
}

// ---- Running ---------------------------------------------------------------

const perTestTimeoutMs = 10_000;

/**
 * The whole run's budget: well inside the run's timeout in
 * tools/internal/browsertest (runTimeout), with room for what the driver
 * does between tests, so that a slow run still comes back as a report of
 * what passed and what did not, rather than as a timeout with no results.
 */
const runBudgetMs = 5 * 60_000;

class Timeout extends Error {}

/** Runs every registered test, then the check for unclaimed violations. */
async function run(): Promise<Report> {
  const results: Result[] = [];
  const deadline = performance.now() + runBudgetMs;
  // Set when a test timed out. Its code may still be running -- a promise
  // cannot be cancelled -- so anything that happened afterwards could be its
  // doing. The remaining tests are reported as not run rather than blamed.
  let abandoned = "";
  for (const t of tests) {
    if (!abandoned && performance.now() > deadline) {
      abandoned = `the run exceeded its ${runBudgetMs / 1000} s budget`;
    }
    if (abandoned) {
      results.push({ name: t.name, passed: false, skipped: "", error: `not run: ${abandoned}`, ms: 0 });
      continue;
    }
    const r = await runOne(t);
    results.push(r);
    // What the test left pressed is let go of while its DOM is there to
    // hear it, where the test left it -- once input the test did not wait
    // for is done -- and then the pointer put where no later test's will be.
    if (gaveInput && !r.timedOut) {
      const moved = movedPointer;
      gaveInput = movedPointer = false;
      try {
        await inFlight;
        await ask({ release: true });
        if (moved) await rest();
      } catch (e) {
        // Said even of a test that failed or skipped: what it left held
        // may fail the next, which should not be the only sign of it.
        const after = wellFormed(`after the test, letting go of its input: ${describe(e)}`);
        Object.assign(r, { passed: false, skipped: "", error: r.error ? `${r.error}\n${after}` : after });
      }
    }
    document.getElementById("fixtures")?.replaceChildren();
    if (r.timedOut) {
      abandoned = `"${t.name}" timed out and may still be running`;
    }
  }
  if (abandoned) {
    return { userAgent: navigator.userAgent, hidden: wasHidden, results, error: `stopped early: ${abandoned}` };
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
  return { userAgent: navigator.userAgent, hidden: wasHidden, results, error: "" };
}

/**
 * Moves the mouse onto a spot of its own, over everything at the
 * viewport's corner: a pointer left where a test had it would rest on, and
 * hover, whatever the next test puts there.
 */
async function rest(): Promise<void> {
  let spot = document.getElementById("rest");
  if (!spot) {
    spot = document.createElement("div");
    spot.id = "rest";
    Object.assign(spot.style, { position: "fixed", right: "0", bottom: "0", width: "4px", height: "4px", zIndex: "2147483647" });
    document.body.append(spot);
  }
  const r = spot.getBoundingClientRect();
  await ask({ input: [mouse([{ type: "pointerMove", x: Math.floor(r.left + 2), y: Math.floor(r.top + 2) }])] });
}

async function runOne(t: Test): Promise<Result & { timedOut: boolean }> {
  // Tell the server which test is starting, so that if the browser itself
  // goes down the run can say during which (tools/internal/browsertest).
  // A beacon is sent even if the page dies straight after.
  navigator.sendBeacon("/progress", t.name);
  testStartSeq = nextSeq;
  const start = performance.now();
  const result = { name: t.name, passed: false, skipped: "", error: "", ms: 0, timedOut: false };
  try {
    await withTimeout(Promise.resolve().then(t.fn), perTestTimeoutMs);
    result.passed = true;
  } catch (e) {
    if (e instanceof Skip) {
      result.skipped = e.message;
    } else {
      result.timedOut = e instanceof Timeout;
      result.error = describe(e);
    }
  }
  result.ms = performance.now() - start;
  result.error = wellFormed(result.error);
  result.skipped = wellFormed(result.skipped);
  return result;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Timeout(`timed out after ${ms} ms`)), ms);
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

/**
 * Text as WebDriver can carry it: a lone surrogate (a test of them may fail
 * with one in its message) is replaced, or the whole report is lost.
 */
function wellFormed(text: string): string {
  return text.replace(/\p{Cs}/gu, "\uFFFD");
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
