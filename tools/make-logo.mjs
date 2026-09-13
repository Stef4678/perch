/* ============================================================================
   Perch — tools/make-logo.mjs
   Renders logo.png (256×256) from pure geometry + zlib. No image libraries.

   The mark: a browser window with a gradient title bar, an arrow dropping onto
   a shelf — "a perch for the things you attach from Eagle".

   Run:  node tools/make-logo.mjs
   This file is a build-time convenience and is not needed at plugin runtime.
   ========================================================================== */
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT_SIZE = 256;
const SS = 4;                     // supersample factor
const SIZE = OUT_SIZE * SS;       // render space

/* ───────────────────────── geometry helpers ───────────────────────── */

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const mix = (a, b, t) => a + (b - a) * t;

/** Signed distance to a rounded rectangle (negative inside). */
function sdRoundRect(px, py, x, y, w, h, r) {
    const cx = x + w / 2, cy = y + h / 2, hw = w / 2, hh = h / 2;
    const qx = Math.abs(px - cx) - (hw - r);
    const qy = Math.abs(py - cy) - (hh - r);
    const ax = Math.max(qx, 0), ay = Math.max(qy, 0);
    return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(qx, qy), 0) - r;
}

/** Signed distance to a thick line segment (round caps). */
function sdSegment(px, py, x1, y1, x2, y2, half) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy || 1;
    const t = clamp(((px - x1) * dx + (py - y1) * dy) / len2, 0, 1);
    const qx = px - (x1 + t * dx), qy = py - (y1 + t * dy);
    return Math.sqrt(qx * qx + qy * qy) - half;
}

/** Winding-free point-in-triangle test. */
function inTriangle(px, py, ax, ay, bx, by, cx, cy) {
    const d1 = (px - bx) * (ay - by) - (ax - bx) * (py - by);
    const d2 = (px - cx) * (by - cy) - (bx - cx) * (py - cy);
    const d3 = (px - ax) * (cy - ay) - (cx - ax) * (py - ay);
    const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
    const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
    return !(hasNeg && hasPos);
}

const sdCircle = (px, py, cx, cy, r) => Math.hypot(px - cx, py - cy) - r;

/* ───────────────────────── palette ───────────────────────── */

const STOPS = [
    { at: 0.00, rgb: [0x8b, 0x5c, 0xf6] },   // violet
    { at: 0.55, rgb: [0x6d, 0x5c, 0xff] },   // indigo
    { at: 1.00, rgb: [0x22, 0xd3, 0xee] }    // cyan
];

function gradientAt(t) {
    const v = clamp(t, 0, 1);
    for (let i = 0; i < STOPS.length - 1; i++) {
        const a = STOPS[i], b = STOPS[i + 1];
        if (v <= b.at) {
            const k = (v - a.at) / (b.at - a.at || 1);
            return [0, 1, 2].map((c) => mix(a.rgb[c], b.rgb[c], k));
        }
    }
    return STOPS[STOPS.length - 1].rgb.slice();
}

/* ───────────────────────── render ───────────────────────── */

const K = SS;                                  // shorthand scale
const bg = { x: 0, y: 0, w: SIZE, h: SIZE, r: 60 * K };

// mark geometry, in 256-space multiplied by SS
const win = { x: 40 * K, y: 38 * K, w: 176 * K, h: 100 * K, r: 20 * K };
const stripTop = win.y;
const stripBottom = win.y + 24 * K;
const dots = [62, 78, 94].map((x) => ({ x: x * K, y: 50 * K, r: 4.5 * K }));
const arrow = { x: 128 * K, y1: 148 * K, y2: 170 * K, half: 6.5 * K };
const arrowHead = { ax: 111 * K, ay: 166 * K, bx: 145 * K, by: 166 * K, cx: 128 * K, cy: 190 * K };
const perch = { x: 58 * K, y: 202 * K, w: 140 * K, h: 16 * K, r: 8 * K };

const rgba = Buffer.alloc(SIZE * SIZE * 4);

for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
        const px = x + 0.5, py = y + 0.5;

        // ── background: rounded square with a diagonal gradient ──
        if (sdRoundRect(px, py, bg.x, bg.y, bg.w, bg.h, bg.r) > 0) continue;

        const t = ((px / SIZE) * 0.55 + (py / SIZE) * 0.45);
        let [r, g, b] = gradientAt(t);

        // soft light source in the upper-left
        const glow = Math.max(0, 1 - Math.hypot(px - SIZE * 0.24, py - SIZE * 0.16) / (SIZE * 0.62));
        r = mix(r, 255, glow * 0.16);
        g = mix(g, 255, glow * 0.16);
        b = mix(b, 255, glow * 0.16);

        // inner hairline border
        const d = sdRoundRect(px, py, bg.x, bg.y, bg.w, bg.h, bg.r);
        if (d > -2.2 * K) {
            const k = clamp(1 - (-d) / (2.2 * K), 0, 1) * 0.28;
            r = mix(r, 255, k); g = mix(g, 255, k); b = mix(b, 255, k);
        }

        let alpha = 255;
        let color = [r, g, b];

        // ── window body ──
        if (sdRoundRect(px, py, win.x, win.y, win.w, win.h, win.r) <= 0) {
            color = [255, 255, 255];

            // gradient title strip, clipped to the window's top corners
            const inStrip = py >= stripTop && py <= stripBottom &&
                sdRoundRect(px, py, win.x, win.y, win.w, win.h, win.r) <= 0;
            if (inStrip) {
                const st = ((px / SIZE) * 0.55 + (py / SIZE) * 0.45);
                const [sr, sg, sb] = gradientAt(st);
                color = [sr * 0.92, sg * 0.92, sb * 0.92];
            }

            // window dots
            for (const dot of dots) {
                if (sdCircle(px, py, dot.x, dot.y, dot.r) <= 0) color = [255, 255, 255];
            }
        }

        // ── arrow (white, on the gradient background) ──
        if (sdSegment(px, py, arrow.x, arrow.y1, arrow.x, arrow.y2, arrow.half) <= 0) color = [255, 255, 255];
        if (inTriangle(px, py, arrowHead.ax, arrowHead.ay, arrowHead.bx, arrowHead.by, arrowHead.cx, arrowHead.cy)) {
            color = [255, 255, 255];
        }

        // ── perch bar ──
        if (sdRoundRect(px, py, perch.x, perch.y, perch.w, perch.h, perch.r) <= 0) color = [255, 255, 255];

        const i = (y * SIZE + x) * 4;
        rgba[i] = Math.round(clamp(color[0], 0, 255));
        rgba[i + 1] = Math.round(clamp(color[1], 0, 255));
        rgba[i + 2] = Math.round(clamp(color[2], 0, 255));
        rgba[i + 3] = alpha;
    }
}

/* ───────────────────────── downsample ───────────────────────── */

const out = Buffer.alloc(OUT_SIZE * OUT_SIZE * 4);
const samples = SS * SS;

for (let y = 0; y < OUT_SIZE; y++) {
    for (let x = 0; x < OUT_SIZE; x++) {
        let r = 0, g = 0, b = 0, a = 0;
        for (let sy = 0; sy < SS; sy++) {
            for (let sx = 0; sx < SS; sx++) {
                const i = ((y * SS + sy) * SIZE + (x * SS + sx)) * 4;
                const sa = rgba[i + 3] / 255;
                r += rgba[i] * sa;
                g += rgba[i + 1] * sa;
                b += rgba[i + 2] * sa;
                a += sa;
            }
        }
        const i = (y * OUT_SIZE + x) * 4;
        out[i] = a > 0 ? Math.round(r / a) : 0;
        out[i + 1] = a > 0 ? Math.round(g / a) : 0;
        out[i + 2] = a > 0 ? Math.round(b / a) : 0;
        out[i + 3] = Math.round((a / samples) * 255);
    }
}

/* ───────────────────────── PNG encoding ───────────────────────── */

const CRC_TABLE = (() => {
    const table = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c;
    }
    return table;
})();

function crc32(buf) {
    let c = -1;
    for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ -1) >>> 0;
}

function chunk(type, data) {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body), 0);
    return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(OUT_SIZE, 0);
ihdr.writeUInt32BE(OUT_SIZE, 4);
ihdr[8] = 8;    // bit depth
ihdr[9] = 6;    // RGBA
ihdr[10] = 0;   // deflate
ihdr[11] = 0;   // adaptive filtering
ihdr[12] = 0;   // no interlace

const raw = Buffer.alloc(OUT_SIZE * (OUT_SIZE * 4 + 1));
for (let y = 0; y < OUT_SIZE; y++) {
    raw[y * (OUT_SIZE * 4 + 1)] = 0;   // filter: none
    out.copy(raw, y * (OUT_SIZE * 4 + 1) + 1, y * OUT_SIZE * 4, (y + 1) * OUT_SIZE * 4);
}

const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
]);

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, '..', 'logo.png');
writeFileSync(target, png);
console.log('wrote ' + target + ' (' + png.length + ' bytes, ' + OUT_SIZE + '×' + OUT_SIZE + ')');
