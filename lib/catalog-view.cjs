// Vista del catálogo: genera el HTML de la lista, los filtros y los contadores.
// Es la ÚNICA fuente de este marcado: build.mjs lo ejecuta para pre-renderizar la página
// (llega completa desde el primer byte) y el navegador usa el mismo código al buscar o filtrar.
// Script plano, sin dependencias, para poder incrustarlo tal cual en la página.
var CatalogView = (function () {
  var SING = { Vitrales: "vitral", Cuadros: "cuadro", Muebles: "mueble", Mosaicos: "mosaico", Esculturas: "escultura" };
  var esc = function (s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); };
  var norm = function (s) { return s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase(); };
  var num = function (n) { return "Nº " + String(n).padStart(3, "0"); };
  var plural = function (n, one, many) { return n + " " + (n === 1 ? one : many); };
  var roman = function (n) { return [["X", 10], ["IX", 9], ["V", 5], ["IV", 4], ["I", 1]].reduce(function (s, rv) { while (n >= rv[1]) { s += rv[0]; n -= rv[1]; } return s; }, ""); };
  var fmtSize = function (b) { return b > 1e6 ? (b / 1e6).toFixed(1).replace(".", ",") + " MB" : Math.max(1, Math.round(b / 1e3)) + " KB"; };
  // Zona horaria fija: el servidor de compilación y el visitante ven la misma fecha
  var fmtDate = function (d) { return new Date(d).toLocaleDateString("es-VE", { day: "numeric", month: "short", year: "numeric", timeZone: "America/Caracas" }); };
  var countIn = function (docs, c) { return docs.filter(function (d) { return d.category === c; }).length; };

  function facts(docs, cats) {
    return cats.map(function (c) {
      var n = countIn(docs, c);
      return "<li><b>" + n + "</b> " + esc(n === 1 && SING[c] ? SING[c] : c.toLowerCase()) + "</li>";
    }).join("");
  }

  // "Vitrales, cuadros, muebles, mosaicos y esculturas"
  function list(cats) {
    var l = cats.map(function (c, i) { return i ? c.toLowerCase() : c; });
    return l.length > 1 ? l.slice(0, -1).join(", ") + " y " + l[l.length - 1] : l.join("");
  }
  function count(docs, cats) {
    return docs.length ? plural(docs.length, "ficha de registro", "fichas de registro") + " · " + list(cats) : "Sin fichas por ahora";
  }

  function chips(docs, cats, active) {
    return ["Todas"].concat(cats).map(function (c) {
      var n = c === "Todas" ? docs.length : countIn(docs, c);
      return '<button class="chip" aria-pressed="' + (c === active) + '" data-c="' + esc(c) + '">' + esc(c) + '<span class="chip-n">' + n + "</span></button>";
    }).join("");
  }

  function results(docs, cats, active, raw) {
    raw = (raw || "").trim();
    var q = norm(raw);
    var shown = docs.filter(function (d) {
      return (active === "Todas" || d.category === active) && (!q || norm(d.title + " " + d.category + " " + d.location).indexOf(q) !== -1);
    });
    var clearBtn = '<button class="linkish" data-clear>ver todo el catálogo</button>';

    if (!docs.length) return '<div class="empty"><p class="serif">Todavía no hay fichas publicadas.</p><p>Las fichas del inventario aparecerán aquí a medida que se incorporen.</p></div>';
    if (!shown.length) {
      return q
        ? '<div class="empty"><p class="serif">Ninguna ficha' + (active !== "Todas" ? " de " + esc(active) : "") + " coincide con «" + esc(raw) + "».</p><p>Prueba con otra palabra o " + clearBtn + ".</p></div>"
        : '<div class="empty"><p class="serif">Aún no hay fichas de ' + esc(active) + ".</p><p>Se publicarán a medida que avance el inventario. Mientras tanto, puedes " + clearBtn + ".</p></div>";
    }

    var order = [], groups = {};
    shown.forEach(function (d) { if (!groups[d.category]) { groups[d.category] = []; order.push(d.category); } groups[d.category].push(d); });
    return order.map(function (cat) {
      var items = groups[cat];
      return '\n<section class="group" aria-label="' + esc(cat) + '">'
        + '<div class="group-head"><span class="roman">' + roman(cats.indexOf(cat) + 1) + "</span><h3>" + esc(cat) + '</h3><span class="count">' + plural(items.length, "ficha", "fichas") + "</span></div>"
        + '<ol class="ledger">' + items.map(function (d) {
          return '\n<li class="row">'
            + '<span class="n">' + num(d.n) + "</span>"
            + '<div><a class="t" href="?d=' + d.id + '" data-id="' + d.id + '">' + esc(d.title) + "</a>"
            + '<div class="meta">' + (d.location ? esc(d.location) + " · " : "") + "PDF · " + fmtSize(d.size) + " · " + fmtDate(d.modified) + "</div></div>"
            + '<div class="acts">'
            + '<button class="icon-btn" data-qr="' + d.id + '" aria-label="Código QR de ' + esc(d.title) + '" title="Código QR"><svg><use href="#i-qr"/></svg></button>'
            + '<a class="icon-btn hide-sm" href="' + d.url + '" download aria-label="Descargar ' + esc(d.title) + '" title="Descargar PDF"><svg><use href="#i-dl"/></svg></a>'
            + "</div></li>";
        }).join("") + "</ol></section>";
    }).join("");
  }

  return { facts: facts, count: count, chips: chips, results: results, esc: esc, num: num, plural: plural };
})();
if (typeof module !== "undefined") module.exports = CatalogView;
