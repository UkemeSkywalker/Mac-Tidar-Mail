// Builds the web logo assets from designs/MacTidar Mail logos/. Run: node scripts/brand-assets.cjs
// (sharp comes with Next.js, so there is nothing extra to install.)
// Cleans the neon-green fringe left around the transparent logo, then writes the mark, the
// horizontal logo, and the favicon set (app/icon.png, app/apple-icon.png, app/favicon.ico).
const fs = require("fs");
const sharp = require("sharp");

const SRC = "designs/MacTidar Mail logos/MacTidar Mail Logo_transparent_bg.png";
const MARK_MAX_X = 880; // the M mark sits left of this column; the wordmark sits right of it
const clear = { r: 0, g: 0, b: 0, alpha: 0 };

function clean(data, W, H) {
  const N = W * H, A = p => data[p * 4 + 3];
  for (let p = 0; p < N; p++) {
    if (A(p) < 40) data[p * 4 + 3] = 0;
    // the mark has no near-black pixels, so any there are background halo
    else if (p % W < MARK_MAX_X && data[p * 4 + 1] < 70) data[p * 4 + 3] = 0;
  }
  // peel neon-green fringe pixels that touch transparency
  const neon = p => { const r = data[p * 4], g = data[p * 4 + 1], b = data[p * 4 + 2]; return g >= 232 && g - r > 130 && g - b > 110; };
  for (let pass = 0; pass < 3; pass++) {
    const kill = [];
    for (let p = 0; p < N; p++) {
      if (!A(p) || !neon(p)) continue;
      const x = p % W, y = (p / W) | 0;
      let edge = false;
      for (let dy = -2; dy <= 2 && !edge; dy++) for (let dx = -2; dx <= 2; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || !A(ny * W + nx)) { edge = true; break; }
      }
      if (edge) kill.push(p);
    }
    for (const p of kill) data[p * 4 + 3] = 0;
  }
}

function bbox(data, W, H, x1) {
  let l = W, t = H, r = 0, b = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < x1; x++) if (data[(y * W + x) * 4 + 3] > 8) { l = Math.min(l, x); t = Math.min(t, y); r = Math.max(r, x); b = Math.max(b, y); }
  return { left: l, top: t, width: r - l + 1, height: b - t + 1 };
}

// Single-image PNGs packed into an .ico container (supported by every current browser).
function ico(pngs, sizes) {
  const head = Buffer.alloc(6 + 16 * pngs.length);
  head.writeUInt16LE(1, 2); head.writeUInt16LE(pngs.length, 4);
  let off = head.length;
  pngs.forEach((p, i) => {
    const o = 6 + 16 * i;
    head[o] = head[o + 1] = sizes[i];
    head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6);
    head.writeUInt32LE(p.length, o + 8); head.writeUInt32LE(off, o + 12);
    off += p.length;
  });
  return Buffer.concat([head, ...pngs]);
}

(async () => {
  const { data, info } = await sharp(SRC).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const W = info.width, H = info.height;
  clean(data, W, H);
  const img = () => sharp(data, { raw: { width: W, height: H, channels: 4 } });
  const mark = await img().extract(bbox(data, W, H, MARK_MAX_X)).png().toBuffer();
  const square = async (size, pad, background = clear) => {
    const inner = Math.round(size * (1 - 2 * pad));
    const m = await sharp(mark).resize(inner, inner, { fit: "contain", background: clear }).toBuffer();
    return sharp({ create: { width: size, height: size, channels: 4, background } }).composite([{ input: m }]).png({ compressionLevel: 9 });
  };

  fs.mkdirSync("public/brand", { recursive: true });
  await sharp(mark).resize({ height: 128 }).webp({ quality: 90, alphaQuality: 100 }).toFile("public/brand/mark.webp");
  await img().extract(bbox(data, W, H, W)).resize({ height: 144 }).webp({ quality: 90, alphaQuality: 100 }).toFile("public/brand/logo.webp");
  await (await square(192, 0.02)).toFile("app/icon.png");
  await (await square(180, 0.14, { r: 255, g: 255, b: 255, alpha: 1 })).flatten({ background: "#ffffff" }).toFile("app/apple-icon.png");
  const sizes = [16, 32, 48];
  fs.writeFileSync("app/favicon.ico", ico(await Promise.all(sizes.map(async s => (await square(s, 0)).toBuffer())), sizes));
})();
