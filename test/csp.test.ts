// These tests check the test page itself: that the strict policy every other
// test relies on is really being enforced. If they fail, a passing component
// test proves nothing about Content-Security-Policy.
import { assertThrows, expectViolation, fixture, skip, test } from "./harness";

test("the page blocks an inline <style> element", async () => {
  const style = document.createElement("style");
  style.textContent = "#fixtures { outline: 1px solid red; }";
  fixture().append(style);
  await expectViolation("style-src");
});

test("the page enforces Trusted Types", async () => {
  if (!("trustedTypes" in window)) {
    skip("this engine does not implement Trusted Types");
  }
  const el = fixture();
  assertThrows(() => {
    el.innerHTML = "<b>x</b>";
  }, TypeError, "assigning a string to innerHTML");
  await expectViolation("require-trusted-types-for");
});
