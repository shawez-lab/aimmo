import { PICKUP_TEXT, SIGN_SIZES } from '../../core/src/panneaux/panneaux.ts';

/**
 * BR104 · Les panneaux à l'écran (HX14, routes de BR23) : `GET /v1/panneaux`, `POST /v1/panneaux/poses` et
 * `POST /v1/panneaux/poses/<id>/retrait` [R282, R283, R284]. Un seul script servi à part (`/app/panneaux.js`), chargé au
 * premier geste par le chargeur commun, par deux portes [R201] :
 *
 * - sur l'accueil de l'agent (`open('')`), « Mes panneaux » : les comptes du stock du réseau, puis ses poses, celles à
 *   récupérer d'abord avec la raison et le jour du serveur ; la direction y lit toutes les poses [R284] ;
 * - dans l'écran « Mettre en vente » du bien (`open(id)`) : les panneaux posés sur ce bien, et la pose d'un panneau, avec
 *   le numéro lu sur le panneau et l'adresse de la pose ; le serveur dit si le bien peut porter un panneau [R42, R282].
 *
 * - sous « Engagements de service » de l'écran du réseau (`show`, BR105), « Stock de panneaux » pour la direction : les
 *   comptes par format, toutes les poses, et l'ajout au stock de 1 à 50 panneaux d'un format (`POST /v1/panneaux/stock`) ;
 *   les numéros donnés par le serveur sont dits, à écrire sur les panneaux [R282]. L'accueil de l'agent ne l'a pas.
 *
 * L'écran ne trie ni ne calcule rien d'autre que le choix des poses du bien. « Récupéré » remet le panneau au stock ;
 * « Perdu » ne part qu'au second appui, car un panneau perdu ne se pose plus [R283], et tout autre geste annule la
 * demande. Un seul envoi à la fois ; après une écriture, la liste est relue ; une écriture sans réponse est dite
 * incertaine. Chaque refus se dit en mots, jamais par un code ; tout texte reçu est posé en texte [R13].
 */

export const PANNEAUX_SIZES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(SIGN_SIZES.map((s) => [s, { grand: 'grand format', moyen: 'format moyen', petit: 'petit format' }[s]])),
);

export const PANNEAUX_PICKUPS: Readonly<Record<string, string>> = Object.freeze({ ...PICKUP_TEXT });

/** Chaque refus du serveur, dit en mots ; un refus inconnu a sa phrase générale, jamais son code. */
export const PANNEAUX_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  role: 'Les panneaux se tiennent par les agents en activité et la direction.',
  network: 'Ce bien n’est pas dans votre réseau.',
  unknown: 'Ce bien ne se trouve pas : rouvrez-le depuis votre journée.',
  pas_son_bien: 'Un panneau se pose sur ce bien par son agent ou la direction.',
  sans_bien: 'Ce bien ne se trouve pas : rouvrez-le depuis votre journée.',
  bien_sans_agent: 'Ce bien n’a pas d’agent : un panneau ne s’y pose pas.',
  unknown_sign: 'Ce numéro n’est pas celui d’un panneau du stock : relisez le numéro sur le panneau.',
  bad_address: 'L’adresse de la pose : numéro, rue, code postal et commune, sans signe étrange.',
  bien_sans_commune: 'La fiche du bien n’a pas de code postal ou de commune : complétez-la d’abord.',
  hors_du_bien: 'La pose se fait au code postal et dans la commune du bien.',
  bien_vendu: 'Ce bien est vendu : un panneau ne s’y pose plus.',
  pas_au_stock: 'Ce panneau est déjà posé ailleurs ou noté perdu : prenez-en un autre du stock.',
  no_mandate: 'Aucun mandat signé et inscrit pour ce bien : pas de panneau sans mandat.',
  cancelled: 'Le mandat de ce bien est annulé : pas de panneau.',
  withdrawn: 'Le vendeur s’est rétracté : pas de panneau.',
  expired: 'Le mandat de ce bien est échu : pas de panneau.',
  duration_unknown: 'La durée du mandat n’est pas connue : pas de panneau tant qu’elle ne l’est pas.',
  withdrawal_period: 'Le délai de rétractation du vendeur court encore : pas de panneau avant sa fin, sauf sa demande écrite.',
  bad_outcome: 'Dites si le panneau est récupéré ou perdu.',
  unknown_placement: 'Cette pose ne se trouve plus : la liste est relue.',
  pas_sa_pose: 'Cette pose se tient par l’agent qui l’a faite ou la direction.',
  deja_retire: 'Ce panneau est déjà noté récupéré ou perdu : la liste est relue.',
  bad_size: 'Choisissez le format des panneaux à ajouter.',
  bad_count: 'Le nombre de panneaux à ajouter : de 1 à 50 à la fois.',
  non_range: 'Les panneaux n’ont pas été ajoutés. La liste est relue, vérifiez-la avant de recommencer.',
  invalid_body: 'La demande n’a pas pu être lue. Rechargez l’écran.',
  unknown_field: 'La demande n’a pas pu être lue. Rechargez l’écran.',
});

export const PANNEAUX_OFFLINE = 'Pas de réseau. Réessayez dans un moment.';

/** Un envoi part encore : rien d'autre ne part avant sa réponse. */
export const PANNEAUX_BUSY = 'Un geste sur les panneaux part encore : rouvrez dans un instant.';

/** Une écriture partie sans réponse : le geste a pu être noté, la liste relue le dira. */
export const PANNEAUX_UNSURE = 'La réponse n’est pas arrivée : le geste a peut-être été noté. La liste est relue, vérifiez-la avant de recommencer.';

/** Le second appui demandé avant « Perdu » : un panneau perdu ne se pose plus [R283]. */
export const PANNEAUX_CONFIRM = 'Un panneau perdu ne se pose plus jamais. Appuyez sur « Confirmer : perdu » pour le noter.';

/** Ce que l'écran demande avant d'envoyer une pose : rien ne part mal formé. */
export const PANNEAUX_FORM = Object.freeze({
  number: 'Le numéro du panneau : les chiffres écrits dessus.',
  street: 'Dites le numéro et la rue de la pose.',
  postcode: 'Le code postal : cinq chiffres.',
  city: 'Dites la commune de la pose.',
  size: 'Choisissez le format des panneaux à ajouter.',
  count: 'Le nombre de panneaux à ajouter : de 1 à 50 à la fois.',
});

/** Le script servi à part (`/app/panneaux.js`). Il ne lit et n'écrit que sous `/v1/panneaux` [R16]. */
export const PANNEAUX_SCRIPT = `'use strict';
globalThis.AIMMO_PANNEAUX = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, select = t.select, date = t.date;
  var SIZES = ${JSON.stringify(PANNEAUX_SIZES)}, PICKUPS = ${JSON.stringify(PANNEAUX_PICKUPS)};
  var REFUSALS = ${JSON.stringify(PANNEAUX_REFUSALS)}, FORM = ${JSON.stringify(PANNEAUX_FORM)};
  var BUSY = ${JSON.stringify(PANNEAUX_BUSY)}, OFFLINE = ${JSON.stringify(PANNEAUX_OFFLINE)}, UNSURE = ${JSON.stringify(PANNEAUX_UNSURE)}, CONFIRM = ${JSON.stringify(PANNEAUX_CONFIRM)};
  var ID = /^[A-Za-z0-9_-]{1,64}$/, DAY = /^\\d{4}-\\d{2}-\\d{2}$/, NUM = /^\\d{1,6}$/, CP = /^\\d{5}$/, COUNT = /^\\d{1,2}$/;
  /* Le bloc ouvert : son bien ('' pour l'accueil), son corps, son état. Une réponse d'un bloc d'avant ne dessine rien. */
  var ctx = null, reading = 0, writing = false, armed = null;
  document.addEventListener('click', function (e) { if (armed && (!e || e.target !== armed)) disarm(); }, true);
  function say(m) { if (ctx) ctx.said.textContent = m; }
  function text(v, max) { return typeof v === 'string' && v.length <= (max || 200) ? v : ''; }
  function own(map, k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(map, k) ? map[k] : ''; }
  function day(d) { return typeof d === 'string' && DAY.test(d) ? d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4) : ''; }
  function disarm() { if (armed) { armed.textContent = 'Perdu'; armed = null; } }
  function refusal(res, fallback) { return own(REFUSALS, (res.body || {}).code) || fallback; }
  function many(n, one, more) { return n + ' ' + (n > 1 ? more : one); }
  /* Une pose reçue, relue champ par champ : un numéro ou un identifiant mal formé, et elle n'est pas dite. */
  function read(p) {
    if (!p || typeof p !== 'object' || !ID.test(text(p.placementId)) || typeof p.signNumber !== 'number' || !isFinite(p.signNumber)) return null;
    var a = p.address && typeof p.address === 'object' ? p.address : {};
    var where = [text(a.streetNumber, 20), text(a.street, 80)].filter(Boolean).join(' ');
    var town = [text(a.postcode, 5), text(a.city, 80)].filter(Boolean).join(' ');
    var k = p.pickup && typeof p.pickup === 'object' ? p.pickup : null;
    return {
      id: p.placementId, property: text(p.propertyId, 64),
      title: 'Panneau n° ' + p.signNumber + (own(SIZES, p.size) ? ', ' + own(SIZES, p.size) : '') + (text(p.reference, 40) ? ' · ' + p.reference : ''),
      address: [where, town].filter(Boolean).join(', ') || 'adresse non dite',
      placed: date(p.placedAt),
      pickup: k ? { text: own(PICKUPS, k.reason) || 'À récupérer.', day: day(k.dueDay) } : null,
    };
  }
  function row(r) {
    var li = el('li');
    li.appendChild(el('p', r.title));
    li.appendChild(el('p', 'Posé ' + (r.placed ? 'le ' + r.placed + ' ' : '') + 'au ' + r.address + '.', 'doux'));
    if (r.pickup) li.appendChild(el('p', r.pickup.text + (r.pickup.day ? ' Depuis le ' + r.pickup.day + '.' : ''), 'alerte'));
    var back = button('Récupéré', function () { disarm(); remove(r, 'recupere', r.title + ' noté récupéré : il revient au stock.'); });
    var lost = button('Perdu', function () {
      if (armed !== lost) { disarm(); armed = lost; lost.textContent = 'Confirmer : perdu'; say(CONFIRM); return; }
      armed = null;
      lost.textContent = 'Perdu';
      remove(r, 'perdu', r.title + ' noté perdu : il ne se posera plus.');
    });
    back.className = 'secondaire';
    lost.className = 'secondaire';
    li.appendChild(back);
    li.appendChild(lost);
    return li;
  }
  function list(rows) { var ul = el('ul', null, 'liste'); rows.forEach(function (r) { ul.appendChild(row(r)); }); return ul; }
  function counts(c) {
    if (!c || typeof c !== 'object') return '';
    var n = function (v) { return typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0; };
    return 'Stock du réseau : ' + many(n(c.enStock), 'panneau', 'panneaux') + ' en stock, ' + many(n(c.poses), 'posé', 'posés') + ', dont ' + n(c.aRecuperer) + ' à récupérer, ' + many(n(c.perdus), 'perdu', 'perdus') + '.';
  }
  function home(data, rows) {
    var due = rows.filter(function (r) { return r.pickup; }), rest = rows.filter(function (r) { return !r.pickup; });
    ctx.corps.appendChild(el('p', counts(data.counts), 'doux'));
    if (due.length) { ctx.corps.appendChild(el('h5', 'À récupérer')); ctx.corps.appendChild(list(due)); }
    if (rest.length) { ctx.corps.appendChild(el('h5', 'Posés')); ctx.corps.appendChild(list(rest)); }
    return rows.length ? many(rows.length, 'panneau posé', 'panneaux posés') + (due.length ? ', dont ' + due.length + ' à récupérer.' : '.') : 'Aucun panneau posé.';
  }
  /* La direction (BR105) : les comptes par format, l'ajout au stock, puis toutes les poses [R282, R284]. */
  function bySize(c) {
    var b = c && typeof c === 'object' && c.bySize && typeof c.bySize === 'object' ? c.bySize : {};
    var n = function (v) { return typeof v === 'number' && isFinite(v) && v >= 0 ? v : 0; };
    var ul = el('ul', null, 'liste');
    Object.keys(SIZES).forEach(function (k) {
      var z = Object.prototype.hasOwnProperty.call(b, k) && b[k] && typeof b[k] === 'object' ? b[k] : {};
      var w = SIZES[k];
      ul.appendChild(el('li', w.charAt(0).toUpperCase() + w.slice(1) + ' : ' + n(z.enStock) + ' en stock, ' + many(n(z.poses), 'posé', 'posés') + '.'));
    });
    return ul;
  }
  function desk(data, rows) {
    ctx.corps.appendChild(bySize(data.counts));
    ctx.corps.appendChild(add());
    return home(data, rows);
  }
  /* Les numéros reçus : entiers positifs seulement ; un numéro mal formé est tu. */
  function numbers(d) {
    var a = d && typeof d === 'object' && Array.isArray(d.numbers) ? d.numbers : [];
    return a.filter(function (x) { return typeof x === 'number' && isFinite(x) && x > 0 && x < 1e7 && Math.floor(x) === x; });
  }
  function add() {
    var box = el('div');
    box.appendChild(el('h5', 'Ajouter au stock'));
    var opts = { '': 'Choisir' };
    Object.keys(SIZES).forEach(function (k) { opts[k] = SIZES[k]; });
    var size = select(box, 'panneau-format', 'Format', opts, '');
    var count = field(box, 'panneau-nombre', 'Nombre de panneaux (de 1 à 50)');
    count.setAttribute('inputmode', 'numeric');
    box.appendChild(button('Ajouter au stock', function () {
      disarm();
      var z = String(size.value || ''), c = String(count.value || '').trim();
      if (!own(SIZES, z)) return say(FORM.size);
      if (!COUNT.test(c) || Number(c) < 1 || Number(c) > 50) return say(FORM.count);
      var k = Number(c);
      post('/v1/panneaux/stock', { size: z, count: k }, function (d) {
        var got = numbers(d), head = many(k, 'panneau', 'panneaux') + ' ' + SIZES[z] + ' ' + (k > 1 ? 'ajoutés' : 'ajouté') + ' au stock.';
        return got.length ? head + ' Écrivez sur ' + (got.length > 1 ? 'chacun son numéro : ' : 'le panneau son numéro : ') + got.join(', ') + '.' : head;
      });
    }));
    return box;
  }
  function property(rows) {
    var mine = rows.filter(function (r) { return r.property === ctx.id; });
    if (mine.length) { ctx.corps.appendChild(el('h5', 'Posés sur ce bien')); ctx.corps.appendChild(list(mine)); }
    ctx.corps.appendChild(place());
    return mine.length ? many(mine.length, 'panneau posé', 'panneaux posés') + ' sur ce bien.' : 'Aucun panneau posé sur ce bien.';
  }
  /* La pose : le numéro lu sur le panneau et l'adresse ; vérifiée ici avant l'appel, puis par le serveur [R282, R42]. */
  function place() {
    var box = el('div');
    box.appendChild(el('h5', 'Poser un panneau'));
    var f = { number: field(box, 'panneau-numero', 'Numéro du panneau'), streetNumber: field(box, 'panneau-voie', 'Numéro dans la rue'), street: field(box, 'panneau-rue', 'Rue'), postcode: field(box, 'panneau-cp', 'Code postal'), city: field(box, 'panneau-commune', 'Commune') };
    f.number.setAttribute('inputmode', 'numeric');
    f.postcode.setAttribute('inputmode', 'numeric');
    f.postcode.setAttribute('autocomplete', 'postal-code');
    var go = button('Poser le panneau', function () {
      disarm();
      var v = function (k) { return String(f[k].value || '').trim(); };
      if (!NUM.test(v('number'))) return say(FORM.number);
      if (!v('streetNumber') || !v('street')) return say(FORM.street);
      if (!CP.test(v('postcode'))) return say(FORM.postcode);
      if (!v('city')) return say(FORM.city);
      var n = Number(v('number'));
      post('/v1/panneaux/poses', { signNumber: n, propertyId: ctx.id, address: { streetNumber: v('streetNumber'), street: v('street'), postcode: v('postcode'), city: v('city') } }, 'Panneau n° ' + n + ' posé sur ce bien.');
    });
    box.appendChild(go);
    return box;
  }
  /* Seule la dernière lecture dessine. Ce qui précède la lecture (un geste noté, ou peut-être noté) reste dit, même si
     la lecture échoue. */
  function load(said) {
    if (writing || !ctx) return Promise.resolve(false);
    disarm();
    var turn = ++reading, mine = ctx, pre = said ? said + ' ' : '';
    clear(ctx.corps);
    say('Chargement…');
    return send('/v1/panneaux', 'GET').then(function (res) {
      if (turn !== reading || mine !== ctx) return false;
      if (res.gone) { clear(ctx.corps); say(''); return false; }
      if (res.offline || !res.body || res.status >= 500) { say(pre + OFFLINE); return false; }
      var data = res.body.data;
      if (!res.ok || !data || typeof data !== 'object' || !Array.isArray(data.placed)) { say(pre + refusal(res, 'Les panneaux ne se lisent pas pour le moment.')); return false; }
      var rows = data.placed.map(read).filter(Boolean);
      var m = ctx.desk ? desk(data, rows) : ctx.id === '' ? home(data, rows) : property(rows);
      say(pre + m);
      return true;
    }, function () { if (turn === reading && mine === ctx) say(pre + OFFLINE); return false; });
  }
  /* Un seul envoi à la fois : un second geste pendant l'envoi ne part pas. */
  function post(path, body, done) {
    if (writing) return Promise.resolve(false);
    writing = true;
    var turn = ++reading, mine = ctx;
    say('Envoi…');
    return send(path, 'POST', body).then(function (res) {
      writing = false;
      if (turn !== reading || mine !== ctx) return false;
      /* Sans réponse : le geste a pu être noté ; la liste relue le dira. */
      if (res.gone) { clear(ctx.corps); say(''); return false; }
      if (res.offline || !res.body || res.status >= 500) return load(UNSURE);
      if (!res.ok) {
        var code = (res.body || {}).code, said = refusal(res, 'Le geste n’a pas pu être noté. Réessayez dans un moment.');
        if (code === 'deja_retire' || code === 'unknown_placement') return load(said);
        say(said);
        return false;
      }
      return load(typeof done === 'function' ? done(res.body.data) : done);
    }, function () { writing = false; if (turn === reading && mine === ctx) return load(UNSURE); return false; });
  }
  function remove(r, outcome, done) { return post('/v1/panneaux/poses/' + encodeURIComponent(r.id) + '/retrait', { outcome: outcome }, done); }
  /* Un envoi en cours garde son verrou : rouvrir le bloc ne relâche rien, et un autre bloc attend sa fin. */
  function open(id, corps, said) {
    if (writing) {
      if (!ctx || ctx.corps !== corps) { clear(corps); said.textContent = BUSY; }
      return Promise.resolve(false);
    }
    disarm();
    ctx = { id: typeof id === 'string' ? id : '', corps: corps, said: said };
    if (ctx.id !== '' && !ID.test(ctx.id)) { clear(corps); say(REFUSALS.unknown); return Promise.resolve(false); }
    return load('');
  }
  /* La direction, sous les engagements de l'écran du réseau (BR105) : le bloc a son propre état. */
  function show(inner) {
    var said = el('p', null, 'etat');
    said.setAttribute('role', 'status');
    if (writing) {
      if (!ctx || !ctx.desk) { clear(inner); inner.appendChild(said); said.textContent = BUSY; }
      return Promise.resolve(false);
    }
    disarm();
    clear(inner);
    var corps = el('div');
    inner.appendChild(said);
    inner.appendChild(corps);
    ctx = { id: '', corps: corps, said: said, desk: true };
    return load('');
  }
  return { open: open, show: show };
};
`;
