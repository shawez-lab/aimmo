import { CERTIFIED_DOMAINS } from '../../core/src/partenaires/annuaire.ts';
import { CLIENT_ONLY, DISCOUNT_CATEGORIES } from '../../core/src/remises/remises.ts';

/**
 * BR73 · Les remises négociées à l'écran (HX08, routes de BR20). Un seul script servi à part (`/app/remises.js`),
 * chargé au premier geste par trois portes, sans rien ajouter au script de l'application que l'appel du chargeur commun
 * [R201] :
 *
 * - sous « Engagements de service » de l'écran du réseau (`show`) : la direction lit le catalogue du jour, range une
 *   remise avec sa source et ses dates [R266], le partenaire cherché dans l'annuaire par métier et code postal [R73],
 *   et retire une remise en deux appuis, avec sa raison ; elle n'est jamais effacée [R17] ;
 * - sur l'accueil de l'agent (BR74, `open('')`) : ses remises « toujours » en entier, avec source et fin ; les autres,
 *   qui ne servent qu'au bon moment d'un bien, seulement comptées par moment du dossier, jamais montrées [R267] ;
 * - dans l'écran « Mettre en vente » du bien (`open`, par le chargeur commun) : l'agent du bien lit les remises du
 *   moment du dossier, lu dans la base et jamais déclaré, chacune avec sa raison, et en écarte une pour ce bien [R267].
 *   Celles du client restent dans l'ordre tiré au sort par le serveur, jamais retriées ici [R75].
 *
 * Un diagnostiqueur, un déménageur ou un artisan ne profite qu'au client, à l'écran comme au serveur [R76]. Tout texte
 * reçu est posé en texte ; un champ mal formé n'est pas dit. Chaque refus est dit en mots [R16] ; une écriture sans
 * réponse est dite incertaine et la liste relue. Rien n'est envoyé d'ici, ni au fournisseur ni au client.
 *
 * Jamais vu : sur la page de son bien, l'agent voit la remise négociée qui sert maintenant, avec la raison lue dans le
 * dossier, et celles du client dans un ordre tiré au sort, dit comme tel.
 *
 * Jamais vu (BR74) : l'accueil dit, moment par moment du dossier, combien de remises négociées attendent l'agent et ses
 * clients, sans en pousser aucune hors du bon moment.
 */

export const REMISES_CATEGORIES: Readonly<Record<string, string>> = Object.freeze(Object.fromEntries(DISCOUNT_CATEGORIES.map((c) => [c.category, c.label])));

/** Le métier de l'annuaire de chaque catégorie qui en a un : seul celui-là se cherche [R73]. */
export const REMISES_TRADES: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(DISCOUNT_CATEGORIES.filter((c) => c.trade !== null).map((c) => [c.category, c.trade as string])),
);

export const REMISES_MOMENTS = Object.freeze({
  estimation: 'Estimation, sans mandat inscrit',
  mandat: 'Mandat inscrit au registre',
  en_vente: 'Annonce en vente',
  compromis: 'Compromis en préparation',
  acte: 'Acte signé depuis moins de 90 jours',
  toujours: 'Toujours, pour l’agent (catalogue seulement)',
});

export const REMISES_FOR = Object.freeze({ client: 'Pour le client', agent: 'Pour l’agent' });

export const REMISES_DOMAINS: Readonly<Record<string, string>> = Object.freeze({
  ...Object.fromEntries(CERTIFIED_DOMAINS.map((d) => [d.domain, d.label])),
  mesurage: 'mesurage de la surface',
});

/** Chaque refus du cœur ou de l'annuaire, dit en mots ; un refus inconnu a sa phrase générale, jamais son code. */
export const REMISES_REFUSALS = Object.freeze({
  role: 'Ce n’est pas dans vos droits.',
  not_assigned: 'Les remises du moment se lisent par l’agent qui suit ce bien.',
  unknown_property: 'Ce bien n’existe plus.',
  unknown_discount: 'Cette remise n’existe plus : la liste est relue.',
  bad_category: 'Choisissez la catégorie de la remise.',
  bad_beneficiary: 'Dites pour qui est la remise : l’agent ou le client.',
  client_seulement: 'Une remise d’un diagnostiqueur, d’un déménageur ou d’un artisan ne profite qu’au client, jamais à l’agent ni au réseau.',
  bad_moment: 'Choisissez le moment du dossier où la remise sert.',
  moment_du_dossier: 'Une remise pour le client sert à un moment du dossier : choisissez-le.',
  bad_supplier: 'Le fournisseur : de 2 à 80 caractères.',
  bad_title: 'Le titre : de 2 à 120 caractères.',
  bad_terms: 'Les conditions : de 2 à 600 caractères.',
  sans_source: 'Dites d’où vient la remise (devis, contrat, courrier), de 2 à 200 caractères : sans source, elle ne se range pas.',
  bad_date: 'Les dates de début et de fin sont à remplir, la fin le jour du début ou après.',
  deja_echue: 'Cette remise est déjà finie : elle ne se range pas.',
  bad_partner: 'Ce partenaire n’est pas lisible : cherchez-le de nouveau dans l’annuaire.',
  unknown_partner: 'Ce partenaire n’est plus dans l’annuaire : cherchez-le de nouveau.',
  partner_trade: 'Ce partenaire n’exerce pas le métier de cette catégorie.',
  partenaire_requis: 'Un diagnostiqueur se choisit dans l’annuaire, avec ses certifications : cherchez-le d’abord.',
  bad_reason: 'Dites pourquoi la remise est retirée, de 2 à 200 caractères.',
  deja_retiree: 'Cette remise est déjà retirée : la liste est relue.',
  invalid_body: 'La saisie n’est pas lisible.',
  unknown_trade: 'Cette catégorie ne se cherche pas dans l’annuaire.',
  bad_postcode: 'Le code postal : cinq chiffres.',
  domain_required: 'Pour un diagnostiqueur, choisissez le domaine.',
  bad_domain: 'Le domaine ne vaut que pour un diagnostiqueur.',
});

export const REMISES_OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
export const REMISES_LOST = 'La réponse n’est pas arrivée : rien n’est sûr. La liste est relue, vérifiez-la avant de recommencer.';
export const REMISES_RANDOM = 'Ordre tiré au sort, aucun classement : le client choisit son professionnel avec vous.';
export const REMISES_NONE_NOW = 'Aucun moment sûr dans le dossier de ce bien : rien à proposer maintenant.';
export const REMISES_ELSEWHERE = 'Les autres remises viennent sur la page du bien, au moment du dossier lu dans la base : aucune n’est montrée ici.';
export const REMISES_NONE_TODAY = 'Aucune remise négociée en vigueur aujourd’hui.';
export const REMISES_CONFIRM = 'Une remise retirée ne revient plus : une correction se range comme une nouvelle remise. Dites pourquoi, puis appuyez sur « Retirer pour de bon ».';

/** Le script servi à part. Il ne lit et n'écrit que sous `/v1/remises`, et ne lit que l'annuaire [R16]. */
export const REMISES_SCRIPT = `'use strict';
globalThis.AIMMO_REMISES = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field;
  var CATS = ${JSON.stringify(REMISES_CATEGORIES)}, TRADES = ${JSON.stringify(REMISES_TRADES)}, CLIENT_ONLY = ${JSON.stringify(CLIENT_ONLY)};
  var MOMENTS = ${JSON.stringify(REMISES_MOMENTS)}, FOR = ${JSON.stringify(REMISES_FOR)}, DOMAINS = ${JSON.stringify(REMISES_DOMAINS)};
  var REFUSALS = ${JSON.stringify(REMISES_REFUSALS)};
  var OFFLINE = ${JSON.stringify(REMISES_OFFLINE)}, LOST = ${JSON.stringify(REMISES_LOST)}, RANDOM = ${JSON.stringify(REMISES_RANDOM)};
  var NONE_NOW = ${JSON.stringify(REMISES_NONE_NOW)}, CONFIRM = ${JSON.stringify(REMISES_CONFIRM)};
  var ELSEWHERE = ${JSON.stringify(REMISES_ELSEWHERE)}, NONE_TODAY = ${JSON.stringify(REMISES_NONE_TODAY)};
  var ID = /^[A-Za-z0-9_-]{1,64}$/, DAY = /^\\d{4}-\\d{2}-\\d{2}$/, CP = /^\\d{5}$/;
  var busy = false;
  function own(map, k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; }
  function str(v, max) { return typeof v === 'string' && v.length > 0 && v.length <= max ? v : null; }
  function day(d) { return typeof d === 'string' && DAY.test(d) ? d.slice(8, 10) + '/' + d.slice(5, 7) + '/' + d.slice(0, 4) : null; }
  function refusal(x, fallback) {
    if (x.offline) return OFFLINE;
    return own(REFUSALS, x.body && x.body.code) || fallback;
  }
  function choice(box, id, label, map, empty) {
    var f = field(box, id, label, 'select'), first = el('option', empty || 'Choisir…');
    first.value = '';
    f.appendChild(first);
    Object.keys(map).forEach(function (k) { var o = el('option', map[k]); o.value = k; f.appendChild(o); });
    f.value = '';
    return f;
  }
  /* Une remise reçue, relue champ par champ : un champ mal formé, et elle n'est pas dite. */
  function read(d) {
    if (!d || typeof d !== 'object' || !ID.test(d.id || '')) return null;
    var r = { id: d.id, cat: own(CATS, d.category), who: own(FOR, d.beneficiary), moment: own(MOMENTS, d.moment), supplier: str(d.supplier, 80), title: str(d.title, 120), terms: str(d.terms, 600), source: str(d.source, 200), from: day(d.validFrom), until: day(d.validUntil) };
    for (var k in r) if (r[k] === null) return null;
    r.why = str(d.why, 200);
    return r;
  }
  function card(r, extra) {
    var box = el('article', null, 'bloc');
    box.appendChild(el('h5', r.cat + ' · ' + r.supplier));
    box.appendChild(el('p', r.title));
    box.appendChild(el('p', r.terms, 'doux'));
    if (extra) extra(box);
    return box;
  }
  /* Une écriture : une à la fois ; sans réponse lisible, ou une panne du serveur, elle a pu passer : relire. */
  function write(b, path, body, said, done, reload, fallback) {
    if (busy) return Promise.resolve(false);
    var mine = t.session();
    busy = true;
    b.disabled = true;
    said.textContent = 'Envoi…';
    return send(path, 'POST', body).then(function (x) {
      busy = false;
      b.disabled = false;
      if (x.gone || mine !== t.session()) return false;
      if (x.offline || !x.body || x.status >= 500) return reload(LOST);
      if (!x.ok) {
        if (x.body.code === 'unknown_discount' || x.body.code === 'deja_retiree') return reload(refusal(x, fallback));
        said.textContent = refusal(x, fallback);
        return false;
      }
      return reload(done);
    });
  }

  /* ---------- La direction : le catalogue du jour, ranger, retirer [R266, R76, R73]. ---------- */
  var desk = null, deskTurn = 0;
  function withdrawZone(r, box) {
    var zone = el('div');
    var ask = button('Retirer…', function () {
      ask.hidden = true;
      zone.appendChild(el('p', CONFIRM, 'alerte'));
      var reason = field(zone, 'remise-raison-' + r.id, 'Raison du retrait');
      reason.setAttribute('maxlength', '200');
      var go = button('Retirer pour de bon', function () {
        var v = String(reason.value || '').trim();
        if (v.length < 2) { desk.said.textContent = REFUSALS.bad_reason; return; }
        write(go, '/v1/remises/' + encodeURIComponent(r.id) + '/retrait', { reason: v }, desk.said, 'Remise retirée : elle reste au journal.', deskLoad, 'La remise n’est pas retirée.');
      });
      zone.appendChild(go);
    });
    ask.className = 'secondaire';
    box.appendChild(ask);
    box.appendChild(zone);
  }
  function partnerZone(form, f) {
    var zone = el('div');
    zone.appendChild(el('p', 'Partenaire de l’annuaire : il n’est proposé qu’une fois justifié ce jour-là et dans la zone du bien.', 'doux'));
    f.cp = field(zone, 'remise-cp', 'Code postal où il intervient');
    f.cp.setAttribute('inputmode', 'numeric');
    f.cp.setAttribute('maxlength', '5');
    var domainLabel = el('div');
    f.domain = choice(domainLabel, 'remise-domaine', 'Domaine du diagnostic', DOMAINS);
    zone.appendChild(domainLabel);
    f.partner = choice(zone, 'remise-partenaire', 'Partenaire choisi', {}, 'Aucun partenaire choisi');
    var found = el('p', null, 'doux');
    found.setAttribute('role', 'status');
    var turn = 0;
    var look = button('Chercher dans l’annuaire', function () {
      var cat = f.category.value, trade = own(TRADES, cat), cp = String(f.cp.value || '').trim();
      if (!trade) { found.textContent = REFUSALS.unknown_trade; return; }
      if (!CP.test(cp)) { found.textContent = REFUSALS.bad_postcode; return; }
      if (cat === 'diagnostiqueur' && !own(DOMAINS, f.domain.value)) { found.textContent = REFUSALS.domain_required; return; }
      var q = '?metier=' + encodeURIComponent(trade) + '&cp=' + encodeURIComponent(cp) + (cat === 'diagnostiqueur' ? '&domaine=' + encodeURIComponent(f.domain.value) : '');
      reset();
      var mine = t.session(), me = turn;
      found.textContent = 'Recherche…';
      send('/v1/partenaires/annuaire' + q, 'GET').then(function (x) {
        if (x.gone || mine !== t.session() || me !== turn) return;
        var d = x.ok && x.body.data && typeof x.body.data === 'object' ? x.body.data : null;
        if (!d || !Array.isArray(d.proposable) || !Array.isArray(d.unavailable)) { found.textContent = refusal(x, 'L’annuaire ne se lit pas pour le moment.'); return; }
        var n = 0;
        [[d.proposable, ''], [d.unavailable, ' (pas justifié ce jour : pas encore proposé)']].forEach(function (g) {
          g[0].forEach(function (p) {
            var name = p && typeof p === 'object' ? str(p.businessName, 120) : null;
            if (!name || !ID.test(p.partnerId || '') || p.trade !== trade) return;
            var o = el('option', name + g[1]);
            o.value = p.partnerId;
            f.partner.appendChild(o);
            n++;
          });
        });
        found.textContent = n ? n + (n > 1 ? ' partenaires trouvés : choisissez-en un.' : ' partenaire trouvé : choisissez-le.') : 'Aucun partenaire de ce métier dans ce code postal.';
      });
    });
    look.className = 'secondaire';
    zone.appendChild(look);
    zone.appendChild(found);
    function reset() {
      turn++;
      while (f.partner.children.length > 1) f.partner.removeChild(f.partner.children[f.partner.children.length - 1]);
      f.partner.value = '';
      found.textContent = '';
    }
    /* Le métier change avec la catégorie : un partenaire déjà trouvé ne vaut plus. */
    function sync() {
      reset();
      zone.hidden = !own(TRADES, f.category.value);
      domainLabel.hidden = f.category.value !== 'diagnostiqueur';
    }
    f.category.addEventListener('change', sync);
    sync();
    form.appendChild(zone);
  }
  /* La saisie, contrôlée comme le serveur la contrôlera ; illisible : le refus en mots, et rien ne part. */
  function readForm(f) {
    var v = {};
    ['category', 'beneficiary', 'moment', 'supplier', 'title', 'terms', 'source', 'validFrom', 'validUntil'].forEach(function (k) { v[k] = String(f[k].value || '').trim(); });
    if (!own(CATS, v.category)) return { refusal: REFUSALS.bad_category };
    if (!own(FOR, v.beneficiary)) return { refusal: REFUSALS.bad_beneficiary };
    if (CLIENT_ONLY.indexOf(v.category) >= 0 && v.beneficiary !== 'client') return { refusal: REFUSALS.client_seulement };
    if (!own(MOMENTS, v.moment)) return { refusal: REFUSALS.bad_moment };
    if (v.moment === 'toujours' && v.beneficiary === 'client') return { refusal: REFUSALS.moment_du_dossier };
    if (v.supplier.length < 2 || v.supplier.length > 80) return { refusal: REFUSALS.bad_supplier };
    if (v.title.length < 2 || v.title.length > 120) return { refusal: REFUSALS.bad_title };
    if (v.terms.length < 2 || v.terms.length > 600) return { refusal: REFUSALS.bad_terms };
    if (v.source.length < 2 || v.source.length > 200) return { refusal: REFUSALS.sans_source };
    if (!DAY.test(v.validFrom) || !DAY.test(v.validUntil) || v.validUntil < v.validFrom) return { refusal: REFUSALS.bad_date };
    var p = own(TRADES, v.category) && ID.test(f.partner.value || '') ? f.partner.value : null;
    if (v.category === 'diagnostiqueur' && !p) return { refusal: REFUSALS.partenaire_requis };
    if (p) v.partnerId = p;
    return { value: v };
  }
  function deskForm() {
    var form = el('div', null, 'bloc');
    form.appendChild(el('h5', 'Ranger une remise'));
    form.appendChild(el('p', 'Une remise rangée ne change plus : une correction se range comme une nouvelle remise, l’ancienne retirée. Le lendemain de sa fin, elle disparaît seule.', 'doux'));
    var f = {};
    f.category = choice(form, 'remise-categorie', 'Catégorie', CATS);
    f.beneficiary = choice(form, 'remise-pour', 'Pour qui', FOR);
    form.appendChild(el('p', 'Diagnostiqueur, déménageur, artisan : pour le client seulement.', 'doux'));
    f.moment = choice(form, 'remise-moment', 'Moment du dossier où elle sert', MOMENTS);
    f.supplier = field(form, 'remise-fournisseur', 'Fournisseur');
    f.supplier.setAttribute('maxlength', '80');
    f.title = field(form, 'remise-titre', 'Titre');
    f.title.setAttribute('maxlength', '120');
    f.terms = field(form, 'remise-conditions', 'Conditions de la remise', 'textarea');
    f.terms.setAttribute('maxlength', '600');
    f.source = field(form, 'remise-source', 'Source : devis, contrat ou courrier');
    f.source.setAttribute('maxlength', '200');
    f.validFrom = field(form, 'remise-debut', 'Valable du');
    f.validFrom.setAttribute('type', 'date');
    f.validUntil = field(form, 'remise-fin', 'Jusqu’au');
    f.validUntil.setAttribute('type', 'date');
    partnerZone(form, f);
    var go = button('Ranger la remise', function () {
      var r = readForm(f);
      if (r.refusal) { desk.said.textContent = r.refusal; return; }
      write(go, '/v1/remises', r.value, desk.said, 'Remise rangée.', deskLoad, 'La remise n’est pas rangée.');
    });
    form.appendChild(go);
    return form;
  }
  function deskLoad(note) {
    var mine = t.session(), me = ++deskTurn;
    clear(desk.list);
    desk.said.textContent = note ? note + ' Relecture…' : 'Lecture des remises…';
    return send('/v1/remises', 'GET').then(function (x) {
      if (x.gone || mine !== t.session() || me !== deskTurn) return false;
      if (!x.ok || !Array.isArray(x.body.data)) { desk.said.textContent = note === LOST ? LOST : refusal(x, 'Les remises ne se lisent pas pour le moment.'); return false; }
      x.body.data.forEach(function (d) {
        var r = read(d);
        if (!r) return;
        desk.list.appendChild(card(r, function (box) {
          box.appendChild(el('p', r.who + ' · ' + r.moment + ' · du ' + r.from + ' au ' + r.until + '.'));
          box.appendChild(el('p', 'Source : ' + r.source, 'doux'));
          withdrawZone(r, box);
        }));
      });
      desk.said.textContent = note || (desk.list.children.length ? '' : 'Aucune remise en vigueur aujourd’hui.');
      return true;
    });
  }
  function show(inner) {
    clear(inner);
    var said = el('p', null, 'etat');
    said.setAttribute('role', 'status');
    desk = { said: said, list: el('div') };
    inner.appendChild(said);
    inner.appendChild(desk.list);
    inner.appendChild(deskForm());
    return deskLoad();
  }

  /* ---------- L'agent du bien : les remises du moment, lu dans la base [R267, R75]. ---------- */
  function group(title, items, ctx, intro) {
    if (!items.length) return;
    ctx.corps.appendChild(el('h5', title));
    if (intro) ctx.corps.appendChild(el('p', intro, 'doux'));
    items.forEach(function (r) {
      ctx.corps.appendChild(card(r, function (box) {
        if (r.why) box.appendChild(el('p', 'Pourquoi maintenant : ' + r.why));
        box.appendChild(el('p', 'Jusqu’au ' + r.until + '.', 'doux'));
        var b = button('Écarter pour ce bien', function () {
          write(b, '/v1/remises/' + encodeURIComponent(r.id) + '/biens/' + encodeURIComponent(ctx.id) + '/ecarter', {}, ctx.said, 'Remise écartée : elle ne reviendra plus sur ce bien.', function (n) { return propLoad(ctx, n); }, 'La remise n’est pas écartée.');
        });
        b.className = 'secondaire';
        box.appendChild(b);
      }));
    });
  }
  function propLoad(ctx, note) {
    var mine = t.session(), me = ctx.corps.aimmoTurn = (ctx.corps.aimmoTurn || 0) + 1;
    clear(ctx.corps);
    ctx.said.textContent = 'Lecture des remises du moment…';
    return send('/v1/remises/biens/' + encodeURIComponent(ctx.id), 'GET').then(function (x) {
      if (x.gone || mine !== t.session() || me !== ctx.corps.aimmoTurn) return false;
      if (!x.ok || !x.body || !('data' in x.body)) { ctx.said.textContent = note === LOST ? LOST : refusal(x, 'Les remises ne se lisent pas pour le moment.'); return false; }
      var d = x.body.data;
      if (d === null) { ctx.said.textContent = note || NONE_NOW; return true; }
      var moment = d && typeof d === 'object' ? own(MOMENTS, d.moment) : null;
      if (!moment || d.moment === 'toujours' || !Array.isArray(d.forAgent) || !Array.isArray(d.forClient)) { ctx.said.textContent = 'Les remises ne se lisent pas pour le moment.'; return false; }
      ctx.corps.appendChild(el('p', 'Moment du dossier, lu dans la base : ' + moment + '.'));
      var mineList = d.forAgent.map(read).filter(function (r) { return r && r.who === FOR.agent; });
      // L'ordre du client est celui du tirage au sort du serveur : jamais retrié ici [R75].
      var theirs = d.forClient.map(read).filter(function (r) { return r && r.who === FOR.client; });
      group('Pour vous', mineList, ctx);
      group('Pour le client', theirs, ctx, RANDOM);
      ctx.said.textContent = note || (mineList.length + theirs.length ? '' : 'Aucune remise négociée pour ce moment du dossier.');
      return true;
    });
  }
  /* ---------- L'agent, sur son accueil : ses remises de tous les jours ; les autres seulement comptées [R267]. ---------- */
  function homeLoad(ctx) {
    var mine = t.session(), me = ctx.corps.aimmoTurn = (ctx.corps.aimmoTurn || 0) + 1;
    clear(ctx.corps);
    ctx.said.textContent = 'Lecture de vos remises…';
    return send('/v1/remises', 'GET').then(function (x) {
      if (x.gone || mine !== t.session() || me !== ctx.corps.aimmoTurn) return false;
      if (!x.ok || !x.body || !Array.isArray(x.body.data)) { ctx.said.textContent = refusal(x, 'Les remises ne se lisent pas pour le moment.'); return false; }
      var always = [], counts = {}, n = 0;
      x.body.data.forEach(function (d) {
        var r = read(d);
        if (!r) return;
        if (r.moment === MOMENTS.toujours) { if (r.who === FOR.agent) always.push(r); return; }
        var c = counts[r.moment] = counts[r.moment] || { agent: 0, client: 0 };
        c[r.who === FOR.agent ? 'agent' : 'client']++;
        n++;
      });
      if (always.length) {
        ctx.corps.appendChild(el('h5', 'Pour vous, tous les jours'));
        always.forEach(function (r) {
          ctx.corps.appendChild(card(r, function (box) {
            box.appendChild(el('p', 'Source : ' + r.source, 'doux'));
            box.appendChild(el('p', 'Jusqu’au ' + r.until + '.', 'doux'));
          }));
        });
      }
      if (n) {
        ctx.corps.appendChild(el('h5', 'Sur la page du bien, au bon moment'));
        ctx.corps.appendChild(el('p', ELSEWHERE, 'doux'));
        var ul = el('ul', null, 'liste');
        Object.keys(MOMENTS).forEach(function (k) {
          var c = counts[MOMENTS[k]];
          if (!c) return;
          var parts = [];
          if (c.agent) parts.push(c.agent + ' pour vous');
          if (c.client) parts.push(c.client + ' pour vos clients');
          ul.appendChild(el('li', MOMENTS[k] + ' : ' + parts.join(', ') + '.'));
        });
        ctx.corps.appendChild(ul);
      }
      ctx.said.textContent = always.length + n ? '' : NONE_TODAY;
      return true;
    });
  }
  function open(propertyId, corps, said) {
    if (propertyId === '') return homeLoad({ corps: corps, said: said });
    if (!ID.test(propertyId || '')) { said.textContent = REFUSALS.unknown_property; return Promise.resolve(false); }
    return propLoad({ id: propertyId, corps: corps, said: said });
  }
  return { show: show, open: open };
};
`;
