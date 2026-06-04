// Generate Capacitor asset sources (icon foreground/background, splash) from
// the project's vector logo. One-off helper for `npx capacitor-assets generate`.
const sharp = require("sharp");
const fs = require("fs");
const path = require("path");

const BG = "#0d1117"; // dark terminal background; light-blue logo pops on it
const OUT = path.resolve(__dirname, "../assets");
fs.mkdirSync(OUT, { recursive: true });

// Original logo shapes (viewBox -45 -40 90 80), re-centered on a square canvas.
function logoSvg(size, withBg, pad) {
  // Fit the 90x80 art into `size*(1-pad)` and center it at the canvas middle.
  const inner = size * (1 - pad);
  const s = Math.min(inner / 90, inner / 80);
  const c = size / 2;
  const bg = withBg ? `<rect width="${size}" height="${size}" fill="${BG}"/>` : "";
  return Buffer.from(
    `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">` +
      bg +
      `<g transform="translate(${c},${c}) scale(${s})">` +
      `<ellipse cx="0" cy="0" rx="38" ry="16" fill="none" stroke="#4af" stroke-width="3"/>` +
      `<path d="M-38,0 Q-10,-28 0,-28 Q10,-28 38,0" fill="none" stroke="#4af" stroke-width="3" stroke-linecap="round"/>` +
      `<circle cx="8" cy="-8" r="7" fill="#4af"/>` +
      `<path d="M-20,-22 Q-14,-32 -6,-30" fill="none" stroke="#4af" stroke-width="2.5" stroke-linecap="round"/>` +
      `</g></svg>`
  );
}

async function png(svg, size, file) {
  await sharp(svg, { density: 384 }).resize(size, size).png().toFile(path.join(OUT, file));
  console.log("wrote", file);
}

(async () => {
  // Adaptive icon: foreground = logo with safe-zone padding (transparent),
  // background = solid color.
  await png(logoSvg(1024, false, 0.42), 1024, "icon-foreground.png");
  await png(
    Buffer.from(`<svg width="1024" height="1024" xmlns="http://www.w3.org/2000/svg"><rect width="1024" height="1024" fill="${BG}"/></svg>`),
    1024,
    "icon-background.png"
  );
  // Legacy/single icon: logo on background.
  await png(logoSvg(1024, true, 0.3), 1024, "icon-only.png");
  await png(logoSvg(1024, true, 0.3), 1024, "logo.png");
  // Splash: logo centered, lots of padding.
  await png(logoSvg(2732, true, 0.66), 2732, "splash.png");
  await png(logoSvg(2732, true, 0.66), 2732, "splash-dark.png");
})();
