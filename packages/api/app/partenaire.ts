/**
 * L'espace partenaire en ligne (U10) : une page servie par le Worker, sans construction ni dépendance, qui ne lit que
 * par les routes `/v1/partenaires/espace` sous les droits du partenaire [R16, R77]. La clé du partenaire est saisie une
 * fois, gardée sur son appareil, envoyée seulement dans l'en-tête `Authorization`, jamais dans une adresse [R13].
 * Les textes sont posés en texte, jamais en code.
 */

export const PARTNER_HTML = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#f4f1ea">
<title>Espace partenaire · AIMMO</title>
<link rel="stylesheet" href="/partenaire/partenaire.css">
<script src="/partenaire/partenaire.js" defer></script>
</head>
<body>
<header class="tete">
<p class="marque">AIMMO<span>Espace partenaire</span></p>
<button type="button" id="sortir" class="discret" hidden>Se déconnecter</button>
</header>
<main>
<p id="etat" class="etat" role="status" aria-live="polite"></p>

<section id="entree" hidden aria-labelledby="titre-entree">
<h1 id="titre-entree">Vos demandes, et rien d’autre</h1>
<p class="doux">Vous voyez ici les seules demandes qu’un agent du réseau vous a confiées, avec l’accord de son client. Saisissez la clé d’accès reçue de l’agence.</p>
<form id="form-cle">
<label for="cle">Clé d’accès</label>
<input id="cle" name="cle" type="password" autocomplete="current-password" minlength="32" required>
<button type="submit">Entrer</button>
</form>
</section>

<section id="liste" hidden aria-labelledby="titre-liste">
<h1 id="titre-liste">Vos demandes</h1>
<ul id="demandes" class="demandes"></ul>
<p id="vide" class="doux" hidden>Aucune demande ne vous est confiée pour l’instant.</p>
</section>

<section id="detail" hidden aria-labelledby="titre-detail">
<button type="button" id="retour" class="discret">← Toutes vos demandes</button>
<h1 id="titre-detail"></h1>
<p id="statut" class="pastille"></p>
<dl id="dossier" class="dossier"></dl>
<div class="actions">
<button type="button" id="commencer">J’ai commencé</button>
<button type="button" id="terminer" class="second">C’est terminé</button>
</div>
<h2>Déposer une pièce</h2>
<p class="doux">PDF, JPEG ou PNG, 10 Mo au plus. La pièce est rangée d’elle-même à sa place ; si elle ne correspond pas à la demande, l’agent la vérifie.</p>
<form id="form-piece">
<label for="sorte">Sorte de pièce</label>
<select id="sorte" name="sorte" required></select>
<label for="faite">Faite le</label>
<input id="faite" name="faite" type="date" required>
<label for="fichier">Fichier</label>
<input id="fichier" name="fichier" type="file" accept="application/pdf,image/jpeg,image/png" required>
<button type="submit">Déposer</button>
</form>
<p id="depot" class="etat" role="status" aria-live="polite"></p>
</section>
</main>
</body>
</html>
`;

export const PARTNER_CSS = `:root { color-scheme: light dark; --fond: #f4f1ea; --carte: #fffdf8; --texte: #1c1a17; --doux: #5d574d; --accent: #7a3b1d; --trait: #d9d2c3; --ok: #2f5d3a; }
@media (prefers-color-scheme: dark) { :root { --fond: #171512; --carte: #211e1a; --texte: #f0ece4; --doux: #b8b0a2; --accent: #e3a57f; --trait: #3a352d; --ok: #8fc9a0; } }
* { box-sizing: border-box; }
body { margin: 0; background: var(--fond); color: var(--texte); font: 17px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
.tete { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: max(1rem, env(safe-area-inset-top)) 1rem 1rem; border-bottom: 1px solid var(--trait); }
.marque { margin: 0; font-weight: 800; letter-spacing: .08em; }
.marque span { display: block; font-weight: 500; letter-spacing: 0; color: var(--doux); font-size: .85rem; }
main { max-width: 36rem; margin: 0 auto; padding: 1.25rem 1rem 4rem; }
h1 { font-size: 1.5rem; line-height: 1.2; margin: .5rem 0 1rem; }
h2 { font-size: 1.1rem; margin: 2rem 0 .5rem; }
p { margin: 0 0 1rem; }
.doux { color: var(--doux); }
.etat:empty { display: none; }
.etat { padding: .75rem 1rem; border-left: 4px solid var(--accent); background: var(--carte); border-radius: .5rem; }
label { display: block; font-weight: 600; margin: 1rem 0 .35rem; }
input, select { width: 100%; font: inherit; min-height: 48px; padding: .6rem .75rem; border: 1px solid var(--trait); border-radius: .6rem; background: var(--carte); color: var(--texte); }
button { font: inherit; font-weight: 600; min-height: 48px; padding: .7rem 1.25rem; border: 0; border-radius: .7rem; background: var(--accent); color: var(--carte); cursor: pointer; margin-top: 1rem; }
button.second { background: transparent; color: var(--accent); border: 2px solid var(--accent); }
button.discret { background: transparent; color: var(--doux); padding: .4rem 0; min-height: 44px; margin: 0; font-weight: 500; }
button:focus-visible, input:focus-visible, select:focus-visible, a:focus-visible { outline: 3px solid var(--texte); outline-offset: 2px; }
button:disabled { opacity: .5; cursor: not-allowed; }
.demandes { list-style: none; margin: 0; padding: 0; display: grid; gap: .75rem; }
.demandes button { width: 100%; text-align: left; margin: 0; background: var(--carte); color: var(--texte); border: 1px solid var(--trait); border-radius: .9rem; padding: 1rem; display: grid; gap: .2rem; }
.demandes small { color: var(--doux); font-weight: 500; }
.pastille { display: inline-block; padding: .2rem .7rem; border-radius: 999px; border: 1px solid var(--accent); color: var(--accent); font-weight: 600; font-size: .9rem; }
.dossier { display: grid; grid-template-columns: auto 1fr; gap: .4rem 1rem; background: var(--carte); border: 1px solid var(--trait); border-radius: .9rem; padding: 1rem; margin: 1rem 0; }
.dossier dt { color: var(--doux); }
.dossier dd { margin: 0; font-weight: 600; }
.actions { display: flex; flex-wrap: wrap; gap: .75rem; }
.actions button { flex: 1 1 10rem; }
@media (prefers-reduced-motion: no-preference) { button { transition: transform .08s ease; } button:active { transform: scale(.98); } }
`;

export const PARTNER_JS = `'use strict';
(function () {
  var KEY = 'aimmo.partenaire.cle';
  var STATES = { proposee: 'Proposée', accord_client: 'Accord du client', confiee: 'Confiée, à commencer', en_cours: 'En cours', terminee: 'Terminée', abandonnee: 'Abandonnée' };
  var FIELDS = [
    ['domain', 'Domaine demandé'], ['postcode', 'Code postal'], ['city', 'Commune'], ['propertyKind', 'Type de bien'],
    ['surfaceM2', 'Surface (m²)'], ['rooms', 'Pièces'], ['priceEur', 'Prix (€)'], ['clientFirstName', 'Prénom du client'],
    ['clientLastName', 'Nom du client'], ['projectKind', 'Projet'], ['budgetMinEur', 'Budget minimum (€)'],
    ['budgetMaxEur', 'Budget maximum (€)'], ['deadline', 'Échéance'], ['saleAmountEur', 'Montant de la vente (€)'], ['saleOpenedOn', 'Dossier ouvert le']
  ];
  var PLACES = {
    property: 'Rangée dans la fiche du bien.',
    sale_file: 'Rangée dans le dossier de vente.',
    financing: 'Rangée dans le financement du dossier.',
    referral: 'Jointe à la demande.',
    agent_queue: 'Transmise à l’agent, qui la vérifiera avant de la ranger.'
  };
  var REFUSALS = {
    credentials: 'Un de vos justificatifs n’est plus valable ce jour : envoyez sa nouvelle version à l’agence.',
    not_assigned: 'Cette demande ne vous est pas confiée.',
    closed: 'Cette demande est close.',
    forbidden_piece: 'Cette pièce ne se dépose pas ici : remettez-la à l’agent directement.',
    bad_date: 'La date de la pièce est à vérifier : elle ne peut pas être dans le futur.',
    too_large: 'Le fichier dépasse 10 Mo.',
    bad_type: 'Le fichier doit être un PDF, un JPEG ou un PNG.',
    storage_unavailable: 'Le dépôt de fichiers n’est pas encore ouvert : remettez la pièce à l’agent.',
    bad_state: 'Ce changement n’est pas possible à cette étape.'
  };
  var current = null;
  /** Chaque déconnexion ou nouvelle clé change de session : une réponse d'une session passée est ignorée. */
  var session = 0;
  /** Le numéro de la dernière demande ouverte. */
  var opening = 0;

  function el(id) { return document.getElementById(id); }
  function readKey() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function writeKey(v) { try { localStorage.setItem(KEY, v); return true; } catch (e) { return false; } }
  function forgetKey() { try { localStorage.removeItem(KEY); } catch (e) { /* rien à effacer */ } }
  function clear(id) { var e = el(id); while (e.firstChild) e.removeChild(e.firstChild); }
  function today() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  /** Le formulaire de dépôt appartient à une seule demande : vidé à chaque changement de demande et à la déconnexion. */
  function resetForm() { el('fichier').value = ''; el('faite').value = today(); say('depot', ''); }
  function say(id, text) { el(id).textContent = text || ''; }
  function show(id) { ['entree', 'liste', 'detail'].forEach(function (s) { el(s).hidden = s !== id; }); el('sortir').hidden = id === 'entree'; }
  function refusal(body) { return (body && REFUSALS[body.code]) || 'La demande n’a pas abouti. Réessayez dans un instant.'; }

  function api(path, init) {
    var key = readKey();
    if (!key) { show('entree'); return Promise.resolve(null); }
    var options = init || {};
    var headers = options.headers || {};
    headers.authorization = 'Bearer ' + key;
    var mine = session;
    return fetch(path, { method: options.method || 'GET', headers: headers, body: options.body, cache: 'no-store' }).then(function (r) {
      if (mine !== session) return null;
      if (r.status === 401) { session += 1; forgetKey(); show('entree'); say('etat', 'Clé refusée. Saisissez-la de nouveau.'); return null; }
      return r.json().then(function (body) { return mine === session ? { status: r.status, body: body } : null; }, function () { return mine === session ? { status: r.status, body: null } : null; });
    }, function () { if (mine === session) say('etat', 'Pas de connexion. Réessayez dans un instant.'); return null; });
  }

  function loadList() {
    say('etat', '');
    return api('/v1/partenaires/espace').then(function (res) {
      if (!res) return;
      if (res.status !== 200) { say('etat', refusal(res.body)); show('liste'); return; }
      var list = el('demandes');
      while (list.firstChild) list.removeChild(list.firstChild);
      var items = res.body.data || [];
      el('vide').hidden = items.length > 0;
      items.forEach(function (item) {
        var li = document.createElement('li');
        var b = document.createElement('button');
        b.setAttribute('type', 'button');
        var t = document.createElement('span');
        t.textContent = item.tradeLabel;
        var s = document.createElement('small');
        s.textContent = STATES[item.state] || item.state;
        b.appendChild(t);
        b.appendChild(s);
        b.addEventListener('click', function () { open(item.referralId); });
        li.appendChild(b);
        list.appendChild(li);
      });
      show('liste');
    });
  }

  function open(id) {
    say('etat', '');
    current = null;
    resetForm();
    var ticket = ++opening;
    return api('/v1/partenaires/espace/' + encodeURIComponent(id)).then(function (res) {
      // Seule la dernière demande ouverte remplit la page : une réponse dépassée est ignorée.
      if (!res || ticket !== opening) return;
      if (res.status !== 200) { say('etat', refusal(res.body)); return; }
      resetForm();
      current = res.body.data;
      el('titre-detail').textContent = current.tradeLabel;
      el('statut').textContent = STATES[current.state] || current.state;
      var dl = el('dossier');
      while (dl.firstChild) dl.removeChild(dl.firstChild);
      FIELDS.forEach(function (f) {
        var v = current.file[f[0]];
        if (v === undefined || v === null || v === '') return;
        var dt = document.createElement('dt');
        dt.textContent = f[1];
        var dd = document.createElement('dd');
        dd.textContent = String(v);
        dl.appendChild(dt);
        dl.appendChild(dd);
      });
      var select = el('sorte');
      while (select.firstChild) select.removeChild(select.firstChild);
      (current.sorts || []).forEach(function (s) {
        var o = document.createElement('option');
        o.setAttribute('value', s.sort);
        o.textContent = s.label;
        select.appendChild(o);
      });
      var open = current.state === 'confiee' || current.state === 'en_cours';
      el('commencer').disabled = current.state !== 'confiee';
      el('terminer').disabled = !open;
      el('form-piece').hidden = !open;
      show('detail');
    });
  }

  function progress(state) {
    if (!current) return null;
    var id = current.referralId;
    var ticket = opening;
    return api('/v1/partenaires/espace/' + encodeURIComponent(id) + '/etat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ state: state }) }).then(function (res) {
      if (!res || ticket !== opening) return;
      if (res.status !== 200) { say('etat', refusal(res.body)); return; }
      return open(id).then(function () { say('etat', state === 'terminee' ? 'Merci, l’agent est prévenu que c’est terminé.' : 'C’est noté : l’agent voit que vous avez commencé.'); });
    });
  }

  function depositPiece() {
    if (!current) return null;
    var files = el('fichier').files;
    var file = files && files[0];
    if (!file) { say('depot', 'Choisissez un fichier.'); return null; }
    var path = '/v1/partenaires/espace/' + encodeURIComponent(current.referralId) + '/pieces?sorte=' + encodeURIComponent(el('sorte').value) + '&faite_le=' + encodeURIComponent(el('faite').value);
    say('depot', 'Envoi en cours…');
    var ticket = opening;
    return api(path, { method: 'POST', headers: { 'content-type': file.type }, body: file }).then(function (res) {
      // La réponse d'un dépôt ne touche que la demande pour laquelle il a été fait.
      if (!res || ticket !== opening) return;
      if (res.status !== 200) { say('depot', refusal(res.body)); return; }
      say('depot', 'Pièce reçue. ' + (PLACES[res.body.data.destination] || ''));
      el('fichier').value = '';
    });
  }

  document.addEventListener('DOMContentLoaded', function () {
    el('form-cle').addEventListener('submit', function (e) {
      e.preventDefault();
      var v = el('cle').value.trim();
      el('cle').value = '';
      if (v.length < 32) { say('etat', 'La clé compte au moins 32 caractères.'); return; }
      session += 1;
      if (!writeKey(v)) { say('etat', 'Ce navigateur ne garde pas la clé : ouvrez la page hors navigation privée.'); return; }
      loadList();
    });
    el('sortir').addEventListener('click', function () { session += 1; opening += 1; forgetKey(); current = null; resetForm(); clear('dossier'); clear('demandes'); show('entree'); });
    el('retour').addEventListener('click', function () { opening += 1; current = null; resetForm(); loadList(); });
    el('commencer').addEventListener('click', function () { progress('en_cours'); });
    el('terminer').addEventListener('click', function () { progress('terminee'); });
    el('form-piece').addEventListener('submit', function (e) { e.preventDefault(); depositPiece(); });
    resetForm();
    if (readKey()) loadList(); else show('entree');
  });
})();
`;
