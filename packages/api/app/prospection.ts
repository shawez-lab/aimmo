import { PARTNER_TRADES } from '../../core/src/partenaires/annuaire.ts';

/**
 * La prospection des partenaires sur l'écran du réseau (U14) : la direction range un contact professionnel, lit la liste,
 * note une opposition et lit les brouillons d'un jour. Script servi à part (`/app/prospection.js`), chargé au premier
 * geste [R201]. Aucun geste n'envoie : la route ne le permet pas, et le refus du contrôle central rangé avec chaque
 * brouillon est dit tel quel [R03, R79]. L'adresse n'est jamais relue : la liste du serveur ne la rend pas [R13].
 * L'écran garde l'ordre reçu, ne note ni ne classe. Tout texte reçu est posé en texte, rien ne reste une fois quitté.
 */

const REFUSALS: Record<string, string> = {
  role: 'Ce n’est pas dans vos droits.',
  unknown: 'Ce contact n’est pas dans la liste de ce réseau.',
  unknown_trade: 'Choisissez le métier.',
  bad_name: 'Le nom de l’entreprise : de 2 à 120 caractères.',
  bad_email: 'L’adresse mail n’est pas lisible.',
  not_professional: 'Seule une adresse professionnelle se range ici, jamais une adresse personnelle.',
  bad_source: 'La source publique de cette adresse : de 3 à 300 caractères.',
  already_listed: 'Cette adresse est déjà dans la liste : elle ne reçoit jamais deux fois le premier mail.',
  opposed: 'Cette adresse a demandé l’arrêt : elle ne revient jamais dans la liste.',
  bad_day: 'Choisissez le jour à lire.',
};
const TRADES = Object.fromEntries(PARTNER_TRADES.map((t) => [t.trade, t.label]));

export const PROSPECTION_ENTRY_HTML = `<section class="bloc" aria-labelledby="titre-prospection">
<h3 id="titre-prospection">Prospection des partenaires</h3>
<p class="doux">Aucun mail ne part d’ici.</p>
<button id="prospection-ouvrir" type="button" class="secondaire">Ouvrir la prospection</button>
<p id="prospection-etat" class="etat" role="status"></p>
<div id="prospection-corps"></div>
</section>
`;

/** Le chargeur posé dans le script de l'application : l'écran est servi à part, chargé une fois, jamais gardé. */
export const PROSPECTION_JS = `
  /* ---------- La prospection des partenaires sur l'écran du réseau (U14), chargée au premier geste [R16, R79, R201]. ---------- */
  function wipeProspection() {
    clear($('prospection-corps'));
    $('prospection-etat').textContent = '';
  }
  function withProspection(act) {
    return withTool('prospection', 'AIMMO_PROSPECTION', 'prospection-etat', 'reseau', act, function () { return { $: $, el: el, clear: clear, send: send, button: button, field: field, select: select, details: details, session: function () { return session; } }; });
  }
`;

/** Le script servi à part (`/app/prospection.js`). Il ne lit et n'écrit que les routes `/v1/partenaires/prospection` [R16]. */
export const PROSPECTION_SCRIPT = `'use strict';
globalThis.AIMMO_PROSPECTION = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, select = t.select, details = t.details;
  var REFUSALS = ${JSON.stringify(REFUSALS)};
  var TRADES = ${JSON.stringify(TRADES)};
  var BASE = '/v1/partenaires/prospection';
  var OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
  /* Une écriture sans réponse, ou coupée par une panne du serveur, a pu passer : l'écran ne dit ni fait ni pas fait. */
  var LOST = 'La réponse n’est pas arrivée : rien n’est sûr. Relisez la liste avant de recommencer.';
  /* Le verrou d'un geste vaut pour sa session : une réponse qui tarde ne bloque pas la connexion suivante. */
  var busy = null, turn = 0;
  function state(text) { $('prospection-etat').textContent = text; }
  function body() { return $('prospection-corps'); }
  function once(work) {
    var mine = t.session();
    if (busy === mine) return Promise.resolve(false);
    busy = mine;
    function done(r) { if (busy === mine) busy = null; return r; }
    return work().then(done, function () { return done(false); });
  }
  function why(res, fallback) {
    if (res.offline) return OFFLINE;
    return (res.body && REFUSALS[res.body.code]) || fallback;
  }
  function lost(x) { return x.offline || !x.body || x.status >= 500; }
  function write(url, payload, done, fallback, lostText) {
    return send(url, 'POST', payload).then(function (x) {
      if (x.gone) return false;
      if (lost(x)) { state(lostText || LOST); return false; }
      if (!x.ok) { state(why(x, fallback)); return false; }
      return done(x.body.data);
    });
  }
  function today() {
    try { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); } catch (e) { return ''; }
  }
  function frenchDay(day) { return String(day).split('-').reverse().join('/'); }
  /* La décision rangée avec le brouillon, telle quelle : l'écran ne la refait pas, et aucun brouillon ne part d'ici [R03, R79]. */
  function decisionText(rule) {
    if (rule === 'R03') return 'Refusé par le contrôle central, règle R03 : il faut un accord préalable tant que la prospection entre professionnels n’est pas tranchée. Ce brouillon ne part pas.';
    if (rule) return 'Refusé par le contrôle central, règle ' + rule + '. Ce brouillon ne part pas.';
    return 'Pas de refus au moment de le préparer. Il ne part pas d’ici : le contrôle central redécide au moment de l’envoi.';
  }

  /* La liste, l'ajout et les brouillons du jour. */
  function show(message) {
    var mine = t.session();
    var at = ++turn;
    clear(body());
    state('Chargement…');
    return send(BASE, 'GET').then(function (res) {
      if (res.gone || mine !== t.session() || at !== turn) return false;
      if (!res.ok || !res.body.data) { state((message ? message + ' ' : '') + why(res, 'Liste indisponible pour le moment.')); return false; }
      var list = res.body.data;
      var names = {};
      list.forEach(function (p) { names[p.prospectId] = p.businessName; });
      body().appendChild(el('p', 'Tant que la prospection entre professionnels n’est pas tranchée, le contrôle central refuse chaque premier mail sous la règle R03. Les brouillons se lisent, aucun ne part.', 'doux'));
      renderList(list);
      renderAdd();
      var read = renderDrafts(names);
      state(message || '');
      return read;
    });
  }
  /* L'ordre reçu, neutre : ni note, ni rang [R14]. */
  function renderList(list) {
    var box = el('section');
    box.appendChild(el('h4', 'Contacts professionnels'));
    if (!list.length) box.appendChild(el('p', 'Aucun contact rangé.', 'doux'));
    var ul = el('ul', null, 'liste');
    list.forEach(function (p) {
      var li = el('li');
      li.appendChild(el('strong', p.businessName));
      li.appendChild(el('p', (TRADES[p.trade] || '') + ' · Source : ' + p.source, 'doux'));
      if (p.opposed) li.appendChild(el('p', 'Opposition notée : plus aucun message, pour toujours.', 'etat'));
      else li.appendChild(el('p', p.mailedOn ? 'Premier mail préparé le ' + frenchDay(p.mailedOn) + ', sans envoi.' : 'Aucun mail préparé.', 'doux'));
      if (!p.opposed) li.appendChild(oppositionButton(p.prospectId));
      ul.appendChild(li);
    });
    if (list.length) box.appendChild(ul);
    body().appendChild(box);
  }
  function renderAdd() {
    var form = details(body(), 'Ajouter un contact professionnel');
    var trade = select(form, 'prospection-metier', 'Métier', Object.assign({ '': 'Choisir le métier' }, TRADES), '');
    var name = field(form, 'prospection-nom', 'Nom de l’entreprise');
    name.setAttribute('maxlength', '120');
    var email = field(form, 'prospection-mail', 'Adresse mail');
    email.setAttribute('type', 'email');
    var kind = select(form, 'prospection-sorte', 'Cette adresse est', { '': 'Choisir', professionnelle: 'professionnelle', personnelle: 'personnelle' }, '');
    var source = field(form, 'prospection-source', 'Source publique de cette adresse');
    source.setAttribute('maxlength', '300');
    form.appendChild(button('Ajouter ce contact', function () {
      if (!trade.value) { state(REFUSALS.unknown_trade); return; }
      if (name.value.trim().length < 2) { state(REFUSALS.bad_name); return; }
      if (!email.value.trim()) { state(REFUSALS.bad_email); return; }
      /* Une adresse personnelle ne quitte pas l'appareil ; le serveur la refuserait de toute façon [R79]. */
      if (kind.value !== 'professionnelle') { state(kind.value ? REFUSALS.not_professional : 'Dites si cette adresse est professionnelle.'); return; }
      if (source.value.trim().length < 3) { state(REFUSALS.bad_source); return; }
      once(function () {
        state('Envoi…');
        return write(BASE, { email: email.value.trim(), addressKind: kind.value, trade: trade.value, businessName: name.value.trim(), source: source.value.trim() }, function () {
          return show('Contact ajouté. Rien ne lui est écrit.');
        }, 'Le contact n’est pas ajouté.');
      });
    }));
  }
  function renderDrafts(names) {
    var box = el('section');
    box.appendChild(el('h4', 'Brouillons du jour'));
    var day = field(box, 'prospection-jour', 'Jour');
    day.setAttribute('type', 'date');
    day.value = today();
    var note = el('p', '', 'etat');
    note.setAttribute('role', 'status');
    var results = el('div');
    box.appendChild(button('Lire ce jour', function () { readDrafts(day.value, results, note, names); }));
    box.appendChild(note);
    box.appendChild(results);
    body().appendChild(box);
    return readDrafts(day.value, results, note, names);
  }
  function readDrafts(day, results, note, names) {
    var mine = t.session();
    var at = ++turn;
    clear(results);
    if (!day) { note.textContent = REFUSALS.bad_day; return Promise.resolve(false); }
    note.textContent = 'Chargement…';
    return send(BASE + '/mails?jour=' + encodeURIComponent(day), 'GET').then(function (res) {
      if (res.gone || mine !== t.session() || at !== turn) return false;
      if (!res.ok || !res.body.data) { note.textContent = why(res, 'Brouillons indisponibles pour le moment.'); return false; }
      var mails = res.body.data;
      note.textContent = mails.length ? '' : 'Aucun brouillon préparé ce jour-là.';
      var ul = el('ul', null, 'liste');
      mails.forEach(function (m) {
        var li = el('li');
        li.appendChild(el('strong', names[m.prospectId] || 'Contact professionnel'));
        li.appendChild(el('p', decisionText(m.decisionRule), 'etat'));
        li.appendChild(el('p', m.text));
        ul.appendChild(li);
      });
      if (mails.length) results.appendChild(ul);
      return true;
    });
  }
  /* Deux appuis espacés : une opposition ne se défait pas [R04]. */
  function oppositionButton(id) {
    var text = 'Noter son opposition', armedAt = null;
    var b = button(text, function () {
      var now = Date.now();
      if (armedAt !== null && now - armedAt < 1000) return;
      if (armedAt === null || now - armedAt > 15000) {
        armedAt = now;
        b.textContent = 'Confirmer : noter son opposition';
        state('Cette adresse ne recevra plus rien de notre part, et cela ne se défait pas. Appuyez de nouveau pour confirmer.');
        return;
      }
      armedAt = null;
      b.textContent = text;
      once(function () {
        state('Envoi…');
        return write(BASE + '/' + encodeURIComponent(id) + '/opposition', undefined, function () { return show('Opposition notée : plus aucun message.'); }, 'L’opposition n’est pas notée.');
      });
    });
    b.className = 'secondaire';
    return b;
  }
  return { show: show };
};
`;
