/**
 * AU018 · La visite sans réseau, sur le téléphone (HX12) [R276, R277, R278].
 *
 * Ce script fait partie de la coquille gardée par l'appareil : il s'ouvre en mode avion. Il garde dans IndexedDB
 * deux choses seulement :
 * - le paquet du jour, préparé à chaque ouverture de l'application avec du réseau : les visites et estimations de
 *   l'agent, la fiche réduite du bien et sa liste de cadrage, jamais rien d'un client ; il s'efface passé minuit [R278] ;
 * - la boîte d'envoi : chaque note, photo ou pièce dite sans objet, avec son identifiant tiré une fois pour toutes. Une
 *   saisie ne quitte la boîte que sur une réponse du serveur qui la nomme ; fermer et rouvrir l'application ne perd rien,
 *   et le même envoi rejoué ne fait aucun doublon [R276].
 * La photo est faite de deux prises de lumières différentes, réduites, fondues et jugées ici même : trop sombre,
 * brûlée ou floue, elle est refusée avant que l'agent quitte la pièce ; le serveur refait le même calcul [R277].
 *
 * Les calculs de la photo et la boîte reprennent ceux de `packages/core/src/hors-ligne/` : un test vérifie qu'ils
 * rendent les mêmes verdicts. Pas d'accent grave dans ce texte : il est servi tel quel.
 */
export const HORS_LIGNE_PATH = '/app/hors-ligne.js';
/** La base IndexedDB de l'appareil et ses deux clés. */
export const HORS_LIGNE_DB = Object.freeze({ name: 'aimmo-hors-ligne', store: 'cles', boite: 'boite', paquet: 'paquet' });
export const HORS_LIGNE_ROUTES = Object.freeze({ paquet: '/v1/hors-ligne/paquet', saisies: '/v1/hors-ligne/saisies' });

export const HORS_LIGNE_SCRIPT = `(function () {
'use strict';
var G = typeof self !== 'undefined' ? self : globalThis;
var DB = ${JSON.stringify(HORS_LIGNE_DB.name)}, STORE = ${JSON.stringify(HORS_LIGNE_DB.store)}, BOITE = ${JSON.stringify(HORS_LIGNE_DB.boite)}, PAQUET = ${JSON.stringify(HORS_LIGNE_DB.paquet)};
var R_PAQUET = ${JSON.stringify(HORS_LIGNE_ROUTES.paquet)}, R_SAISIES = ${JSON.stringify(HORS_LIGNE_ROUTES.saisies)};
var MIN_SIDE = 32, MAX_SIDE = 128, MAX_NOTE = 2000;
var T = { minBrightness: 60, maxClipped: 0.2, minSharpness: 40, minExposures: 2, minExposureSpread: 25 };
var ADVICE = {
  trop_sombre: 'Trop sombre : allumez, ouvrez les volets, puis reprenez la photo.',
  brulee: 'Trop de blanc : tournez-vous un peu pour sortir la fenêtre du centre, puis reprenez la photo.',
  floue: 'Floue : tenez le téléphone à deux mains, attendez une seconde sans bouger, puis reprenez la photo.'
};
var REASONS = [['piece_absente', 'Pièce absente'], ['acces_refuse', 'Accès refusé']];
var CODES = {
  conflit: 'déjà envoyée avec un autre contenu', heure_invalide: 'heure du téléphone fausse', pas_son_rendez_vous: 'pas votre rendez-vous',
  rendez_vous_annule: 'rendez-vous annulé', bad_note: 'note vide ou trop longue', bad_shot: 'photo hors de la liste', bad_reason: 'raison inconnue',
  prises_invalides: 'photo incomplète', pas_hdr: 'une seule lumière', trop_sombre: 'trop sombre', brulee: 'brûlée', floue: 'floue', sans_bien: 'sans bien'
};

/* Le rangement : IndexedDB, ou la mémoire quand l'appareil n'en a pas (rien ne survit alors à la fermeture). */
var mem = {};
var dbp = null;
function clone(v) { return v === null || v === undefined ? null : JSON.parse(JSON.stringify(v)); }
function idb() {
  if (!G.indexedDB) return null;
  if (!dbp) dbp = new Promise(function (ok, ko) {
    var r = G.indexedDB.open(DB, 1);
    r.onupgradeneeded = function () { r.result.createObjectStore(STORE); };
    r.onsuccess = function () { ok(r.result); };
    r.onerror = function () { ko(r.error); };
  });
  return dbp;
}
function tx(mode, run) {
  var p = idb();
  if (!p) return null;
  return p.then(function (db) {
    return new Promise(function (ok, ko) {
      var t = db.transaction(STORE, mode);
      var out = run(t.objectStore(STORE));
      t.oncomplete = function () { ok(out && 'result' in out ? out.result : undefined); };
      t.onerror = function () { ko(t.error); };
      t.onabort = function () { ko(t.error); };
    });
  });
}
function get(k) {
  var p = tx('readonly', function (s) { return s.get(k); });
  return p ? p.then(function (v) { return v === undefined ? null : v; }) : Promise.resolve(clone(mem[k]));
}
function put(k, v) {
  var p = tx('readwrite', function (s) { s.put(clone(v), k); });
  if (p) return p;
  mem[k] = clone(v);
  return Promise.resolve();
}
function del(k) {
  var p = tx('readwrite', function (s) { s['delete'](k); });
  if (p) return p;
  delete mem[k];
  return Promise.resolve();
}

/* La boîte d'envoi [R276]. */
/* Chaque agent a sa boîte et son paquet, sous une marque tirée par le serveur : un autre agent sur le même téléphone
   ne voit, n'envoie ni ne perd rien de lui [R16, R276]. */
var states = {}, queue = Promise.resolve(), flushing = {};
function excl(fn) { var run = queue.then(fn, fn); queue = run.then(null, function () {}); return run; }
function uuid() { return G.crypto.randomUUID(); }
function current(o) {
  if (states[o]) return Promise.resolve(states[o]);
  return get(BOITE + ':' + o).then(function (s) {
    if (s) { states[o] = s; return s; }
    var n = { deviceId: uuid(), nextSeq: 1, pending: [], refused: [] };
    return put(BOITE + ':' + o, n).then(function () { states[o] = n; return n; });
  });
}
function add(kind, appointmentId, payload) {
  var o = ui && ui.owner;
  if (!o) return Promise.reject(new Error('aucun agent'));
  return excl(function () {
    return current(o).then(function (s) {
      var op = { opId: uuid(), seq: s.nextSeq, kind: kind, appointmentId: appointmentId, writtenAt: new Date().toISOString(), payload: payload };
      var next = { deviceId: s.deviceId, nextSeq: s.nextSeq + 1, pending: s.pending.concat([op]), refused: s.refused };
      return put(BOITE + ':' + o, next).then(function () { states[o] = next; return op; });
    });
  });
}
function bySeq(a, b) { return a.seq - b.seq; }
function flush(o, send, limit) {
  if (!flushing[o]) flushing[o] = doFlush(o, send, limit > 0 ? limit : 10).then(function (r) { delete flushing[o]; return r; }, function (e) { delete flushing[o]; throw e; });
  return flushing[o];
}
function doFlush(o, send, limit) {
  var sent = 0, refused = 0;
  function step() {
    return excl(function () { return current(o); }).then(function (s) {
      var batch = s.pending.slice().sort(bySeq).slice(0, limit);
      if (!batch.length) return { offline: false, sent: sent, refused: refused, left: 0 };
      return send({ deviceId: s.deviceId, ops: batch }).then(function (r) { return r && Array.isArray(r.results) ? r.results : []; }, function () { return null; }).then(function (results) {
        if (results === null) return { offline: true, sent: sent, refused: refused, left: s.pending.length };
        var asked = {}, by = {}, named = 0;
        batch.forEach(function (o) { asked[o.opId] = true; });
        results.forEach(function (r) { if (r && typeof r.opId === 'string' && asked[r.opId] && !by[r.opId]) { by[r.opId] = r; named++; } });
        return excl(function () {
          return current(o).then(function (now) {
            var keep = [], gone = [];
            now.pending.forEach(function (op) {
              var r = by[op.opId];
              if (r && r.outcome === 'applique') sent++;
              else if (r && r.outcome === 'refuse') { refused++; gone.push({ opId: op.opId, seq: op.seq, kind: op.kind, appointmentId: op.appointmentId, writtenAt: op.writtenAt, payload: op.payload, code: typeof r.code === 'string' ? r.code : 'refuse', rule: typeof r.rule === 'string' ? r.rule : null }); }
              else keep.push(op);
            });
            var next = { deviceId: now.deviceId, nextSeq: now.nextSeq, pending: keep, refused: now.refused.concat(gone) };
            return put(BOITE + ':' + o, next).then(function () { states[o] = next; return keep.length; });
          });
        }).then(function (left) { return named ? step() : { offline: false, sent: sent, refused: refused, left: left }; });
      });
    });
  }
  return step();
}

/* Le paquet du jour : rien d'un client ; passé sa fin de validité, il est effacé [R278]. */
function readPack(o) {
  if (!o) return Promise.resolve(null);
  return get(PAQUET + ':' + o).then(function (p) {
    if (p && typeof p.validUntil === 'string' && Date.parse(p.validUntil) > Date.now() && Array.isArray(p.appointments)) return p;
    return p ? del(PAQUET + ':' + o).then(function () { return null; }) : null;
  });
}
/* L'empreinte de la clé, jamais la clé : elle relie la clé de l'appareil à la marque de son agent, pour ouvrir sans réseau. */
function tag(key) {
  return G.crypto.subtle.digest('SHA-256', new G.TextEncoder().encode(String(key))).then(function (b) {
    var h = '', a = new Uint8Array(b);
    for (var i = 0; i < a.length; i++) h += (a[i] < 16 ? '0' : '') + a[i].toString(16);
    return 'cle:' + h;
  });
}

/* La photo [R277] : les mêmes calculs que le serveur. */
function figures(img) {
  var w = img.width, h = img.height, l = img.luma, sum = 0, white = 0, i;
  for (i = 0; i < l.length; i++) { sum += l[i]; if (l[i] >= 250) white++; }
  var n = 0, mean = 0, m2 = 0;
  for (var y = 1; y < h - 1; y++) for (var x = 1; x < w - 1; x++) {
    i = y * w + x;
    var lap = l[i - 1] + l[i + 1] + l[i - w] + l[i + w] - 4 * l[i];
    n++;
    var d = lap - mean;
    mean += d / n;
    m2 += d * (lap - mean);
  }
  function round(v, k) { k = k || 100; return Math.round(v * k) / k; }
  return { brightness: round(sum / l.length), clipped: round(white / l.length, 1000), sharpness: round(n > 0 ? m2 / n : 0) };
}
function judge(img) {
  var f = figures(img), p = [];
  if (f.brightness < T.minBrightness) p.push('trop_sombre');
  if (f.clipped > T.maxClipped) p.push('brulee');
  if (f.sharpness < T.minSharpness) p.push('floue');
  return { ok: p.length === 0, problems: p, figures: f, advice: p.length ? ADVICE[p[0]] : null };
}
function weight(v) { var x = v / 255 - 0.5; return Math.exp(-(x * x) / (2 * 0.2 * 0.2)) + 1e-6; }
function fuse(list) {
  var w = list[0].width, h = list[0].height, out = new Uint8Array(w * h);
  for (var i = 0; i < out.length; i++) {
    var num = 0, den = 0;
    for (var k = 0; k < list.length; k++) { var v = list[k].luma[i], q = weight(v); num += q * v; den += q; }
    out[i] = Math.max(0, Math.min(255, Math.round(num / den)));
  }
  return { width: w, height: h, luma: out };
}
function valid(e) { return e && e.width >= MIN_SIDE && e.height >= MIN_SIDE && e.width <= MAX_SIDE && e.height <= MAX_SIDE && e.luma && e.luma.length === e.width * e.height; }
function hdr(list) {
  var whole = 'La photo n’a pas été prise en entier : reprenez-la.';
  if (!Array.isArray(list) || list.length > 5 || !list.every(valid)) return { ok: false, code: 'prises_invalides', advice: whole };
  if (list.some(function (e) { return e.width !== list[0].width || e.height !== list[0].height; })) return { ok: false, code: 'prises_invalides', advice: whole };
  var means = list.map(function (e) { return figures(e).brightness; });
  if (list.length < T.minExposures || Math.max.apply(null, means) - Math.min.apply(null, means) < T.minExposureSpread) return { ok: false, code: 'pas_hdr', advice: 'Une seule lumière a été prise : la première prise vers la fenêtre, la seconde vers le coin sombre, sans bouger.' };
  var v = judge(fuse(list));
  return v.ok ? { ok: true, verdict: v } : { ok: false, code: v.problems[0], advice: v.advice, verdict: v };
}
function encode(img) { var s = ''; for (var i = 0; i < img.luma.length; i++) s += String.fromCharCode(img.luma[i]); return { width: img.width, height: img.height, data: G.btoa(s) }; }
function fit(w, h) {
  var s = Math.min(1, MAX_SIDE / Math.max(w, h, 1));
  return { width: Math.max(MIN_SIDE, Math.min(MAX_SIDE, Math.round(w * s))), height: Math.max(MIN_SIDE, Math.min(MAX_SIDE, Math.round(h * s))) };
}
/* Une prise de l'appareil photo, réduite en niveaux de gris ; la seconde prend la taille de la première. */
function reduce(file, size) {
  return G.createImageBitmap(file).then(function (bmp) {
    var d = size || fit(bmp.width, bmp.height);
    var c = G.OffscreenCanvas ? new G.OffscreenCanvas(d.width, d.height) : G.document.createElement('canvas');
    c.width = d.width;
    c.height = d.height;
    var g = c.getContext('2d');
    g.drawImage(bmp, 0, 0, d.width, d.height);
    var px = g.getImageData(0, 0, d.width, d.height).data, l = new Uint8Array(d.width * d.height);
    for (var i = 0; i < l.length; i++) l[i] = Math.round(0.299 * px[4 * i] + 0.587 * px[4 * i + 1] + 0.114 * px[4 * i + 2]);
    if (bmp.close) bmp.close();
    return { width: d.width, height: d.height, luma: l };
  });
}

/* L'écran. */
var doc = G.document, ui = null;
function $(id) { return doc.getElementById(id); }
function el(tag, text, cls) { var e = doc.createElement(tag); if (text) e.textContent = text; if (cls) e.className = cls; return e; }
function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
function btn(text, f, cls) { var b = el('button', text, cls); b.setAttribute('type', 'button'); b.addEventListener('click', f); return b; }
function hour(iso) { try { return new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Paris' }).format(new Date(iso)); } catch (e) { return ''; } }
function call(key, path, method, body) {
  var init = { method: method, headers: { authorization: 'Bearer ' + key }, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' };
  if (body !== undefined) { init.headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
  return G.fetch(path, init).then(function (r) {
    if (!r.ok) throw new Error('refus ' + r.status);
    return r.json().then(function (b) { if (!b || !b.data) throw new Error('réponse'); return b.data; });
  });
}
var limit = 10;
function sender(key) { return function (batch) { return call(key, R_SAISIES, 'POST', batch); }; }

function sync(key) {
  // Seulement la boîte de l'agent connecté, avec sa clé : après une sortie, plus rien ne part [R16].
  if (!key || !ui || ui.key !== key || !ui.owner) return Promise.resolve(null);
  return flush(ui.owner, sender(key), limit).then(function (r) { if (ui) render(); return r; }, function () { return null; });
}
/** Avec du réseau : le paquet du jour est préparé et gardé, puis la boîte part [R278, R276]. */
function prepare(key, show, back) {
  var mine = ui = { key: key, owner: null, show: show, back: back, open: false };
  return call(key, R_PAQUET, 'GET').then(function (d) {
    if (d.batchLimit > 0) limit = d.batchLimit;
    if (typeof d.owner !== 'string' || !/^[a-f0-9]{16,64}$/.test(d.owner)) return null;
    return tag(key).then(function (t) { return put(t, d.owner); }).then(function () {
      return d.pack && Array.isArray(d.pack.appointments) ? put(PAQUET + ':' + d.owner, d.pack) : null;
    }).then(function () {
      if (ui !== mine) return null;
      mine.owner = d.owner;
      entry();
      return sync(key);
    });
  }, function () { return null; });
}
/** La session finie (sortie, clé refusée, autre clé) : l'écran oublie la clé et l'agent ; rien n'est effacé de la boîte. */
function stop() { ui = null; }
/** Sans réseau au démarrage : la visite préparée s'ouvre, si un paquet du jour est là. */
function start(key, show, back, alive) {
  // Seule la clé qui a préparé le paquet l'ouvre : une autre clé tapée sans réseau ne voit rien [R16].
  return tag(key).then(get).then(function (o) {
    return typeof o === 'string' ? readPack(o).then(function (p) { return p ? { o: o, p: p } : null; }) : null;
  }).then(function (got) {
    if (!got || (alive && !alive())) return false;
    ui = { key: key, owner: got.o, show: show, back: back, open: true };
    return render().then(function () { show('hors-ligne'); return true; });
  }, function () { return false; });
}
function entry() {
  var home = $('accueil');
  if (!home || $('hors-ligne-ouvrir')) return;
  var b = btn('Mes visites sans réseau', function () { if (ui) { ui.open = true; render().then(function () { ui.show('hors-ligne'); }); } }, 'secondaire');
  b.id = 'hors-ligne-ouvrir';
  home.appendChild(b);
}
function render() {
  var root = $('hors-ligne');
  if (!root || !ui) return Promise.resolve();
  var o = ui.owner;
  return Promise.all([readPack(o), excl(function () { return current(o); })]).then(function (got) {
    var p = got[0], box = got[1];
    clear(root);
    if (ui.back) root.appendChild(btn('Retour à ma journée', function () { ui.open = false; ui.back(ui.key); }, 'retour'));
    root.appendChild(el('h2', 'Mes visites sans réseau'));
    var etat = el('p', '', 'etat');
    etat.setAttribute('role', 'status');
    etat.textContent = box.pending.length ? box.pending.length + (box.pending.length > 1 ? ' saisies attendent' : ' saisie attend') + ' le réseau : elles partiront seules.' : 'Tout est envoyé.';
    root.appendChild(etat);
    if (box.pending.length && ui.key) root.appendChild(btn('Envoyer maintenant', function () { sync(ui.key); }));
    box.refused.forEach(function (r) { root.appendChild(el('p', 'Refusée par le serveur : ' + (CODES[r.code] || r.code) + '.', 'doux')); });
    if (!p) { root.appendChild(el('p', 'Aucune visite préparée. Ouvrez l’application avec du réseau : la journée se prépare seule.')); return; }
    if (!p.appointments.length) root.appendChild(el('p', 'Aucune visite ni estimation prévue ce jour.'));
    p.appointments.forEach(function (a) { root.appendChild(card(a, box.pending)); });
  });
}
function card(a, pending) {
  var c = el('article', '', 'carte');
  var b = a.property;
  c.appendChild(el('h3', (a.kind === 'estimation' ? 'Estimation' : 'Visite') + ' à ' + hour(a.start) + (b ? ' · ' + b.reference + (b.city ? ', ' + b.city : '') : '')));
  if (b) c.appendChild(el('p', [b.surfaceM2 ? b.surfaceM2 + ' m²' : '', b.rooms ? b.rooms + ' pièces' : ''].filter(Boolean).join(', '), 'doux'));
  var done = {}, skip = {};
  a.accepted.forEach(function (k) { done[k] = true; });
  a.skipped.forEach(function (k) { skip[k] = true; });
  pending.forEach(function (o) { if (o.appointmentId !== a.appointmentId) return; if (o.kind === 'visite.photo') done[o.payload.shot] = true; if (o.kind === 'visite.sans_objet') skip[o.payload.shot] = true; });
  var missing = [];
  var list = el('ul');
  a.shots.forEach(function (s) {
    var li = el('li');
    var st = done[s.key] ? 'faite' : skip[s.key] ? 'sans objet' : 'à faire';
    li.appendChild(el('strong', s.label + ' : ' + st));
    if (st === 'à faire') { missing.push(s.label); shotTools(li, a, s); }
    list.appendChild(li);
  });
  if (a.shots.length) c.appendChild(list);
  c.appendChild(el('p', missing.length ? 'Avant de repartir, il manque : ' + missing.join(', ') + '.' : 'Tout est fait : vous pouvez repartir.', missing.length ? 'etat' : 'doux'));
  var note = el('textarea');
  note.setAttribute('aria-label', 'Note de la visite');
  note.setAttribute('maxlength', String(MAX_NOTE));
  var said = el('p', '', 'doux');
  c.appendChild(note);
  c.appendChild(btn('Garder la note', function () {
    var t = String(note.value || '').trim();
    if (!t || t.length > MAX_NOTE) { said.textContent = 'Une note de 1 à 2 000 caractères.'; return; }
    add('visite.note', a.appointmentId, { text: t }).then(function () { note.value = ''; said.textContent = 'Note gardée sur le téléphone.'; return render(); });
  }));
  c.appendChild(said);
  return c;
}
function shotTools(li, a, s) {
  if (s.advice) li.appendChild(el('p', s.advice, 'doux'));
  var said = el('p', '', 'doux'), shots = [null, null];
  function input(i, label) {
    var f = el('input');
    f.setAttribute('type', 'file');
    f.setAttribute('accept', 'image/*');
    f.setAttribute('capture', 'environment');
    f.setAttribute('aria-label', label + ', ' + s.label);
    f.addEventListener('change', function () {
      shots[i] = f.files && f.files[0] ? f.files[0] : null;
      if (shots[0] && shots[1]) keep();
    });
    li.appendChild(el('span', label));
    li.appendChild(f);
  }
  function keep() {
    said.textContent = 'Photo en cours de contrôle…';
    reduce(shots[0]).then(function (one) {
      return reduce(shots[1], { width: one.width, height: one.height }).then(function (two) { return [one, two]; });
    }).then(function (list) {
      var r = hdr(list);
      if (!r.ok) { shots = [null, null]; said.textContent = 'Photo refusée. ' + r.advice; return; }
      return add('visite.photo', a.appointmentId, { shot: s.key, exposures: list.map(encode) }).then(render);
    }, function () { said.textContent = 'Photo illisible : reprenez-la.'; });
  }
  input(0, '1re prise, vers la fenêtre');
  input(1, '2e prise, vers le coin sombre');
  REASONS.forEach(function (r) { li.appendChild(btn(r[1], function () { add('visite.sans_objet', a.appointmentId, { shot: s.key, reason: r[0] }).then(render); }, 'secondaire')); });
  li.appendChild(said);
}
if (G.addEventListener) G.addEventListener('online', function () { if (ui && ui.key) sync(ui.key); });

G.AimmoHorsLigne = Object.freeze({
  preparer: prepare,
  start: start,
  sync: sync,
  add: add,
  stop: stop,
  pending: function (o) { o = o || (ui && ui.owner); return o ? excl(function () { return current(o); }).then(function (s) { return s.pending.slice(); }) : Promise.resolve([]); },
  refused: function (o) { o = o || (ui && ui.owner); return o ? excl(function () { return current(o); }).then(function (s) { return s.refused.slice(); }) : Promise.resolve([]); },
  readPack: readPack,
  photo: Object.freeze({ figures: figures, judge: judge, fuse: fuse, hdr: hdr, encode: encode, reduce: reduce })
});
})();
`;
