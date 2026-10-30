// Renders the PWA/app icons to public/icons. Run after changing the design:
//   node scripts/generate-icons.mjs
import { writeFileSync } from "node:fs";
import { ImageResponse } from "next/og.js";

const PULSE =
  "M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2";

function icon(size, { maskable = false, radius = 0.22 } = {}) {
  const glyph = Math.round(size * (maskable ? 0.46 : 0.58));
  return {
    type: "div",
    props: {
      style: {
        width: size,
        height: size,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        background: "#0a0a0a",
        borderRadius: maskable ? 0 : size * radius,
      },
      children: {
        type: "svg",
        props: {
          width: glyph,
          height: glyph,
          viewBox: "0 0 24 24",
          fill: "none",
          stroke: "#3987e5",
          strokeWidth: 2,
          strokeLinecap: "round",
          strokeLinejoin: "round",
          children: { type: "path", props: { d: PULSE } },
        },
      },
    },
  };
}

const targets = [
  ["icon-192.png", 192, {}],
  ["icon-512.png", 512, {}],
  ["maskable-512.png", 512, { maskable: true }],
  ["apple-touch-icon.png", 180, { maskable: true }],
  ["favicon-32.png", 32, { radius: 0.25 }],
];
for (const [file, size, opts] of targets) {
  const res = new ImageResponse(icon(size, opts), { width: size, height: size });
  writeFileSync(`public/icons/${file}`, Buffer.from(await res.arrayBuffer()));
  console.log("wrote", file);
}
