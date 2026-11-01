import { canStep, drawnWidth, preloadOrder, step, swipeOutcome } from "../src/nav";
import { assertEqual, test } from "./harness";

const list = (xs: number[]): string => xs.join(",");

test("step stops at the ends, or wraps when looping", () => {
  assertEqual(step(0, 5, 1, false), 1, "next");
  assertEqual(step(4, 5, 1, false), 4, "next at the end");
  assertEqual(step(0, 5, -1, false), 0, "previous at the start");
  assertEqual(step(4, 5, 1, true), 0, "next at the end, looping");
  assertEqual(step(0, 5, -1, true), 4, "previous at the start, looping");
  assertEqual(step(2, 5, -7, true), 0, "far back, looping");
  assertEqual(step(0, 0, 1, true), 0, "an empty show");
});

test("canStep says whether there is anywhere to go", () => {
  assertEqual(canStep(0, 5, -1, false), false, "back from the first");
  assertEqual(canStep(0, 5, -1, true), true, "back from the first, looping");
  assertEqual(canStep(4, 5, 1, false), false, "on from the last");
  assertEqual(canStep(0, 1, 1, true), false, "a show of one, even looping");
  assertEqual(canStep(2, 5, 1, false), true, "on from the middle");
});

test("preloadOrder loads ahead in the direction of travel", () => {
  assertEqual(list(preloadOrder(2, 10, 1, false)), "3,1,4", "forward from the middle");
  assertEqual(list(preloadOrder(2, 10, -1, false)), "1,3,0", "backward from the middle");
  assertEqual(list(preloadOrder(0, 10, 1, false)), "1,2", "forward from the first");
  assertEqual(list(preloadOrder(0, 10, 1, true)), "1,9,2", "forward from the first, looping");
  assertEqual(list(preloadOrder(0, 2, 1, true)), "1", "a show of two, looping: the other one, once");
  assertEqual(list(preloadOrder(0, 1, 1, true)), "", "a show of one");
});

test("drawnWidth is the width a photo is drawn at", () => {
  assertEqual(drawnWidth(800, 400, 1.5, "contain"), 600, "landscape, limited by height");
  assertEqual(drawnWidth(800, 800, 1.5, "contain"), 800, "landscape, limited by width");
  assertEqual(drawnWidth(800, 400, 1.5, "cover"), 800, "cover fills the width");
  assertEqual(drawnWidth(800, 800, 1.5, "cover"), 1200, "cover crops the sides");
  assertEqual(drawnWidth(801, 400, 0.6667, "contain"), 267, "rounded up, never short of a pixel");
  assertEqual(drawnWidth(0, 400, 1.5, "contain"), 0, "no frame yet");
});

test("swipeOutcome commits a long drag or a quick flick", () => {
  assertEqual(swipeOutcome(-150, 0, 600), -1, "a long drag left: the next");
  assertEqual(swipeOutcome(150, 0, 600), 1, "a long drag right: the previous");
  assertEqual(swipeOutcome(-60, -0.1, 600), 0, "a short, slow drag springs back");
  assertEqual(swipeOutcome(-60, -0.8, 600), -1, "a short flick goes on");
  assertEqual(swipeOutcome(-60, 0.8, 600), 0, "a drag left flicked back right springs back");
  assertEqual(swipeOutcome(-5, -2, 600), 0, "a twitch is not a flick");
});
