// Mejora una foto con IA local (ComfyUI + Real-ESRGAN x4plus): más resolución y nitidez,
// sin inventar detalles (no es un modelo generativo).
//
// Uso:   npm run enhance -- <entrada.jpg> [salida.png] [anchoFinal]
// Ej.:   npm run enhance -- "C:\Users\Daniel\Downloads\foto.jpeg" assets-src/iglesia.png
//
// Requisitos: ComfyUI abierto (Comfy Desktop o servidor) y el modelo
// models/upscale_models/RealESRGAN_x4plus.pth. Variable COMFY_URL si no usa 127.0.0.1:8188.
import { readFile, writeFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import sharp from "sharp";

const COMFY = (process.env.COMFY_URL || "http://127.0.0.1:8188").replace(/\/$/, "");
const MODEL = process.env.UPSCALE_MODEL || "RealESRGAN_x4plus.pth";
const [input, output = input.replace(/(\.[^.]+)?$/, "-mejorada.png"), finalWidth = "2400"] = process.argv.slice(2);
if (!input) { console.error("Uso: npm run enhance -- <entrada> [salida] [anchoFinal]"); process.exit(1); }

const api = async (path, opts) => {
  const r = await fetch(COMFY + path, opts).catch(() => null);
  if (!r) throw new Error(`No se pudo conectar con ComfyUI en ${COMFY}. ¿Está abierto?`);
  if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
  return r;
};

// 0) ¿Está el modelo?
const models = await (await api("/models/upscale_models")).json();
if (!models.includes(MODEL)) throw new Error(`Falta ${MODEL} en models/upscale_models (hay: ${models.join(", ") || "ninguno"})`);

// 1) Subir la imagen (como PNG, para no recomprimir)
const name = `enhance-${Date.now()}-${basename(input, extname(input)).replace(/[^\w-]+/g, "_")}.png`;
const form = new FormData();
form.append("image", new Blob([await sharp(await readFile(input)).rotate().png().toBuffer()], { type: "image/png" }), name);
form.append("overwrite", "true");
const uploaded = await (await api("/upload/image", { method: "POST", body: form })).json();

// 2) Flujo: cargar → modelo de escalado → escalar ×4 → guardar
const prompt = {
  1: { class_type: "LoadImage", inputs: { image: uploaded.name } },
  2: { class_type: "UpscaleModelLoader", inputs: { model_name: MODEL } },
  3: { class_type: "ImageUpscaleWithModel", inputs: { upscale_model: ["2", 0], image: ["1", 0] } },
  4: { class_type: "SaveImage", inputs: { images: ["3", 0], filename_prefix: "inventario/mejorada" } },
};
const { prompt_id } = await (await api("/prompt", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ prompt }) })).json();
process.stdout.write("Procesando en ComfyUI");

// 3) Esperar el resultado
let out;
for (let i = 0; i < 600 && !out; i++) {
  await new Promise((r) => setTimeout(r, 1000));
  process.stdout.write(".");
  const h = (await (await api(`/history/${prompt_id}`)).json())[prompt_id];
  if (h?.status?.status_str === "error") throw new Error("ComfyUI devolvió un error: " + JSON.stringify(h.status.messages?.at(-1)));
  out = h?.outputs?.["4"]?.images?.[0];
}
if (!out) throw new Error("Tiempo de espera agotado.");
const img = await (await api(`/view?${new URLSearchParams({ filename: out.filename, subfolder: out.subfolder, type: out.type })}`)).arrayBuffer();

// 4) Ajustar al ancho final (el ×4 suele pasarse) y guardar sin pérdidas
const before = await sharp(input).metadata();
const buf = await sharp(Buffer.from(img)).resize({ width: Math.min(+finalWidth, before.width * 4), kernel: "lanczos3" }).png().toBuffer();
await writeFile(output, buf);
const after = await sharp(buf).metadata();
console.log(`\n✓ ${before.width}×${before.height} → ${after.width}×${after.height}  ${output}`);
