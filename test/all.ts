// The test bundle's entry point. The harness is imported first so it is
// listening for policy violations before any test module runs.
import { run, type Report } from "./harness";
import "./csp.test";
import "./element.test";
import "./schemas.test";

declare global {
  interface Window {
    clackTestRun?: Promise<Report>;
  }
}

window.clackTestRun = run();
