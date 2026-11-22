// Ajusta cada ficha a UNA sola hoja "a la medida":
//  - recorta cada página a su contenido impreso (el área de impresión de la hoja de cálculo),
//  - si la ficha se partió en varias páginas (p. ej. el pie quedó en la página 2), las apila
//    una debajo de la otra para que vuelva a verse completa,
//  - deja márgenes pequeños y uniformes.
// Cada página se coloca una sola vez, así que el texto sigue siendo seleccionable y sin duplicados.
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { PDFDocument } from "pdf-lib";

const require = createRequire(import.meta.url);
const _w = console.warn, _l = console.log;
console.warn = console.log = () => {};
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");
console.warn = _w; console.log = _l;

const MARGIN = 18;            // pt (~0,6 cm) alrededor de todo
const GAP = 0;                // entre páginas apiladas: 0 para que el corte se una sin costura
const mul = (a, b) => [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
const apply = (m, x, y) => [m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]];

/** Caja del contenido de una página (coordenadas PDF), limitada por el recorte de impresión si existe. */
async function contentBox(page) {
  const [px0, py0, px1, py1] = page.view;
  const mk = () => ({ x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity });
  const box = mk(), txtBox = mk(), imgBox = mk();   // box: líneas de la tabla (marcan exactamente dónde se cortó la hoja)
  const addTo = (b) => (x, y) => { b.x0 = Math.min(b.x0, x); b.x1 = Math.max(b.x1, x); b.y0 = Math.min(b.y0, y); b.y1 = Math.max(b.y1, y); };
  const add = addTo(box), addTxt = addTo(txtBox), addImg = addTo(imgBox);

  const ops = await page.getOperatorList(), O = pdfjs.OPS;
  let ctm = [1, 0, 0, 1, 0, 0], lastRect = null, clip = null; const stack = [];
  const ARGS = { [O.rectangle]: 4, [O.moveTo]: 2, [O.lineTo]: 2, [O.curveTo]: 6, [O.curveTo2]: 4, [O.curveTo3]: 4 };
  for (let i = 0; i < ops.fnArray.length; i++) {
    const fn = ops.fnArray[i], args = ops.argsArray[i];
    if (fn === O.save) stack.push(ctm);
    else if (fn === O.restore) ctm = stack.pop() ?? ctm;
    else if (fn === O.transform) ctm = mul(ctm, args);
    else if (fn === O.paintImageXObject || fn === O.paintInlineImageXObject || fn === O.paintImageMaskXObject) {
      for (const [x, y] of [[0, 0], [1, 1], [0, 1], [1, 0]]) addImg(...apply(ctm, x, y));
    } else if (fn === O.constructPath) {
      const [sub, a] = args; let k = 0; lastRect = null;
      for (const s of sub) {
        const n = ARGS[s] || 0, pts = a.slice(k, k + n);
        if (s === O.rectangle) {
          const c = [apply(ctm, pts[0], pts[1]), apply(ctm, pts[0] + pts[2], pts[1] + pts[3])];
          lastRect = { x0: Math.min(c[0][0], c[1][0]), x1: Math.max(c[0][0], c[1][0]), y0: Math.min(c[0][1], c[1][1]), y1: Math.max(c[0][1], c[1][1]) };
        }
        for (let j = 0; j + 1 < pts.length && s !== O.rectangle; j += 2) add(...apply(ctm, pts[j], pts[j + 1]));
        k += n;
      }
      // Un rectángulo usado como recorte: el primero que cubre casi toda la página es el área de impresión
      const next = ops.fnArray[i + 1];
      if (lastRect && (next === O.clip || next === O.eoClip)) {
        const big = (lastRect.x1 - lastRect.x0) > (px1 - px0) * 0.5 && (lastRect.y1 - lastRect.y0) > (py1 - py0) * 0.3;
        if (big && !clip && (lastRect.x1 - lastRect.x0) < (px1 - px0) - 1) clip = lastRect;
      } else if (lastRect) { add(lastRect.x0, lastRect.y0); add(lastRect.x1, lastRect.y1); }
    }
  }
  const tc = await page.getTextContent();
  for (const it of tc.items) if (it.str?.trim()) { addTxt(it.transform[4], it.transform[5]); addTxt(it.transform[4] + it.width, it.transform[5] + (it.height || 8)); }

  // El texto puede seguir "existiendo" aunque la hoja de cálculo lo recortara: solo cuenta si no hay tabla.
  // Sin tabla ni texto (p. ej. una ficha escaneada): se usan las imágenes.
  if (!isFinite(box.x0)) Object.assign(box, isFinite(txtBox.x0) ? txtBox : imgBox);
  if (!isFinite(box.x0)) return null;
  const c = clip || { x0: px0, y0: py0, x1: px1, y1: py1 };
  const r = { x0: Math.max(box.x0, c.x0, px0), y0: Math.max(box.y0, c.y0, py0), x1: Math.min(box.x1, c.x1, px1), y1: Math.min(box.y1, c.y1, py1) };
  return r.x1 - r.x0 > 2 && r.y1 - r.y0 > 2 ? r : null;
}

/** Reescribe `file` como una sola hoja ajustada al contenido. Devuelve {pages, width, height}. */
export async function fitPages(file) {
  const bytes = await readFile(file);
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false }).promise;
  const boxes = [];
  try { for (let p = 1; p <= doc.numPages; p++) boxes.push(await contentBox(await doc.getPage(p))); }
  finally { await doc.destroy(); }
  const parts = boxes.map((b, i) => ({ b, i })).filter((x) => x.b);
  if (!parts.length) return { pages: boxes.length, skipped: true };

  // Todas las partes alineadas a la misma columna (mismo borde izquierdo de la tabla)
  const left = Math.min(...parts.map((x) => x.b.x0)), right = Math.max(...parts.map((x) => x.b.x1));
  const W = right - left + 2 * MARGIN;
  const H = parts.reduce((h, x) => h + (x.b.y1 - x.b.y0), 0) + GAP * (parts.length - 1) + 2 * MARGIN;

  const src = await PDFDocument.load(bytes);
  const out = await PDFDocument.create();
  const page = out.addPage([W, H]);
  let top = H - MARGIN;
  for (const { b, i } of parts) {
    const box = { left, right, bottom: b.y0, top: b.y1 };          // misma anchura en todas: el corte encaja
    const emb = await out.embedPage(src.getPage(i), box);
    const h = b.y1 - b.y0;
    page.drawPage(emb, { x: MARGIN, y: top - h, width: right - left, height: h });
    top -= h + GAP;
  }
  out.setTitle(src.getTitle() || "");
  out.setProducer("Inventario de Patrimonio — UJAP");
  await writeFile(file, await out.save({ useObjectStreams: true }));
  return { pages: boxes.length, width: Math.round(W), height: Math.round(H) };
}
