// Genera ./dist:
//  - copia public/ y documentos/
//  - optimiza las imágenes de assets-src/ a WebP
//  - genera un QR por documento + uno del sitio (logo UJAP al centro), estampado en cada ficha
//  - pre-renderiza el catálogo dentro de index.html
//  - genera qr.html, una hoja imprimible con todos los códigos QR
import { readdir, stat, mkdir, cp, rm, writeFile, readFile, access } from "node:fs/promises";
import { join, relative, extname, basename, sep } from "node:path";
import { createRequire } from "node:module";
import sharp from "sharp";
import QRCode from "qrcode";
import potrace from "potrace";
import { stampQR } from "./lib/stamp-qr.mjs";
import { fitPages } from "./lib/fit-pages.mjs";

// En GitHub la dirección viene de la variable SITE_URL; esta es la de respaldo para compilar en local.
const SITE_URL = (process.env.SITE_URL || "https://patrimonio-arquidiocesis-valencia.arq-hillary-ruiz.workers.dev").replace(/\/$/, "");

const SRC = "documentos";
const ASSETS = "assets-src";
const OUT = "dist";
const MAX_BYTES = 25 * 1024 * 1024;

const exists = (p) => access(p).then(() => true, () => false);
const prettify = (name) => basename(name, extname(name)).replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
const slugify = (s) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase()
  .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 60) || "documento";
const escHtml = (s) => s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".")) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else if (extname(entry.name).toLowerCase() === ".pdf") out.push(full);
  }
  return out;
}

// ---------- 1. Copiar estáticos ----------
await rm(OUT, { recursive: true, force: true });
await mkdir(join(OUT, "img"), { recursive: true });
await mkdir(join(OUT, "qr"), { recursive: true });
await cp("public", OUT, { recursive: true });
await cp(SRC, join(OUT, SRC), { recursive: true, filter: (s) => !basename(s).startsWith(".") });

// ---------- 2. Imágenes -> WebP ----------
const img = (f) => join(OUT, "img", f);
const logoSrc = join(ASSETS, "ujap-logo.jpg");
await sharp(logoSrc).resize({ width: 240 }).webp({ quality: 88 }).toFile(img("ujap-logo.webp"));
// Favicon sin fondo: se borra solo el blanco conectado con el borde (relleno por inundación), así el texto
// blanco dentro del escudo se conserva; borde suavizado para que no se vea dentado.
async function removeOuterWhite(input) {
  const { data, info } = await sharp(input).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const { width: w, height: h } = info, N = w * h;
  const white = (i) => Math.min(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
  // 1) "Engordar" el dibujo R px para cerrar las rendijas bajo la corona (así el relleno no entra al escudo)
  const R = Math.max(4, Math.round(Math.min(w, h) / 34));
  const ink = new Uint8Array(N); for (let i = 0; i < N; i++) ink[i] = white(i) < 225 ? 1 : 0;
  const nb = (i, f) => { const x = i % w, y = (i / w) | 0; if (x > 0) f(i - 1); if (x < w - 1) f(i + 1); if (y > 0) f(i - w); if (y < h - 1) f(i + w); };
  const dist = new Int32Array(N).fill(-1), queue = new Int32Array(N); let qh = 0, qt = 0;
  for (let i = 0; i < N; i++) if (ink[i]) { dist[i] = 0; queue[qt++] = i; }
  while (qh < qt) { const i = queue[qh++]; if (dist[i] >= R) continue; nb(i, (j) => { if (dist[j] < 0) { dist[j] = dist[i] + 1; queue[qt++] = j; } }); }
  // 2) Fondo = blanco alcanzable desde el borde sin cruzar el dibujo engordado (entra entre las puntas de la corona)
  const bg = new Uint8Array(N); qh = qt = 0;
  const push = (i) => { if (!bg[i] && dist[i] < 0) { bg[i] = 1; queue[qt++] = i; } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (qh < qt) nb(queue[qh++], push);
  // 3) Recuperar la franja de R px pegada al dibujo por fuera (blanco a ≤ R+1 px del fondo)
  const d2 = new Int32Array(N).fill(-1); qh = qt = 0;
  for (let i = 0; i < N; i++) if (bg[i]) { d2[i] = 0; queue[qt++] = i; }
  while (qh < qt) { const i = queue[qh++]; if (d2[i] > R) continue;
    nb(i, (j) => { if (d2[j] < 0 && !ink[j]) { d2[j] = d2[i] + 1; bg[j] = 1; queue[qt++] = j; } }); }
  // 4) Bajo la banda dorada solo es fondo lo que queda fuera de la silueta del escudo (envolvente convexa):
  //    así no se vacían zonas blancas del diseño abiertas a los lados (p. ej. el rizo de la cinta).
  let bandTop = h;                                                         // primera fila con tinta en ≥70 % del ancho (la banda dorada)
  for (let y = 0; y < h && bandTop === h; y++) { let c = 0; for (let x = 0; x < w; x++) c += ink[y * w + x]; if (c >= w * 0.7) bandTop = y; }
  const pts = [];
  for (let y = 0; y < h; y++) { let a = -1, b = -1; for (let x = 0; x < w; x++) if (ink[y * w + x]) { if (a < 0) a = x; b = x; }
    if (a >= 0) pts.push([a, y], [b + 1, y], [a, y + 1], [b + 1, y + 1]); }
  pts.sort((p, q) => p[0] - q[0] || p[1] - q[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const half = (list) => { const out = []; for (const p of list) { while (out.length >= 2 && cross(out.at(-2), out.at(-1), p) <= 0) out.pop(); out.push(p); } out.pop(); return out; };
  const hull = [...half(pts), ...half([...pts].reverse())];
  for (let y = bandTop; y < h; y++) {
    const yc = y + 0.5, xs = [];
    for (let k = 0; k < hull.length; k++) { const [x1, y1] = hull[k], [x2, y2] = hull[(k + 1) % hull.length];
      if ((y1 <= yc && y2 > yc) || (y2 <= yc && y1 > yc)) xs.push(x1 + (yc - y1) / (y2 - y1) * (x2 - x1)); }
    const lo = xs.length ? Math.min(...xs) : Infinity, hi = xs.length ? Math.max(...xs) : -Infinity;
    for (let x = 0; x < w; x++) { const i = y * w + x; if (x + 0.5 >= lo && x + 0.5 <= hi) bg[i] = 0; }
  }
  for (let i = 0; i < N; i++) {
    if (bg[i]) { data[i * 4 + 3] = 0; continue; }
    const x = i % w, y = (i / w) | 0;                                     // borde: transparencia parcial según lo blanco que sea
    const nearBg = (x > 0 && bg[i - 1]) || (x < w - 1 && bg[i + 1]) || (y > 0 && bg[i - w]) || (y < h - 1 && bg[i + w]);
    if (nearBg) data[i * 4 + 3] = Math.round(255 * Math.min(1, (255 - white(i)) / 90));
  }
  return sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}
const logoClear = await removeOuterWhite(logoSrc);
await sharp(logoClear).trim().resize(64, 64, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 90, alphaQuality: 100 }).toFile(img("favicon.webp"));
// Foto del encabezado (assets-src/iglesia.png) y sus créditos
const hero = {
  src: join(ASSETS, "iglesia.png"), pos: "50% 50%",
  alt: "Fachada del Templo Parroquial Inmaculado Corazón de María, en El Viñedo, Valencia",
  caption: "Templo Parroquial Inmaculado Corazón de María, El Viñedo, Valencia",
  credit: 'Foto: <a class="ig" href="https://www.instagram.com/p/DD42s0TPUU5/" target="_blank" rel="noopener" aria-label="Martín Ustáriz en Instagram"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="17.4" cy="6.6" r="1.2" fill="currentColor"/></svg>Martín Ustáriz</a>',
};
const heroMeta = await sharp(hero.src).metadata();
for (const w of [800, 1400, 2000]) {
  await sharp(hero.src).rotate().resize({ width: Math.min(w, heroMeta.width) }).webp({ quality: 72, effort: 6 }).toFile(img(`portada-${w}.webp`));
}
await sharp(hero.src).rotate().resize(1200, 630, { fit: "cover", position: "attention" }).webp({ quality: 72 }).toFile(img("og.webp"));

// Logo opcional de la Escuela de Arquitectura (assets-src/arquitectura.png|jpg|jpeg|svg|webp)
// Logo de la Escuela de Arquitectura: marca (cabecera) y versión completa (pie)
let hasArqLogo = false;
for (const [name, height] of [["arquitectura", 120], ["arquitectura-completo", 180]]) {
  for (const ext of ["png", "jpg", "jpeg", "svg", "webp"]) {
    const p = join(ASSETS, `${name}.${ext}`);
    if (await exists(p)) {
      await sharp(p, { density: 300 }).resize({ height }).webp({ quality: 85 }).toFile(img(`${name}.webp`));
      if (name === "arquitectura") hasArqLogo = true;
      break;
    }
  }
}

// Marca EAUJAP vectorizada (para dibujarla con animación en la pantalla de bienvenida)
let arqSvg = "";
const arqMark = join(ASSETS, "arquitectura.png");
if (await exists(arqMark)) {
  const svg = await new Promise((ok, fail) => potrace.trace(arqMark, { threshold: 128, turdSize: 8, optTolerance: 0.3 }, (e, r) => (e ? fail(e) : ok(r))));
  const [, w, h] = svg.match(/width="(\d+)" height="(\d+)"/);
  const d = svg.match(/ d="([^"]+)"/)[1].trim();
  const parts = d.split(/(?=M)/).map((p) => p.trim()).filter(Boolean);
  arqSvg = `<svg class="splash-arq" viewBox="0 0 ${w} ${h}" role="img" aria-label="Escuela de Arquitectura UJAP">`
    + `<path class="arq-fill" fill-rule="evenodd" d="${d}"/>`
    + parts.map((p, i) => `<path class="arq-line" pathLength="1" style="--k:${i}" d="${p}"/>`).join("")
    + `</svg>`;
}

// ---------- 3. QR con el logo UJAP al centro ----------
const QR_SIZE = 1000;
const logoBox = Math.round(QR_SIZE * 0.24);            // ~6% del área: seguro con corrección de errores H
const logoPad = Math.round(logoBox * 0.1);
const logoTile = await sharp({
  create: { width: logoBox, height: logoBox, channels: 4, background: "#ffffff" },
}).composite([
  { input: await sharp(logoSrc).resize(logoBox - logoPad * 2, logoBox - logoPad * 2, { fit: "contain", background: "#ffffff" }).toBuffer(), left: logoPad, top: logoPad },
]).png().toBuffer();

async function makeQR(text, file) {
  const qr = await QRCode.toBuffer(text, {
    errorCorrectionLevel: "H", margin: 3, width: QR_SIZE, color: { dark: "#231a16", light: "#ffffff" },
  });
  const size = (await sharp(qr).metadata()).width;
  const offset = Math.round((size - logoBox) / 2);
  await sharp(qr).composite([{ input: logoTile, left: offset, top: offset }])
    .webp({ lossless: true, effort: 6 }).toFile(join(OUT, "qr", file));
  return `/qr/${file}`;
}

const siteQR = await makeQR(SITE_URL + "/", "sitio.webp");

// ---------- 4. Índice de documentos ----------
// documentos/<Categoría>/[<Ubicación>/...]archivo.pdf
// Las categorías fijas aparecen siempre en el filtro (aunque estén vacías), en este orden.
const CATEGORIES = ["Vitrales", "Cuadros", "Muebles", "Mosaicos", "Esculturas"];
const docs = [];
const usedIds = new Set();
const srcOf = new Map();
for (const file of await walk(SRC)) {
  const rel = relative(SRC, file).split(sep);
  const info = await stat(file);
  if (info.size > MAX_BYTES) console.warn(`⚠  ${file} pesa más de 25 MB: Cloudflare no lo aceptará.`);
  const title = prettify(rel.at(-1));
  const folder = rel.length > 1 ? rel[0] : "";
  const category = CATEGORIES.find((c) => slugify(c) === slugify(folder)) ?? (folder || "Sin clasificar");
  if (!CATEGORIES.includes(category)) console.warn(`⚠  ${file}: muévelo a documentos/${CATEGORIES.join(", documentos/")}.`);
  const location = rel.slice(1, -1).join(" / ");
  let id = slugify(title), n = 2;
  while (usedIds.has(id)) id = `${slugify(title)}-${n++}`;
  usedIds.add(id);
  srcOf.set(id, { src: file, dest: join(OUT, SRC, ...rel) });
  docs.push({ id, title, category, location, url: "/" + [SRC, ...rel].map(encodeURIComponent).join("/"), size: info.size, modified: info.mtime.toISOString() });
}
const catOrder = (c) => (CATEGORIES.indexOf(c) + 1) || 99;
docs.sort((a, b) => catOrder(a.category) - catOrder(b.category) || a.title.localeCompare(b.title, "es"));
const categories = [...new Set([...CATEGORIES, ...docs.map((d) => d.category)])];
let stamped = 0;
for (const [i, d] of docs.entries()) {
  d.n = i + 1;
  d.link = `${SITE_URL}/?d=${d.id}`;
  d.qr = await makeQR(d.link, `${d.id}.webp`);
  // QR dentro de la casilla "CODIGO QR" de la ficha (solo en dist/; el original no se toca)
  const { src, dest } = srcOf.get(d.id);
  const r = await stampQR(src, dest, join(OUT, "qr", `${d.id}.webp`));
  if (r.ok) stamped++;
  else console.warn(`⚠  ${src}: ${r.reason}; se publica sin QR.`);
  // Una sola hoja ajustada al contenido (une fichas partidas en varias páginas)
  let fit = null;
  try { fit = await fitPages(dest); } catch (e) { console.warn(`⚠  ${src}: no se pudo ajustar la hoja (${e.message}); se publica tal cual.`); }
  d.size = (await stat(dest)).size;
  const joined = fit && fit.pages > 1 ? ` · ${fit.pages} páginas unidas en una` : "";
  console.log(`   ${r.ok ? `QR ${r.sizeCm} cm` : "sin QR"}${fit && !fit.skipped ? ` · hoja ${fit.width}×${fit.height} pt` : ""}${joined} → ${d.title}`);
}

// ---------- 5. Plantillas ----------
const fill = (html) => html
  .replaceAll("{{SITE_URL}}", SITE_URL)
  .replaceAll("{{SITE_QR}}", siteQR)
  .replaceAll("{{ARQ_SVG}}", arqSvg)
  .replaceAll("{{HERO_ALT}}", hero.alt)
  .replaceAll("{{HERO_CAPTION}}", hero.caption)
  .replaceAll("{{HERO_CREDIT}}", hero.credit)
  .replaceAll("{{HERO_POS}}", hero.pos)
  .replace(/<!--ARQ-->([\s\S]*?)<!--\/ARQ-->/g, hasArqLogo ? "$1" : "");

// Pre-renderizado: el catálogo llega ya dibujado en el HTML (mismo código que usa el navegador)
const require = createRequire(import.meta.url);
const CatalogView = require("./lib/catalog-view.cjs");
const viewSource = await readFile("lib/catalog-view.cjs", "utf8");
const inlineJSON = (v) => JSON.stringify(v).replaceAll("<", "\\u003c");   // evita cerrar la etiqueta <script>
const prerender = {
  "{{FACTS}}": CatalogView.facts(docs, categories),
  "{{COUNT}}": CatalogView.esc(CatalogView.count(docs, categories)),
  "{{CHIPS}}": CatalogView.chips(docs, categories, "Todas"),
  "{{RESULTS}}": CatalogView.results(docs, categories, "Todas", ""),
  "{{DATA}}": inlineJSON({ categorias: categories, documentos: docs }),
  "{{CATALOG_VIEW}}": viewSource.replace(/^if \(typeof module[^\n]*\n?/m, ""),
};
let indexHtml = fill(await readFile("public/index.html", "utf8"));
for (const [k, v] of Object.entries(prerender)) indexHtml = indexHtml.replaceAll(k, () => v);   // función: sin interpretar "$" del contenido
await writeFile(join(OUT, "index.html"), indexHtml);

const num = (n) => String(n).padStart(3, "0");
const qrSheet = docs.map((d) => `
    <figure class="label">
      <img src="${d.qr}" alt="QR de ${escHtml(d.title)}" width="300" height="300">
      <figcaption><span class="n">Nº ${num(d.n)}</span><strong>${escHtml(d.title)}</strong><span class="c">${escHtml(d.category)}</span></figcaption>
    </figure>`).join("");
await writeFile(join(OUT, "qr.html"), fill(await readFile("public/qr.html", "utf8")).replace("{{QR_LABELS}}", qrSheet));

console.log(`✓ ${docs.length} documento(s), ${docs.length + 1} QR (${stamped} insertados en sus fichas), imágenes WebP${hasArqLogo ? " (+ logo Arquitectura)" : ""} → ${OUT}/  [${SITE_URL}]`);
