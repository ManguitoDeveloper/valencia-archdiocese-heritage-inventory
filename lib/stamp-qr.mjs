// Inserta el código QR de cada ficha en su casilla "CODIGO QR" del PDF.
// Por defecto AGRANDA la casilla: reduce un poco la foto de la ficha (sin recortarla),
// sube la fila "CODIGO DE FICHA" y estira la fila "CODIGO DE OBJETO" para que el QR mida ~3 cm.
//
// Edita la página "quirúrgicamente": mueve los bloques de texto reescribiendo su posición,
// borra el texto "CODIGO QR" y vuelve a dibujar la foto y las líneas. Así el texto sigue siendo
// texto real (seleccionable y buscable), sin duplicados, y el PDF apenas crece.
// Se ejecuta automáticamente desde build.mjs; el PDF original no se modifica.
import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { PDFDocument, PDFArray, PDFName, decodePDFRawStream } from "pdf-lib";
import sharp from "sharp";

const require = createRequire(import.meta.url);
const _w = console.warn, _l = console.log;
console.warn = console.log = () => {};          // pdf.js avisa de que no hay "canvas" (no lo necesitamos)
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");
console.warn = _w; console.log = _l;

const TARGET_QR = 2.9 / 2.54 * 72;              // tamaño deseado del QR: 2,9 cm (en puntos)
const MAX_PHOTO_SHRINK = 0.3;                   // la foto nunca pierde más del 30 % de su alto
const PAD = 3;                                  // margen blanco alrededor del QR (pt)

const norm = (s) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toUpperCase().replace(/\s+/g, " ").trim();
const mul = (a, b) => [a[0]*b[0]+a[2]*b[1], a[1]*b[0]+a[3]*b[1], a[0]*b[2]+a[2]*b[3], a[1]*b[2]+a[3]*b[3], a[0]*b[4]+a[2]*b[5]+a[4], a[1]*b[4]+a[3]*b[5]+a[5]];
const apply = (m, x, y) => [m[0]*x + m[2]*y + m[4], m[1]*x + m[3]*y + m[5]];
const n = (v) => +v.toFixed(4);

// ---------------------------------------------------------------------------
// 1) Análisis con pdf.js: texto "CODIGO QR", líneas de la tabla e imágenes (coordenadas PDF)
// ---------------------------------------------------------------------------
async function analyze(bytes) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0, isEvalSupported: false }).promise;
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const page = await doc.getPage(p);
      const items = (await page.getTextContent()).items.filter((it) => it.str?.trim());
      let hit = null;
      for (let i = 0; i < items.length && !hit; i++) {
        const a = items[i], ta = norm(a.str);
        if (ta === "CODIGO QR" || ta === "QR CODE") hit = { x: a.transform[4], y: a.transform[5], w: a.width, h: a.height || 10 };
        else if (ta === "CODIGO") {
          const b = items.find((it) => norm(it.str) === "QR" && Math.abs(it.transform[5] - a.transform[5]) < 3 && it.transform[4] > a.transform[4] && it.transform[4] - (a.transform[4] + a.width) < 20);
          if (b) hit = { x: a.transform[4], y: a.transform[5], w: b.transform[4] + b.width - a.transform[4], h: a.height || 10 };
        }
      }
      // Plantilla nueva: sin el texto "CODIGO QR" (la casilla está vacía). Se localiza la fila
      // "CODIGO DE FICHA:" y la casilla del QR es la de la derecha en la fila inmediatamente inferior.
      let ficha = null;
      if (!hit) {
        for (let i = 0; i < items.length && !ficha; i++) {
          const a = items[i], ta = norm(a.str);
          if (/^CODIGO DE FICHA:?$/.test(ta)) ficha = { x: a.transform[4], y: a.transform[5] };
          else if (ta === "CODIGO") {
            const b = items.find((it) => /^(DE )?FICHA:?$/.test(norm(it.str)) && Math.abs(it.transform[5] - a.transform[5]) < 3 && it.transform[4] > a.transform[4] && it.transform[4] - (a.transform[4] + a.width) < 40);
            if (b) ficha = { x: a.transform[4], y: a.transform[5] };
          }
        }
        if (!ficha) continue;
      }

      const ops = await page.getOperatorList(), O = pdfjs.OPS;
      let ctm = [1, 0, 0, 1, 0, 0]; const stack = [], H = [], V = [], images = [];
      const ARGS = { [O.rectangle]: 4, [O.moveTo]: 2, [O.lineTo]: 2, [O.curveTo]: 6, [O.curveTo2]: 4, [O.curveTo3]: 4 };
      for (let i = 0; i < ops.fnArray.length; i++) {
        const fn = ops.fnArray[i], args = ops.argsArray[i];
        if (fn === O.save) stack.push(ctm);
        else if (fn === O.restore) ctm = stack.pop() ?? ctm;
        else if (fn === O.transform) ctm = mul(ctm, args);
        else if (fn === O.paintImageXObject) {
          const c = [apply(ctm, 0, 0), apply(ctm, 1, 1)];
          images.push({ id: args[0], x0: Math.min(c[0][0], c[1][0]), x1: Math.max(c[0][0], c[1][0]), y0: Math.min(c[0][1], c[1][1]), y1: Math.max(c[0][1], c[1][1]) });
        } else if (fn === O.constructPath) {
          const [sub, a] = args; let k = 0, last = null;
          for (const s of sub) {
            if (s === O.rectangle) {
              const [x, y, w, h] = a.slice(k, k + 4);
              const p1 = apply(ctm, x, y), p2 = apply(ctm, x + w, y + h);
              const x0 = Math.min(p1[0], p2[0]), x1 = Math.max(p1[0], p2[0]), y0 = Math.min(p1[1], p2[1]), y1 = Math.max(p1[1], p2[1]);
              if (y1 - y0 < 4 && x1 - x0 > 8) H.push({ x0, x1, y0, y1 });
              if (x1 - x0 < 4 && y1 - y0 > 8) V.push({ x0, x1, y0, y1 });
            } else if (s === O.moveTo) last = apply(ctm, a[k], a[k + 1]);
            else if (s === O.lineTo && last) {
              const q = apply(ctm, a[k], a[k + 1]);
              if (Math.abs(q[1] - last[1]) < 1) H.push({ x0: Math.min(q[0], last[0]), x1: Math.max(q[0], last[0]), y0: q[1] - 0.5, y1: q[1] + 0.5 });
              if (Math.abs(q[0] - last[0]) < 1) V.push({ y0: Math.min(q[1], last[1]), y1: Math.max(q[1], last[1]), x0: q[0] - 0.5, x1: q[0] + 0.5 });
              last = q;
            }
            k += ARGS[s] || 0;
          }
        }
      }
      // Color del borde de cada imagen (para rellenar los lados de la foto al reducirla)
      for (const im of images) {
        try {
          const o = page.objs.get(im.id), d = o?.data, ch = o?.kind === 3 ? 4 : o?.kind === 2 ? 3 : 0;
          if (!d || !ch) continue;
          let r = 0, g = 0, b = 0, c = 0; const band = Math.max(1, Math.round(o.width * 0.02));
          for (let y = 0; y < o.height; y += 2) for (const x0 of [0, o.width - band]) for (let x = x0; x < x0 + band; x++) {
            const i = (y * o.width + x) * ch; r += d[i]; g += d[i + 1]; b += d[i + 2]; c++;
          }
          im.edge = [r / c / 255, g / c / 255, b / c / 255];
        } catch { /* sin datos: blanco */ }
      }
      if (!hit && ficha) {
        const below = (y, x) => H.filter((l) => l.y1 < y && l.x0 <= x && l.x1 >= x).sort((a, b) => b.y1 - a.y1);
        const [rowTopLine, rowBotLine] = below(ficha.y, ficha.x + 5);              // líneas que encierran la fila de abajo
        if (rowTopLine && rowBotLine) {
          const cy = (rowTopLine.y0 + rowBotLine.y1) / 2;
          const verts = V.filter((l) => l.y0 <= cy && l.y1 >= cy).sort((a, b) => a.x0 - b.x0);
          const divider = verts.find((l) => l.x0 > ficha.x + 20);                    // separa etiqueta/código | QR
          const border = divider && verts.find((l) => l.x0 > divider.x1 + 10);       // borde derecho de la casilla
          if (divider && border) { const cx = (divider.x1 + border.x0) / 2; hit = { x: cx - 1, y: cy - 1, w: 2, h: 3 }; }
        }
        if (!hit) continue;
      }
      return { page: p - 1, hit, H, V, images };
    }
    return null;
  } finally {
    await doc.destroy();
  }
}

// ---------------------------------------------------------------------------
// 2) Geometría: casilla del QR y (si se puede) cómo estirarla
// ---------------------------------------------------------------------------
function layout({ hit, H, V, images }) {
  const cx = hit.x + hit.w / 2, cy = hit.y + hit.h / 3;
  const near = (arr, keep, dist) => arr.filter(keep).reduce((b, l) => (b === null || dist(l) < dist(b) ? l : b), null);
  const covers = (l, x) => l.x0 <= x && l.x1 >= x;
  const spans = (l, y) => l.y0 <= y && l.y1 >= y;

  const top = near(H, (l) => l.y0 > cy && covers(l, cx), (l) => l.y0 - cy);       // línea sobre la casilla
  const bot = near(H, (l) => l.y1 < cy && covers(l, cx), (l) => cy - l.y1);       // línea bajo la casilla
  const left = near(V, (l) => l.x1 < cx && spans(l, cy), (l) => cx - l.x1);       // divisor etiqueta | QR
  const right = near(V, (l) => l.x0 > cx && spans(l, cy), (l) => l.x0 - cx);      // borde derecho
  if (!top || !bot || !left || !right) {
    const s = 48; return { cell: { x: cx - s / 2, y: cy - s / 2, w: s, h: s } };
  }
  const cell = { x: left.x1, y: bot.y1, w: right.x0 - left.x1, h: top.y0 - bot.y1 };

  const colX = (top.x0 + Math.min(top.x1, right.x0)) / 2;
  const rowTop = near(H, (l) => l.y0 > top.y1 + 2 && covers(l, colX), (l) => l.y0 - top.y1);       // línea bajo la foto
  const photoTop = rowTop && near(H, (l) => l.y0 > rowTop.y1 + 2 && covers(l, colX), (l) => l.y0 - rowTop.y1);
  const outer = near(V, (l) => l.x1 <= top.x0 + 3 && spans(l, cy), (l) => top.x0 - l.x1);
  if (!rowTop || !photoTop) return { cell, left, right };

  const X0 = outer ? outer.x1 : top.x0, X1 = right.x0;
  const photo = { x: X0, y: rowTop.y1, w: X1 - X0, h: photoTop.y0 - rowTop.y1 };
  const want = Math.min(TARGET_QR, cell.w - 2 * PAD) + 2 * PAD;
  const grow = Math.max(0, Math.min(want - cell.h, photo.h * MAX_PHOTO_SHRINK));
  if (grow < 4) return { cell, left, right };

  const img = images.filter((im) => im.x0 < photo.x + photo.w && im.x1 > photo.x && im.y0 < photo.y + photo.h && im.y1 > photo.y)
    .sort((a, b) => (b.x1 - b.x0) * (b.y1 - b.y0) - (a.x1 - a.x0) * (a.y1 - a.y0))[0];
  return { cell, grow, X0, X1, photo, top, bot, left, right, rowTop, img, fill: img?.edge ?? [1, 1, 1] };
}

// ---------------------------------------------------------------------------
// 3) Lectura del flujo de contenido: bloques de texto (BT…ET) y dibujos de imágenes (Do)
// ---------------------------------------------------------------------------
const TOKEN = /\s+|%[^\r\n]*|\/[^\s\/\[\]<>(){}%]*|<<|>>|<[0-9A-Fa-f\s]*>|\((?:\\[\s\S]|[^\\()])*\)|\[|\]|[-+]?(?:\d+\.?\d*|\.\d+)|[A-Za-z'"][A-Za-z0-9*'"]*|[\s\S]/g;

function parseContent(src) {
  let ctm = [1, 0, 0, 1, 0, 0]; const stack = [], operands = [], blocks = [], dos = [];
  let block = null, m;
  TOKEN.lastIndex = 0;
  while ((m = TOKEN.exec(src))) {
    const t = m[0], at = m.index;
    if (/^\s/.test(t) || t[0] === "%") continue;
    if (/^[A-Za-z'"]/.test(t)) {
      if (t === "q") stack.push(ctm);
      else if (t === "Q") ctm = stack.pop() ?? ctm;
      else if (t === "cm") ctm = mul(ctm, operands.slice(-6).map((o) => +o.t));
      else if (t === "BT") block = { start: at, ctm };
      else if (t === "Tm" && block && !block.tm) block.tm = { vals: operands.slice(-6).map((o) => +o.t), from: operands.at(-6).at, to: at };
      else if (t === "ET" && block) { block.end = at + 2; blocks.push(block); block = null; }
      else if (t === "Do") dos.push({ name: operands.at(-1)?.t, ctm });
      operands.length = 0;
    } else operands.push({ t, at });
  }
  return { blocks, dos };
}
const inv2 = ([a, b, c, d]) => { const det = a * d - b * c; return [d / det, -b / det, -c / det, a / det]; };

// ---------------------------------------------------------------------------
// 4) Estampado
// ---------------------------------------------------------------------------
/**
 * Copia `src` a `dest` con el QR (`qrImage`, cualquier formato que lea sharp) en la casilla "CODIGO QR".
 * Devuelve {ok, sizeCm, stretched} u {ok:false, reason}.
 */
export async function stampQR(src, dest, qrImage, { stretch = true } = {}) {
  const bytes = await readFile(src);
  const found = await analyze(bytes);
  if (!found) { await writeFile(dest, bytes); return { ok: false, reason: 'no tiene la casilla "CODIGO QR"' }; }
  const L = layout(found);

  const pdf = await PDFDocument.load(bytes);
  const page = pdf.getPage(found.page), ctx = pdf.context;

  // Flujo de contenido original (uno o varios)
  const contents = page.node.Contents();
  const parts = contents instanceof PDFArray ? contents.asArray().map((r) => ctx.lookup(r)) : [contents];
  let content = parts.map((s) => Buffer.from(decodePDFRawStream(s).decode()).toString("latin1")).join("\n");
  const { blocks, dos } = parseContent(content);
  const pos = (b) => b.tm ? apply(b.ctm, b.tm.vals[4], b.tm.vals[5]) : null;      // posición del bloque en la página
  const inBox = (p, x0, x1, y0, y1) => p && p[0] >= x0 - 1 && p[0] <= x1 + 1 && p[1] >= y0 - 1 && p[1] <= y1 + 1;

  const g = stretch && L.grow ? L.grow : 0;
  const cellTop = L.cell.y + L.cell.h;
  const moved = [];          // bloques que se vuelven a dibujar desplazados
  const edits = [];          // [inicio, fin, reemplazo] sobre el flujo original

  for (const b of blocks) {
    const p = pos(b);
    if (inBox(p, L.cell.x, L.cell.x + L.cell.w, L.cell.y, cellTop)) { edits.push([b.start, b.end, ""]); continue; }  // "CODIGO QR"
    if (!g) continue;
    let dy = 0;
    if (inBox(p, L.X0, L.left.x0, L.cell.y, cellTop)) dy = g / 2;                                  // "CODIGO DE OBJETO:"
    else if (inBox(p, L.X0, L.X1, L.top.y1, L.rowTop.y0)) dy = g;                                  // fila "CODIGO DE FICHA"
    if (!dy) continue;
    // Desplazamiento en espacio de usuario equivalente a subir `dy` puntos en la página
    const [ia, ib, ic, id] = inv2(b.ctm), ux = ic * dy, uy = id * dy;
    const v = b.tm.vals.slice(); v[4] += ux; v[5] += uy;
    const text = content.slice(b.start, b.tm.from) + v.map(n).join(" ") + " " + content.slice(b.tm.to, b.end);
    moved.push(`q ${b.ctm.map(n).join(" ")} cm 0 0 0 RG ${text} Q`);
    edits.push([b.start, b.end, ""]);
  }
  for (const [a, b, r] of edits.sort((x, y) => y[0] - x[0])) content = content.slice(0, a) + r + content.slice(b);

  // Contenido nuevo que se dibuja encima
  const ops = [];
  const rect = (x, y, w, h, [r, gg, b]) => ops.push(`${n(r)} ${n(gg)} ${n(b)} rg ${n(x)} ${n(y)} ${n(w)} ${n(h)} re f`);
  let cell = L.cell;

  if (g) {
    const { X0, X1, photo, top, rowTop, left } = L;
    // a) Borrar la columna desde la casilla del QR hasta el borde superior de la foto
    rect(X0, L.cell.y, X1 - X0, photo.y + photo.h - L.cell.y, [1, 1, 1]);
    // b) Foto reducida (proporción intacta), centrada, con el color de su borde a los lados
    const s = (photo.h - g) / photo.h, newY = photo.y + g;
    rect(photo.x, newY, photo.w, photo.h - g, L.fill);
    const im = L.img && dos.filter((d) => d.name).map((d) => {
      const c = [apply(d.ctm, 0, 0), apply(d.ctm, 1, 1)];
      const ox = Math.min(c[0][0], c[1][0]) - L.img.x0, oy = Math.min(c[0][1], c[1][1]) - L.img.y0;
      return { ...d, err: Math.abs(ox) + Math.abs(oy) };
    }).sort((a, b) => a.err - b.err)[0];
    if (im && im.err < 2) {
      const tx = photo.x + (photo.w - photo.w * s) / 2 - photo.x * s, ty = newY - photo.y * s;
      const M = [s * im.ctm[0], s * im.ctm[1], s * im.ctm[2], s * im.ctm[3], s * im.ctm[4] + tx, s * im.ctm[5] + ty];
      ops.push(`q ${n(photo.x)} ${n(newY)} ${n(photo.w)} ${n(photo.h - g)} re W n ${M.map(n).join(" ")} cm ${im.name} Do Q`);
    }
    // c) Líneas de la tabla en su nueva posición + divisor estirado
    const black = [0, 0, 0];
    rect(X0, rowTop.y0 + g, X1 - X0, rowTop.y1 - rowTop.y0, black);
    rect(X0, top.y0 + g, X1 - X0, top.y1 - top.y0, black);
    rect(left.x0, L.cell.y, left.x1 - left.x0, L.cell.h + g, black);
    cell = { ...L.cell, h: L.cell.h + g };
  } else {
    rect(cell.x + 0.6, cell.y + 0.6, cell.w - 1.2, cell.h - 1.2, [1, 1, 1]);
  }
  // d) Textos desplazados (siguen siendo texto real)
  ops.push(...moved);

  // e) QR (PNG: el PDF no admite WebP), a ~600 ppp para que imprima nítido
  const size = Math.min(cell.w, cell.h) - PAD * 2;
  const px = Math.max(300, Math.round((size / 72) * 600));
  const png = await sharp(qrImage).resize(px, px, { kernel: "nearest" }).png({ compressionLevel: 9, palette: true }).toBuffer();
  const qr = await pdf.embedPng(png);
  const qrName = page.node.newXObject("QRficha", qr.ref);
  ops.push(`q ${n(size)} 0 0 ${n(size)} ${n(cell.x + (cell.w - size) / 2)} ${n(cell.y + (cell.h - size) / 2)} cm ${qrName.toString()} Do Q`);

  // Página = contenido original editado (encapsulado en q…Q) + capa nueva
  const original = ctx.register(ctx.flateStream(`q\n${content}\nQ\n`));
  const overlay = ctx.register(ctx.flateStream(ops.join("\n")));
  page.node.set(PDFName.of("Contents"), ctx.obj([original, overlay]));

  await writeFile(dest, await pdf.save({ useObjectStreams: true }));
  return { ok: true, sizeCm: +(size / 72 * 2.54).toFixed(2), stretched: !!g };
}
