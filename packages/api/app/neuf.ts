import { LOT_CONFIRMATION_DAYS, LOT_STATUSES, LOT_TYPOLOGIES } from '../../core/src/neuf-viager/index.ts';

/**
 * La grille de mes programmes neufs, à l'écran de l'agent (BR78), servie à part (`/app/neuf.js`) et chargée seulement
 * quand l'agent ouvre la partie « Programmes neufs » de l'écran « Gagner des mandats » : l'application tient ainsi son
 * budget de poids [R201].
 *
 * Il lit `GET /v1/neuf/programmes` et `GET /v1/neuf/programmes/<id>`, et écrit seulement par
 * `POST /v1/neuf/programmes/<id>/lots` [R16]. Il ne calcule aucun frais et ne trie rien : les frais du neuf, de
 * l'ancien et leur écart viennent du serveur, chacun avec sa source, sa date et son hypothèse ; sans barème, aucun
 * chiffre de frais n'est écrit [R544]. Il met seulement en forme les entiers reçus (centimes en euros, centièmes de m²
 * en m²), et convertit ceux que l'agent tape avant de les envoyer. Un lot vendu ne revient jamais : l'écran ne lui
 * offre plus aucun geste [R543]. Un refus se dit en mots, jamais par son code ; une écriture sans réponse est dite
 * incertaine et la grille relue. Tout texte reçu est posé avec `textContent` ; rien n'est gardé sur l'appareil.
 */

export const NEUF_TYPOLOGIES: Readonly<Record<(typeof LOT_TYPOLOGIES)[number], string>> = Object.freeze({
  studio: 'Studio',
  t1: 'T1',
  t2: 'T2',
  t3: 'T3',
  t4: 'T4',
  t5: 'T5',
  t6: 'T6',
  maison: 'Maison',
  local: 'Local',
});
export const NEUF_STATUSES: Readonly<Record<(typeof LOT_STATUSES)[number], string>> = Object.freeze({
  disponible: 'Disponible',
  option: 'Sous option',
  reserve: 'Réservé',
  vendu: 'Vendu',
});
/** Les raisons d'un refus, dites à l'agent : jamais un code interne. */
export const NEUF_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  role: 'Les programmes neufs ne sont pas dans vos droits.',
  not_assigned: 'Ce programme est confié à un autre agent.',
  agent_left: 'Votre accès d’agent est fermé : les programmes ne se lisent plus.',
  agent_inactive: 'Votre accès d’agent n’est pas actif.',
  unknown: 'Introuvable : la liste a changé, rouvrez les programmes.',
  vendu: 'Ce lot est vendu : il ne revient jamais.',
  lot_ref: 'La référence du lot : lettres, chiffres et tirets, 20 au plus.',
  typology: 'Choisissez la typologie dans la liste.',
  area: 'La surface doit être entre 10 et 1 000 m².',
  floor: 'L’étage doit être un nombre entier, de -2 à 60.',
  price: 'Le prix doit être entre 10 000 € et 100 000 000 €.',
  status: 'Choisissez l’état dans la liste.',
  confirmed_on: 'Le jour de confirmation ne peut être ni dans le futur, ni avant la dernière confirmation de ce lot.',
  invalid_body: 'La demande n’a pas pu être lue.',
});
export const NEUF_OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
export const NEUF_LOST = 'La réponse n’est pas arrivée : rien n’est sûr. La grille est relue, vérifiez-la avant de recommencer.';
export const NEUF_NONE = 'Aucun programme neuf ne vous est confié : la direction les ouvre et les confie.';
export const NEUF_NO_SCALE = 'Aucun barème des frais en vigueur : aucun chiffre de frais n’est donné.';
export const NEUF_SOLD = 'Vendu : ce lot ne revient jamais.';
export const NEUF_STALE = `Disponibles, mais confirmés il y a plus de ${LOT_CONFIRMATION_DAYS} jours : ils ne sont plus publiés tant que le promoteur ne les a pas reconfirmés.`;
export const NEUF_MISSING = 'Remplissez chaque champ avant de ranger le lot.';

export const NEUF_SCRIPT = `'use strict';
globalThis.AIMMO_NEUF = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button;
  var TYPES = ${JSON.stringify(NEUF_TYPOLOGIES)};
  var STATES = ${JSON.stringify(NEUF_STATUSES)};
  var REFUSALS = ${JSON.stringify(NEUF_REFUSALS)};
  var OFFLINE = ${JSON.stringify(NEUF_OFFLINE)}, LOST = ${JSON.stringify(NEUF_LOST)}, NONE = ${JSON.stringify(NEUF_NONE)};
  var NO_SCALE = ${JSON.stringify(NEUF_NO_SCALE)}, SOLD = ${JSON.stringify(NEUF_SOLD)}, STALE = ${JSON.stringify(NEUF_STALE)}, MISSING = ${JSON.stringify(NEUF_MISSING)};
  var ID = /^[A-Za-z0-9_-]{1,64}$/, DAY = /^\\d{4}-\\d{2}-\\d{2}$/;
  var root = null, load = 0;
  function own(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }
  function str(x) { return typeof x === 'string' ? x : ''; }
  function int(x) { return typeof x === 'number' && isFinite(x) && Math.floor(x) === x; }
  function refusal(x, fallback) {
    if (x.offline) return OFFLINE;
    var c = x.body && typeof x.body.code === 'string' ? x.body.code : '';
    return own(REFUSALS, c) ? REFUSALS[c] : fallback;
  }
  function day(s) { var p = typeof s === 'string' && DAY.test(s) ? s.split('-') : null; return p ? p[2] + '/' + p[1] + '/' + p[0] : ''; }
  function group(n) { return String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g, '\\u202f'); }
  /** Des centimes reçus, écrits en euros : rien n'est arrondi ni recalculé. */
  function euros(c) {
    if (!int(c) || c < 0) return '';
    var r = c % 100;
    return group((c - r) / 100) + (r ? ',' + (r < 10 ? '0' : '') + r : '') + '\\u00a0€';
  }
  /** Des centièmes, écrits sans unité : 6250 donne « 62,5 ». */
  function plain(h) {
    var r = h % 100;
    return String((h - r) / 100) + (r ? ',' + (r < 10 ? '0' + r : String(r)).replace(/0$/, '') : '');
  }
  function area(h) { return int(h) && h > 0 ? group(plain(h)) + '\\u00a0m²' : ''; }
  function floor(f) { return !int(f) ? '' : f === 0 ? 'Rez-de-chaussée' : f > 0 ? 'Étage ' + f : 'Niveau ' + f; }
  /** Ce que l'agent tape, en entier de centièmes : « 62,5 » donne 6250 ; une forme douteuse n'est pas lue. */
  function hundredths(s) {
    var m = /^(\\d{1,9})(?:[.,](\\d{1,2}))?$/.exec(String(s).replace(/[\\s\\u00a0\\u202f]/g, ''));
    if (!m) return null;
    var d = m[2] || '';
    return Number(m[1]) * 100 + (d ? Number(d.length === 1 ? d + '0' : d) : 0);
  }
  function field(box, id, label, type) {
    var l = el('label', label);
    l.setAttribute('for', id);
    var f = el('input');
    f.setAttribute('id', id);
    if (type) f.setAttribute('type', type);
    box.appendChild(l);
    box.appendChild(f);
    return f;
  }
  function choice(box, id, label, options) {
    var l = el('label', label);
    l.setAttribute('for', id);
    var f = el('select');
    f.setAttribute('id', id);
    var none = el('option', 'Choisir…');
    none.value = '';
    f.appendChild(none);
    Object.keys(options).forEach(function (k) { var o = el('option', options[k]); o.value = k; f.appendChild(o); });
    box.appendChild(l);
    box.appendChild(f);
    return f;
  }
  function note(text) { var p = el('p', text, 'etat'); p.setAttribute('role', 'status'); return p; }
  /** Un frais reçu, avec sa source, sa date et son hypothèse ; incomplet, il n'est pas dit [R544]. */
  function fee(ul, label, f) {
    if (!f || typeof f !== 'object' || !int(f.value) || !str(f.source) || !DAY.test(str(f.asOf)) || !str(f.hypothesis)) return false;
    var li = el('li');
    li.appendChild(el('strong', label + ' : ' + euros(f.value)));
    li.appendChild(el('p', f.hypothesis + ' · source : ' + f.source + ' · en vigueur depuis le ' + day(f.asOf), 'doux'));
    ul.appendChild(li);
    return true;
  }
  function lotLine(l) { return (own(TYPES, l.typology) ? TYPES[l.typology] : '') + ' · ' + area(l.livingAreaHundredths) + ' · ' + floor(l.floor); }
  function wellFormed(l) { return l && typeof l === 'object' && str(l.lotRef) && own(TYPES, l.typology) && area(l.livingAreaHundredths) && int(l.floor) && euros(l.priceCents) && DAY.test(str(l.confirmedOn)); }
  function published(g) {
    var box = el('section', null, 'bloc');
    var lots = Array.isArray(g.lots) ? g.lots.filter(wellFormed) : [];
    box.appendChild(el('h4', 'Lots publiés (' + lots.length + ')'));
    box.appendChild(el('p', 'Ce que lit un visiteur du site du réseau : les seuls lots disponibles confirmés depuis peu, sans aucun nom.', 'doux'));
    if (!lots.length) { box.appendChild(el('p', 'Aucun lot publié : rien n’est disponible et confirmé depuis peu.', 'doux')); return box; }
    var ol = el('ol', null, 'liste');
    lots.forEach(function (l) {
      var li = el('li');
      li.appendChild(el('strong', 'Lot ' + l.lotRef + ' · ' + euros(l.priceCents)));
      li.appendChild(el('p', lotLine(l) + ' · confirmé le ' + day(l.confirmedOn), 'doux'));
      var ul = el('ul');
      var f = l.fees && typeof l.fees === 'object' ? l.fees : null;
      var said = !!f && fee(ul, 'Frais du neuf', f.newFees) && fee(ul, 'Frais de l’ancien au même prix', f.oldFees) && fee(ul, 'Écart', f.saving);
      if (said) li.appendChild(ul);
      else li.appendChild(el('p', NO_SCALE, 'doux'));
      ol.appendChild(li);
    });
    box.appendChild(ol);
    return box;
  }
  function stale(g) {
    var refs = Array.isArray(g.toConfirm) ? g.toConfirm.filter(function (r) { return str(r); }) : [];
    if (!refs.length) return null;
    var box = el('section', null, 'bloc');
    box.appendChild(el('h4', 'À reconfirmer auprès du promoteur (' + refs.length + ')'));
    box.appendChild(el('p', STALE, 'doux'));
    var ul = el('ul', null, 'liste');
    refs.forEach(function (r) { ul.appendChild(el('li', 'Lot ' + r)); });
    box.appendChild(ul);
    return box;
  }
  function form(ctx, from) {
    var box = el('section', null, 'bloc');
    box.appendChild(el('h4', from ? 'Mettre à jour le lot ' + from.lotRef : 'Ranger l’état d’un lot'));
    box.appendChild(el('p', 'Tel que le promoteur vient de le confirmer : chaque changement est une nouvelle version, rien ne s’efface.', 'doux'));
    var f = {
      ref: field(box, 'neuf-lot-ref', 'Référence du lot'),
      type: choice(box, 'neuf-lot-type', 'Typologie', TYPES),
      area: field(box, 'neuf-lot-surface', 'Surface habitable (m²)'),
      floor: field(box, 'neuf-lot-etage', 'Étage (0 pour le rez-de-chaussée)'),
      price: field(box, 'neuf-lot-prix', 'Prix TTC (€)'),
      state: choice(box, 'neuf-lot-etat', 'État', STATES),
      on: field(box, 'neuf-lot-confirme', 'Confirmé par le promoteur le', 'date'),
    };
    f.area.setAttribute('inputmode', 'decimal');
    f.floor.setAttribute('inputmode', 'numeric');
    f.price.setAttribute('inputmode', 'decimal');
    if (from) {
      f.ref.value = from.lotRef;
      f.ref.setAttribute('readonly', 'readonly');
      f.type.value = from.typology;
      f.area.value = plain(from.livingAreaHundredths);
      f.floor.value = String(from.floor);
      f.price.value = plain(from.priceCents);
    }
    var said = note('');
    var go = button('Ranger ce lot', function () {
      if (go.disabled) return;
      var a = hundredths(f.area.value), p = hundredths(f.price.value), fl = /^-?\\d{1,2}$/.test(String(f.floor.value).trim()) ? Number(String(f.floor.value).trim()) : null;
      if (!str(f.ref.value).trim() || !f.type.value || a === null || p === null || fl === null || !f.state.value || !DAY.test(str(f.on.value))) { said.textContent = MISSING; return; }
      go.disabled = true;
      said.textContent = 'Envoi…';
      var body = { lotRef: str(f.ref.value).trim(), typology: f.type.value, livingAreaHundredths: a, floor: fl, priceCents: p, status: f.state.value, confirmedOn: f.on.value };
      send('/v1/neuf/programmes/' + encodeURIComponent(ctx.id) + '/lots', 'POST', body).then(function (x) {
        go.disabled = false;
        if (x.gone || ctx.mine !== load) return;
        if (x.offline || !x.body || x.status >= 500) { grid(ctx.id, ctx.name, LOST); return; }
        if (!x.ok) { said.textContent = refusal(x, 'Le lot n’a pas été rangé.'); return; }
        grid(ctx.id, ctx.name, 'Lot ' + body.lotRef + ' rangé.');
      });
    });
    box.appendChild(go);
    box.appendChild(said);
    return box;
  }
  function every(ctx, g, place) {
    var lots = Array.isArray(g.all) ? g.all.filter(function (l) { return wellFormed(l) && own(STATES, l.status); }) : [];
    var box = el('section', null, 'bloc');
    box.appendChild(el('h4', 'Tous les lots (' + lots.length + ')'));
    if (!lots.length) box.appendChild(el('p', 'Aucun lot rangé pour ce programme.', 'doux'));
    var ul = el('ul', null, 'liste');
    lots.forEach(function (l) {
      var li = el('li');
      li.appendChild(el('strong', 'Lot ' + l.lotRef + ' · ' + STATES[l.status] + ' · ' + euros(l.priceCents)));
      li.appendChild(el('p', lotLine(l) + ' · confirmé le ' + day(l.confirmedOn), 'doux'));
      // Un lot vendu ne revient jamais : aucun geste ne lui est offert [R543].
      if (l.status === 'vendu') li.appendChild(el('p', SOLD, 'doux'));
      else li.appendChild(button('Mettre à jour', function () { clear(place); place.appendChild(form(ctx, l)); }));
      ul.appendChild(li);
    });
    box.appendChild(ul);
    box.appendChild(button('Ranger un nouveau lot', function () { clear(place); place.appendChild(form(ctx, null)); }));
    return box;
  }
  function grid(id, name, message) {
    if (!root || !ID.test(id)) return Promise.resolve(false);
    var box = root, mine = ++load;
    clear(box);
    box.appendChild(button('Retour à mes programmes', function () { list(); }));
    box.appendChild(el('h4', name));
    var said = note(message === LOST ? LOST : 'Chargement…');
    box.appendChild(said);
    return send('/v1/neuf/programmes/' + encodeURIComponent(id), 'GET').then(function (x) {
      if (x.gone || box !== root || mine !== load) return false;
      var g = x.ok && x.body.data && typeof x.body.data === 'object' ? x.body.data : null;
      if (!g) { said.textContent = message === LOST ? LOST + ' ' + refusal(x, 'La grille ne se lit pas pour le moment.') : refusal(x, 'La grille ne se lit pas pour le moment.'); return false; }
      said.textContent = message || '';
      var where = [str(g.promoter) ? 'Promoteur : ' + g.promoter : '', [str(g.postalCode), str(g.city)].filter(Boolean).join(' ')].filter(Boolean).join(' · ');
      if (where) box.appendChild(el('p', where, 'doux'));
      var ctx = { id: id, name: name, mine: mine };
      var place = el('div');
      box.appendChild(published(g));
      var s = stale(g);
      if (s) box.appendChild(s);
      box.appendChild(every(ctx, g, place));
      box.appendChild(place);
      return true;
    });
  }
  function list() {
    if (!root) return Promise.resolve(false);
    var box = root, mine = ++load;
    clear(box);
    var said = note('Chargement…');
    box.appendChild(said);
    return send('/v1/neuf/programmes', 'GET').then(function (x) {
      if (x.gone || box !== root || mine !== load) return false;
      var items = x.ok && Array.isArray(x.body.data) ? x.body.data : null;
      if (!items) { said.textContent = refusal(x, 'Les programmes ne se lisent pas pour le moment.'); return false; }
      items = items.filter(function (p) { return p && typeof p === 'object' && ID.test(str(p.programId)) && str(p.name); });
      said.textContent = items.length ? '' : NONE;
      var ul = el('ul', null, 'liste');
      items.forEach(function (p) {
        var li = el('li');
        li.appendChild(el('strong', p.name));
        var where = [str(p.postalCode), str(p.city)].filter(Boolean).join(' ');
        li.appendChild(el('p', [where, str(p.promoter) ? 'promoteur ' + p.promoter : ''].filter(Boolean).join(' · '), 'doux'));
        li.appendChild(button('Voir la grille', function () { grid(p.programId, p.name, ''); }));
        ul.appendChild(li);
      });
      if (items.length) box.appendChild(ul);
      return true;
    });
  }
  return { show: function (box) { root = box; return list(); } };
};
`;
