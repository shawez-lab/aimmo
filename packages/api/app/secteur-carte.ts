/**
 * AU073b · Dessiner le secteur d'une recherche au doigt, sur une carte [R16, R201].
 *
 * Servi à part (`/app/secteur-carte.js`) et chargé seulement au geste « Dessiner sur la carte » du bloc « Secteur de la
 * recherche », pour garder le budget de l'application. La carte est un canevas : ses tuiles viennent du Worker
 * (`/v1/carte/tuiles/…`), jamais d'une autre adresse, et seuls leurs numéros partent. L'agent centre la carte sur un
 * lieu dit (géocodé par le serveur), trace le contour du doigt ou à la souris, puis le range : au plus 40 points, au
 * moins 3, comme le serveur l'exige. Sans tuiles (fournisseur pas branché), le tracé reste possible sur un fond vide.
 */

/** Ce que l'écran dit d'un refus du serveur. */
export const CARTE_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  centre: 'Dites le lieu précis : une adresse, une gare, une école…',
  lieu_introuvable: 'Ce lieu n’a pas été trouvé : précisez la commune.',
  geocodage_absent: 'La recherche des lieux n’est pas branchée : la carte ne peut pas être centrée.',
  points: 'Tracez un contour d’au moins trois points.',
  nom: 'Donnez un nom au secteur : quelques mots, sans numéro.',
  not_assigned: 'Ce client est suivi par un autre agent.',
});

/** Au plus 40 points pour un secteur dessiné, comme le serveur (AREA_LIMITS). */
export const CARTE_MAX_POINTS = 40;

export const SECTEUR_CARTE_SCRIPT = `'use strict';
globalThis.AIMMO_SECTEUR_CARTE = function (t) {
  var el = t.el;
  var REFUSALS = ${JSON.stringify(CARTE_REFUSALS)};
  var MAX = ${CARTE_MAX_POINTS}, SIZE = 300, TILE = 256, ZMIN = 12, ZMAX = 18;
  var OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
  // Web Mercator : un point en pixels du monde à ce niveau, et l'inverse.
  function project(lat, lon, z) {
    var n = TILE * Math.pow(2, z), s = Math.sin(lat * Math.PI / 180);
    return { x: (lon + 180) / 360 * n, y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n };
  }
  function unproject(x, y, z) {
    var n = TILE * Math.pow(2, z);
    var lon = x / n * 360 - 180, m = Math.PI - 2 * Math.PI * y / n;
    return { lat: Math.round(180 / Math.PI * Math.atan(0.5 * (Math.exp(m) - Math.exp(-m))) * 1e6) / 1e6, lon: Math.round(lon * 1e6) / 1e6 };
  }
  // Au plus MAX points, pris à intervalles réguliers le long du tracé.
  function thin(points) {
    if (points.length <= MAX) return points.slice();
    var out = [];
    for (var i = 0; i < MAX; i++) out.push(points[Math.round(i * (points.length - 1) / (MAX - 1))]);
    return out;
  }
  function btn(label, run) { var b = el('button', label); b.setAttribute('type', 'button'); b.addEventListener('click', function () { run(); }); return b; }
  function field(form, fid, label) {
    var l = el('label', label);
    l.setAttribute('for', fid);
    var i = el('input');
    i.setAttribute('id', fid);
    form.appendChild(l);
    form.appendChild(i);
    return i;
  }
  function bytesOf(b64) {
    var s = atob(b64), a = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
    return a;
  }
  return function (box, ctx) {
    var id = t.cSeq();
    var state = t.cState();
    var center = null, z = 15, drawing = true, stroke = [], panFrom = null, tiles = {}, noTiles = false;
    var place = field(box, id + '-centre', 'Lieu où centrer la carte (adresse, gare, école…)');
    var canvas = el('canvas');
    canvas.setAttribute('width', String(SIZE));
    canvas.setAttribute('height', String(SIZE));
    canvas.setAttribute('aria-label', 'Carte du secteur : tracez le contour du doigt');
    canvas.className = 'carte-secteur';
    var g = canvas.getContext ? canvas.getContext('2d') : null;
    function said(text) { state.textContent = text; }
    function why(res, fallback) { return res.offline ? OFFLINE : REFUSALS[res.body && res.body.code] || fallback; }
    function origin() { var c = project(center.lat, center.lon, z); return { x: c.x - SIZE / 2, y: c.y - SIZE / 2 }; }
    function toScreen(p) { var o = origin(), w = project(p.lat, p.lon, z); return { x: w.x - o.x, y: w.y - o.y }; }
    function toPoint(sx, sy) { var o = origin(); return unproject(o.x + sx, o.y + sy, z); }
    function at(e) {
      var r = canvas.getBoundingClientRect ? canvas.getBoundingClientRect() : null;
      var k = r && r.width ? SIZE / r.width : 1;
      var x = r ? e.clientX - r.left : e.offsetX, y = r ? e.clientY - r.top : e.offsetY;
      return { x: x * k, y: y * k };
    }
    function paint() {
      if (!g || !center) return;
      g.clearRect(0, 0, SIZE, SIZE);
      var o = origin(), n = Math.pow(2, z);
      for (var tx = Math.floor(o.x / TILE); tx <= Math.floor((o.x + SIZE) / TILE); tx++) {
        for (var ty = Math.floor(o.y / TILE); ty <= Math.floor((o.y + SIZE) / TILE); ty++) {
          if (tx < 0 || ty < 0 || tx >= n || ty >= n) continue;
          var key = z + '/' + tx + '/' + ty, img = tiles[key];
          if (img && img !== 'attente' && img !== 'absente') g.drawImage(img, tx * TILE - o.x, ty * TILE - o.y);
          else if (!img && !noTiles) fetchTile(key);
        }
      }
      if (stroke.length) {
        g.beginPath();
        stroke.forEach(function (p, i) { var s = toScreen(p); if (i) g.lineTo(s.x, s.y); else g.moveTo(s.x, s.y); });
        if (!panFrom && stroke.length > 2) g.closePath();
        g.lineWidth = 3;
        // La couleur d'accent du système de design, lue sur la page : aucune couleur écrite ici.
        var accent = typeof getComputedStyle === 'function' ? getComputedStyle(canvas).getPropertyValue('--accent').trim() : '';
        if (accent) g.strokeStyle = accent;
        g.stroke();
      }
    }
    // Une tuile qui n'arrive pas (réseau, fournisseur en panne) : le fond reste vide là, c'est dit, et « Recharger la
    // carte » redemande les tuiles manquantes.
    var warned = false;
    function failedTiles() { if (!warned) { warned = true; said('Une partie de la carte n’a pas pu être lue : le tracé reste possible ; « Recharger la carte » réessaie.'); } }
    function fetchTile(key) {
      tiles[key] = 'attente';
      t.send('/v1/carte/tuiles/' + key, 'GET').then(function (res) {
        if (res.gone) return;
        if (!res.ok) {
          tiles[key] = 'absente';
          if (res.body && res.body.code === 'carte_absente') { noTiles = true; said('La carte n’est pas branchée : le tracé reste possible sur un fond vide, ou rangez un rayon autour d’un lieu.'); }
          else failedTiles();
          return;
        }
        if (typeof createImageBitmap !== 'function') { tiles[key] = 'absente'; return; }
        createImageBitmap(new Blob([bytesOf(res.body.data.base64)], { type: res.body.data.type })).then(function (img) { tiles[key] = img; paint(); }, function () { tiles[key] = 'absente'; failedTiles(); });
      });
    }
    var mode = btn('Déplacer la carte', function () {
      drawing = !drawing;
      mode.textContent = drawing ? 'Déplacer la carte' : 'Dessiner le contour';
      said(drawing ? 'Tracez le contour du secteur.' : 'Faites glisser la carte.');
    });
    mode.className = 'secondaire';
    canvas.addEventListener('pointerdown', function (e) {
      if (!center) return;
      if (e.preventDefault) e.preventDefault();
      if (canvas.setPointerCapture && e.pointerId !== undefined) canvas.setPointerCapture(e.pointerId);
      var p = at(e);
      if (drawing) { stroke = [toPoint(p.x, p.y)]; panFrom = p; }
      else panFrom = p;
      paint();
    });
    canvas.addEventListener('pointermove', function (e) {
      if (!center || !panFrom) return;
      var p = at(e);
      if (drawing) {
        var last = toScreen(stroke[stroke.length - 1]);
        if (Math.abs(p.x - last.x) + Math.abs(p.y - last.y) >= 6) stroke.push(toPoint(p.x, p.y));
      } else {
        var c = project(center.lat, center.lon, z);
        center = unproject(c.x - (p.x - panFrom.x), c.y - (p.y - panFrom.y), z);
        panFrom = p;
      }
      paint();
    });
    function end() {
      if (!panFrom) return;
      panFrom = null;
      if (drawing) said(stroke.length > 2 ? 'Contour tracé : ' + Math.min(stroke.length, MAX) + ' points. Rangez-le, ou tracez-en un autre.' : REFUSALS.points);
      paint();
    }
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
    function zoom(d) { var nz = Math.max(ZMIN, Math.min(ZMAX, z + d)); if (nz !== z) { z = nz; paint(); } }
    box.appendChild(t.accordButton('Centrer la carte', function () {
      return t.send(ctx.base() + '/lieu?q=' + encodeURIComponent(place.value.trim()), 'GET').then(function (res) {
        if (res.gone) return false;
        if (!res.ok) { said(why(res, 'Ce lieu n’a pas été trouvé.')); return false; }
        center = { lat: res.body.data.lat, lon: res.body.data.lon };
        said('Carte centrée. Tracez le contour du secteur.');
        paint();
        return true;
      });
    }));
    box.appendChild(canvas);
    var tools = el('div');
    tools.appendChild(mode);
    var plus = btn('Rapprocher', function () { zoom(1); });
    var minus = btn('Éloigner', function () { zoom(-1); });
    var erase = btn('Effacer le tracé', function () { stroke = []; said('Tracé effacé.'); paint(); });
    var reload = btn('Recharger la carte', function () {
      Object.keys(tiles).forEach(function (k) { if (tiles[k] === 'absente') delete tiles[k]; });
      warned = false;
      noTiles = false;
      paint();
    });
    [plus, minus, erase, reload].forEach(function (b) { b.className = 'secondaire'; tools.appendChild(b); });
    box.appendChild(tools);
    box.appendChild(t.accordButton('Ranger ce secteur dessiné', function () {
      if (!ctx.ready()) { said('Le secteur en place n’est pas lu : réessayez de le lire d’abord.'); return Promise.resolve(false); }
      if (stroke.length < 3) { said(REFUSALS.points); return Promise.resolve(false); }
      var points = thin(stroke).map(function (p) { return { lat: p.lat, lon: p.lon }; });
      return t.send(ctx.base(), 'POST', { shape: 'polygone', points: points, label: ctx.label() }).then(function (res) {
        if (res.gone) return false;
        if (!res.ok) { said(why(res, 'Le secteur n’est pas rangé.')); return false; }
        said('Secteur dessiné rangé.');
        ctx.done(res.body.data);
        return true;
      });
    }));
    box.appendChild(state);
    // Un secteur déjà dessiné : la carte s'ouvre dessus, son contour en place.
    var a = ctx.current();
    if (a && a.shape === 'polygone' && a.points && a.points.length) {
      var lat = 0, lon = 0;
      a.points.forEach(function (p) { lat += p.lat; lon += p.lon; });
      center = { lat: lat / a.points.length, lon: lon / a.points.length };
      stroke = a.points.slice();
      paint();
    } else if (a && a.shape === 'cercle') { center = { lat: a.center.lat, lon: a.center.lon }; paint(); }
  };
};
`;
