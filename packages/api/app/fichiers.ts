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
<section class="bloc" aria-labelledby="titre-biens">
<h3 id="titre-biens">Mes biens à mettre en vente</h3>
<p id="biens-etat" class="etat"></p>
<ul id="biens" class="liste"></ul>
</section>
<section class="bloc" aria-labelledby="titre-apres-jour">
<h3 id="titre-apres-jour">Après mes ventes</h3>
<p id="apres-jour-etat" class="etat"></p>
<ul id="apres-jour" class="liste"></ul>
<button id="apres-ouvrir" type="button" class="secondaire">Mes ventes conclues</button>
</section>
<section class="bloc" aria-labelledby="titre-chiffres-accueil">
<h3 id="titre-chiffres-accueil">Mes chiffres</h3>
<p class="etat">Chaque chiffre s’ouvre sur les lignes qui le font : vous pouvez tout recompter.</p>
<button id="chiffres-ouvrir" type="button" class="secondaire">Voir mes chiffres</button>
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
<section id="vente" hidden>
<button id="vente-retour" type="button" class="retour">Retour à ma journée</button>
<h2 id="vente-titre"></h2>
<p id="vente-etat" class="etat" role="status"></p>
<div id="vente-corps"></div>
</section>
<section id="apres" hidden>
<button id="apres-retour" type="button" class="retour">Retour à ma journée</button>
<h2 id="apres-titre">Mes ventes conclues</h2>
<p id="apres-etat" class="etat" role="status"></p>
<div id="apres-corps"></div>
</section>
<section id="chiffres" hidden>
<button id="chiffres-retour" type="button" class="retour">Retour à ma journée</button>
<h2 id="chiffres-titre">Mes chiffres</h2>
<div class="periodes" role="group" aria-label="Période">
<button id="chiffres-mois" type="button" class="secondaire" aria-pressed="true">Ce mois-ci</button>
<button id="chiffres-precedent" type="button" class="secondaire" aria-pressed="false">Mois dernier</button>
<button id="chiffres-annee" type="button" class="secondaire" aria-pressed="false">12 derniers mois</button>
</div>
<p id="chiffres-etat" class="etat" role="status"></p>
<div id="chiffres-corps"></div>
</section>
<section id="reseau" hidden>
<h2 id="reseau-titre">Le réseau</h2>
<div class="periodes" role="group" aria-label="Période">
<button id="reseau-mois" type="button" class="secondaire" aria-pressed="true">Ce mois-ci</button>
<button id="reseau-precedent" type="button" class="secondaire" aria-pressed="false">Mois dernier</button>
<button id="reseau-annee" type="button" class="secondaire" aria-pressed="false">12 derniers mois</button>
</div>
<p id="reseau-etat" class="etat" role="status"></p>
<div id="reseau-corps"></div>
<section class="bloc" aria-labelledby="titre-reseau-alertes">
<h3 id="titre-reseau-alertes">Alertes</h3>
<p id="reseau-alertes-etat" class="etat" role="status"></p>
<ul id="reseau-alertes" class="liste"></ul>
</section>
<section class="bloc" aria-labelledby="titre-reseau-reversements">
<h3 id="titre-reseau-reversements">Reversements à faire</h3>
<p id="reseau-reversements-etat" class="etat" role="status"></p>
<ul id="reseau-reversements" class="liste"></ul>
</section>
<section class="bloc" aria-labelledby="titre-reseau-brouillons">
<h3 id="titre-reseau-brouillons">Factures à valider</h3>
<p class="doux">Mode essai : une facture validée part à la plateforme d’essai, jamais à une vraie plateforme. Elle ne change plus ensuite : un avoir la corrige.</p>
<p id="reseau-brouillons-etat" class="etat" role="status"></p>
<ul id="reseau-brouillons" class="liste"></ul>
</section>
<section class="bloc" aria-labelledby="titre-reseau-export">
<h3 id="titre-reseau-export">Export du jour</h3>
<p class="doux">Les chiffres d’un jour, au format tableur, pour les comparer au comptage manuel.</p>
<label for="reseau-export-jour">Jour</label>
<input id="reseau-export-jour" type="date" required>
<button id="reseau-export" type="button" class="secondaire">Télécharger l’export</button>
<p id="reseau-export-etat" class="etat" role="status"></p>
</section>
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
.secondaire { background: transparent; color: var(--accent); border: 2px solid var(--accent); }
.vente { margin-top: 24px; padding-top: 12px; border-top: 2px solid var(--accent); }
.vente h3 { margin-bottom: 0; }
.client { padding: 12px 0; border-top: 1px solid var(--doux); }
.client h4 { margin-top: 0; }
.brouillon { margin: 8px 0; padding: 8px 12px; border-left: 4px solid var(--accent); white-space: pre-wrap; }
.note { font-size: 1.4rem; font-weight: 700; color: var(--accent); }
.periodes { display: flex; flex-wrap: wrap; gap: 8px; }
.periodes button { margin-top: 0; flex: 1 1 auto; }
.periodes button[aria-pressed="true"] { background: var(--accent); color: var(--fond); }
.chiffre { border-top: 1px solid var(--doux); }
.chiffre summary { justify-content: space-between; gap: 12px; color: var(--texte); }
.chiffre .valeur { font-size: 1.6rem; font-weight: 700; color: var(--accent); font-variant-numeric: tabular-nums; }
.chiffre ul { margin: 0 0 12px; padding-left: 18px; }
.chiffre li { padding: 4px 0; }
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
      // Le prénom n'est pas un droit : la route de la visite contrôle l'accès ; seule une fiche d'un autre agent est écartée ici.
      if (a.kind === 'visite' && a.briefMissing !== 'no_access' && ID.test(a.id)) li.appendChild(button('Ouvrir la visite', function () { openVisit(a.id); }));
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
      part('biens', api('/v1/annonces', key), renderBiens, mine),
      part('rdv', api('/v1/rendez-vous/jour', key), renderAppointments, mine),
      part('apres-jour', api('/v1/apres-vente/journee', key), renderAfterSaleDay, mine),
    ]).then(function (done) {
      if (mine !== session) return;
      // Une clé refusée en cours de route : rien n'est gardé à l'écran ni sur l'appareil.
      if (done.indexOf(false) !== -1) { wipe(); forgetKey(); refuse('Clé refusée. Vérifiez-la ou demandez-en une nouvelle.'); }
    });
  }
  function wipe() {
    ['plan', 'chauds', 'rdv', 'semaine', 'biens', 'apres-jour'].forEach(function (id) { clear($(id)); $(id + '-etat').textContent = ''; });
    wipeFiche();
    wipeM08();
    wipeApres();
    wipeChiffres();
    wipeReseau();
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
      if (res.status === 403) { $('visite-etat').textContent = 'Cette visite n’est pas dans vos droits.'; return false; }
      // Une visite réservée en ligne n'a pas encore de dossier de visite : elle n'est rattachée à aucune recherche d'achat.
      if (res.status === 404) { $('visite-etat').textContent = 'Pas de dossier de visite pour ce rendez-vous : s’il a été réservé en ligne, il n’est pas encore rattaché à la recherche d’un acquéreur.'; return false; }
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
    $('visite-titre').textContent = v.property ? 'Visite · ' + (p.reference || 'bien') + (p.city ? ', ' + p.city : '') : 'Visite';
    if (!v.property) body.appendChild(el('p', 'Le bien n’est plus dans vos droits : ni sa référence ni ses acquéreurs ne sont montrés.', 'doux'));
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
  function raiseAlert(retried) {
    if (!alertId) alertId = newAlertId();
    var box = $('alerte-etat');
    box.hidden = false;
    box.textContent = 'Alerte en cours d’envoi…';
    return send('/v1/visites/alertes/' + alertId, 'POST').then(function (res) {
      if (res.gone) return false;
      // Un identifiant déjà rangé au nom d'un autre (même téléphone, autre agent) : un nouvel identifiant, une fois.
      if (res.status === 403 && retried !== true) { alertId = null; return raiseAlert(true); }
      if (res.offline || !res.ok) {
        box.textContent = res.offline ? 'Pas de réseau : l’alerte n’est pas partie. Appuyez de nouveau, ou appelez le 112 si vous êtes en danger.' : 'L’alerte n’est pas partie. Appelez le 112 si vous êtes en danger.';
        return false;
      }
      alertId = null;
      var data = res.body.data || {};
      // En mode essai, rien ne part à la direction : l'agent le lit, avec le numéro d'urgence.
      box.textContent = data.trial !== false
        ? 'Mode essai : l’alerte est enregistrée, mais la direction n’est pas encore prévenue par message. Appelez le 112 si vous êtes en danger.'
        : data.notified ? 'Alerte reçue : la direction est prévenue. Appelez le 112 si vous êtes en danger.' : 'Alerte enregistrée : la direction sera prévenue dès que possible. Appelez le 112 si vous êtes en danger.';
      return true;
    });
  }
  var CRITERIA = { kind: 'type de bien', commune: 'commune', budget: 'budget', surface: 'surface', rooms: 'pièces', bedrooms: 'chambres' };
  var MATCH = { match: 'remplit tous les critères', tolerated: 'dans les tolérances écrites' };
  var WA = /^https:\\/\\/wa\\.me\\/[0-9]{6,15}\\?text=[A-Za-z0-9%._~!*'()-]*$/;
  var currentBien = null;
  var LINK_TTL_MS = 120000;
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
      state.textContent = 'Message prêt : ouvrez WhatsApp maintenant, envoyez-le, puis revenez le confirmer.';
      // Le lien ne sert qu'une fois, tout de suite : le contrôle central a été fait pour cet instant [R01, R49].
      var a = el('a', 'Ouvrir WhatsApp', 'appel');
      a.setAttribute('href', d.link);
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
      var live = true;
      function drop() { if (live) { live = false; li.removeChild(a); } }
      a.addEventListener('click', function () { setTimeout(drop, 0); });
      if (typeof setTimeout === 'function') setTimeout(function () { if (live) { drop(); state.textContent = 'Lien expiré sans être ouvert : préparez de nouveau l’alerte si besoin.'; } }, LINK_TTL_MS);
      li.appendChild(a);
      var done = button('Message envoyé', function () {
        drop();
        send('/v1/acquereurs/whatsapp/' + encodeURIComponent(d.messageId) + '/envoye', 'POST').then(function (r) {
          if (r.gone) return;
          if (r.ok) li.removeChild(done);
          state.textContent = r.ok ? 'Envoi noté : ce bien ne lui sera plus proposé.' : r.offline ? 'Pas de réseau : l’envoi n’est pas noté.' : 'L’envoi n’a pas pu être noté.';
        });
      });
      li.appendChild(done);
      return true;
    });
  }
  /* ---------- M07 : l'écran « Mettre en vente » (P10). ---------- */
  var LISTING_STATES = { en_vente: 'en vente', sous_offre: 'sous offre', vendu: 'vendu', retiree: 'retirée de la vente' };
  function renderBiens(list, data) {
    var items = Array.isArray(data) ? data : [];
    items.forEach(function (b) {
      if (!ID.test(b.id)) return;
      var li = el('li');
      li.appendChild(el('strong', b.reference + (b.city ? ' · ' + b.city : '')));
      li.appendChild(el('p', b.state ? 'Annonce ' + (LISTING_STATES[b.state] || 'publiée') + '.' : 'Pas encore publiée.', 'doux'));
      li.appendChild(button(b.state ? 'Voir l’annonce' : 'Mettre en vente', function () { openVente(b.id, b.reference); }));
      list.appendChild(li);
    });
    return items.length === 0 ? 'Aucun bien à mettre en vente.' : null;
  }
  var MENTIONS = { prix: 'Prix et honoraires', energie: 'Performance énergétique', copropriete: 'Copropriété', risques: 'Risques du terrain', carte: 'Carte professionnelle' };
  var MISSING_MENTION = {
    pas_de_mandat: 'aucun mandat signé', prix_inconnu: 'prix du mandat inconnu', honoraires_inconnus: 'honoraires inconnus', pas_de_diagnostic: 'diagnostic énergétique absent',
    copropriete_inconnue: 'copropriété non renseignée', risques_inconnus: 'état des risques absent', carte_inconnue: 'numéro de carte du réseau non réglé', type_de_bien_non_pris_en_charge: 'type de bien pas encore pris en charge',
  };
  var FIELDS = {
    kind: 'type de bien', city: 'commune', postalCode: 'code postal', surfaceM2: 'surface', rooms: 'pièces', bedrooms: 'chambres', floor: 'étage', floorsTotal: 'étages de l’immeuble', buildYear: 'année de construction',
    heating: 'chauffage', outdoor: 'extérieur', landM2: 'terrain', parkingSpaces: 'stationnement', elevator: 'ascenseur', energyClass: 'classe énergie', climateClass: 'classe climat',
  };
  var SENTENCE_PROBLEMS = { nombre_sans_source: 'nombre absent de la fiche', fait_sans_source: 'fait absent de la fiche', adresse: 'situe le bien trop précisément', critere_discriminant: 'critère discriminant', mot_interdit: 'mot interdit' };
  var CHANNEL_NAMES = { site: 'site', reseaux: 'réseaux sociaux', google: 'fiche Google', portails: 'portails' };
  var PUSH = { publiee: 'publiée', en_attente: 'en attente', echec: 'en échec, reprise au passage suivant' };
  var LISTING_REFUSALS = {
    not_latest_draft: 'Une version plus récente existe : validez la dernière.',
    stale_sheet: 'La fiche du bien a changé depuis ce brouillon : rédigez de nouveau.',
    already_validated: 'Cette annonce est déjà validée.',
    mentions_incomplete: 'Il manque des mentions obligatoires : complétez la fiche du bien.',
    refused_text: 'Une phrase n’est pas reliée à la fiche : corrigez-la.',
    busy: 'Une rédaction est déjà en cours : patientez un instant.',
  };
  var currentVente = null;
  function price(n) { try { return Number(n).toLocaleString('fr-FR') + ' €'; } catch (e) { return String(n) + ' €'; } }
  function openVente(propertyId, reference) {
    if (!ID.test(propertyId)) return Promise.resolve(false);
    currentVente = { id: propertyId, reference: reference };
    clear($('vente-corps'));
    $('vente-titre').textContent = 'Mettre en vente · ' + reference;
    $('vente-etat').textContent = 'Chargement…';
    show('vente');
    var base = '/v1/annonces/' + encodeURIComponent(propertyId);
    return Promise.all([send(base + '/controle', 'GET'), send(base + '/brouillon', 'GET'), send(base + '/publication', 'GET')]).then(function (all) {
      if (all[0].gone || all[1].gone || all[2].gone) return false;
      if (all[0].offline) { $('vente-etat').textContent = 'Pas de réseau. Réessayez dans un moment.'; return false; }
      if (all[0].status === 403 || all[0].status === 404) { $('vente-etat').textContent = 'Ce bien n’est pas dans vos droits.'; return false; }
      if (!all[0].ok) { $('vente-etat').textContent = 'Indisponible pour le moment. Réessayez plus tard.'; return false; }
      $('vente-etat').textContent = '';
      // Seul « aucune annonce » est un état vide ; une lecture en échec est dite comme telle, sans geste proposé.
      var draft = all[1].ok ? all[1].body.data : all[1].status === 404 && all[1].body && all[1].body.code === 'no_draft' ? null : undefined;
      var status = all[2].ok ? all[2].body.data : undefined;
      renderVente(propertyId, all[0].body.data, draft, status);
      return true;
    });
  }
  function venteAct(path, fallback) {
    var v = currentVente;
    $('vente-etat').textContent = 'Envoi…';
    return send(path, 'POST').then(function (res) {
      if (res.gone) return false;
      if (res.offline) { $('vente-etat').textContent = 'Pas de réseau : rien n’est fait.'; return false; }
      if (!res.ok) { $('vente-etat').textContent = (res.body && LISTING_REFUSALS[res.body.code]) || fallback; return false; }
      return openVente(v.id, v.reference).then(function () { return true; });
    });
  }
  function renderVente(propertyId, checklist, draft, status) {
    var body = $('vente-corps');
    clear(body);
    var check = section('Mentions obligatoires');
    check.appendChild(el('p', checklist.complete ? 'Toutes les mentions sont là.' + (checklist.publishedPriceEur ? ' Prix publié partout : ' + price(checklist.publishedPriceEur) + '.' : '') : 'Il manque des mentions : l’annonce ne peut pas partir.', checklist.complete ? 'fait' : 'alerte'));
    var ul = el('ul', null, 'liste');
    (checklist.items || []).forEach(function (m) {
      var name = MENTIONS[m.id] || 'Autre mention';
      ul.appendChild(el('li', m.status === 'presente' ? name + ' : présente' : m.status === 'sans_objet' ? name + ' : sans objet' : name + ' : manque, ' + (MISSING_MENTION[m.reason] || 'à compléter'), m.status === 'manquante' ? 'retard' : null));
    });
    check.appendChild(ul);
    body.appendChild(check);
    var text = section('L’annonce, phrase par phrase');
    var base = '/v1/annonces/' + encodeURIComponent(propertyId);
    if (draft === undefined) {
      text.appendChild(el('p', 'L’annonce n’a pas pu être lue. Réessayez dans un moment.', 'alerte'));
      body.appendChild(text);
    } else if (!draft) {
      text.appendChild(el('p', 'Aucune annonce rédigée pour ce bien.', 'doux'));
      text.appendChild(button('Rédiger l’annonce', function () { venteAct(base + '/brouillon', 'L’annonce n’a pas pu être rédigée.'); }));
      body.appendChild(text);
    } else {
      text.appendChild(el('h4', draft.title));
      var ol = el('ol', null, 'liste');
      // Chaque phrase avec les champs de la fiche d'où viennent ses nombres et ses faits.
      (draft.sentences || []).forEach(function (sentence) {
        var li = el('li', sentence.text);
        (sentence.sources || []).forEach(function (src) { li.appendChild(el('p', src.value + ' : ' + (FIELDS[src.field] || 'champ de la fiche') + ', lu dans la fiche du bien', 'doux')); });
        (sentence.problems || []).forEach(function (pb) { li.appendChild(el('p', 'À corriger : ' + (SENTENCE_PROBLEMS[pb.code] || 'phrase refusée') + ' (« ' + pb.value + ' »)', 'retard')); });
        ol.appendChild(li);
      });
      text.appendChild(ol);
      if (draft.validated) text.appendChild(el('p', 'Annonce validée le ' + date(draft.validated.at) + '.', 'fait'));
      else if (ID.test(draft.id)) text.appendChild(button('Valider l’annonce', function () { venteAct('/v1/annonces/brouillons/' + encodeURIComponent(draft.id) + '/validation', 'L’annonce n’est pas validée.'); }));
      text.appendChild(button('Rédiger de nouveau', function () { venteAct(base + '/brouillon', 'L’annonce n’a pas pu être rédigée.'); }));
      body.appendChild(text);
    }
    var pub = section('Publication');
    if (status === undefined) pub.appendChild(el('p', 'L’état de la publication n’a pas pu être lu. Réessayez dans un moment.', 'alerte'));
    else if (!status) pub.appendChild(el('p', 'Pas encore publiée : elle part d’elle-même au passage suivant, une fois l’annonce validée et le délai de rétractation fini.', 'doux'));
    else {
      pub.appendChild(el('p', 'Version ' + status.version + ', ' + (LISTING_STATES[status.state] || 'publiée') + (status.priceEur ? ', au prix de ' + price(status.priceEur) : '') + '.'));
      var ch = el('ul', null, 'liste');
      Object.keys(CHANNEL_NAMES).forEach(function (c) { if (status.channels && status.channels[c]) ch.appendChild(el('li', CHANNEL_NAMES[c] + ' : ' + (PUSH[status.channels[c]] || 'inconnu'))); });
      pub.appendChild(ch);
    }
    body.appendChild(pub);
  }
  /* ---------- M11 : après la vente (F07). ---------- */
  var SIDES = { vendeur: 'Vendeur', acquereur: 'Acquéreur' };
  var AFTER_TASKS = { lien_avis: 'Réglez le lien de votre fiche Google : sans lui, aucune demande d’avis ne part.', avis_non_parti: 'La demande d’avis n’a pas pu partir à temps : demandez l’avis vous-même.' };
  var REVIEW = { sent: 'partie (mode essai)', waiting: 'attend le prochain créneau permis', refused: 'bloquée par le contrôle des envois', failed: 'en échec, sera retentée', closed: 'non partie dans le délai' };
  var THANKS = { sent: 'message parti (mode essai)', waiting: 'message validé, attend le prochain créneau permis', sending: 'message en cours d’envoi', refused: 'message bloqué par le contrôle des envois', failed: 'message en échec, sera retenté', closed: 'message non parti dans le délai' };
  var REMINDER = { sent: 'partie (mode essai)', waiting: 'attend le prochain créneau permis', refused: 'bloquée par le contrôle des envois', failed: 'en échec, sera retentée', closed: 'non partie' };
  function sideName(side, firstName) { return (SIDES[side] || 'Client') + (firstName ? ' · ' + firstName : ''); }
  // « Ma journée » : les appels pour remercier, les proches recommandés, les tâches ouvertes ; rien n'y est retrié.
  function renderAfterSaleDay(list, data) {
    if (!data) return 'Indisponible pour le moment. Réessayez plus tard.';
    (data.remercier || []).forEach(function (t) {
      var li = el('li', 'Appeler pour remercier : ' + sideName(t.side, t.firstName));
      if (t.reference) li.appendChild(el('p', 'Bien ' + t.reference, 'doux'));
      list.appendChild(li);
    });
    (data.recommandations || []).forEach(function (c) {
      var li = el('li', 'Appeler ' + (c.firstName || 'le proche recommandé') + ', recommandé par un client');
      li.appendChild(el('p', 'À appeler avant ' + hour(c.dueAt) + ', ' + dayLabel(c.dueAt), 'doux'));
      if (ID.test(c.referralId)) {
        var b = button('Appel fait', function () { referralDone(c.referralId, li, b); });
        li.appendChild(b);
      }
      list.appendChild(li);
    });
    (data.taches || []).forEach(function (t) {
      var li = el('li', AFTER_TASKS[t.kind] || 'Tâche après la vente');
      if (t.reference) li.appendChild(el('p', 'Bien ' + t.reference, 'doux'));
      list.appendChild(li);
    });
    return list.firstChild ? null : 'Rien à faire après vos ventes aujourd’hui.';
  }
  function referralDone(id, li, b) {
    b.disabled = true;
    return send('/v1/apres-vente/appels/' + encodeURIComponent(id) + '/fait', 'POST').then(function (res) {
      if (res.gone) return;
      if (!res.ok) { b.disabled = false; $('apres-jour-etat').textContent = res.offline ? 'Pas de réseau : l’appel n’est pas marqué.' : 'L’appel n’est pas marqué.'; return; }
      li.removeChild(b);
      li.appendChild(el('p', 'Appel fait', 'fait'));
    });
  }
  function wipeApres() {
    clear($('apres-corps'));
    $('apres-etat').textContent = '';
  }
  function openApres() {
    if (!currentKey) return Promise.resolve(false);
    session += 1;
    wipeApres();
    show('apres');
    $('apres-etat').textContent = 'Chargement…';
    return send('/v1/apres-vente/dossiers', 'GET').then(function (res) {
      if (res.gone) return false;
      if (!res.ok) { $('apres-etat').textContent = res.offline ? 'Pas de réseau. Réessayez dans un moment.' : 'Indisponible pour le moment. Réessayez plus tard.'; return false; }
      renderApres(Array.isArray(res.body.data) ? res.body.data : []);
      return true;
    });
  }
  function apresAct(path, body, fallback) {
    $('apres-etat').textContent = 'Envoi…';
    return send(path, 'POST', body).then(function (res) {
      if (res.gone) return false;
      if (!res.ok) { $('apres-etat').textContent = res.offline ? 'Pas de réseau : rien n’est enregistré.' : refusalText(res.body, fallback); return false; }
      return openApres().then(function () { $('apres-etat').textContent = 'Enregistré.'; return true; });
    });
  }
  function reviewLinkBlock(body) {
    var box = section('Le lien de ma fiche Google');
    box.appendChild(el('p', 'Les demandes d’avis portent ce lien. AIMMO ne publie jamais d’avis à la place d’un client.', 'doux'));
    var f = field(box, 'lien-avis', 'Adresse de votre fiche Google (https://…)');
    f.setAttribute('type', 'url');
    f.setAttribute('inputmode', 'url');
    f.setAttribute('autocomplete', 'off');
    box.appendChild(button('Enregistrer le lien', function () {
      var url = String(f.value || '').trim();
      if (!url) { $('apres-etat').textContent = 'Saisissez d’abord l’adresse.'; return; }
      apresAct('/v1/apres-vente/lien-avis', { url: url }, 'Ce lien n’est pas celui d’une fiche Google.');
    }));
    body.appendChild(box);
  }
  function clientBlock(file, c) {
    var box = el('div', null, 'client');
    box.appendChild(el('h4', sideName(c.side, c.firstName)));
    var base = '/v1/apres-vente/dossiers/' + encodeURIComponent(file.fileId) + '/clients/' + encodeURIComponent(c.personId);
    var ids = ID.test(file.fileId) && ID.test(c.personId);
    var t = c.thankYou;
    if (t) {
      box.appendChild(el('p', t.calledAt ? 'Appelé pour le remercier le ' + date(t.calledAt) + '.' : 'À appeler pour le remercier.', t.calledAt ? 'fait' : null));
      if (!t.calledAt && ids) box.appendChild(button('Appel fait', function () { apresAct(base + '/appele', undefined, 'L’appel n’est pas marqué.'); }));
      box.appendChild(el('p', 'Message préparé, à valider ou non :', 'doux'));
      box.appendChild(el('p', t.draft, 'brouillon'));
      if (t.decision === null && ids) {
        box.appendChild(button('Envoyer ce message', function () { apresAct(base + '/remerciement', { decision: 'send' }, 'Le message n’est pas validé.'); }));
        box.appendChild(button('Ne pas l’envoyer', function () { apresAct(base + '/remerciement', { decision: 'decline' }, 'Le choix n’est pas enregistré.'); }));
      } else if (t.decision === 'decline') {
        box.appendChild(el('p', 'Vous avez choisi de ne pas l’envoyer.', 'doux'));
      } else if (t.decision === 'send') {
        box.appendChild(el('p', THANKS[t.sendStatus] || 'message validé', 'doux'));
      }
    }
    box.appendChild(el('p', 'Demande d’avis : ' + (c.review ? (REVIEW[c.review.status] || 'état inconnu') : 'pas encore préparée')));
    (c.reminders || []).forEach(function (r) { box.appendChild(el('p', 'Nouvelles à ' + r.year + ' an' + (r.year > 1 ? 's' : '') + ' : ' + (REMINDER[r.status] || 'état inconnu'), 'doux')); });
    if (c.satisfaction) {
      var n = el('p', null);
      n.appendChild(el('span', c.satisfaction.score + ' sur 5', 'note'));
      box.appendChild(el('p', 'Sa note, reçue le ' + date(c.satisfaction.answeredAt) + ' :', 'doux'));
      box.appendChild(n);
      if (c.satisfaction.comment) box.appendChild(el('p', c.satisfaction.comment, 'brouillon'));
    }
    return box;
  }
  function renderApres(files) {
    var body = $('apres-corps');
    clear(body);
    $('apres-etat').textContent = files.length ? '' : 'Aucune vente conclue pour le moment.';
    files.forEach(function (f) {
      var box = el('section', null, 'vente');
      box.appendChild(el('h3', 'Bien ' + (f.reference || 'sans référence') + (f.city ? ', ' + f.city : '')));
      if (f.closedOn) box.appendChild(el('p', 'Acte signé le ' + dayLabel(f.closedOn + 'T12:00:00Z'), 'doux'));
      (f.clients || []).forEach(function (c) { box.appendChild(clientBlock(f, c)); });
      body.appendChild(box);
    });
    reviewLinkBlock(body);
  }
  /* ---------- M13 : mes chiffres (K08). Chaque chiffre s'ouvre sur ses lignes ; rien n'est comparé à un autre agent. ---------- */
  var APPOINTMENT_KINDS = { estimation: 'Rendez-vous d’estimation', visite: 'Visite', signature: 'Signature', appel: 'Appel' };
  var FEE_STATUS = { prevue: 'prévue, compromis signé', due: 'due, acte signé', facturee: 'facturée, en attente du versement' };
  var chiffresRange = 'mois';
  function parisToday() {
    try { return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }); } catch (e) { return new Date().toISOString().slice(0, 10); }
  }
  function shiftDay(day, n) { return new Date(Date.parse(day + 'T12:00:00Z') + n * 86400000).toISOString().slice(0, 10); }
  function periodOf(range) {
    var today = parisToday();
    var first = today.slice(0, 8) + '01';
    if (range === 'precedent') { var last = shiftDay(first, -1); return { from: last.slice(0, 8) + '01', to: last }; }
    if (range === 'annee') return { from: shiftDay(today, -364), to: today };
    return { from: first, to: today };
  }
  function euros(cents) {
    var n = Number(cents) / 100;
    try { return n.toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).replace(/[\u202f\u00a0]/g, ' ') + ' €'; } catch (e) { return n.toFixed(2) + ' €'; }
  }
  function figure(body, label, value, lines, line) {
    var d = el('details', null, 'chiffre');
    var s = el('summary');
    s.appendChild(el('span', label));
    s.appendChild(el('span', value, 'valeur'));
    d.appendChild(s);
    var list = el('ul');
    (lines || []).forEach(function (l) { list.appendChild(line(l)); });
    if (!list.firstChild) d.appendChild(el('p', 'Aucune ligne sur la période.', 'doux'));
    else d.appendChild(list);
    body.appendChild(d);
  }
  function plural(n, one, many) { return n > 1 ? many : one; }
  function renderChiffres(data) {
    var body = $('chiffres-corps');
    clear(body);
    var c = data.contacts || { value: 0, lines: [] };
    figure(body, plural(c.value, 'Contact reçu', 'Contacts reçus'), c.value, c.lines, function (l) {
      var li = el('li', 'Reçu le ' + date(l.at));
      if (ID.test(l.personId)) li.appendChild(ficheButton(l.personId));
      return li;
    });
    var a = data.appointments || { value: 0, lines: [] };
    figure(body, plural(a.value, 'Rendez-vous tenu', 'Rendez-vous tenus'), a.value, a.lines, function (l) { return el('li', (APPOINTMENT_KINDS[l.kind] || 'Rendez-vous') + ', le ' + date(l.at)); });
    var m = data.mandates || { value: 0, lines: [] };
    figure(body, plural(m.value, 'Mandat signé', 'Mandats signés'), m.value, m.lines, function (l) { return el('li', 'Signé le ' + date(l.at)); });
    var v = data.sales || { value: 0, lines: [] };
    figure(body, plural(v.value, 'Vente', 'Ventes'), v.value, v.lines, function (l) { return el('li', 'Acte signé le ' + date(l.signedOn + 'T12:00:00Z')); });
    var f = data.upcomingFees || { value: 0, lines: [] };
    figure(body, 'Honoraires à venir', euros(f.value), f.lines, function (l) { return el('li', euros(l.amountCents) + ' · ' + (FEE_STATUS[l.status] || 'en cours')); });
    body.appendChild(el('p', 'Les honoraires à venir sont vos parts pas encore versées, quelle que soit la période. Ces chiffres sont calculés depuis vos dossiers, jamais saisis ni estimés.', 'doux'));
  }
  function wipeChiffres() {
    clear($('chiffres-corps'));
    $('chiffres-etat').textContent = '';
  }
  function openChiffres(range) {
    if (!currentKey) return Promise.resolve(false);
    chiffresRange = range || chiffresRange;
    session += 1;
    wipeChiffres();
    show('chiffres');
    ['mois', 'precedent', 'annee'].forEach(function (r) { $('chiffres-' + r).setAttribute('aria-pressed', r === chiffresRange ? 'true' : 'false'); });
    var p = periodOf(chiffresRange);
    $('chiffres-etat').textContent = 'Chargement…';
    return send('/v1/pilotage/mes-chiffres?du=' + p.from + '&au=' + p.to, 'GET').then(function (res) {
      if (res.gone) return false;
      if (!res.ok) { $('chiffres-etat').textContent = res.offline ? 'Pas de réseau. Réessayez dans un moment.' : 'Indisponible pour le moment. Réessayez plus tard.'; return false; }
      $('chiffres-etat').textContent = 'Du ' + date(p.from + 'T12:00:00Z') + ' au ' + date(p.to + 'T12:00:00Z') + '.';
      renderChiffres(res.body.data || {});
      return true;
    });
  }
  /* ---------- M13 : l'écran « Le réseau » de la direction (K09). Les agents dans l'ordre de leur identifiant, jamais classés [R14] ; chaque total montre ses lignes et dit s'il leur est égal [R69]. ---------- */
  var COUNTERS = [
    { key: 'contacts', one: 'Contact reçu', many: 'Contacts reçus' },
    { key: 'appointments', one: 'Rendez-vous tenu', many: 'Rendez-vous tenus' },
    { key: 'mandates', one: 'Mandat signé', many: 'Mandats signés' },
    { key: 'sales', one: 'Vente', many: 'Ventes' },
  ];
  var MANDATE_SOURCES = { site: 'site', online_valuation: 'estimation en ligne', value_tracking: 'suivi de la valeur', referral: 'recommandation', social: 'réseaux sociaux', portal: 'portail', agent_network: 'réseau de l’agent', neighbourhood_letter: 'lettre de quartier', other: 'autre origine' };
  var INDICATORS = { contacts: 'les contacts reçus', appointments: 'les rendez-vous tenus', mandates: 'les mandats signés', sales: 'les ventes' };
  var PIECES = { contrat_agent_commercial: 'contrat d’agent commercial', attestation_habilitation: 'attestation d’habilitation', immatriculation_rsac: 'immatriculation au RSAC', assurance_rcp: 'assurance de responsabilité civile professionnelle', attestation_vigilance: 'attestation de vigilance' };
  var reseauRange = 'mois';
  function agentName(id) { return id ? 'Agent ' + id : 'Direction, sans agent'; }
  function count(n) { var x = Number(n); return isFinite(x) ? x : 0; }
  function percent(bp) { return (count(bp) / 100).toLocaleString('fr-FR') + ' %'; }
  function issuerName(issuer) { return issuer === 'reseau' ? 'le réseau' : /^agent:/.test(String(issuer)) ? 'l’agent ' + String(issuer).slice(6) : 'émetteur inconnu'; }
  /** Un total et ses lignes : le total est celui de la base, la somme est refaite ici, un écart est dit, jamais caché. */
  function totalWithLines(body, label, total, lines) {
    var d = el('details', null, 'chiffre');
    var s = el('summary');
    s.appendChild(el('span', label));
    s.appendChild(el('span', total, 'valeur'));
    d.appendChild(s);
    var list = el('ul');
    var sum = 0;
    lines.forEach(function (l) { sum += count(l.value); list.appendChild(el('li', l.label + ' : ' + l.value)); });
    if (list.firstChild) d.appendChild(list); else d.appendChild(el('p', 'Aucune ligne sur la période.', 'doux'));
    d.appendChild(sum === count(total) ? el('p', 'Total égal à la somme des lignes.', 'doux') : el('p', 'Écart : la somme des lignes fait ' + sum + '. À signaler.', 'retard'));
    body.appendChild(d);
  }
  function renderReseau(data) {
    var body = $('reseau-corps');
    clear(body);
    var totals = data.totals || {};
    var agents = Array.isArray(data.byAgent) ? data.byAgent : [];
    var zones = Array.isArray(data.byZone) ? data.byZone : [];
    var h = el('h3', 'Par agent');
    body.appendChild(h);
    COUNTERS.forEach(function (c) {
      var n = count(totals[c.key]);
      totalWithLines(body, plural(n, c.one, c.many), n, agents.map(function (a) { return { label: agentName(a.agentId), value: count(a[c.key]) }; }));
    });
    body.appendChild(el('p', 'Les agents sont listés dans l’ordre de leur identifiant, sans rang ni note.', 'doux'));
    body.appendChild(el('h3', 'Par commune'));
    COUNTERS.forEach(function (c) {
      var n = count(totals[c.key]);
      totalWithLines(body, plural(n, c.one, c.many), n, zones.map(function (z) { return { label: z.zone ? String(z.zone) : 'Sans commune', value: count(z[c.key]) }; }));
    });
    var src = data.bySource || {};
    body.appendChild(el('h3', 'Par origine'));
    totalWithLines(body, plural(count(totals.contacts), 'Contact reçu', 'Contacts reçus'), count(totals.contacts), (src.contacts || []).map(function (x) { return { label: channel(x.channel), value: count(x.count) }; }));
    totalWithLines(body, plural(count(totals.mandates), 'Mandat signé', 'Mandats signés'), count(totals.mandates), (src.mandates || []).map(function (x) { return { label: MANDATE_SOURCES[x.source] || 'autre origine', value: count(x.count) }; }));
    var ai = data.aiCosts || {};
    body.appendChild(el('h3', 'Coûts de l’IA'));
    var d = el('details', null, 'chiffre');
    var s = el('summary');
    s.appendChild(el('span', 'Sur la période'));
    s.appendChild(el('span', euros(ai.totalCents || 0), 'valeur'));
    d.appendChild(s);
    var list = el('ul');
    var sum = 0;
    (ai.byChannel || []).forEach(function (x) { sum += count(x.cents); list.appendChild(el('li', channel(x.channel) + ' : ' + euros(x.cents))); });
    if (list.firstChild) d.appendChild(list); else d.appendChild(el('p', 'Aucun texte écrit par l’IA sur la période.', 'doux'));
    d.appendChild(sum === count(ai.totalCents) ? el('p', 'Total égal à la somme des lignes.', 'doux') : el('p', 'Écart : la somme des lignes fait ' + euros(sum) + '. À signaler.', 'retard'));
    body.appendChild(d);
    body.appendChild(el('p', ai.perSignedMandateCents === null || ai.perSignedMandateCents === undefined ? 'Aucun mandat signé sur la période : pas de coût par mandat.' : 'Par mandat signé : ' + euros(ai.perSignedMandateCents) + '.', 'doux'));
  }
  function alertText(a) {
    var x = a.data || {};
    if (a.kind === 'budget_ia') return 'Le coût de l’IA du mois atteint ' + percent(x.thresholdBp) + ' du budget réglé.';
    if (a.kind === 'baisse_indicateur') return 'Baisse sur ' + (INDICATORS[x.indicator] || 'un indicateur') + ' : ' + count(x.last7) + ' sur les 7 derniers jours, contre ' + count(x.previous28) + ' sur les 28 précédents.';
    if (a.kind === 'document_agent') return 'Pièce à renouveler pour l’agent ' + (x.agentId || '') + ' : ' + (PIECES[x.document] || 'une pièce de son dossier') + ', valable jusqu’au ' + date(x.validUntil + 'T12:00:00Z') + '.';
    return 'Alerte de pilotage.';
  }
  function renderAlertes(items) {
    var list = $('reseau-alertes');
    clear(list);
    $('reseau-alertes-etat').textContent = items.length ? '' : 'Aucune alerte.';
    items.forEach(function (a) {
      var li = el('li', alertText(a));
      li.appendChild(el('p', 'Le ' + date(a.createdAt) + ' à ' + hour(a.createdAt), 'doux'));
      list.appendChild(li);
    });
  }
  function renderReversements(items) {
    var list = $('reseau-reversements');
    clear(list);
    $('reseau-reversements-etat').textContent = items.length ? '' : 'Aucun reversement à faire.';
    items.forEach(function (t) {
      var late = (t.alerts || []).indexOf('echeance_depassee') !== -1;
      var li = el('li', 'Dossier ' + t.fileId + ' : à verser avant le ' + date(t.payoutDueAt) + ' à ' + hour(t.payoutDueAt));
      li.appendChild(el('p', 'Honoraires encaissés le ' + date(t.receivedAt) + '.', 'doux'));
      if (late) li.appendChild(el('p', 'Échéance dépassée.', 'retard'));
      list.appendChild(li);
    });
  }
  var DRAFT_PROBLEMS = { already: 'Cette facture est déjà émise.', sale_cancelled: 'La vente est annulée par un avoir : plus aucune facture ne s’émet.', busy: 'Une autre validation est en cours. Réessayez dans un moment.', unknown: 'Cette facture n’existe plus.' };
  function renderBrouillons(items, mine) {
    var list = $('reseau-brouillons');
    clear(list);
    $('reseau-brouillons-etat').textContent = items.length ? '' : 'Aucune facture à valider.';
    items.forEach(function (f) {
      var li = el('li', (f.kind === 'honoraires' ? 'Honoraires' : 'Reversement') + ' émis par ' + issuerName(f.issuer) + ' : ' + euros(f.amountCents) + ' toutes taxes, TVA ' + percent(f.vatBp));
      li.appendChild(el('p', 'Dossier ' + f.fileId + ', préparée le ' + date(f.createdAt) + '.', 'doux'));
      var state = el('p', '', 'etat');
      state.setAttribute('role', 'status');
      if (ID.test(f.id)) {
        // Une facture émise ne change plus [R71] : la validation demande un second geste.
        var armed = false;
        var b = button('Valider cette facture', function () {
          if (!armed) { armed = true; b.textContent = 'Confirmer : émettre la facture'; state.textContent = 'Une fois émise, elle ne change plus. Touchez de nouveau pour confirmer.'; return; }
          validateDraft(f.id, li, b, state, mine);
        });
        li.appendChild(b);
      }
      li.appendChild(state);
      list.appendChild(li);
    });
  }
  function validateDraft(id, li, b, state, mine) {
    if (b.disabled) return Promise.resolve(false);
    b.disabled = true;
    state.textContent = 'Validation…';
    return send('/v1/pilotage/factures/brouillons/' + encodeURIComponent(id) + '/valider', 'POST').then(function (res) {
      if (res.gone || mine !== session) return false;
      if (!res.ok) {
        b.disabled = false;
        state.textContent = res.offline ? 'Pas de réseau : rien n’est émis. Réessayez dans un moment.' : (res.body && DRAFT_PROBLEMS[res.body.code]) || 'La facture n’est pas émise. Réessayez plus tard.';
        return false;
      }
      var v = res.body.data;
      li.removeChild(b);
      state.textContent = 'Facture émise en mode essai' + (v && v.content && typeof v.content.label === 'string' ? ' : ' + v.content.label : '') + '.';
      return true;
    });
  }
  function wipeReseau() {
    ['reseau-corps', 'reseau-alertes', 'reseau-reversements', 'reseau-brouillons'].forEach(function (id) { clear($(id)); });
    ['reseau-etat', 'reseau-alertes-etat', 'reseau-reversements-etat', 'reseau-brouillons-etat', 'reseau-export-etat'].forEach(function (id) { $(id).textContent = ''; });
  }
  function reseauPart(stateId, request, render, mine) {
    $(stateId).textContent = 'Chargement…';
    return request.then(function (res) {
      if (res.gone || mine !== session) return false;
      if (!res.ok) { $(stateId).textContent = res.offline ? 'Pas de réseau. Réessayez dans un moment.' : 'Indisponible pour le moment. Réessayez plus tard.'; return false; }
      $(stateId).textContent = '';
      render(res.body.data, mine);
      return true;
    });
  }
  function openReseau(range) {
    if (!currentKey) return Promise.resolve(false);
    reseauRange = range || reseauRange;
    session += 1;
    var mine = session;
    wipeReseau();
    show('reseau');
    ['mois', 'precedent', 'annee'].forEach(function (r) { $('reseau-' + r).setAttribute('aria-pressed', r === reseauRange ? 'true' : 'false'); });
    if (!$('reseau-export-jour').value) $('reseau-export-jour').value = shiftDay(parisToday(), -1);
    var p = periodOf(reseauRange);
    var list = function (x) { return Array.isArray(x) ? x : []; };
    return Promise.all([
      reseauPart('reseau-etat', send('/v1/pilotage/reseau?du=' + p.from + '&au=' + p.to, 'GET'), function (data) {
        $('reseau-etat').textContent = 'Du ' + date(p.from + 'T12:00:00Z') + ' au ' + date(p.to + 'T12:00:00Z') + '.';
        renderReseau(data || {});
      }, mine),
      reseauPart('reseau-alertes-etat', send('/v1/pilotage/alertes', 'GET'), function (d) { renderAlertes(list(d)); }, mine),
      reseauPart('reseau-reversements-etat', send('/v1/pilotage/reversements', 'GET'), function (d) { renderReversements(list(d)); }, mine),
      reseauPart('reseau-brouillons-etat', send('/v1/pilotage/factures/brouillons', 'GET'), function (d, m) { renderBrouillons(list(d), m); }, mine),
    ]).then(function (done) { return done.every(function (x) { return x; }); });
  }
  /** L'export se télécharge avec la clé dans l'en-tête, jamais dans l'adresse [R13] ; le fichier reste sur l'appareil de la direction. */
  function downloadExport() {
    var day = $('reseau-export-jour').value;
    var state = $('reseau-export-etat');
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(day)) { state.textContent = 'Choisissez un jour.'; return Promise.resolve(false); }
    if (!currentKey) return Promise.resolve(false);
    var mine = session;
    state.textContent = 'Préparation…';
    return api('/v1/pilotage/export-quotidien?jour=' + day, currentKey).then(function (r) {
      if (mine !== session) return false;
      if (!r.ok) { state.textContent = 'Export indisponible pour ce jour. Réessayez plus tard.'; return false; }
      return r.blob().then(function (blob) {
        if (mine !== session) return false;
        var url = URL.createObjectURL(blob);
        var a = el('a', 'Enregistrer le fichier');
        a.href = url;
        a.download = 'chiffres-' + day + '.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        state.textContent = 'Export du ' + date(day + 'T12:00:00Z') + ' téléchargé.';
        return true;
      });
    }, function () {
      if (mine === session) state.textContent = 'Pas de réseau. Réessayez dans un moment.';
      return false;
    });
  }
  function wipeM08() {
    ['visite-corps', 'bien-corps', 'vente-corps'].forEach(function (id) { clear($(id)); });
    ['visite-titre', 'visite-etat', 'bien-titre', 'bien-etat', 'alerte-etat', 'vente-titre', 'vente-etat'].forEach(function (id) { $(id).textContent = ''; });
    $('alerte-etat').hidden = true;
    visitId = null;
    currentBien = null;
    currentVente = null;
    alertId = null;
  }
  function wipeFiche() {
    clear($('fiche-corps'));
    $('fiche-nom').textContent = '';
    $('fiche-etat').textContent = '';
  }
  function show(id) {
    ['connexion', 'accueil', 'attente', 'fiche', 'visite', 'bien', 'vente', 'apres', 'chiffres', 'reseau'].forEach(function (s) { $(s).hidden = s !== id; });
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
      // L'agent a sa journée ; la direction a l'écran du réseau (K09) ; tout autre rôle est refusé ici.
      if (res.refused || (res.body && (!me || (me.role !== 'agent' && me.role !== 'direction')))) {
        forgetKey();
        return refuse('Clé refusée. Vérifiez-la ou demandez-en une nouvelle.');
      }
      if (!res.body) return refuse('Le service ne répond pas. Réessayez dans un moment.');
      if (me.role === 'direction') {
        $('erreur').hidden = true;
        currentKey = key;
        return openReseau('mois');
      }
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
      wipeApres();
      wipeChiffres();
      show('accueil');
      day(currentKey, session);
    }
    $('visite-retour').addEventListener('click', home);
    $('apres-retour').addEventListener('click', home);
    $('apres-ouvrir').addEventListener('click', function () { openApres(); });
    $('chiffres-retour').addEventListener('click', home);
    $('chiffres-ouvrir').addEventListener('click', function () { openChiffres('mois'); });
    ['mois', 'precedent', 'annee'].forEach(function (r) { $('chiffres-' + r).addEventListener('click', function () { openChiffres(r); }); });
    $('vente-retour').addEventListener('click', home);
    ['mois', 'precedent', 'annee'].forEach(function (r) { $('reseau-' + r).addEventListener('click', function () { openReseau(r); }); });
    $('reseau-export').addEventListener('click', function () { downloadExport(); });
    $('bien-retour').addEventListener('click', function () { if (visitId) openVisit(visitId); else home(); });
    $('alerte').addEventListener('click', function () { raiseAlert(false); });
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

