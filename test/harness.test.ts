// The harness itself, where what it does is between tests: these run in
// order, the first leaving something for the harness to tidy, the next
// looking at how it did.
import { assert, assertEqual, fixture, input, mouse, test } from "./harness";
import { pointOn } from "./input";

/** What the pointer did after the first test pressed it, as the next sees. */
const after: string[] = [];
let pressedAt: { x: number; y: number } | null = null;
const listening = new AbortController();

test("(a test that ends with the mouse pressed, not waiting for it)", async () => {
  const spot = document.createElement("div");
  spot.style.height = "40px";
  fixture().append(spot);
  for (const type of ["pointermove", "pointerup"] as const) {
    document.addEventListener(type, (e) => {
      if (pressedAt) after.push(`${e.type} ${Math.round(e.clientX)},${Math.round(e.clientY)} buttons ${e.buttons}`);
    }, { signal: listening.signal });
  }
  const at = pointOn(spot);
  await input([mouse([{ type: "pointerMove", ...at }])]);
  pressedAt = at;
  // Pressed, and the test over before the driver has done it.
  void input([mouse([{ type: "pointerDown", button: 0 }])]);
});

test("what a test left pressed is let go of where it left it, before the mouse is put out of the way", () => {
  listening.abort();
  assert(pressedAt, "the test before pressed the mouse");
  const up = after.findIndex((e) => e.startsWith("pointerup"));
  assert(up >= 0, `let go of: ${after.join("; ") || "nothing heard"}`);
  assertEqual(after[up], `pointerup ${pressedAt.x},${pressedAt.y} buttons 0`, "where the test had it");
  assert(
    after.slice(0, up).every((e) => !e.startsWith("pointermove")),
    `not dragged anywhere first: ${after.slice(0, up).join("; ")}`,
  );
  assert(after.slice(up + 1).some((e) => e.startsWith("pointermove")), "then moved out of the way");
});

const afterRefused: string[] = [];
let refusedAt: { x: number; y: number } | null = null;
const listeningAgain = new AbortController();

test("(a test whose letting go is refused, as the driver is still pressing)", async () => {
  const spot = document.createElement("div");
  spot.style.height = "40px";
  fixture().append(spot);
  document.addEventListener("pointerup", (e) => afterRefused.push(`pointerup ${Math.round(e.clientX)},${Math.round(e.clientY)}`), { signal: listeningAgain.signal });
  const at = pointOn(spot);
  await input([mouse([{ type: "pointerMove", ...at }])]);
  refusedAt = at;
  void input([mouse([{ type: "pointerDown", button: 0 }])]);
  // Asked while the press is still under way: refused, so not done.
  await input([mouse([{ type: "pointerUp", button: 0 }])]).catch(() => undefined);
});

test("a press whose letting go was refused is still let go of after the test", () => {
  listeningAgain.abort();
  assert(refusedAt, "the test before pressed the mouse");
  assertEqual(afterRefused[0], `pointerup ${refusedAt.x},${refusedAt.y}`, "let go of, where the test had it");
});
