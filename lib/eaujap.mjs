// Marca EAUJAP a partir de su trazo vectorial (potrace):
//  - splash: las barras se rellenan en zigzag de izquierda a derecha (un trazo grueso recortado por la forma,
//    sin borde) y cada letra aparece cuando termina de llenarse la parte del logo que tiene encima;
//  - static: la misma marca, quieta, para la cabecera (así la animación aterriza en un logo idéntico).
// Las letras se alinean con el logo: E empieza en el borde de la primera barra completa y P termina en el borde derecho.

const COL = 34;                 // ancho de cada pasada del pincel (unidades del viewBox)
export const DURATION = 1.2;    // s, ritmo constante (letras a intervalos parejos)

// Límites reales de un subtrazo (muestrea las curvas Bézier en vez de usar sus puntos de control)
function box(p) {
  const tk = p.match(/[MLC]|-?\d+(?:\.\d+)?/g); let cmd = "M", i = 0, cx = 0, cy = 0; const X = [], Y = [];
  const add = (x, y) => { X.push(x); Y.push(y); };
  while (i < tk.length) {
    if (/[MLC]/.test(tk[i])) { cmd = tk[i++]; continue; }
    if (cmd === "C") {
      const [x1, y1, x2, y2, x3, y3] = tk.slice(i, i + 6).map(Number); i += 6;
      for (let k = 0; k <= 16; k++) { const t = k / 16, u = 1 - t;
        add(u*u*u*cx + 3*u*u*t*x1 + 3*u*t*t*x2 + t*t*t*x3, u*u*u*cy + 3*u*u*t*y1 + 3*u*t*t*y2 + t*t*t*y3); }
      cx = x3; cy = y3;
    } else { cx = +tk[i]; cy = +tk[i + 1]; i += 2; add(cx, cy); }
  }
  return { X, Y, x0: Math.min(...X), x1: Math.max(...X), y0: Math.min(...Y), y1: Math.max(...Y) };
}

// Proporciones del logo oficial de la EAUJAP (medidas sobre el original, relativas a la caja de las barras):
// E empieza al 4,3 % del ancho, P termina al 100,8 % y la fila de letras queda 7,9 % del alto por debajo.
export const OFFICIAL = { left: 0.043, right: 1.008, gap: 0.079 };

// moveDown = false: solo alinea en horizontal (p. ej. el logo del pie, que tiene textos justo debajo)
export function eaujap(d, W, H, { ink = "currentColor", align = OFFICIAL, moveDown = true } = {}) {
  const parts = d.split(/(?=M)/).map((s) => s.trim()).filter(Boolean).map((p) => ({ p, ...box(p) }));
  // Barras = el subtrazo más alto; letras = los que quedan por debajo de las barras
  const barsPart = parts.reduce((a, b) => (b.y1 - b.y0 > a.y1 - a.y0 ? b : a));
  const barsBottom = barsPart.y1, lettersTop = barsBottom + 4;
  const bars = parts.filter((q) => q.y1 <= lettersTop).map((q) => q.p).join(" ");

  // Agrupar las letras (los huecos de A y P van con su letra), de izquierda a derecha
  const letters = [];
  for (const q of parts.filter((q) => q.y0 >= lettersTop - 6).sort((a, b) => a.x0 - b.x0)) {
    const g = letters.find((l) => q.x0 < l.x1 && q.x1 > l.x0);
    if (g) { g.p += " " + q.p; g.x0 = Math.min(g.x0, q.x0); g.x1 = Math.max(g.x1, q.x1); } else letters.push({ p: q.p, x0: q.x0, x1: q.x1 });
  }

  // Alineación según el logo oficial (fracciones del ancho/alto de las barras)
  const bw = barsPart.x1 - barsPart.x0, bh = barsBottom - barsPart.y0;
  const left = barsPart.x0 + align.left * bw, right = barsPart.x0 + align.right * bw;
  const curTop = Math.min(...parts.filter((q) => q.y0 >= lettersTop - 6).map((q) => q.y0));
  const dy = moveDown ? barsBottom + align.gap * bh - curTop : 0;
  const VW = Math.max(W, Math.ceil(right + 1)), VH = Math.ceil(H + Math.max(0, dy));   // el lienzo crece si hace falta
  const gap = (right - left - letters.reduce((s, l) => s + (l.x1 - l.x0), 0)) / Math.max(1, letters.length - 1);
  let cursor = left;
  for (const l of letters) { l.dx = cursor - l.x0; l.x0 += l.dx; l.x1 += l.dx; cursor = l.x1 + gap; }

  // Zigzag: columnas de arriba abajo y de abajo arriba, con los extremos dentro de las barras
  const y0 = COL * 0.6, y1 = barsBottom - COL * 0.6, cols = [];
  for (let x = COL / 2; x - COL / 2 < W; x += COL) cols.push(x);
  const pts = cols.flatMap((x, i) => (i % 2 ? [[x, y1], [x, y0]] : [[x, y0], [x, y1]]));
  const snake = "M " + pts.map((p) => p.map((v) => +v.toFixed(1)).join(" ")).join(" L ");
  const segV = y1 - y0, total = cols.length * segV + (cols.length - 1) * COL;
  // Cada letra aparece cuando termina la columna que cubre su borde derecho (ritmo lineal: avance = tiempo)
  const at = letters.map((l) => { let c = cols.findIndex((x) => x + COL / 2 >= l.x1); if (c < 0) c = cols.length - 1;
    return ((c + 1) * segV + c * COL) / total; });

  const r = (v) => +v.toFixed(2);
  const letterPaths = (cls, i) => letters.map((l, k) =>
    `<g transform="translate(${r(l.dx)} ${r(dy)})"><path${cls ? ` class="${cls}"` : ""} fill-rule="evenodd"${i ? ` style="--at:${at[k].toFixed(3)}"` : ""} d="${l.p}"/></g>`).join("");

  const splash = `<svg class="splash-arq" viewBox="0 0 ${VW} ${VH}" role="img" aria-label="Escuela de Arquitectura UJAP">`
    + `<defs><clipPath id="eau-bars"><path fill-rule="evenodd" clip-rule="evenodd" d="${bars}"/></clipPath></defs>`
    + `<g clip-path="url(#eau-bars)"><path class="eau-snake" pathLength="1" stroke-width="${Math.round(COL * 1.2)}" d="${snake}"/></g>`
    + letterPaths("eau-letter", true) + `</svg>`;
  const static_ = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VW} ${VH}" width="${VW}" height="${VH}">`
    + `<g fill="${ink}"><path fill-rule="evenodd" d="${bars}"/>${letterPaths("", false)}</g></svg>`;
  // Solo las letras alineadas (para reemplazar la fila de letras en otras versiones del logo, p. ej. la del pie)
  const lettersOnly = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VW} ${VH}" width="${VW}" height="${VH}">`
    + `<g fill="${ink}">${letterPaths("", false)}</g></svg>`;
  return { splash, static: static_, lettersOnly, lettersBand: [barsBottom + 2, H], width: VW, height: VH, at };
}
