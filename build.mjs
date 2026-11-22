// Genera ./dist:
//  - copia public/ y documentos/
//  - optimiza las imágenes de assets-src/ a WebP
//  - genera documentos.json, un QR por documento + uno del sitio (logo UJAP al centro)
//  - genera qr.html, una hoja imprimible con todos los códigos QR
import { readdir, stat, mkdir, cp, rm, writeFile, readFile, access } from "node:fs/promises";
import { join, relative, extname, basename, sep } from "node:path";
import { createRequire } from "node:module";
import sharp from "sharp";
import QRCode from "qrcode";
import potrace from "potrace";
import { stampQR } from "./lib/stamp-qr.mjs";

// Cambia esto (o usa la variable SITE_URL) si Cloudflare te asigna otra dirección.
const SITE_URL = (process.env.SITE_URL || "https://patrimonio-arquidiocesis-valencia.manguito-dev.workers.dev").replace(/\/$/, "");

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
await sharp(logoSrc).resize(64, 64, { fit: "contain", background: "#ffffff" }).webp({ quality: 90 }).toFile(img("favicon.webp"));
// Foto del encabezado: la iglesia de la parroquia si existe assets-src/iglesia.*, si no la Catedral.
const HEROES = [
  { file: "iglesia", ratio: "4 / 3", pos: "50% 50%",
    alt: "Fachada del Templo Parroquial Inmaculado Corazón de María, en El Viñedo, Valencia",
    caption: "Templo Parroquial Inmaculado Corazón de María, El Viñedo, Valencia",
    credit: 'Foto: <a class="ig" href="https://www.instagram.com/p/DD42s0TPUU5/" target="_blank" rel="noopener" aria-label="Martín Ustáriz en Instagram"><svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="18" height="18" rx="5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="4.2" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="17.4" cy="6.6" r="1.2" fill="currentColor"/></svg>Martín Ustáriz</a>' },
  { file: "catedral", ratio: "4 / 5", pos: "55% 40%",
    alt: "Fachada de la Catedral Basílica de Valencia, con sus columnas corintias y la torre del reloj",
    caption: "Catedral Basílica de Nuestra Señora del Socorro, Valencia",
    credit: 'Foto: <a href="https://commons.wikimedia.org/wiki/File:CatedraldeValencia.JPG" target="_blank" rel="noopener">Diegoept</a>, <a href="https://creativecommons.org/licenses/by-sa/4.0/deed.es" target="_blank" rel="noopener">CC BY-SA 4.0</a>' },
];
let hero;
for (const h of HEROES) {
  for (const ext of ["jpg", "jpeg", "png", "webp"]) if (!hero && await exists(join(ASSETS, `${h.file}.${ext}`))) hero = { ...h, src: join(ASSETS, `${h.file}.${ext}`) };
}
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
  if (r.ok) { stamped++; d.size = (await stat(dest)).size; console.log(`   QR ${r.sizeCm} cm${r.stretched ? " (casilla agrandada)" : ""} → ${d.title}`); }
  else console.warn(`⚠  ${src}: ${r.reason}; se publica sin QR.`);
}
await writeFile(join(OUT, "documentos.json"), JSON.stringify({ categorias: categories, documentos: docs }, null, 2));

// ---------- 5. Plantillas ----------
const fill = (html) => html
  .replaceAll("{{SITE_URL}}", SITE_URL)
  .replaceAll("{{SITE_QR}}", siteQR)
  .replaceAll("{{ARQ_SVG}}", arqSvg)
  .replaceAll("{{HERO_ALT}}", hero.alt)
  .replaceAll("{{HERO_CAPTION}}", hero.caption)
  .replaceAll("{{HERO_CREDIT}}", hero.credit)
  .replaceAll("{{HERO_RATIO}}", hero.ratio)
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
