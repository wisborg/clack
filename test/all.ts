// The test bundle's entry point. The harness is imported first so it is
// listening for policy violations before any test module runs.
import { run, type Report } from "./harness";
import "./csp.test";
import "./element.test";
import "./nav.test";
import "./slides.test";
import "./show.test";
import "./manifest.test";
import "./schema.test";
import "./schemas.test";
import "./thumbhash.test";
import "./theme.test";
import "./layout.test";

declare global {
  interface Window {
    clackTestRun?: Promise<Report>;
  }
}

window.clackTestRun = run();
