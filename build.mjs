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
import { eaujap } from "./lib/eaujap.mjs";

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
const logoSrc = join(ASSETS, "ujap-logo.png");                            // escudo UJAP, ya sin fondo
await sharp(logoSrc).resize({ height: 240 }).webp({ quality: 88, alphaQuality: 100 }).toFile(img("ujap-logo.webp"));
await sharp(logoSrc).resize(64, 64, { fit: "contain", background: { r: 0, g: 0, b: 0, alpha: 0 } }).webp({ quality: 90, alphaQuality: 100 }).toFile(img("favicon.webp"));
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

// Marca EAUJAP vectorizada: animación de la pantalla de bienvenida (zigzag + letras) y, desde la misma
// geometría alineada, la imagen de la cabecera, para que la animación aterrice en un logo idéntico.
let arqSvg = "";
const arqMark = join(ASSETS, "arquitectura.png");
if (await exists(arqMark)) {
  const svg = await new Promise((ok, fail) => potrace.trace(arqMark, { threshold: 128, turdSize: 8, optTolerance: 0.3 }, (e, r) => (e ? fail(e) : ok(r))));
  const [, w, h] = svg.match(/width="(\d+)" height="(\d+)"/).map(Number);
  const mark = eaujap(svg.match(/ d="([^"]+)"/)[1].trim(), w, h, { ink: "#2b211c" });
  arqSvg = mark.splash;
  await sharp(Buffer.from(mark.static), { density: 144 }).resize({ height: 120 }).webp({ quality: 90, alphaQuality: 100 }).toFile(img("arquitectura.webp"));

  // Logo completo del pie: misma marca + textos. Se reemplaza SOLO la fila "EAUJAP" por las letras alineadas
  // (los textos pequeños se conservan tal cual, sin vectorizar).
  const fullSrc = join(ASSETS, "arquitectura-completo.png");
  if (await exists(fullSrc)) {
    const ink = async (file) => { const { data, info } = await sharp(file).flatten({ background: "#fff" }).greyscale().raw().toBuffer({ resolveWithObject: true });
      return { d: data, w: info.width, h: info.height, at: (x, y) => data[y * info.width + x] < 128 }; };
    const [F, M] = await Promise.all([ink(fullSrc), ink(arqMark)]);
    const firstX = (I) => { for (let x = 0; x < I.w; x++) for (let y = 0; y < Math.min(I.h, 300); y++) if (I.at(x, y)) return x; };
    const firstY = (I) => { for (let y = 0; y < I.h; y++) for (let x = 0; x < I.w; x++) if (I.at(x, y)) return y; };
    const ox = firstX(F) - firstX(M), oy = firstY(F) - firstY(M);         // dónde está la marca dentro del logo completo
    const [b0, b1] = mark.lettersBand;
    // En el pie solo se alinea en horizontal: debajo están los textos "ESCUELA DE ARQUITECTURA…"
    const footMark = eaujap(svg.match(/ d="([^"]+)"/)[1].trim(), w, h, { ink: "#000", moveDown: false });
    const letters = await sharp(Buffer.from(footMark.lettersOnly)).png().toBuffer();
    const full = await sharp(fullSrc).flatten({ background: "#fff" })
      .composite([
        { input: { create: { width: F.w, height: Math.round(b1 - b0 + 6), channels: 3, background: "#fff" } }, left: 0, top: Math.round(oy + b0 - 2) },
        { input: letters, left: ox, top: oy },
      ]).png().toBuffer();
    await sharp(full).resize({ height: 180 }).webp({ quality: 88 }).toFile(img("arquitectura-completo.webp"));
  }
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
