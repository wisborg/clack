// Chooses the page's colour scheme before it is drawn: ?scheme=light or
// ?scheme=dark when given (so screenshots can show both), the visitor's
// system setting otherwise. A file of its own because the pages are served
// under a policy that allows no inline script.
(() => {
  const asked = new URLSearchParams(location.search).get("scheme");
  const scheme =
    asked === "light" || asked === "dark"
      ? asked
      : matchMedia("(prefers-color-scheme: dark)").matches
        ? "dark"
        : "light";
  document.documentElement.dataset.scheme = scheme;
})();
