// Lee de la ficha quién la elaboró: el texto de la casilla "ELABORADO POR:".
//   "Castro Zapata, Maria Ximena"   → "Maria Ximena Castro Zapata"
//   "Ruiz Escudero Hillary Aleska"  → "Hillary Aleska Ruiz Escudero"  (4 palabras sin coma: 2 apellidos + 2 nombres)
// La línea de la cédula (números) que va debajo NUNCA se lee: no debe publicarse.
// Devuelve una lista de nombres (vacía si la ficha no tiene la casilla o está en blanco).
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";

const require = createRequire(import.meta.url);
const _w = console.warn, _l = console.log;
console.warn = console.log = () => {};          // pdf.js avisa de que no hay "canvas" (no lo necesitamos)
const pdfjs = require("pdfjs-dist/legacy/build/pdf.js");
console.warn = _w; console.log = _l;

const norm = (s) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toUpperCase().replace(/\s+/g, " ").trim();

const titleCase = (s) => s === s.toUpperCase() ? s.toLowerCase().replace(/(^|[\s-])\p{L}/gu, (m) => m.toUpperCase()) : s;

function natural(raw) {
  const s = titleCase(raw.replace(/\s+/g, " ").replace(/\s+,/g, ",").trim().replace(/[.,;:]+$/, ""));
  if (s.includes(",")) { const [last, first] = s.split(",").map((x) => x.trim()); return first ? `${first} ${last}` : last; }
  const w = s.split(" ");
  return w.length === 4 ? `${w[2]} ${w[3]} ${w[0]} ${w[1]}` : s;
}

export async function documentedBy(file) {
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await readFile(file)), verbosity: 0, isEvalSupported: false }).promise;
  try {
    for (let p = 1; p <= doc.numPages; p++) {
      const items = (await (await doc.getPage(p)).getTextContent()).items
        .filter((i) => i.str?.trim())
        .map((i) => ({ s: i.str, x: i.transform[4], y: i.transform[5], w: i.width }));
      const label = items.find((i) => norm(i.s).startsWith("ELABORADO"));
      if (!label) continue;
      // La casilla de al lado ("FECHA DE ELABORACIÓN") marca el borde derecho de la columna del nombre
      const next = items.find((i) => i !== label && Math.abs(i.y - label.y) < 3 && i.x > label.x && norm(i.s).startsWith("FECHA"));
      const right = next ? next.x - 4 : Infinity;
      const below = items.filter((i) => i.y < label.y - 3 && i.y > label.y - 45 && i.x < right).sort((a, b) => b.y - a.y || a.x - b.x);
      // Agrupar en líneas; las piezas pegadas (p. ej. "Hern" + "á" + "ndez") se unen sin espacio
      const lines = [];
      for (const i of below) {
        const line = lines.at(-1);
        if (line && Math.abs(line.y - i.y) < 2.5) {
          const gap = i.x - (line.end ?? i.x);
          line.text += (gap > 1.5 ? " " : "") + i.s; line.end = i.x + i.w;
        } else lines.push({ y: i.y, text: i.s, end: i.x + i.w });
      }
      const name = [];
      for (const l of lines) { if (/\d/.test(l.text)) break; name.push(l.text.trim()); }   // se detiene en la cédula
      return name.join(" ").split(/\s*(?:;|\/|&|\s+y\s+)\s*/i).map(natural).filter((n) => n.length > 2);
    }
    return [];
  } finally { await doc.destroy(); }
}
