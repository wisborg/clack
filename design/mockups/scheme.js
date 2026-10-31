// Forces a colour scheme when the URL asks for one with ?scheme=light or
// ?scheme=dark, so screenshots can show both. Without it the page follows
// the visitor's system setting through CSS alone (color-scheme and
// light-dark() in mockups.css), live, and needs no script at all. A file of
// its own because the pages are served under a policy that allows no
// inline script.
(() => {
  const asked = new URLSearchParams(location.search).get("scheme");
  if (asked === "light" || asked === "dark") {
    document.documentElement.dataset.scheme = asked;
  }
})();
