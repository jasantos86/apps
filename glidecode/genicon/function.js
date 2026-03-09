// Custom SVG Icon Code Column for Glide
//
// Accepts any SVG code and returns it as a data URI image that
// automatically switches color between light mode and dark mode.
//
// HOW IT WORKS
// Most modern icon libraries (heroicons, Lucide, Phosphor, etc.) render
// their paths with fill="currentColor" or stroke="currentColor".
// "currentColor" means "inherit the CSS `color` property from the element."
// So we only need to inject one CSS rule that sets `color` on the <svg>
// element, and all paths inside pick it up automatically.
//
// HOW TO USE
// 1. Go to heroicons.com (or any icon site), pick your icon, click "Copy SVG"
// 2. Store that SVG string in a Glide column (e.g. a text column or computed value)
// 3. Map it to the "SVG code" parameter of this column
// 4. Set "Light mode color" and "Dark mode color" to any CSS color
//    (hex, rgb, hsl, or a named color like "white" / "black")
//
// TIPS
// - For heroicons: use the outline, solid, or mini variant — all work
// - For Lucide icons: copy SVG from lucide.dev — uses currentColor by default
// - For Phosphor icons: copy SVG from phosphoricons.com
// - The function strips width/height/class attributes so the image
//   scales cleanly inside Glide's image component
// - If your SVG does NOT use currentColor, the color params will have
//   no effect — you would need to pre-edit the SVG to use currentColor
//
// DEFAULTS
//   Light mode color : #111827  (near-black)
//   Dark mode color  : #f9fafb  (near-white)

window.function = function (svg, lightColor, darkColor) {
  svg        = (svg.value        ?? "").trim();
  lightColor = (lightColor.value ?? "").trim() || "#111827";
  darkColor  = (darkColor.value  ?? "").trim() || "#f9fafb";

  if (!svg) return undefined;

  // ── 1. Strip presentation attributes we don't want ──────────────────────
  // Remove class, width, and height so Glide can size the image freely.
  svg = svg.replace(/\s+class="[^"]*"/g, "");
  svg = svg.replace(/\s+width="[^"]*"/g,  "");
  svg = svg.replace(/\s+height="[^"]*"/g, "");

  // ── 2. Ensure xmlns is present (required for a standalone SVG data URI) ──
  if (!svg.includes("xmlns=")) {
    svg = svg.replace("<svg", '<svg xmlns="http://www.w3.org/2000/svg"');
  }

  // ── 3. Inject the dark-mode style block ─────────────────────────────────
  // We set `color` on the <svg> element. Paths using currentColor inherit it.
  const style = [
    "<style>",
    "  svg { color: " + lightColor + "; }",
    "  @media (prefers-color-scheme: dark) {",
    "    svg { color: " + darkColor + "; }",
    "  }",
    "</style>"
  ].join("");

  // Insert style immediately after the opening <svg ...> tag
  svg = svg.replace(/(<svg[^>]*>)/, "$1" + style);

  // ── 4. Return as a data URI ──────────────────────────────────────────────
  return "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
};
