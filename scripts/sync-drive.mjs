// Descarga la carpeta compartida de Google Drive en ./documentos (espejo exacto).
//   Drive/Inventario/Vitrales|Cuadros|Muebles|Mosaicos|Esculturas/[Ubicación/]archivo.pdf  →  documentos/…
//
// Variables de entorno:
//   GOOGLE_SERVICE_ACCOUNT_JSON  contenido del JSON de la cuenta de servicio (lectura)
//   DRIVE_FOLDER_ID              id de la carpeta raíz compartida con esa cuenta
//
// Reglas: solo PDF; archivos vacíos (0 bytes, p. ej. una subida cortada) y de más de 25 MB
// (Cloudflare no los acepta) se omiten;
// si hay dos archivos con el mismo nombre en una carpeta, gana el más reciente.
import { createSign } from "node:crypto";
import { mkdir, rm, writeFile, utimes, readdir } from "node:fs/promises";
import { join } from "node:path";

const OUT = "documentos";
const MAX_BYTES = 25 * 1024 * 1024;
const API = process.env.DRIVE_API || "https://www.googleapis.com/drive/v3";              // (sobrescribible para pruebas)
const TOKEN_URL = process.env.GOOGLE_TOKEN_URL || "https://oauth2.googleapis.com/token";
const FOLDER = "application/vnd.google-apps.folder";

const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON || "null");
const rootId = process.env.DRIVE_FOLDER_ID;
if (!creds?.client_email || !creds?.private_key || !rootId) {
  console.error("Faltan GOOGLE_SERVICE_ACCOUNT_JSON y/o DRIVE_FOLDER_ID.");
  process.exit(1);
}

// --- Token de acceso (JWT firmado con la clave de la cuenta de servicio) ---
const b64url = (x) => Buffer.from(x).toString("base64url");
async function accessToken() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claim = b64url(JSON.stringify({ iss: creds.client_email, scope: "https://www.googleapis.com/auth/drive.readonly",
    aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const sig = createSign("RSA-SHA256").update(`${head}.${claim}`).sign(creds.private_key, "base64url");
  const r = await fetch(TOKEN_URL, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${head}.${claim}.${sig}` }),
  });
  if (!r.ok) throw new Error(`Google rechazó la autenticación: ${r.status} ${await r.text()}`);
  return (await r.json()).access_token;
}
const token = await accessToken();
const get = async (url) => {
  for (let attempt = 1; ; attempt++) {
    const r = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (r.ok) return r;
    if (attempt < 4 && (r.status === 429 || r.status >= 500)) { await new Promise((ok) => setTimeout(ok, attempt * 2000)); continue; }
    throw new Error(`Drive ${r.status}: ${await r.text()}`);
  }
};

async function children(id) {
  const out = []; let page = "";
  do {
    const q = new URLSearchParams({ q: `'${id}' in parents and trashed = false`, pageSize: "1000", pageToken: page,
      fields: "nextPageToken, files(id, name, mimeType, modifiedTime, size)", supportsAllDrives: "true", includeItemsFromAllDrives: "true" });
    const j = await (await get(`${API}/files?${q}`)).json();
    out.push(...j.files); page = j.nextPageToken || "";
  } while (page);
  return out;
}

// --- Recorrer el árbol ---
const safe = (s) => s.replace(/[\\/:*?"<>|]+/g, "-").trim();
const files = [];         // { id, path, modifiedTime, size }
const warnings = [];
async function walk(id, rel) {
  const items = await children(id);
  const seen = new Map();
  for (const it of items) {
    const name = safe(it.name);
    if (it.mimeType === FOLDER) { await walk(it.id, [...rel, name]); continue; }
    if (!/\.pdf$/i.test(name) || (it.mimeType && it.mimeType !== "application/pdf")) { warnings.push(`no es PDF, se omite: ${[...rel, name].join("/")}`); continue; }
    if (+it.size === 0) { warnings.push(`está vacío (0 bytes), se omite — vuelve a subirlo: ${[...rel, name].join("/")}`); continue; }
    if (+it.size > MAX_BYTES) { warnings.push(`pesa más de 25 MB, se omite: ${[...rel, name].join("/")}`); continue; }
    const key = name.toLowerCase(), prev = seen.get(key);
    if (prev) {
      warnings.push(`nombre repetido en ${rel.join("/") || "raíz"}: "${name}" — se usa el más reciente`);
      if (prev.modifiedTime >= it.modifiedTime) continue;
      files.splice(files.indexOf(prev), 1);
    }
    const f = { id: it.id, path: [...rel, name], modifiedTime: it.modifiedTime, size: +it.size };
    seen.set(key, f); files.push(f);
  }
}
await walk(rootId, []);

// Protección: una carpeta vacía casi siempre es un error de permisos o de id, no una intención.
// Se aborta para no publicar un inventario vacío (ALLOW_EMPTY=1 para permitirlo a propósito).
if (!files.length && process.env.ALLOW_EMPTY !== "1") {
  for (const w of warnings) console.warn(`⚠  ${w}`);
  console.error("✗ La carpeta de Drive no tiene PDF visibles para la cuenta de servicio. ¿Está compartida con ella y es el id correcto? No se publica nada.");
  process.exit(1);
}

// --- Espejo local: vaciar documentos/ y descargar ---
await mkdir(OUT, { recursive: true });
for (const e of await readdir(OUT)) if (!e.startsWith(".")) await rm(join(OUT, e), { recursive: true, force: true });
let bytes = 0;
for (const f of files) {
  const dest = join(OUT, ...f.path);
  await mkdir(join(OUT, ...f.path.slice(0, -1)), { recursive: true });
  const buf = Buffer.from(await (await get(`${API}/files/${f.id}?alt=media&supportsAllDrives=true`)).arrayBuffer());
  await writeFile(dest, buf);
  const t = new Date(f.modifiedTime);
  await utimes(dest, t, t);          // la fecha del catálogo es la de Drive, no la de la descarga
  bytes += buf.length;
  console.log(`   ↓ ${f.path.join("/")}`);
}
for (const w of warnings) console.warn(`⚠  ${w}`);
console.log(`✓ Drive sincronizado: ${files.length} PDF (${(bytes / 1e6).toFixed(1)} MB)`);
