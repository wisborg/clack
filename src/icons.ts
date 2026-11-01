/**
 * The few icons Clack draws, as inline SVG built element by element: no
 * markup is parsed, and nothing is fetched.
 */

const paths = {
  "chevron-left": ["M14.5 5.5 8 12l6.5 6.5"],
  "chevron-right": ["M9.5 5.5 16 12l-6.5 6.5"],
  // A photo with a line through it.
  "photo-off": [
    "M4 6.5A1.5 1.5 0 0 1 5.5 5h13A1.5 1.5 0 0 1 20 6.5v11a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 4 17.5z",
    "m4 16 4.5-4.5 3 3 2-2L20 17",
    "M3 3l18 18",
  ],
} satisfies Record<string, string[]>;

const svgNS = "http://www.w3.org/2000/svg";

/** An icon, sized and coloured by CSS (.icon, currentColor); hidden from screen readers, which hear its button's label. */
export function icon(name: keyof typeof paths): SVGSVGElement {
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", `icon icon-${name}`);
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("focusable", "false");
  for (const d of paths[name]) {
    const path = document.createElementNS(svgNS, "path");
    path.setAttribute("d", d);
    svg.append(path);
  }
  return svg;
}
