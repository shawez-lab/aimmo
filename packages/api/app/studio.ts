import { OPERATION_LABELS } from '../../core/src/studio/certificats.ts';
import { ROOM_KINDS } from '../../core/src/studio/plan.ts';

/**
 * L'écran « Studio » de l'application de l'agent (X11), en morceaux posés dans `fichiers.ts` : sa section de page, son
 * chargeur et son script, servi à part (`/app/studio.js`) et chargé à la première ouverture pour tenir le budget de
 * l'application [R201]. Il s'ouvre depuis un bien de la liste « Mes biens ».
 *
 * L'écran ne lit et n'écrit que par les routes `/v1/studio` [R16]. Les corrections de photo se font sur le téléphone,
 * dans une toile, avec la seule liste fermée des corrections d'ensemble ; aucune image ni vidéo n'est envoyée à un
 * serveur pour traitement [R130] : l'écran envoie des références, des choix et des cotes, et dépose les fichiers finis
 * (original, photo corrigée, vidéo montée), rangés tels quels, avec l'empreinte calculée sur le téléphone (X12). Tout texte reçu est posé
 * avec `textContent` ; l'écran ne calcule ni surface, ni texte, ni droit : il montre ce que le code a décidé.
 */

const EVENT_LABELS = { nouveau_bien: 'Nouveau bien', visite: 'Visites en cours', offre: 'Offre reçue', vente: 'Bien vendu' };
const CHANNEL_LABELS = { instagram: 'Instagram', facebook: 'Facebook', linkedin: 'LinkedIn', google: 'Fiche Google', tiktok: 'TikTok', youtube: 'YouTube' };
const ROOM_LABELS = Object.fromEntries(Object.entries(ROOM_KINDS).map(([k, v]) => [k, v.label]));
/** Les raisons d'un refus, dites à l'agent : jamais un code interne. */
const REFUSALS = {
  deja_valide: 'Le guide est déjà validé par la direction.',
  vue_inconnue: 'Cette vue n’est plus dans le guide du bien.',
  photo_inconnue: 'Cette photo n’est plus dans la fiche du bien.',
  pieces_invalides: 'Le plan doit compter au moins une pièce, chacune avec ses cotes.',
  sorte_inconnue: 'Choisissez la sorte de pièce dans la liste.',
  cote_absente: 'Une cote manque : saisissez-les toutes, en centimètres.',
  cote_impossible: 'Une cote est impossible : vérifiez-la.',
  chevauchement: 'Deux pièces se chevauchent : vérifiez leurs positions.',
  evenement_inconnu: 'Choisissez l’événement dans la liste.',
  evenement_sans_fondement: 'Le bien n’est pas dans l’état que cet événement annonce.',
  visuels_invalides: 'Choisissez de 1 à 10 photos.',
  visuel_sans_certificat: 'Une photo n’a pas son certificat : elle ne peut pas partir.',
  bien_non_diffusable: 'Le bien ne peut pas encore être diffusé : mandat absent ou délai de rétractation en cours.',
  mentions_incompletes: 'Il manque des mentions obligatoires : complétez la fiche du bien.',
  texte_refuse: 'Le texte situe le bien ou nomme quelqu’un : il est refusé.',
  texte_trop_long: 'Le texte dépasse la longueur admise par les réseaux.',
  visuel_inconnu: 'Ce visuel n’est plus dans la publication.',
  liste_incomplete: 'Répondez à chaque question de la liste de contrôle.',
  deja_controle: 'Ce visuel est déjà contrôlé.',
  adresse_visible: 'Refusé : une adresse se lit sur ce visuel.',
  personne_sans_accord: 'Refusé : une personne se reconnaît sans accord rangé.',
  amenagement_sans_mention: 'Refusé : la mention « Aménagement virtuel » doit se voir sur l’image.',
  stockage_indisponible: 'Stockage indisponible : réessayez dans un moment.',
  non_validee: 'Validez d’abord la publication.',
  canal_hors_service: 'Ce réseau n’est pas en service.',
  cibles_invalides: 'Choisissez au moins un réseau.',
  visuels_non_controles: 'Contrôlez d’abord chaque visuel.',
  visuel_refuse: 'Un visuel est refusé : préparez une nouvelle publication.',
  deja_validee: 'Cette publication est déjà validée.',
  texte_perime: 'La fiche a changé depuis : préparez une nouvelle publication.',
  agent_parti: 'L’agent qui l’a préparée a quitté le réseau : préparez une nouvelle publication.',
  empreinte_differente: 'Le fichier reçu n’est pas celui préparé sur ce téléphone : rien n’est rangé. Réessayez.',
  type_refuse: 'Ce type de fichier n’est pas admis.',
  trop_lourd: 'Fichier trop lourd pour la fiche.',
  fichier_vide: 'Le fichier est vide.',
  fiche_absente: 'Remplissez d’abord la fiche du bien.',
  fiche_pleine: 'La fiche compte déjà 80 photos et vidéos.',
  fiche_occupee: 'La fiche n’a pas reçu le fichier : réessayez.',
  fiche_refusee: 'La fiche n’a pas reçu le fichier : réessayez.',
  depot_ferme: 'Le rangement des fichiers n’est pas encore ouvert.',
  original_absent: 'L’original n’est pas rangé : réessayez.',
  empreinte_incoherente: 'Les empreintes ne correspondent pas aux corrections : préparez de nouveau la photo.',
  video_inconnue: 'Cette vidéo n’est pas dans la fiche du bien.',
  duree_invalide: 'La durée ne correspond pas au modèle.',
  deja_rangee: 'Cette vidéo est déjà rangée.',
};

export const STUDIO_HTML = `<section id="studio" hidden>
<button id="studio-retour" type="button" class="retour">Retour à ma journée</button>
<h2 id="studio-titre">Studio</h2>
<p class="doux">Photos, vidéo et plan se préparent sur ce téléphone : aucune image ne part pour être traitée.</p>
<p id="studio-etat" class="etat" role="status"></p>
<div id="studio-corps"></div>
</section>
`;

/** Le chargeur posé dans le script de l'application : l'écran est servi à part, chargé une fois, jamais gardé. */
export const STUDIO_JS = `
  /* ---------- M19 : l'écran « Studio » (X11), chargé à la demande [R130, R16, R201]. ---------- */
  var studioScreen = null;
  function wipeStudio() {
    if (studioScreen) { studioScreen.wipe(); return; }
    clear($('studio-corps'));
    $('studio-etat').textContent = '';
  }
  // Le dépôt d'un fichier fini, tel quel, sous la session en cours, comme send (X12) : le serveur le range, sans le traiter [R130].
  function studioUpload(path, file, type, sha) {
    if (!currentKey) return Promise.resolve({ gone: true });
    var mine = session;
    return fetch(path, { method: 'POST', headers: { authorization: 'Bearer ' + currentKey, 'content-type': type, 'x-aimmo-sha256': sha }, body: file, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }).then(function (r) {
      return r.json().then(function (b) { return b; }, function () { return null; }).then(function (b) {
        if (mine !== session) return { gone: true };
        if (r.status === 401 || (r.status === 403 && b && b.code === 'agent_inactive')) { forgetKey(currentKey); refuse('Clé refusée. Vérifiez-la ou demandez-en une nouvelle.'); return { gone: true }; }
        return { status: r.status, ok: r.ok && !!b && b.ok === true, body: b };
      });
    }, function () { return mine !== session ? { gone: true } : { offline: true }; });
  }
  function openStudio(id, reference) {
    if (!currentKey || !ID.test(id)) return Promise.resolve(false);
    if (studioScreen) return studioScreen.open(id, reference);
    session += 1;
    var mine = session;
    wipeStudio();
    show('studio', [id, reference]);
    $('studio-etat').textContent = 'Chargement…';
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.setAttribute('src', '/app/studio.js');
      s.addEventListener('load', function () {
        var make = globalThis.AIMMO_STUDIO;
        try { delete globalThis.AIMMO_STUDIO; } catch (e) { /* rien */ }
        if (mine !== session || typeof make !== 'function') { resolve(false); return; }
        studioScreen = make({ $: $, el: el, clear: clear, send: send, upload: studioUpload, button: button, field: field, checkbox: checkbox, show: show, ID: ID, key: function () { return currentKey; }, session: function () { return session; }, bump: function () { session += 1; return session; } });
        resolve(studioScreen.open(id, reference));
      });
      s.addEventListener('error', function () {
        if (mine === session) $('studio-etat').textContent = 'Pas de réseau. Réessayez dans un moment.';
        resolve(false);
      });
      $('studio').appendChild(s);
    });
  }
`;

/**
 * Le script de l'écran, servi à part (`/app/studio.js`). Il reçoit les outils de l'application et ne garde rien :
 * ni clé, ni réponse, ni image une fois l'écran quitté.
 */
export const STUDIO_SCRIPT = `'use strict';
globalThis.AIMMO_STUDIO = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, upload = t.upload, button = t.button, field = t.field, checkbox = t.checkbox, show = t.show, ID = t.ID;
  var OPS = ${JSON.stringify(OPERATION_LABELS)};
  var EVENTS = ${JSON.stringify(EVENT_LABELS)};
  var CHANNELS = ${JSON.stringify(CHANNEL_LABELS)};
  var ROOMS = ${JSON.stringify(ROOM_LABELS)};
  var NO = ${JSON.stringify(REFUSALS)};
  var PARTS = [['guide', 'Guide'], ['photo', 'Photo'], ['montage', 'Montage'], ['plan', 'Plan'], ['publications', 'Publications']];
  var cur = null, seq = 0, photo = null;
  function state(x) { $('studio-etat').textContent = x; }
  function body() { return $('studio-corps'); }
  function block(title) { var b = el('section', null, 'bloc'); b.appendChild(el('h3', title)); body().appendChild(b); return b; }
  function day(iso) { return typeof iso === 'string' ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) : ''; }
  function why(res, fallback) {
    if (res.offline) return 'La réponse n’est pas arrivée : rien n’est sûr. Relisez avant de recommencer.';
    if (res.status === 403 || res.status === 404) return 'Ce bien n’est pas dans vos droits.';
    return (res.body && NO[res.body.code]) || fallback;
  }
  function forget() { if (photo) [photo.url, photo.originalUrl].forEach(function (u) { if (u) { try { URL.revokeObjectURL(u); } catch (e) { /* rien */ } } }); photo = null; }
  function safe(n) { return String(n).replace(/[^A-Za-z0-9._-]/g, '_'); }
  function wipe() { forget(); clear(body()); state(''); $('studio-titre').textContent = 'Studio'; cur = null; }
  function base() { return '/v1/studio/biens/' + encodeURIComponent(cur.id); }
  function open(id, reference) {
    if (!t.key() || !ID.test(id)) return Promise.resolve(false);
    t.bump();
    wipe();
    cur = { id: id, reference: reference || 'ce bien', part: 'guide', atelier: null };
    $('studio-titre').textContent = 'Studio · ' + cur.reference;
    show('studio', [id, reference]);
    return part('guide');
  }
  // Une partie à la fois, sur téléphone ; une réponse arrivée après un autre choix est ignorée.
  function part(name, message) {
    if (!cur) return Promise.resolve(false);
    cur.part = name;
    var mine = ++seq;
    forget();
    clear(body());
    var nav = el('div', null, 'periodes');
    nav.setAttribute('role', 'group');
    nav.setAttribute('aria-label', 'Parties du Studio');
    PARTS.forEach(function (p) {
      var b = button(p[1], function () { part(p[0]); });
      b.className = 'secondaire';
      b.setAttribute('aria-pressed', p[0] === name ? 'true' : 'false');
      nav.appendChild(b);
    });
    body().appendChild(nav);
    state('Chargement…');
    var reads = [send(base(), 'GET')];
    if (name === 'guide') reads.push(send(base() + '/guide', 'GET'));
    if (name === 'montage') reads.push(send(base() + '/montage', 'GET'));
    if (name === 'plan') reads.push(send(base() + '/plan', 'GET'));
    return Promise.all(reads).then(function (all) {
      if (mine !== seq || !cur || all.some(function (x) { return x.gone; })) return false;
      var bad = all.filter(function (x) { return !x.ok; })[0];
      if (bad) { state(bad.offline ? 'Pas de réseau. Réessayez dans un moment.' : bad.status === 403 || bad.status === 404 ? 'Ce bien n’est pas dans vos droits.' : 'Indisponible pour le moment. Réessayez plus tard.'); return false; }
      cur.atelier = all[0].body.data || { photos: [], posts: [] };
      state(message || '');
      if (name === 'guide') guide(all[1].body.data);
      else if (name === 'photo') photoPart();
      else if (name === 'montage') { montage(all[1].body.data); return trackedLinks('videos', mine); }
      else if (name === 'plan') plan(all[1].body.data);
      else { publications(); return trackedLinks('posts', mine); }
      return true;
    });
  }
  /* AT20 · le lien marqué de ce que l'agent poste lui-même : sa panne n'empêche rien d'autre de l'écran. */
  function trackedLinks(side, mine) {
    return send(base() + '/liens', 'GET').then(function (res) {
      if (res.gone || mine !== seq) return false;
      var items = res.ok && res.body.data ? res.body.data[side] || [] : [];
      var online = res.ok && res.body.data ? res.body.data.online : true;
      if (res.ok && !items.length && online) return true;
      var b = block('Liens à coller');
      if (!res.ok) { b.appendChild(el('p', 'Liens indisponibles pour le moment.', 'doux')); return true; }
      if (!online) b.appendChild(el('p', 'Ce bien n’a pas de page en ligne : pas de lien pour le moment.', 'doux'));
      if (items.length) b.appendChild(el('p', 'Collez ce lien avec ce que vous postez vous-même : il dit de quel contenu vient le contact, rien sur la personne.', 'doux'));
      var ul = el('ul', null, 'liste');
      items.forEach(function (x) {
        var li = el('li');
        li.appendChild(el('strong', side === 'videos' ? 'Vidéo de ' + x.durationSeconds + ' s, le ' + day(x.recordedAt) : (EVENTS[x.event] || 'Publication') + ', le ' + day(x.createdAt)));
        li.appendChild(el('p', x.link));
        li.appendChild(button('Copier le lien', function () {
          var clip = navigator.clipboard;
          if (!clip) { state('Copiez le lien à la main.'); return; }
          clip.writeText(x.link).then(function () { state('Lien copié.'); }, function () { state('Copiez le lien à la main.'); });
        }));
        ul.appendChild(li);
      });
      b.appendChild(ul);
      return true;
    });
  }
  function act(path, payload, fallback, done, then) {
    var mine = seq;
    state('Envoi…');
    return send(path, 'POST', payload).then(function (res) {
      if (res.gone || mine !== seq) return false;
      if (!res.ok) { state(why(res, fallback)); return false; }
      return then ? then(res.body.data, done) : part(cur.part, done);
    });
  }
  function photos(real) {
    return (cur.atelier.photos || []).filter(function (p) { return typeof p.ref === 'string' && (!real || p.edit !== 'amenagement_virtuel'); });
  }
  function photoName(p) { var all = photos(false); return 'Photo ' + (all.indexOf(p) + 1) + (p.overlay ? ' · ' + p.overlay : ''); }

  /* ---------- Guide de prise de vue (X01) : pièce par pièce, consigne écrite par le code. ---------- */
  function guide(g) {
    var head = block('Guide de prise de vue');
    if (g.validated) head.appendChild(el('p', 'Validé par la direction le ' + day(g.validated.at) + '.', 'fait'));
    else if (g.ready) head.appendChild(el('p', 'Toutes les vues obligatoires ont leur photo : prêt pour la validation de la direction.', 'fait'));
    else head.appendChild(el('p', (g.missing || []).length + ' vue(s) obligatoire(s) encore à faire.', 'etat'));
    var mine = photos(true);
    var ol = el('ol', null, 'parcours');
    (g.views || []).forEach(function (v, i) {
      var li = el('li', null, v.mediaRef ? 'fait' : '');
      li.appendChild(el('strong', v.label + (v.mandatory ? '' : ' · facultative')));
      li.appendChild(el('p', 'Où : ' + v.place));
      li.appendChild(el('p', 'Hauteur : ' + v.height));
      li.appendChild(el('p', 'Lumière : ' + v.light));
      var chosen = v.mediaRef ? mine.filter(function (p) { return p.ref === v.mediaRef; })[0] : null;
      li.appendChild(el('p', v.mediaRef ? 'Photo retenue' + (chosen ? ' : ' + photoName(chosen) : '') + '.' : 'À faire.', v.mediaRef ? 'fait' : 'doux'));
      if (!g.validated && mine.length) {
        var s = field(li, 'studio-vue-' + i, 'Photo de la fiche pour cette vue', 'select');
        mine.forEach(function (p) { var o = el('option', photoName(p)); o.setAttribute('value', p.ref); if (p.ref === v.mediaRef) o.setAttribute('selected', ''); s.appendChild(o); });
        if (!s.value && mine[0]) s.value = mine[0].ref;
        li.appendChild(button('Retenir cette photo', function () { act(base() + '/guide/vues', { viewKey: v.key, mediaRef: s.value }, 'La photo n’est pas retenue.', 'Photo retenue pour ' + v.label + '.'); }));
      }
      ol.appendChild(li);
    });
    head.appendChild(ol);
    if (!mine.length) head.appendChild(el('p', 'Aucune photo dans la fiche du bien pour le moment.', 'doux'));
    var rem = block('À ne pas oublier');
    var ul = el('ul', null, 'liste');
    (g.doNotForget || []).forEach(function (x) { ul.appendChild(el('li', x)); });
    rem.appendChild(ul);
  }

  /* ---------- Photo corrigée sur le téléphone (X02) : corrections d'ensemble, liste fermée [R130]. ---------- */
  // Les réglages de chaque correction et leur valeur neutre : une correction neutre n'est pas une correction.
  var KNOBS = [
    ['exposition', 'ev', -3, 3, 0.1, 0, 'IL'],
    ['balance_des_blancs', 'kelvin', 2000, 12000, 100, 6500, 'K'],
    ['contraste', 'amount', -100, 100, 1, 0, 'sur 100'],
    ['verticales', 'degrees', -15, 15, 0.5, 0, '°'],
    ['nettete', 'amount', 0, 100, 1, 0, 'sur 100'],
    ['recadrage', 'keep', 60, 100, 1, 100, '% gardés'],
  ];
  function num(v, k) { var n = Number(v); if (!isFinite(n)) n = k[5]; return Math.min(k[3], Math.max(k[2], n)); }
  // Les corrections dites au serveur et au client, dans l'ordre de la liste fermée ; les neutres sont retirées.
  function operations(values) {
    var out = [];
    KNOBS.forEach(function (k) {
      var v = num(values[k[0]], k);
      if (v === k[5]) return;
      if (k[0] === 'recadrage') { var f = v / 100, m = Math.round((1 - f) / 2 * 1000) / 1000; out.push({ op: 'recadrage', x: m, y: m, width: f, height: f }); return; }
      var o = { op: k[0] }; o[k[1]] = k[0] === 'balance_des_blancs' || k[0] === 'contraste' || k[0] === 'nettete' ? Math.round(v) : Math.round(v * 10) / 10; out.push(o);
    });
    return out;
  }
  function say(o) {
    var n = function (x) { return String(x).replace('.', ','); };
    if (o.op === 'exposition') return OPS.exposition + ' : ' + (o.ev > 0 ? '+' : '') + n(o.ev) + ' IL';
    if (o.op === 'balance_des_blancs') return OPS.balance_des_blancs + ' : ' + o.kelvin + ' K';
    if (o.op === 'contraste') return OPS.contraste + ' : ' + (o.amount > 0 ? '+' : '') + o.amount + ' sur 100';
    if (o.op === 'verticales') return OPS.verticales + ' : ' + (o.degrees > 0 ? '+' : '') + n(o.degrees) + '°';
    if (o.op === 'nettete') return OPS.nettete + ' : ' + o.amount + ' sur 100';
    return OPS.recadrage + ' : ' + Math.round(o.width * 100) + ' % de la largeur et de la hauteur gardés';
  }
  // Chaque pixel reçoit le même calcul : exposition, balance des blancs, contraste. Aucune zone, aucun masque.
  function pixels(d, ops) {
    var gain = 1, wr = 1, wb = 1, c = 1;
    ops.forEach(function (o) {
      if (o.op === 'exposition') gain = Math.pow(2, o.ev);
      if (o.op === 'balance_des_blancs') { var s = (o.kelvin - 6500) / 6500; wr = 1 + s * 0.25; wb = 1 - s * 0.25; }
      if (o.op === 'contraste') c = (100 + o.amount) / 100;
    });
    for (var i = 0; i < d.length; i += 4) {
      d[i] = (d[i] * gain * wr - 128) * c + 128;
      d[i + 1] = (d[i + 1] * gain - 128) * c + 128;
      d[i + 2] = (d[i + 2] * gain * wb - 128) * c + 128;
    }
    return d;
  }
  // La netteté : le même masque flou soustrait sur toute l'image.
  function sharpen(d, w, h, amount) {
    if (!amount) return d;
    var a = amount / 100, src = d.slice(0), x, y, ch, i;
    for (y = 1; y < h - 1; y += 1) for (x = 1; x < w - 1; x += 1) for (ch = 0; ch < 3; ch += 1) {
      i = (y * w + x) * 4 + ch;
      d[i] = src[i] + a * (4 * src[i] - src[i - 4] - src[i + 4] - src[i - w * 4] - src[i + w * 4]);
    }
    return d;
  }
  function hex(buf) { return Array.prototype.map.call(new Uint8Array(buf), function (b) { return (b < 16 ? '0' : '') + b.toString(16); }).join(''); }
  function digest(buf) { return crypto.subtle.digest('SHA-256', buf).then(hex); }
  function draw(canvas, bmp, ops) {
    var crop = ops.filter(function (o) { return o.op === 'recadrage'; })[0];
    var turn = ops.filter(function (o) { return o.op === 'verticales'; })[0];
    var sx = crop ? crop.x * bmp.width : 0, sy = crop ? crop.y * bmp.height : 0;
    var sw = crop ? crop.width * bmp.width : bmp.width, sh = crop ? crop.height * bmp.height : bmp.height;
    canvas.width = Math.round(sw);
    canvas.height = Math.round(sh);
    var g = canvas.getContext('2d');
    g.save();
    g.translate(canvas.width / 2, canvas.height / 2);
    if (turn) g.rotate(turn.degrees * Math.PI / 180);
    g.drawImage(bmp, sx, sy, sw, sh, -canvas.width / 2, -canvas.height / 2, canvas.width, canvas.height);
    g.restore();
    var img = g.getImageData(0, 0, canvas.width, canvas.height);
    pixels(img.data, ops);
    var sharp = ops.filter(function (o) { return o.op === 'nettete'; })[0];
    if (sharp) sharpen(img.data, canvas.width, canvas.height, sharp.amount);
    g.putImageData(img, 0, 0);
  }
  function photoPart() {
    var b = block('Corriger une photo sur ce téléphone');
    b.appendChild(el('p', 'Seulement des corrections d’ensemble : exposition, balance des blancs, contraste, verticales, netteté, recadrage. Aucune retouche locale, aucun défaut effacé ; enregistrez toujours l’original avec la photo corrigée.', 'doux'));
    var pick = field(b, 'studio-photo-fichier', 'Prendre ou choisir une photo');
    pick.setAttribute('type', 'file');
    pick.setAttribute('accept', 'image/*');
    pick.setAttribute('capture', 'environment');
    var knobs = {};
    KNOBS.forEach(function (k) {
      var r = field(b, 'studio-reglage-' + k[0], OPS[k[0]] + ' (' + k[6] + ')');
      r.setAttribute('type', 'range');
      r.setAttribute('min', String(k[2]));
      r.setAttribute('max', String(k[3]));
      r.setAttribute('step', String(k[4]));
      r.value = String(k[5]);
      knobs[k[0]] = r;
    });
    var canvas = el('canvas');
    canvas.setAttribute('role', 'img');
    canvas.setAttribute('aria-label', 'Aperçu de la photo corrigée');
    b.appendChild(canvas);
    var out = el('div');
    b.appendChild(out);
    var local = el('p', null, 'doux');
    local.setAttribute('role', 'status');
    b.appendChild(local);
    function values() { var v = {}; KNOBS.forEach(function (k) { v[k[0]] = knobs[k[0]].value; }); return v; }
    pick.addEventListener('change', function () {
      var file = pick.files && pick.files[0];
      forget();
      clear(out);
      if (!file) return;
      local.textContent = 'Lecture de la photo sur ce téléphone…';
      var mine = seq;
      file.arrayBuffer().then(function (buf) {
        return Promise.all([digest(buf), createImageBitmap(file)]);
      }).then(function (both) {
        if (mine !== seq) return;
        photo = { name: file.name || 'photo.jpg', file: file, type: String(file.type || '').toLowerCase(), originalSha256: both[0], bitmap: both[1], url: null, originalUrl: URL.createObjectURL(file) };
        draw(canvas, photo.bitmap, []);
        local.textContent = 'Photo prête : réglez, puis préparez la photo corrigée.';
      }, function () { if (mine === seq) local.textContent = 'Cette photo ne se lit pas sur ce téléphone.'; });
    });
    b.appendChild(button('Voir les corrections', function () {
      if (!photo) { local.textContent = 'Prenez ou choisissez d’abord une photo.'; return; }
      draw(canvas, photo.bitmap, operations(values()));
      local.textContent = 'Aperçu à jour.';
    }));
    b.appendChild(button('Préparer la photo corrigée', function () {
      if (!photo) { local.textContent = 'Prenez ou choisissez d’abord une photo.'; return; }
      var ops = operations(values()), mine = seq, held = photo;
      draw(canvas, held.bitmap, ops);
      local.textContent = 'Préparation sur ce téléphone…';
      canvas.toBlob(function (blob) {
        if (!blob || mine !== seq || held !== photo) return;
        blob.arrayBuffer().then(digest).then(function (sha) {
          if (mine !== seq || held !== photo) return;
          clear(out);
          out.appendChild(el('h4', 'Ce que dira le certificat'));
          var ul = el('ul', null, 'liste');
          if (!ops.length) ul.appendChild(el('li', 'Aucune correction : la photo publiée sera l’original, tel quel.'));
          ops.forEach(function (o) { ul.appendChild(el('li', say(o) + ', sur toute l’image')); });
          out.appendChild(ul);
          out.appendChild(el('p', 'Empreinte de l’original : ' + held.originalSha256, 'doux'));
          // L'original, tel qu'il a été pris : toujours proposé, pour qu'il reste gardé [R130].
          var o = el('a', 'Enregistrer l’original sur ce téléphone');
          o.setAttribute('href', held.originalUrl);
          o.setAttribute('download', 'original-' + safe(held.name));
          out.appendChild(o);
          if (ops.length) {
            // L'empreinte dite est celle du fichier enregistré, à l'octet près.
            out.appendChild(el('p', 'Empreinte de la photo corrigée : ' + sha, 'doux'));
            held.url = URL.createObjectURL(blob);
            var a = el('a', 'Enregistrer la photo corrigée sur ce téléphone');
            a.setAttribute('href', held.url);
            a.setAttribute('download', 'corrigee-' + safe(held.name));
            out.appendChild(a);
          }
          out.appendChild(button('Ranger la photo, son original et son certificat', function () { keep(held, ops, ops.length ? blob : null, sha); }));
          local.textContent = (ops.length ? 'Photo corrigée prête' : 'Aucune correction') + '. Rien n’a quitté ce téléphone.';
        });
      }, 'image/jpeg', 0.92);
    }));
  }

  /* ---------- Dépôt (X12) : l'original, puis la photo, rangés tels quels ; enfin le certificat [R130]. ---------- */
  var ORIGINAL_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/x-adobe-dng'];
  var PHOTO_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
  // Un dépôt, puis la suite ; un refus est dit, une réponse arrivée après un autre choix est ignorée.
  function put(kind, file, type, sha, query, fallback) {
    var mine = seq;
    return upload(base() + '/fichiers/' + kind + (query || ''), file, type, sha).then(function (res) {
      if (res.gone || mine !== seq) return null;
      if (!res.ok) { state(why(res, fallback)); return null; }
      return res.body.data;
    });
  }
  function keep(held, ops, blob, sha) {
    if (held !== photo) return;
    if (ORIGINAL_TYPES.indexOf(held.type) < 0) { state('Cette photo n’est pas en JPEG, PNG, WebP, HEIC ou DNG : elle ne peut pas être rangée.'); return; }
    // Sans correction, la photo publiée est l'original lui-même : il doit être d'un type que la fiche admet.
    if (!blob && PHOTO_TYPES.indexOf(held.type) < 0) { state('Sans correction, la photo doit être en JPEG, PNG ou WebP : appliquez une correction ou choisissez une autre photo.'); return; }
    state('Envoi de l’original…');
    put('original', held.file, held.type, held.originalSha256, '', 'L’original n’est pas rangé.').then(function (o) {
      if (!o) return null;
      state('Envoi de la photo…');
      return put('photo', blob || held.file, blob ? 'image/jpeg' : held.type, blob ? sha : held.originalSha256, '?retouche=' + (blob ? 'lumiere_cadrage' : 'aucune'), 'La photo n’est pas rangée.').then(function (p) {
        if (!p) return null;
        return act(base() + '/photos', { resultRef: p.ref, resultSha256: p.sha256, originalRef: o.ref, originalSha256: o.sha256, operations: ops, processedOn: 'appareil' }, 'Le certificat n’est pas rangé.', 'Photo rangée dans la fiche, avec son original et son certificat.');
      });
    });
  }

  /* ---------- Montage (X03) : le plan de tournage du modèle, monté sur le téléphone. ---------- */
  function montage(m) {
    var b = block('Montage depuis le modèle');
    b.appendChild(el('p', (m.clips || []).length + ' plans, ' + m.totalSeconds + ' secondes, environ ' + m.estimatedMinutes + ' minutes de montage en ' + m.gestures + ' gestes.', 'etat'));
    var ol = el('ol', null, 'parcours');
    (m.clips || []).forEach(function (c) {
      var li = el('li');
      li.appendChild(el('strong', c.shot + ' · ' + c.seconds + ' s'));
      if (c.subtitle) li.appendChild(el('p', 'Sous-titre : ' + c.subtitle, 'doux'));
      ol.appendChild(li);
    });
    b.appendChild(ol);
    var n = block('À ne jamais filmer');
    var ul = el('ul', null, 'liste');
    (m.neverFilm || []).forEach(function (x) { ul.appendChild(el('li', x)); });
    n.appendChild(ul);
    // La vidéo montée sur le téléphone : rangée telle quelle, puis son montage et ses textes contrôlés (X12).
    var v = block('Ranger la vidéo montée');
    var pick = field(v, 'studio-video-fichier', 'Vidéo montée (MP4)');
    pick.setAttribute('type', 'file');
    pick.setAttribute('accept', 'video/mp4');
    var len = field(v, 'studio-video-duree', 'Durée (secondes)');
    len.setAttribute('type', 'number');
    len.setAttribute('min', '1');
    len.value = String(m.totalSeconds || '');
    var cap = field(v, 'studio-video-legende', 'Légende', 'textarea');
    var subs = (m.clips || []).map(function (c) { return c.subtitle; }).filter(function (x) { return typeof x === 'string' && x; });
    v.appendChild(button('Ranger la vidéo dans la fiche', function () {
      var file = pick.files && pick.files[0];
      if (!file) { state('Choisissez d’abord la vidéo montée.'); return; }
      if (String(file.type || '').toLowerCase() !== 'video/mp4') { state('La vidéo doit être en MP4.'); return; }
      var mine = seq;
      state('Lecture de la vidéo sur ce téléphone…');
      file.arrayBuffer().then(digest).then(function (sha) {
        if (mine !== seq) return null;
        state('Envoi de la vidéo…');
        return put('video', file, 'video/mp4', sha, '', 'La vidéo n’est pas rangée.').then(function (d) {
          if (!d) return null;
          return act(base() + '/montage', { videoRef: d.ref, videoSha256: d.sha256, durationSeconds: Math.round(Number(len.value)), subtitles: subs, caption: cap.value, musicId: null, processedOn: 'appareil' }, 'Le montage n’est pas rangé.', 'Vidéo rangée dans la fiche, avec son montage.');
        });
      }, function () { if (mine === seq) state('Cette vidéo ne se lit pas sur ce téléphone.'); });
    }));
  }

  /* ---------- Plan du logement (X04) : cotes saisies, surfaces calculées par le code [R135]. ---------- */
  function plan(p) {
    var b = block('Plan du logement');
    var rooms = p && Array.isArray(p.rooms) ? p.rooms : [];
    var keep = rooms.map(function (r) { return { kind: r.kind, xCm: r.xCm, yCm: r.yCm, widthCm: r.widthCm, depthCm: r.depthCm }; });
    if (p) {
      b.appendChild(el('p', p.mention, 'etat'));
      b.appendChild(el('p', 'Surface des pièces : ' + p.inside + (p.annexCm2 ? ' · annexes : ' + p.annex : '') + '.'));
      if (p.gapWithSheet && p.gapWithSheet.warn) b.appendChild(el('p', 'Écart de ' + String(p.gapWithSheet.percent).replace('.', ',') + ' % avec la surface de la fiche (' + p.gapWithSheet.sheetM2 + ' m²) : vérifiez les cotes.', 'retard'));
    } else b.appendChild(el('p', 'Aucun plan saisi pour ce bien.', 'doux'));
    var ul = el('ul', null, 'liste');
    rooms.forEach(function (r, i) {
      var li = el('li');
      li.appendChild(el('strong', r.label + ' · ' + r.area));
      li.appendChild(el('p', r.widthCm + ' × ' + r.depthCm + ' cm, à ' + r.xCm + ' cm et ' + r.yCm + ' cm de l’angle', 'doux'));
      li.appendChild(button('Retirer ' + r.label, function () {
        act(base() + '/plan', { rooms: keep.filter(function (_, j) { return j !== i; }) }, 'Le plan n’est pas enregistré.', 'Pièce retirée.');
      }));
      ul.appendChild(li);
    });
    b.appendChild(ul);
    var f = block('Ajouter une pièce');
    var kind = field(f, 'studio-piece-sorte', 'Pièce', 'select');
    Object.keys(ROOMS).forEach(function (k) { var o = el('option', ROOMS[k]); o.setAttribute('value', k); kind.appendChild(o); });
    kind.value = Object.keys(ROOMS)[0];
    var dims = [['xCm', 'Distance au bord gauche (cm)'], ['yCm', 'Distance au bord haut (cm)'], ['widthCm', 'Largeur (cm)'], ['depthCm', 'Profondeur (cm)']].map(function (d) {
      var x = field(f, 'studio-piece-' + d[0], d[1]);
      x.setAttribute('type', 'number');
      x.setAttribute('inputmode', 'numeric');
      x.setAttribute('min', '0');
      return [d[0], x];
    });
    f.appendChild(button('Ajouter la pièce', function () {
      var room = { kind: kind.value };
      dims.forEach(function (d) { room[d[0]] = d[1].value === '' ? null : Number(d[1].value); });
      act(base() + '/plan', { rooms: keep.concat([room]) }, 'Le plan n’est pas enregistré.', 'Pièce ajoutée : surfaces recalculées.');
    }));
  }

  /* ---------- Publications (X05) : préparées, contrôlées, validées par l'agent, en mode essai [R132, R134]. ---------- */
  function publications() {
    var certified = photos(false).filter(function (p) { return typeof p.certificatePath === 'string'; });
    var b = block('Préparer une publication');
    b.appendChild(el('p', 'Mode essai : rien ne part réellement sur les réseaux.', 'doux'));
    var ev = field(b, 'studio-evenement', 'Événement', 'select');
    Object.keys(EVENTS).forEach(function (k) { var o = el('option', EVENTS[k]); o.setAttribute('value', k); ev.appendChild(o); });
    ev.value = 'nouveau_bien';
    var picks = certified.map(function (p, i) { return [p.ref, checkbox(b, 'studio-visuel-' + i, photoName(p) + ' (avec certificat)')]; });
    if (!certified.length) b.appendChild(el('p', 'Aucune photo certifiée : seule une photo avec son certificat peut partir.', 'etat'));
    else b.appendChild(button('Préparer la publication', function () {
      var refs = picks.filter(function (x) { return x[1].checked; }).map(function (x) { return x[0]; });
      if (!refs.length) { state('Choisissez au moins une photo.'); return; }
      act(base() + '/publications', { event: ev.value, visuals: refs }, 'La publication n’est pas préparée.', 'Publication préparée : contrôlez chaque visuel, puis validez.', function (post, done) { return openPost(post.id, done); });
    }));
    var l = block('Publications de ce bien');
    var posts = Array.isArray(cur.atelier.posts) ? cur.atelier.posts : [];
    if (!posts.length) l.appendChild(el('p', 'Aucune publication pour le moment.', 'doux'));
    var ul = el('ul', null, 'liste');
    posts.forEach(function (p) {
      if (!ID.test(p.id)) return;
      var li = el('li');
      li.appendChild(el('strong', (EVENTS[p.event] || 'Publication') + ', le ' + day(p.createdAt)));
      li.appendChild(el('p', p.validated ? 'Validée.' : 'À valider.', p.validated ? 'fait' : 'doux'));
      li.appendChild(button('Ouvrir', function () { openPost(p.id); }));
      ul.appendChild(li);
    });
    l.appendChild(ul);
  }
  function openPost(id, message) {
    if (!cur || !ID.test(id)) return Promise.resolve(false);
    var mine = ++seq;
    clear(body());
    body().appendChild(button('Retour aux publications', function () { part('publications'); }));
    state('Chargement…');
    var path = '/v1/studio/publications/' + encodeURIComponent(id);
    return send(path, 'GET').then(function (res) {
      if (res.gone || mine !== seq) return false;
      if (!res.ok) { state(why(res, 'Indisponible pour le moment. Réessayez plus tard.')); return false; }
      state(message || '');
      var p = res.body.data;
      var again = function (data, done) { return openPost(id, done); };
      var b = block(EVENTS[p.event] || 'Publication');
      b.appendChild(el('p', p.origin === 'ia' ? 'Texte rédigé par l’IA, chaque fait relié à la fiche.' : 'Texte de secours, écrit depuis la fiche.', 'doux'));
      String(p.text || '').split('\\n').forEach(function (line) { if (line) b.appendChild(el('p', line)); });
      var v = block('Visuels');
      (p.visuals || []).forEach(function (x, i) {
        var known = photos(false).filter(function (q) { return q.ref === x.ref; })[0];
        var box = el('div', null, 'bloc');
        box.appendChild(el('strong', (known ? photoName(known) : 'Visuel ' + (i + 1)) + (x.overlay ? ' · ' + x.overlay : '')));
        box.appendChild(el('p', 'Certificat public : ' + x.certificatePath, 'doux'));
        if (x.check) box.appendChild(el('p', x.check === 'admis' ? 'Contrôlé : admis.' : 'Contrôlé : refusé.', x.check === 'admis' ? 'fait' : 'retard'));
        else {
          var adr = checkbox(box, 'studio-adresse-' + i, 'Une adresse, un numéro ou une plaque se lit');
          var per = checkbox(box, 'studio-personne-' + i, 'Une personne se reconnaît');
          var consent = field(box, 'studio-accord-' + i, 'Référence de l’accord rangé, si une personne se reconnaît');
          var lab = x.overlay ? checkbox(box, 'studio-mention-' + i, 'La mention « Aménagement virtuel » se voit sur l’image') : null;
          box.appendChild(button('Contrôler ce visuel', function () {
            var input = { ref: x.ref, addressVisible: !!adr.checked, personVisible: !!per.checked };
            if (consent.value) input.consentRef = consent.value;
            if (lab) input.stagingLabelVisible = !!lab.checked;
            act(path + '/visuels', input, 'Le contrôle n’est pas enregistré.', 'Visuel contrôlé.', again);
          }));
        }
        v.appendChild(box);
      });
      var s = block('Validation et envoi');
      if (!p.validated) {
        s.appendChild(el('p', 'Rien ne part sans votre validation.', 'doux'));
        s.appendChild(button('Valider la publication', function () { act(path + '/validation', undefined, 'La publication n’est pas validée.', 'Publication validée.', again); }));
      } else {
        s.appendChild(el('p', 'Validée le ' + day(p.validated.at) + '.', 'fait'));
        var acc = field(s, 'studio-compte', 'Compte', 'select');
        [['agent', 'Mon compte'], ['reseau', 'Compte du réseau']].forEach(function (a) { var o = el('option', a[1]); o.setAttribute('value', a[0]); acc.appendChild(o); });
        acc.value = 'agent';
        var nets = Object.keys(CHANNELS).map(function (c) { return [c, checkbox(s, 'studio-reseau-' + c, CHANNELS[c])]; });
        s.appendChild(button('Envoyer en mode essai', function () {
          var targets = nets.filter(function (n) { return n[1].checked; }).map(function (n) { return { channel: n[0], account: acc.value }; });
          if (!targets.length) { state(NO.cibles_invalides); return; }
          act(path + '/envoi', { targets: targets }, 'Rien n’est parti.', 'Envoyé en mode essai : rien n’est parti réellement.', again);
        }));
      }
      var sent = (p.sends || []);
      if (sent.length) {
        var ul = el('ul', null, 'liste');
        sent.forEach(function (x) { ul.appendChild(el('li', (CHANNELS[x.channel] || x.channel) + ' · ' + (x.account === 'reseau' ? 'compte du réseau' : 'mon compte') + ' : ' + (x.outcome === 'envoye' ? 'envoyé en essai' : x.outcome === 'echec' ? 'en échec' : 'en cours'))); });
        s.appendChild(ul);
      }
      return true;
    });
  }
  return { open: open, wipe: wipe, inside: function () { return cur !== null; }, operations: operations, pixels: pixels, say: say };
};
`;
