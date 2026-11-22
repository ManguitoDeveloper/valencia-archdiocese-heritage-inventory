/**
 * Vigilante de la carpeta de Google Drive del inventario.
 * Cada 5 minutos calcula una "huella" de la carpeta (nombres, fechas, borrados) y, si cambió,
 * pide a GitHub que publique el sitio (workflow "Publicar inventario").
 *
 * Instalación (una sola vez), en https://script.google.com con la cuenta dueña de la carpeta:
 *   1. Nuevo proyecto → pega este archivo.
 *   2. Configuración del proyecto → Propiedades del script → agrega:
 *        FOLDER_ID     id de la carpeta raíz del inventario (lo que va después de /folders/ en la URL)
 *        GITHUB_REPO   ManguitoDeveloper/inventario-patrimonio
 *        GITHUB_TOKEN  token de GitHub con permiso "Contents: Read and write" sobre ese repositorio
 *   3. Elige la función "instalar" y pulsa Ejecutar (acepta los permisos).
 * Para probar a mano: ejecuta "publicarAhora".
 */

function instalar() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("revisarCambios").timeBased().everyMinutes(5).create();
  PropertiesService.getScriptProperties().deleteProperty("HUELLA");
  revisarCambios();
}

function revisarCambios() {
  var props = PropertiesService.getScriptProperties();
  var huella = calcularHuella_(DriveApp.getFolderById(props.getProperty("FOLDER_ID")));
  if (huella === props.getProperty("HUELLA")) return;          // nada cambió
  publicar_("cambio en Drive");
  props.setProperty("HUELLA", huella);
}

function publicarAhora() { publicar_("manual"); }

function calcularHuella_(raiz) {
  var lineas = [];
  (function recorrer(carpeta, ruta) {
    var archivos = carpeta.getFiles();
    while (archivos.hasNext()) {
      var f = archivos.next();
      lineas.push(ruta + "/" + f.getName() + "|" + f.getId() + "|" + f.getLastUpdated().getTime() + "|" + f.getSize());
    }
    var sub = carpeta.getFolders();
    while (sub.hasNext()) { var c = sub.next(); recorrer(c, ruta + "/" + c.getName()); }
  })(raiz, "");
  lineas.sort();
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, lineas.join("\n"));
  return Utilities.base64Encode(digest);
}

function publicar_(motivo) {
  var props = PropertiesService.getScriptProperties();
  var res = UrlFetchApp.fetch("https://api.github.com/repos/" + props.getProperty("GITHUB_REPO") + "/dispatches", {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + props.getProperty("GITHUB_TOKEN"), Accept: "application/vnd.github+json" },
    payload: JSON.stringify({ event_type: "drive-changed", client_payload: { motivo: motivo } }),
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 204) throw new Error("GitHub respondió " + res.getResponseCode() + ": " + res.getContentText());
  console.log("Publicación solicitada (" + motivo + ")");
}
