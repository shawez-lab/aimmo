/**
 * Les fichiers de l'application de l'agent (A01), tels que le navigateur de l'agent les reçoit. Ce code tourne sur le
 * téléphone de l'agent, pas dans le Worker : il n'appelle que l'API de la même adresse (politique de contenu
 * `connect-src 'self'`), jamais une adresse extérieure. Le Worker les sert tels quels (`src/agent-app.ts`).
 */
export const INDEX_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="theme-color" content="#1f3a5f">
<meta name="referrer" content="no-referrer">
<title>AIMMO</title>
<link rel="manifest" href="/app/manifest.webmanifest">
<link rel="icon" href="/app/icon.svg" type="image/svg+xml">
<link rel="stylesheet" href="/app/app.css">
<script src="/app/app.js" defer></script>
</head>
<body>
<header><h1>AIMMO</h1><button id="sortir" type="button" hidden>Se déconnecter</button></header>
<main>
<section id="connexion" hidden>
<h2>Connexion</h2>
<p>Saisissez votre clé personnelle. Elle reste sur cet appareil.</p>
<form id="form-connexion" autocomplete="off">
<label for="cle">Clé personnelle</label>
<input id="cle" name="cle" type="password" minlength="32" required autocomplete="off" spellcheck="false">
<button type="submit">Entrer</button>
</form>
<p id="erreur" role="alert" hidden></p>
</section>
<section id="accueil" hidden>
<h2 id="bonjour"></h2>
<section class="bloc" aria-labelledby="titre-plan">
<h3 id="titre-plan">Mon plan du jour</h3>
<p id="plan-etat" class="etat"></p>
<ol id="plan" class="liste"></ol>
</section>
<section class="bloc" aria-labelledby="titre-chauds">
<h3 id="titre-chauds">Contacts chauds à rappeler</h3>
<p id="chauds-etat" class="etat"></p>
<ul id="chauds" class="liste"></ul>
</section>
<section class="bloc" aria-labelledby="titre-rdv">
<h3 id="titre-rdv">Rendez-vous du jour</h3>
<p id="rdv-etat" class="etat"></p>
<ul id="rdv" class="liste"></ul>
</section>
<section class="bloc" aria-labelledby="titre-semaine">
<h3 id="titre-semaine">Ma semaine</h3>
<p id="semaine-etat" class="etat"></p>
<ul id="semaine" class="liste"></ul>
</section>
</section>
<section id="fiche" hidden>
<button id="retour" type="button">Retour à ma journée</button>
<h2 id="fiche-nom"></h2>
<p id="fiche-etat" class="etat" role="status"></p>
<div id="fiche-corps"></div>
</section>
<section id="visite" hidden>
<button id="visite-retour" type="button" class="retour">Retour à ma journée</button>
<button id="alerte" type="button" class="danger">Alerte : prévenir la direction</button>
<p id="alerte-etat" role="alert" hidden></p>
<h2 id="visite-titre"></h2>
<p id="visite-etat" class="etat" role="status"></p>
<div id="visite-corps"></div>
</section>
<section id="bien" hidden>
<button id="bien-retour" type="button" class="retour">Retour à la visite</button>
<h2 id="bien-titre"></h2>
<p id="bien-etat" class="etat" role="status"></p>
<div id="bien-corps"></div>
</section>
<p id="attente">Chargement…</p>
<p id="note" role="status" hidden></p>
</main>
</body>
</html>
`;

export const APP_CSS = `:root { color-scheme: light dark; --fond: #ffffff; --texte: #14202e; --accent: #1f3a5f; --doux: #5b6b7d; }
@media (prefers-color-scheme: dark) { :root { --fond: #10161d; --texte: #e8eef4; --accent: #8fb3dd; --doux: #9aa8b6; } }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; background: var(--fond); color: var(--texte); }
header { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--doux); }
h1 { margin: 0; font-size: 1.25rem; color: var(--accent); }
main { padding: 16px; max-width: 40rem; margin: 0 auto; }
label { display: block; margin-bottom: 4px; }
input { width: 100%; padding: 12px; font-size: 1rem; border: 1px solid var(--doux); border-radius: 8px; background: transparent; color: inherit; }
button { margin-top: 12px; min-height: 44px; padding: 8px 16px; font-size: 1rem; border: 0; border-radius: 8px; background: var(--accent); color: var(--fond); }
header button { margin: 0; }
#erreur { color: #b3261e; }
.bloc { margin-top: 24px; }
h3 { margin: 0 0 8px; font-size: 1.05rem; }
.liste { list-style: none; margin: 0; padding: 0; }
.liste > li { padding: 12px 0; border-top: 1px solid var(--doux); overflow-wrap: anywhere; }
.liste p { margin: 4px 0 0; }
.doux, .etat { color: var(--doux); font-size: 0.9rem; }
.retard { color: #b3261e; }
.alerte { padding: 12px; border: 2px solid #b3261e; border-radius: 8px; }
.appel { display: inline-flex; align-items: center; min-height: 44px; margin-top: 12px; padding: 8px 16px; border-radius: 8px; background: var(--accent); color: var(--fond); text-decoration: none; }
.liste button, #fiche-corps button { margin-top: 8px; }
details { margin-top: 8px; }
summary { min-height: 44px; display: flex; align-items: center; cursor: pointer; color: var(--accent); }
h4 { margin: 12px 0 4px; font-size: 0.95rem; }
.brief ul { margin: 0; padding-left: 18px; }
a { color: var(--accent); }
textarea, select { width: 100%; padding: 12px; font: inherit; border: 1px solid var(--doux); border-radius: 8px; background: transparent; color: inherit; }
textarea { min-height: 7rem; resize: vertical; }
select { min-height: 44px; }
label + input, label + textarea, label + select { margin-bottom: 12px; }
.case { display: flex; align-items: center; gap: 12px; min-height: 44px; margin-top: 8px; }
.case input { width: 24px; height: 24px; flex: none; }
.danger { width: 100%; background: #b3261e; color: #ffffff; font-weight: 600; }
.retour { background: transparent; color: var(--accent); padding-left: 0; }
.fait { color: #1b6e3a; font-weight: 600; }
@media (prefers-color-scheme: dark) { .fait { color: #7fd39b; } }
.acquereur { padding: 12px 0; }
.acquereur ul { margin: 4px 0 0; padding-left: 18px; }
button:focus-visible, a:focus-visible, input:focus-visible, textarea:focus-visible, select:focus-visible, summary:focus-visible { outline: 3px solid var(--accent); outline-offset: 2px; }
`;

/**
 * Le script de la page. Tout texte venu de l'API est posé avec `textContent`, jamais comme du code. La clé ne passe
 * que dans l'en-tête `Authorization`.
 */
export const APP_JS = `'use strict';
(function () {
  var KEY = 'aimmo.cle';
  var $ = function (id) { return document.getElementById(id); };
  function readKey() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function writeKey(v) { try { localStorage.setItem(KEY, v); return true; } catch (e) { return false; } }
  function forgetKey() { try { localStorage.removeItem(KEY); } catch (e) { /* rien à effacer */ } }
  function el(tag, text, cls) {
    var n = document.createElement(tag);
    if (text !== undefined && text !== null) n.textContent = String(text);
    if (cls) n.className = cls;
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }
  function hour(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try { return d.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }); } catch (e) { return ''; }
  }
  var KINDS = { estimation: 'Estimation', visite: 'Visite', signature: 'Signature', appel: 'Appel' };
  var STATUS = { honored: 'honoré', absent: 'client absent' };
  var SECTIONS = { client: 'Le client', histoire: 'Son histoire', bien: 'Le bien', ventes: 'Ventes du quartier', questions: 'Questions à prévoir', documents: 'Documents à apporter', itineraire: 'Itinéraire' };
  var MISSING = { not_ready: 'Le brief sera prêt une heure avant le rendez-vous.', no_access: 'Fiche suivie par un autre agent : ni brief ni détail.', changed: 'La fiche a changé depuis le brief : il n’est pas montré.', property: 'Le bien n’est plus dans vos droits : le brief n’est pas montré.' };
  // Le seul lien extérieur admis : l'itinéraire du brief, vers l'application de navigation.
  var ROUTE = /^https:\\/\\/www\\.google\\.com\\/maps\\/dir\\/\\?api=1&destination=[A-Za-z0-9%._~!*'()-]+$/;
  // Le plan est rendu dans l'ordre reçu du socle, jamais retrié ici [R35].
  function renderPlan(list, data) {
    if (!data) return 'Le plan du jour sera prêt à 7 h 30.';
    var items = Array.isArray(data.items) ? data.items : [];
    items.forEach(function (item) {
      var li = el('li');
      li.appendChild(el('strong', String(item.rank) + '. ' + (item.firstName || 'Prénom inconnu')));
      li.appendChild(el('p', item.reason));
      li.appendChild(el('p', 'Place : ' + item.order, 'doux'));
      li.appendChild(ficheButton(item.personId));
      list.appendChild(li);
    });
    if (data.hiddenSinceFrozen > 0) list.appendChild(el('li', String(data.hiddenSinceFrozen) + ' ligne(s) retirée(s) depuis 7 h 30.', 'doux'));
    return items.length === 0 && !(data.hiddenSinceFrozen > 0) ? 'Rien au plan aujourd’hui.' : null;
  }
  function renderHot(list, data) {
    var contacts = data && Array.isArray(data.contacts) ? data.contacts : [];
    contacts.forEach(function (c) {
      var li = el('li');
      li.appendChild(el('strong', c.firstName || 'Prénom inconnu'));
      li.appendChild(el('p', c.reason));
      li.appendChild(el('p', (c.overdue ? 'En retard : à rappeler depuis ' : 'À rappeler avant ') + hour(c.dueAt), c.overdue ? 'retard' : 'doux'));
      li.appendChild(ficheButton(c.personId));
      list.appendChild(li);
    });
    return contacts.length === 0 ? 'Aucun contact chaud à rappeler.' : null;
  }
  function renderBrief(brief) {
    var box = el('details', null, 'brief');
    box.appendChild(el('summary', 'Brief du rendez-vous'));
    var items = Array.isArray(brief.items) ? brief.items : [];
    var current = null;
    var ul = null;
    items.forEach(function (item) {
      if (item.section !== current) {
        current = item.section;
        box.appendChild(el('h4', SECTIONS[current] || 'Autre'));
        ul = el('ul');
        box.appendChild(ul);
      }
      var li = el('li');
      if (item.value === null || item.value === undefined) {
        li.appendChild(el('span', item.label + ' : manque, ' + item.missing, 'doux'));
      } else if (item.section === 'itineraire' && typeof item.value === 'string' && ROUTE.test(item.value)) {
        var a = el('a', 'Ouvrir l’itinéraire');
        a.setAttribute('href', item.value);
        a.setAttribute('target', '_blank');
        a.setAttribute('rel', 'noopener noreferrer');
        li.appendChild(a);
      } else {
        li.appendChild(el('span', item.label + ' : ' + item.value));
        if (item.source) li.appendChild(el('span', ' (' + item.source + ')', 'doux'));
      }
      ul.appendChild(li);
    });
    return box;
  }
  function renderAppointments(list, data) {
    var appointments = data && Array.isArray(data.appointments) ? data.appointments : [];
    appointments.forEach(function (a) {
      var li = el('li');
      var head = hour(a.start) + ' à ' + hour(a.end) + ' · ' + (KINDS[a.kind] || 'Rendez-vous') + (a.firstName ? ' · ' + a.firstName : '');
      li.appendChild(el('strong', head));
      if (STATUS[a.status]) li.appendChild(el('p', 'Rendez-vous ' + STATUS[a.status] + '.', 'doux'));
      if (a.brief) li.appendChild(renderBrief(a.brief));
      else li.appendChild(el('p', MISSING[a.briefMissing] || MISSING.not_ready, 'doux'));
      // Une visite dont l'agent voit le visiteur s'ouvre sur son écran : sécurité, bon, compte rendu, acquéreurs.
      if (a.kind === 'visite' && a.firstName && ID.test(a.id)) li.appendChild(button('Ouvrir la visite', function () { openVisit(a.id); }));
      list.appendChild(li);
    });
    return appointments.length === 0 ? 'Aucun rendez-vous aujourd’hui.' : null;
  }
  var currentKey = null;
  var ID = /^[A-Za-z0-9_-]{1,64}$/;
  var TEL = /^tel:[+]?[0-9]{6,15}$/;
  var PROJECTS = { sell: 'Vendre', buy: 'Acheter', rent_out: 'Mettre en location', rent: 'Louer', invest: 'Investir', sell_business: 'Céder une entreprise', buy_business: 'Reprendre une entreprise', valuation: 'Faire estimer' };
  var STAGES = { new: 'nouveau', recue: 'demande reçue', appele: 'appelé' };
  var CHANNELS = { email: 'mail', phone: 'téléphone', sms: 'SMS', instagram: 'Instagram', facebook: 'Facebook', whatsapp: 'WhatsApp', site: 'site', gohighlevel: 'reprise de GoHighLevel', manychat: 'reprise de ManyChat', exclusion_list: 'liste d’exclusion' };
  // Les codes internes ne s'affichent jamais : un code inconnu prend un libellé général.
  function stage(code) { return STAGES[code] || 'en cours'; }
  function channel(code) { return CHANNELS[code] || 'autre canal'; }
  var PURPOSES = { valuation_follow_up: 'suivi de l’avis de valeur', value_tracking: 'suivi de la valeur du bien', prospecting: 'prospection', appointment: 'rendez-vous' };
  var EXCLUSIONS = { network_list: 'sur la liste d’exclusion', stop: 'a demandé l’arrêt', refused: 'a dit non', sold: 'a déjà vendu', followed_elsewhere: 'suivi par quelqu’un d’autre' };
  function date(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try { return d.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' }); } catch (e) { return ''; }
  }
  function ficheButton(personId) {
    var b = el('button', 'Voir la fiche');
    b.setAttribute('type', 'button');
    b.addEventListener('click', function () { openFiche(personId); });
    return b;
  }
  function block(title, rows) {
    var box = el('section', null, 'bloc');
    box.appendChild(el('h3', title));
    var ul = el('ul', null, 'liste');
    rows.forEach(function (r) { ul.appendChild(r); });
    if (rows.length === 0) box.appendChild(el('p', 'Rien pour le moment.', 'etat'));
    box.appendChild(ul);
    return box;
  }
  function line(text, note) {
    var li = el('li', text);
    if (note) li.appendChild(el('p', note, 'doux'));
    return li;
  }
  function renderFiche(f, personId) {
    var body = $('fiche-corps');
    clear(body);
    $('fiche-nom').textContent = [f.firstName, f.lastName].filter(function (x) { return x; }).join(' ') || 'Nom inconnu';
    var contact = f.contact || { allowed: false, reasons: [] };
    // Personne exclue ou qui a demandé l'arrêt : signalée, sans bouton d'appel [R02, R04].
    if (!contact.allowed) {
      var reasons = (contact.reasons || []).map(function (r) { return EXCLUSIONS[r] || 'autre raison'; }).join(', ');
      body.appendChild(el('p', 'Ne plus contacter : ' + (reasons || 'exclusion active') + '.', 'alerte'));
    } else if (typeof f.call === 'string' && TEL.test(f.call)) {
      var a = el('a', 'Appeler', 'appel');
      a.setAttribute('href', f.call);
      body.appendChild(a);
    } else {
      body.appendChild(el('p', 'Aucun numéro sur la fiche.', 'doux'));
    }
    var callbacks = (f.callbacks || []).map(function (c) {
      var li = line(c.reason, c.doneAt ? 'Fait le ' + date(c.doneAt) : 'À rappeler avant le ' + date(c.dueAt) + ' à ' + hour(c.dueAt));
      if (!c.doneAt && ID.test(c.taskId)) {
        var b = el('button', 'Rappel fait');
        b.setAttribute('type', 'button');
        b.addEventListener('click', function () { callbackDone(c.taskId, personId); });
        li.appendChild(b);
      }
      return li;
    });
    body.appendChild(block('Rappels', callbacks));
    body.appendChild(block('Projets', (f.projects || []).map(function (p) {
      var budget = p.budgetMaxEur ? ', budget jusqu’à ' + p.budgetMaxEur + ' €' : '';
      return line((PROJECTS[p.kind] || 'Autre projet') + ' (étape : ' + stage(p.stage) + ')' + budget, p.deadline ? 'Échéance le ' + date(p.deadline) : null);
    })));
    body.appendChild(block('Origines', (f.sources || []).map(function (s) { return line(channel(s.channel) + (s.detail ? ' (' + s.detail + ')' : ''), 'Le ' + date(s.occurredAt)); })));
    body.appendChild(block('Accords', (f.consents || []).map(function (c) {
      return line((PURPOSES[c.purpose] || 'autre accord') + ' par ' + channel(c.channel), c.withdrawnAt ? 'Retiré le ' + date(c.withdrawnAt) : 'Donné le ' + date(c.givenAt));
    })));
    body.appendChild(block('Derniers messages', (f.messages || []).map(function (m) {
      return line(m.body, (m.direction === 'in' ? 'Reçu' : 'Envoyé') + ' par ' + channel(m.channel) + ', le ' + date(m.occurredAt) + ' à ' + hour(m.occurredAt));
    })));
  }
  // La réponse d'une demande de fiche : clé refusée, fiche hors des droits, panne, ou la fiche.
  function ficheAnswer(r) {
    if (r.status === 401) return { refused: true };
    return r.json().then(function (body) {
      if (r.status === 403 && body && body.code === 'agent_inactive') return { refused: true };
      if (r.status === 403 || r.status === 404) return { denied: true };
      if (!r.ok || !body || body.ok !== true) return { failed: true };
      return { body: body };
    }, function () { return { failed: true }; });
  }
  function openFiche(personId) {
    if (!currentKey || typeof personId !== 'string' || !ID.test(personId)) return Promise.resolve(false);
    var mine = session;
    var key = currentKey;
    wipeFiche();
    $('fiche-etat').textContent = 'Chargement…';
    show('fiche');
    return api('/v1/fiches/' + encodeURIComponent(personId) + '/resume', key).then(ficheAnswer).then(function (res) {
      if (mine !== session) return false;
      if (res.refused) { forgetKey(); refuse('Clé refusée. Vérifiez-la ou demandez-en une nouvelle.'); return false; }
      if (res.denied) { $('fiche-etat').textContent = 'Cette fiche n’est pas dans vos droits.'; return false; }
      if (res.failed) { $('fiche-etat').textContent = 'Indisponible pour le moment. Réessayez plus tard.'; return false; }
      $('fiche-etat').textContent = '';
      renderFiche(res.body.data, personId);
      return true;
    }, function () {
      if (mine !== session) return false;
      $('fiche-etat').textContent = 'Indisponible pour le moment. Réessayez plus tard.';
      return false;
    });
  }
  // « Rappel fait » : rien n'est envoyé ; la fiche est relue pour montrer la ligne gardée.
  function callbackDone(taskId, personId) {
    if (!currentKey || !ID.test(taskId)) return Promise.resolve(false);
    var mine = session;
    var key = currentKey;
    return api('/v1/rappels/' + encodeURIComponent(taskId) + '/fait', key, 'POST').then(function (r) {
      if (mine !== session) return false;
      if (r.status === 401) { forgetKey(); refuse('Clé refusée. Vérifiez-la ou demandez-en une nouvelle.'); return false; }
      if (!r.ok) { $('fiche-etat').textContent = 'Le rappel n’a pas pu être marqué fait.'; return false; }
      return openFiche(personId);
    }, function () {
      if (mine !== session) return false;
      $('fiche-etat').textContent = 'Pas de réseau : le rappel n’est pas marqué fait.';
      return false;
    });
  }
  // Chaque entrée, sortie ou refus ouvre une nouvelle session : une réponse d'une session finie n'est jamais montrée.
  var session = 0;
  // L'usage du matin : pour l'agent seul, ses propres jours ; aucune comparaison avec les autres [R14].
  function renderWeek(list, data) {
    if (!data || data.scope !== 'agent' || !Array.isArray(data.days)) return 'Mesure indisponible.';
    list.appendChild(el('li', 'Plan ouvert avant midi : ' + data.openedDays + ' jour(s) sur ' + data.days.length + '.'));
    var marks = data.days.map(function (d) { return date(d.day + 'T12:00:00Z').slice(0, 5) + (d.opened ? ' oui' : ' non'); }).join(' · ');
    list.appendChild(el('li', marks, 'doux'));
    return null;
  }
  function part(id, request, render, mine) {
    var list = $(id);
    var state = $(id + '-etat');
    clear(list);
    state.textContent = 'Chargement…';
    return request.then(function (r) {
      if (r.status === 401 || r.status === 403) return { refused: true };
      if (!r.ok) return { failed: true };
      return r.json().then(function (body) { return { body: body }; });
    }).then(function (res) {
      if (mine !== session) return true;
      if (res.refused) return false;
      if (res.failed || !res.body || res.body.ok !== true) { state.textContent = 'Indisponible pour le moment. Réessayez plus tard.'; return true; }
      var empty = render(list, res.body.data);
      state.textContent = empty || '';
      return true;
    }, function () {
      if (mine !== session) return true;
      clear(list);
      state.textContent = 'Indisponible pour le moment. Réessayez plus tard.';
      return true;
    });
  }
  function day(key, mine) {
    return Promise.all([
      // La semaine est lue après le plan : l'ouverture de ce matin y compte déjà.
      part('plan', api('/v1/plan-du-jour', key), renderPlan, mine).then(function (done) {
        if (!done || mine !== session) return done;
        return part('semaine', api('/v1/usage/matin', key), renderWeek, mine);
      }),
      part('chauds', api('/v1/contacts-chauds', key), renderHot, mine),
      part('rdv', api('/v1/rendez-vous/jour', key), renderAppointments, mine),
    ]).then(function (done) {
      if (mine !== session) return;
      // Une clé refusée en cours de route : rien n'est gardé à l'écran ni sur l'appareil.
      if (done.indexOf(false) !== -1) { wipe(); forgetKey(); refuse('Clé refusée. Vérifiez-la ou demandez-en une nouvelle.'); }
    });
  }
  function wipe() {
    ['plan', 'chauds', 'rdv', 'semaine'].forEach(function (id) { clear($(id)); $(id + '-etat').textContent = ''; });
    wipeFiche();
    wipeM08();
  }
  /* ---------- M08 : l'écran de la visite et l'écran des acquéreurs d'un bien (T08). ---------- */
  function button(text, onClick) {
    var b = el('button', text);
    b.setAttribute('type', 'button');
    b.addEventListener('click', onClick);
    return b;
  }
  function section(title) {
    var box = el('section', null, 'bloc');
    box.appendChild(el('h3', title));
    return box;
  }
  // Un champ toujours relié à son libellé, pour les lecteurs d'écran.
  function field(box, id, label, tag) {
    var l = el('label', label);
    l.setAttribute('for', id);
    var f = el(tag || 'input');
    f.setAttribute('id', id);
    box.appendChild(l);
    box.appendChild(f);
    return f;
  }
  function checkbox(box, id, label) {
    var wrap = el('div', null, 'case');
    var c = el('input');
    c.setAttribute('type', 'checkbox');
    c.setAttribute('id', id);
    var l = el('label', label);
    l.setAttribute('for', id);
    wrap.appendChild(c);
    wrap.appendChild(l);
    box.appendChild(wrap);
    return c;
  }
  function dayLabel(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    try { return d.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', weekday: 'long', day: 'numeric', month: 'long' }); } catch (e) { return ''; }
  }
  // Ce que l'agent lit quand une demande est refusée : la raison, jamais un code interne.
  var REFUSALS = {
    bad_code: 'Code faux : vérifiez-le avec le visiteur.',
    expired: 'Code expiré : envoyez-en un nouveau.',
    blocked: 'Trop d’essais avec ce code : envoyez-en un nouveau.',
    superseded: 'Un nouveau code a été envoyé : saisissez le dernier reçu.',
    bad_identity: 'Ce nom n’est pas celui de la fiche du visiteur.',
    no_identity: 'La fiche du visiteur n’a pas de nom de famille : complétez-la avant la visite.',
    no_code: 'Aucun code envoyé pour cette visite.',
    not_booked: 'Cette visite n’est plus prévue.',
    already_confirmed: 'Cette visite est déjà confirmée.',
    consent_withdrawn: 'Le visiteur a retiré son accord pour les SMS : confirmez son identité de vive voix.',
    send_refused: 'Le SMS n’est pas parti : le contrôle des envois l’a bloqué.',
    buyer_named: 'Le compte rendu nomme le visiteur : retirez son nom avant l’envoi au vendeur.',
    contact: 'Le compte rendu contient une coordonnée : retirez-la avant l’envoi au vendeur.',
    shape: 'Compte rendu incomplet : un avis de 300 caractères au plus, l’intérêt, et des listes courtes.',
    invented_figure: 'Un chiffre n’est pas dans la dictée : retirez-le.',
    invented_offer: 'La dictée ne dit pas que le visiteur veut faire une offre.',
    no_report: 'Écrivez d’abord le compte rendu.',
    no_dictation: 'Dictez d’abord ce que le visiteur a dit.',
    already_validated: 'Ce compte rendu est déjà validé.',
    not_matching: 'Ce bien ne remplit plus la recherche de cet acquéreur.',
    inactive: 'Cette recherche n’est plus active : mettez-la à jour avec l’acquéreur.',
    no_unsubscribe_link: 'Les alertes ne sont pas encore ouvertes pour le réseau.',
    waiting: 'Hors des heures d’envoi : l’alerte attend le prochain créneau permis.',
    no_template: 'Aucun modèle de bon de visite validé dans le réseau.',
  };
  function refusalText(body, fallback) {
    if (body && REFUSALS[body.code]) return REFUSALS[body.code];
    if (body && typeof body.reason === 'string' && body.reason.length < 300) return body.reason;
    return fallback;
  }
  // Une demande à l'API, sous la session en cours : une clé refusée efface tout ; une réponse d'une session finie est ignorée.
  function send(path, method, body) {
    if (!currentKey) return Promise.resolve({ gone: true });
    var mine = session;
    return api(path, currentKey, method, body).then(function (r) {
      return r.json().then(function (b) { return b; }, function () { return null; }).then(function (b) {
        if (mine !== session) return { gone: true };
        if (r.status === 401 || (r.status === 403 && b && b.code === 'agent_inactive')) { forgetKey(); refuse('Clé refusée. Vérifiez-la ou demandez-en une nouvelle.'); return { gone: true }; }
        return { status: r.status, ok: r.ok && !!b && b.ok === true, body: b };
      });
    }, function () { return mine !== session ? { gone: true } : { offline: true }; });
  }
  var visitId = null;
  function openVisit(id) {
    if (!ID.test(id)) return Promise.resolve(false);
    visitId = id;
    clear($('visite-corps'));
    $('visite-titre').textContent = '';
    $('visite-etat').textContent = 'Chargement…';
    show('visite');
    return send('/v1/visites/' + encodeURIComponent(id), 'GET').then(function (res) {
      if (res.gone) return false;
      if (res.offline) { $('visite-etat').textContent = 'Pas de réseau. Réessayez dans un moment.'; return false; }
      if (res.status === 403 || res.status === 404) { $('visite-etat').textContent = 'Cette visite n’est pas dans vos droits.'; return false; }
      if (!res.ok) { $('visite-etat').textContent = 'Indisponible pour le moment. Réessayez plus tard.'; return false; }
      $('visite-etat').textContent = '';
      renderVisit(res.body.data);
      return true;
    });
  }
  // Un geste sur la visite : la réponse est dite, puis l'écran relu pour montrer l'état rangé.
  function act(path, body, fallback) {
    var id = visitId;
    $('visite-etat').textContent = 'Envoi…';
    return send(path, 'POST', body).then(function (res) {
      if (res.gone) return false;
      if (res.offline) { $('visite-etat').textContent = 'Pas de réseau : rien n’est parti. Réessayez dans un moment.'; return false; }
      if (!res.ok) { $('visite-etat').textContent = refusalText(res.body, fallback); return false; }
      return openVisit(id).then(function () { return true; });
    });
  }
  function renderVisit(v) {
    var body = $('visite-corps');
    clear(body);
    var p = v.property || {};
    $('visite-titre').textContent = 'Visite · ' + (p.reference || 'bien') + (p.city ? ', ' + p.city : '');
    body.appendChild(el('p', dayLabel(v.start) + ', ' + hour(v.start) + ' à ' + hour(v.end) + (v.visitor && v.visitor.firstName ? ' · avec ' + v.visitor.firstName : ''), 'doux'));
    if (v.status !== 'booked' && v.status !== 'honored') body.appendChild(el('p', 'Cette visite n’est plus prévue.', 'alerte'));
    body.appendChild(safetyBlock(v));
    body.appendChild(reportBlock(v));
    body.appendChild(slipBlock(v.slip));
    if (typeof p.id === 'string' && ID.test(p.id)) {
      body.appendChild(button('Acquéreurs pour ce bien', function () { openBien(p.id, p.reference || 'ce bien'); }));
    }
  }
  function safetyBlock(v) {
    var box = section('Visite sécurisée');
    var base = '/v1/visites/' + encodeURIComponent(v.appointmentId);
    if (v.safety === 'confirmee') { box.appendChild(el('p', 'Téléphone et identité du visiteur confirmés.', 'fait')); return box; }
    if (v.safety === 'code_envoye') {
      box.appendChild(el('p', 'Le visiteur a reçu un code par SMS. Saisissez-le avec son nom de famille, en face de lui.', 'doux'));
      var code = field(box, 'v-code', 'Code reçu par le visiteur');
      code.setAttribute('inputmode', 'numeric');
      code.setAttribute('autocomplete', 'one-time-code');
      code.setAttribute('maxlength', '6');
      var name = field(box, 'v-nom', 'Nom de famille du visiteur');
      name.setAttribute('autocomplete', 'off');
      box.appendChild(button('Confirmer la visite', function () {
        act(base + '/confirmation', { code: String(code.value).trim(), lastName: String(name.value).trim() }, 'La visite n’est pas confirmée.');
      }));
      box.appendChild(button('Envoyer un nouveau code', function () { act(base + '/code', { consentProof: CONSENT }, 'Le code n’est pas parti.'); }));
      return box;
    }
    box.appendChild(el('p', 'Avant d’ouvrir la porte, le visiteur confirme son téléphone et son identité.', 'doux'));
    var agreed = checkbox(box, 'v-accord', 'Le visiteur accepte de recevoir un code par SMS pour cette visite');
    box.appendChild(button('Envoyer le code au visiteur', function () {
      if (!agreed.checked) { $('visite-etat').textContent = 'Cochez d’abord l’accord du visiteur.'; return; }
      act(base + '/code', { consentProof: CONSENT }, 'Le code n’est pas parti.');
    }));
    return box;
  }
  var CONSENT = 'Accord du visiteur pour recevoir un code par SMS, recueilli par son agent dans l’application avant la visite.';
  var INTEREST = { aucun: 'aucun intérêt', faible: 'intérêt faible', moyen: 'intérêt moyen', fort: 'intérêt fort' };
  var DELIVERY = {
    sent: 'Envoyé au vendeur, sans le nom du visiteur.',
    waiting: 'Validé : il part au vendeur au prochain créneau d’envoi permis.',
    refused: 'Validé, mais le vendeur ne reçoit pas de message : accord retiré ou exclusion. Dites-le-lui de vive voix.',
    failed: 'Validé ; l’envoi a échoué, il sera repris.',
  };
  function reportLines(box, r) {
    box.appendChild(el('p', r.opinion));
    if (r.strengths && r.strengths.length) box.appendChild(el('p', 'Points forts : ' + r.strengths.join(', ')));
    if (r.reservations && r.reservations.length) box.appendChild(el('p', 'Réserves : ' + r.reservations.join(', ')));
    box.appendChild(el('p', (INTEREST[r.interest] || 'intérêt non dit') + (r.readyToOffer ? ' · prêt à faire une offre' : ''), 'doux'));
  }
  function list(text) { return String(text).split(',').map(function (x) { return x.trim(); }).filter(function (x) { return x; }); }
  function reportForm(box, base, draft) {
    var opinion = field(box, 'v-avis', 'Avis du visiteur, en une ou deux phrases', 'textarea');
    opinion.setAttribute('maxlength', '300');
    var strengths = field(box, 'v-forts', 'Points forts, séparés par des virgules');
    var reservations = field(box, 'v-reserves', 'Réserves, séparées par des virgules');
    var interest = field(box, 'v-interet', 'Intérêt du visiteur', 'select');
    ['fort', 'moyen', 'faible', 'aucun'].forEach(function (k) {
      var o = el('option', INTEREST[k]);
      o.setAttribute('value', k);
      interest.appendChild(o);
    });
    var ready = checkbox(box, 'v-offre', 'Le visiteur a dit vouloir faire une offre');
    if (draft) {
      opinion.value = draft.opinion || '';
      strengths.value = (draft.strengths || []).join(', ');
      reservations.value = (draft.reservations || []).join(', ');
      interest.value = INTEREST[draft.interest] ? draft.interest : 'moyen';
      ready.checked = draft.readyToOffer === true;
    } else interest.value = 'moyen';
    box.appendChild(button('Valider et envoyer au vendeur', function () {
      var report = { opinion: String(opinion.value).trim(), strengths: list(strengths.value), reservations: list(reservations.value), interest: interest.value, readyToOffer: ready.checked === true };
      act(base + '/compte-rendu/validation', { report: report }, 'Le compte rendu n’est pas validé.');
    }));
  }
  function reportBlock(v) {
    var box = section('Compte rendu au vendeur');
    var base = '/v1/visites/' + encodeURIComponent(v.appointmentId);
    var r = v.report;
    if (r && r.status === 'valide') {
      if (r.report) reportLines(box, r.report);
      box.appendChild(el('p', DELIVERY[r.delivery] || 'Validé.', r.delivery === 'sent' ? 'fait' : 'doux'));
      return box;
    }
    if (r && r.report) {
      // Le compte rendu rédigé d'après la dictée : un seul geste pour l'envoyer ; corriger reste possible.
      box.appendChild(el('p', 'Rédigé d’après votre dictée. Relisez, puis validez.', 'doux'));
      reportLines(box, r.report);
      box.appendChild(button('Valider et envoyer au vendeur', function () { act(base + '/compte-rendu/validation', {}, 'Le compte rendu n’est pas validé.'); }));
      var fix = el('details');
      fix.appendChild(el('summary', 'Corriger avant d’envoyer'));
      reportForm(fix, base, r.report);
      box.appendChild(fix);
      return box;
    }
    if (r) {
      box.appendChild(el('p', 'Votre dictée est gardée. Le compte rendu n’a pas pu être rédigé pour vous : écrivez-le ici, le nom du visiteur ne doit pas y figurer.', 'doux'));
      reportForm(box, base, null);
    }
    var dictation = field(box, 'v-dictee', r ? 'Dicter de nouveau' : 'Ce que le visiteur a dit', 'textarea');
    dictation.setAttribute('maxlength', '5000');
    box.appendChild(el('p', 'Touchez le micro du clavier et parlez : une phrase ou 30 secondes suffisent.', 'doux'));
    box.appendChild(button('Envoyer la dictée', function () {
      var text = String(dictation.value).trim();
      if (!text) { $('visite-etat').textContent = 'Dictez d’abord ce que le visiteur a dit.'; return; }
      act(base + '/compte-rendu/dictee', { dictation: text }, 'La dictée n’est pas enregistrée.');
    }));
    return box;
  }
  function slipBlock(slip) {
    var box = section('Bon de visite');
    if (!slip) { box.appendChild(el('p', 'Le bon de visite n’est pas prêt.', 'alerte')); return box; }
    var state = slip.signed ? 'signé et rangé' : slip.status === 'complet' ? 'prêt à signer' : 'incomplet : complétez la fiche avant la visite';
    box.appendChild(el('p', 'Bon de visite ' + state + (slip.mode === 'essai' ? ' (modèle d’essai, en attente de validation juridique).' : '.'), slip.signed ? 'fait' : 'doux'));
    return box;
  }
  // L'alerte en un geste : un seul appui, sans confirmation. Le même identifiant sert jusqu'à ce qu'elle soit rangée.
  var alertId = null;
  function newAlertId() {
    var out = 'al-';
    try {
      var buf = new Uint8Array(16);
      crypto.getRandomValues(buf);
      for (var i = 0; i < buf.length; i++) out += (buf[i] < 16 ? '0' : '') + buf[i].toString(16);
      return out;
    } catch (e) {
      return out + Date.now().toString(36) + Math.floor(Math.random() * 1e9).toString(36);
    }
  }
  function raiseAlert() {
    if (!alertId) alertId = newAlertId();
    var box = $('alerte-etat');
    box.hidden = false;
    box.textContent = 'Alerte en cours d’envoi…';
    return send('/v1/visites/alertes/' + alertId, 'POST').then(function (res) {
      if (res.gone) return false;
      if (res.offline || !res.ok) {
        box.textContent = res.offline ? 'Pas de réseau : l’alerte n’est pas partie. Appuyez de nouveau, ou appelez le 112 si vous êtes en danger.' : 'L’alerte n’est pas partie. Appelez le 112 si vous êtes en danger.';
        return false;
      }
      alertId = null;
      box.textContent = res.body.data && res.body.data.notified ? 'Alerte reçue : la direction est prévenue.' : 'Alerte enregistrée : la direction sera prévenue dès que possible. Appelez le 112 si vous êtes en danger.';
      return true;
    });
  }
  var CRITERIA = { kind: 'type de bien', commune: 'commune', budget: 'budget', surface: 'surface', rooms: 'pièces', bedrooms: 'chambres' };
  var MATCH = { match: 'remplit tous les critères', tolerated: 'dans les tolérances écrites' };
  var WA = /^https:\\/\\/wa\\.me\\/[0-9]{6,15}\\?text=[A-Za-z0-9%._~!*'()-]*$/;
  var currentBien = null;
  function openBien(propertyId, reference) {
    if (!ID.test(propertyId)) return Promise.resolve(false);
    currentBien = { id: propertyId, reference: reference };
    clear($('bien-corps'));
    $('bien-titre').textContent = 'Acquéreurs pour ' + reference;
    $('bien-etat').textContent = 'Chargement…';
    show('bien');
    var path = '/v1/acquereurs/biens/' + encodeURIComponent(propertyId);
    return Promise.all([send(path, 'GET'), send(path + '/carte', 'GET')]).then(function (both) {
      var buyers = both[0];
      var map = both[1];
      if (buyers.gone || map.gone) return false;
      if (buyers.offline) { $('bien-etat').textContent = 'Pas de réseau. Réessayez dans un moment.'; return false; }
      if (buyers.status === 403 || buyers.status === 404) { $('bien-etat').textContent = 'Ce bien n’est pas dans vos droits.'; return false; }
      if (buyers.body && buyers.body.rule === 'R42') { $('bien-etat').textContent = 'Ce bien ne peut pas encore être proposé : le mandat n’est pas en vigueur ou le délai de rétractation court.'; return false; }
      if (!buyers.ok) { $('bien-etat').textContent = 'Indisponible pour le moment. Réessayez plus tard.'; return false; }
      $('bien-etat').textContent = '';
      renderBien(propertyId, buyers.body.data, map.ok ? map.body.data : null);
      return true;
    });
  }
  function renderBien(propertyId, buyers, map) {
    var body = $('bien-corps');
    clear(body);
    var demand = section('La demande pour ce bien');
    if (map) {
      demand.appendChild(el('p', map.matching + ' acquéreur(s) sur ' + map.activeBuyers + ' recherche(s) active(s) du réseau.'));
      (map.nearMisses || []).forEach(function (n) { demand.appendChild(el('p', n.count + ' écarté(s) par un seul critère : ' + (CRITERIA[n.criterion] || 'autre critère') + '.', 'doux')); });
    } else demand.appendChild(el('p', 'Carte de la demande indisponible pour le moment.', 'doux'));
    body.appendChild(demand);
    var box = section('Vos acquéreurs proposés, dans l’ordre du rapprochement');
    var ul = el('ol', null, 'liste');
    // L'ordre est celui du socle, jamais retrié ici [R51].
    (Array.isArray(buyers) ? buyers : []).forEach(function (b) {
      var li = el('li', null, 'acquereur');
      li.appendChild(el('strong', b.rank + '. ' + (b.firstName || 'Prénom inconnu') + ' · ' + (MATCH[b.status] || 'proposé')));
      var why = el('ul');
      (b.reasons || []).forEach(function (r) { why.appendChild(el('li', r)); });
      li.appendChild(why);
      var state = el('p', null, 'doux');
      state.setAttribute('role', 'status');
      li.appendChild(state);
      if (ID.test(b.projectId)) li.appendChild(button('Alerte WhatsApp', function () { prepareWhatsApp(propertyId, b.projectId, li, state); }));
      if (ID.test(b.personId)) li.appendChild(ficheButton(b.personId));
      ul.appendChild(li);
    });
    if (ul.children.length === 0) box.appendChild(el('p', 'Aucun de vos acquéreurs ne cherche ce bien pour le moment.', 'etat'));
    box.appendChild(ul);
    body.appendChild(box);
  }
  // Le lien est préparé après le contrôle central ; le message part du téléphone de l'agent, puis l'agent dit qu'il est parti.
  function prepareWhatsApp(propertyId, projectId, li, state) {
    state.textContent = 'Contrôle de l’envoi…';
    return send('/v1/acquereurs/biens/' + encodeURIComponent(propertyId) + '/whatsapp/' + encodeURIComponent(projectId), 'POST').then(function (res) {
      if (res.gone) return false;
      if (res.offline) { state.textContent = 'Pas de réseau : rien n’est préparé.'; return false; }
      if (!res.ok) { state.textContent = refusalText(res.body, 'L’alerte n’est pas permise pour cet acquéreur.'); return false; }
      var d = res.body.data || {};
      if (typeof d.link !== 'string' || !WA.test(d.link) || !ID.test(d.messageId)) { state.textContent = 'Le lien reçu n’est pas un lien WhatsApp : rien n’est ouvert.'; return false; }
      state.textContent = 'Message prêt : ouvrez WhatsApp, envoyez-le, puis revenez le confirmer.';
      var a = el('a', 'Ouvrir WhatsApp', 'appel');
      a.setAttribute('href', d.link);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      li.appendChild(a);
      li.appendChild(button('Message envoyé', function () {
        send('/v1/acquereurs/whatsapp/' + encodeURIComponent(d.messageId) + '/envoye', 'POST').then(function (r) {
          if (r.gone) return;
          state.textContent = r.ok ? 'Envoi noté : ce bien ne lui sera plus proposé.' : r.offline ? 'Pas de réseau : l’envoi n’est pas noté.' : 'L’envoi n’a pas pu être noté.';
        });
      }));
      return true;
    });
  }
  function wipeM08() {
    ['visite-corps', 'bien-corps'].forEach(function (id) { clear($(id)); });
    ['visite-titre', 'visite-etat', 'bien-titre', 'bien-etat', 'alerte-etat'].forEach(function (id) { $(id).textContent = ''; });
    $('alerte-etat').hidden = true;
    visitId = null;
    currentBien = null;
  }
  function wipeFiche() {
    clear($('fiche-corps'));
    $('fiche-nom').textContent = '';
    $('fiche-etat').textContent = '';
  }
  function show(id) {
    ['connexion', 'accueil', 'attente', 'fiche', 'visite', 'bien'].forEach(function (s) { $(s).hidden = s !== id; });
    $('sortir').hidden = id === 'connexion' || id === 'attente';
  }
  function api(path, key, method, body) {
    var headers = { authorization: 'Bearer ' + key };
    var init = { method: method || 'GET', headers: headers, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' };
    if (body !== undefined) { headers['content-type'] = 'application/json'; init.body = JSON.stringify(body); }
    return fetch(path, init);
  }
  function refuse(message) {
    session += 1;
    currentKey = null;
    wipe();
    $('bonjour').textContent = '';
    $('erreur').textContent = message;
    $('erreur').hidden = false;
    show('connexion');
    return false;
  }
  function enter(key) {
    session += 1;
    var mine = session;
    wipe();
    show('attente');
    return api('/v1/moi', key).then(function (r) {
      // Clé refusée : elle est effacée de l'appareil. Une panne ou une erreur du serveur ne l'efface pas.
      if (r.status === 401 || r.status === 403) return { refused: true };
      if (!r.ok) return { refused: false };
      return r.json().then(function (body) { return { body: body }; });
    }).then(function (res) {
      // Une réponse d'une session finie (sortie, autre clé) ne touche plus à rien.
      if (mine !== session) return false;
      var me = res.body && res.body.data;
      if (res.refused || (res.body && (!me || me.role !== 'agent'))) {
        forgetKey();
        return refuse('Clé refusée. Vérifiez-la ou demandez-en une nouvelle.');
      }
      if (!res.body) return refuse('Le service ne répond pas. Réessayez dans un moment.');
      $('bonjour').textContent = me.firstName ? 'Bonjour ' + me.firstName : 'Bonjour';
      $('erreur').hidden = true;
      currentKey = key;
      show('accueil');
      return day(key, mine).then(function () { return true; });
    }, function () {
      if (mine !== session) return false;
      return refuse('Pas de réseau. Réessayez dans un moment.');
    });
  }
  document.addEventListener('DOMContentLoaded', function () {
    $('form-connexion').addEventListener('submit', function (event) {
      event.preventDefault();
      var key = $('cle').value.trim();
      $('cle').value = '';
      if (key.length < 32) { $('erreur').textContent = 'Une clé compte au moins 32 caractères.'; $('erreur').hidden = false; return; }
      $('erreur').hidden = true;
      if (writeKey(key)) enter(key); else { $('erreur').textContent = 'Cet appareil ne peut pas garder la clé.'; $('erreur').hidden = false; }
    });
    $('retour').addEventListener('click', function () {
      if (!currentKey) return;
      session += 1;
      wipeFiche();
      show('accueil');
      day(currentKey, session);
    });
    function home() {
      if (!currentKey) return;
      session += 1;
      wipeFiche();
      wipeM08();
      show('accueil');
      day(currentKey, session);
    }
    $('visite-retour').addEventListener('click', home);
    $('bien-retour').addEventListener('click', function () { if (visitId) openVisit(visitId); else home(); });
    $('alerte').addEventListener('click', raiseAlert);
    $('sortir').addEventListener('click', function () {
      session += 1;
      currentKey = null;
      forgetKey();
      $('bonjour').textContent = '';
      wipe();
      show('connexion');
    });
    var key = readKey();
    if (key) enter(key); else show('connexion');
    var offline = 'Cet appareil ne garde pas l’application : elle ne s’ouvrira qu’avec du réseau.';
    function warn() { $('note').textContent = offline; $('note').hidden = false; }
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/app/sw.js', { scope: '/app/' }).catch(warn); else warn();
  });
})();
`;

/**
 * Le service worker : il garde la coquille pour un démarrage rapide, et laisse tout le reste au réseau, sans jamais
 * le mettre en cache. Une réponse de l'API n'est jamais gardée sur l'appareil.
 */
export const swJs = (cache: string, shell: readonly string[]): string => `'use strict';
var CACHE = ${JSON.stringify(cache)};
var SHELL = ${JSON.stringify(shell)};
self.addEventListener('install', function (event) {
  event.waitUntil(caches.open(CACHE).then(function (cache) { return cache.addAll(SHELL); }));
});
self.addEventListener('activate', function (event) {
  event.waitUntil(caches.keys().then(function (names) {
    return Promise.all(names.filter(function (n) { return n !== CACHE; }).map(function (n) { return caches.delete(n); }));
  }));
});
self.addEventListener('fetch', function (event) {
  var url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || SHELL.indexOf(url.pathname) === -1) return;
  event.respondWith(fetch(event.request).catch(function () { return caches.match(url.pathname); }));
});
`;

export const MANIFEST = JSON.stringify({
  name: 'AIMMO',
  short_name: 'AIMMO',
  lang: 'fr',
  start_url: '/app/',
  scope: '/app/',
  display: 'standalone',
  background_color: '#ffffff',
  theme_color: '#1f3a5f',
  icons: [{ src: '/app/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
});

export const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="14" fill="#1f3a5f"/><path d="M14 32 32 16l18 16v18H38V38H26v12H14z" fill="#ffffff"/></svg>`;

