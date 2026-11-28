import { LOUER_MODELES_CONFORMITE_HTML } from './louer.ts';
import { clesEntryHtml } from './cles.ts';
import { MANDAT_MODELES_CONFORMITE_HTML } from './mandat-modeles.ts';
import { VAULT_CONTENT_TYPES, VAULT_MAX_BYTES, VAULT_PIECES } from '../../core/src/conformite/coffre.ts';
import { PERSON_REQUEST_CHANNELS, PERSON_REQUEST_KINDS } from '../../core/src/conformite/demandes-personnes.ts';
import { BREACH_CATEGORIES, BREACH_LATE_CAUSES, BREACH_NATURES, BREACH_RISKS } from '../../core/src/conformite/fuites.ts';
import { RISK_LEVELS } from '../../core/src/conformite/risque.ts';
import { SUSPICION_DECISIONS } from '../../core/src/conformite/signalement.ts';
import type { TransferVigilanceMissing } from '../../core/src/commerces/vigilance-cession.ts';
import { VIGILANCE_DECISIONS } from '../../core/src/conformite/vigilance.ts';

/**
 * L'écran « Conformité » de l'application (L10), en morceaux posés dans `fichiers.ts` : sa section de page, sa mise en
 * page et son script ; et, sur la fiche d'un client, le dépôt d'une pièce au coffre par son agent.
 *
 * L'écran ne lit et n'écrit que par les routes `/v1/conformite` [R16]. Il s'ouvre pour la seule clé du responsable de
 * la conformité (rôle `compliance`) : un agent ou la direction ne le reçoivent jamais, et les routes le refusent de
 * toute façon. Aucune donnée personnelle n'y est montrée : un client est nommé par la fin de son identifiant de fiche.
 * Les niveaux, alertes et échéances sont ceux que le code calcule : l'écran les montre, il ne les calcule pas ; chaque
 * décision est signée du nom de qui la prend. L'agent dépose une pièce et lit sa preuve de dépôt (sorte, jour,
 * empreinte), jamais la pièce [R90]. Tout texte reçu est posé avec `textContent`.
 */

type Labels<K extends string> = Record<K, string>;

/** Les libellés des listes fermées de M12, vérifiés contre le code métier : une valeur nouvelle sans libellé ne compile pas. */
const LEVELS: Labels<(typeof RISK_LEVELS)[number]> = { faible: 'faible', moyen: 'moyen', eleve: 'élevé' };
const VIGILANCE: Labels<(typeof VIGILANCE_DECISIONS)[number]> = {
  classee: 'Classer l’alerte',
  origine_des_fonds_demandee: 'Demander l’origine des fonds',
  vigilance_maintenue: 'Maintenir la vigilance',
};
const SUSPICION: Labels<(typeof SUSPICION_DECISIONS)[number]> = { declaration_faite: 'Déclaration de soupçon faite', pas_de_declaration: 'Pas de déclaration' };
const REQUEST_KINDS: Labels<(typeof PERSON_REQUEST_KINDS)[number]> = { acces: 'Accès', rectification: 'Rectification', effacement: 'Effacement', opposition: 'Opposition' };
const REQUEST_CHANNELS: Labels<(typeof PERSON_REQUEST_CHANNELS)[number]> = {
  mail: 'Mail',
  courrier: 'Courrier',
  telephone: 'Téléphone',
  sur_place: 'Sur place',
  message: 'Message',
  formulaire: 'Formulaire',
};
const RISKS: Labels<(typeof BREACH_RISKS)[number]> = { aucun: 'Aucun risque pour les personnes', risque: 'Un risque pour les personnes', eleve: 'Un risque élevé pour les personnes' };
const NATURES: Labels<(typeof BREACH_NATURES)[number]> = { confidentialite: 'Confidentialité', integrite: 'Intégrité', disponibilite: 'Disponibilité' };
const CATEGORIES: Labels<(typeof BREACH_CATEGORIES)[number]> = {
  identite: 'Identité',
  coordonnees: 'Coordonnées',
  projet_et_budget: 'Projet et budget',
  messages: 'Messages',
  pieces_identite: 'Pièces d’identité',
  donnees_financieres: 'Données financières',
  documents_signes: 'Documents signés',
  acces_et_cles: 'Accès et clés',
};
const LATE_CAUSES: Labels<(typeof BREACH_LATE_CAUSES)[number]> = {
  evaluation_en_cours: 'Évaluation encore en cours',
  information_du_sous_traitant: 'Information tardive du sous-traitant',
  autre: 'Autre cause',
};
const PIECES = VAULT_PIECES.map((p) => ({ kind: p.kind, label: p.label }));

/**
 * DS009 · l'écran du responsable en trois rubriques, une seule à la fois : ce qui est à décider (les personnes, les
 * alertes, les fuites), les registres (traitements, gels, dossier anti-blanchiment), les modèles à valider. Les clés de
 * l'appareil restent dessous, avec la déconnexion : c'est le compte, pas une rubrique.
 *
 * La rangée des rubriques est cachée dans la page et montrée par le script du responsable : s'il n'arrive pas, les
 * modèles, eux dans la page, restent à portée comme avant.
 */
export const CONFORMITE_RUBRIQUES: readonly (readonly [id: string, name: string, host: string])[] = [
  ['decider', 'À décider', 'conformite-corps'],
  ['registres', 'Registres', 'conformite-registres'],
  ['modeles', 'Modèles', 'conformite-modeles'],
];

export const CONFORMITE_HTML = `<section id="conformite" hidden>
<h2 id="conformite-titre">Conformité</h2>
<p class="doux">Vous seul lisez cet écran. Chaque décision porte votre nom ; rien n’en part vers un client.</p>
<p id="conformite-etat" class="etat" role="status"></p>
<p id="conformite-echeance" class="etat"></p>
<ul id="conformite-resume" class="resume" aria-label="À traiter"></ul>
<button id="conformite-actualiser" type="button" class="secondaire">Actualiser</button>
<div id="conformite-rubriques" class="rubriques" role="group" aria-label="Rubrique" hidden>
${CONFORMITE_RUBRIQUES.map(([id, name], i) => `<button id="conformite-r-${id}" type="button" class="secondaire" aria-pressed="${i === 0}">${name}</button>`).join('\n')}
</div>
<div id="conformite-corps"></div>
<div id="conformite-registres"></div>
<div id="conformite-modeles">
${MANDAT_MODELES_CONFORMITE_HTML}${LOUER_MODELES_CONFORMITE_HTML}</div>
${clesEntryHtml('conformite')}</section>
`;

export const CONFORMITE_CSS = `
#conformite { padding-top: var(--e-2); }
.resume { display: flex; flex-wrap: wrap; gap: var(--e-2); margin: var(--e-3) 0; padding: 0; list-style: none; }
.resume li { display: inline-flex; align-items: baseline; gap: var(--e-1); min-height: 32px; padding: var(--e-1) var(--e-3); border-radius: var(--r-rond); border: 1.5px solid var(--trait); font-size: var(--t-s); }
.resume li b { font: 600 var(--t-m)/1 var(--police-titre); font-variant-numeric: tabular-nums; }
.resume li.urgent { border-color: var(--danger); }
.resume li.urgent b { color: var(--danger); }
.resume li.calme b { color: var(--succes); }
.decision { margin-top: var(--e-3); padding: var(--e-3) var(--e-4); border-left: 3px solid var(--moutarde); }
.empreinte { font-family: var(--police-texte); font-size: var(--t-xs); font-variant-numeric: tabular-nums; overflow-wrap: anywhere; color: var(--doux); }
.compte { font: 600 var(--t-l)/1.1 var(--police-titre); font-variant-numeric: tabular-nums; }
.compte.urgent { color: var(--danger); }
.coffre { margin-top: var(--e-4); padding: var(--e-3) var(--e-4); border: 1.5px dashed var(--trait); border-radius: var(--r-m); }
.criteres { margin: var(--e-2) 0; padding-left: var(--e-5); }
.criteres li { padding: var(--e-1) 0; }
.cases { display: flex; flex-wrap: wrap; gap: var(--e-1) var(--e-3); margin: var(--e-2) 0; padding: 0; border: 0; }
.cases legend { width: 100%; padding: 0; color: var(--doux); font-size: var(--t-s); }
`;

/**
 * La part de l'écran posée dans le script de l'application : les outils partagés et le chargement à la demande du
 * script du responsable. Le bloc du coffre sur la fiche d'un client, chargé au geste (BR102), est demandé par la fiche
 * servie à part (`/app/fiche.js`, DS010). Un agent ne reçoit jamais le code de l'écran du responsable : il n'est chargé
 * que pour la clé du responsable.
 */
export const COFFRE_JS = `
  /* ---------- M12 : le dépôt au coffre depuis la fiche, et l'écran « Conformité » chargé à la demande (L10). ---------- */
  function cToday() {
    try { return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }); } catch (e) { return new Date().toISOString().slice(0, 10); }
  }
  function cSelect(box, id, label, labels, value) {
    var s = field(box, id, label, 'select');
    Object.keys(labels).forEach(function (k) { var o = el('option', labels[k]); o.setAttribute('value', k); s.appendChild(o); });
    s.value = value || Object.keys(labels)[0];
    return s;
  }
  function cSeq() { formSeq += 1; return 'c' + formSeq; }
  function cState() { var p = el('p', null, 'etat'); p.setAttribute('role', 'status'); return p; }
  function wipeConformite() {
    ['conformite-corps', 'conformite-registres', 'conformite-resume'].forEach(function (id) { clear($(id)); });
    $('conformite-etat').textContent = $('conformite-echeance').textContent = '';
  }
  var conformiteScreen = null;
  // Le script du responsable, chargé une fois, reçoit les outils de l'application ; il ne garde aucune donnée.
  function openConformite(fresh) {
    show('conformite');
    if (conformiteScreen) return conformiteScreen.open(fresh);
    var mine = session;
    $('conformite-etat').textContent = 'Chargement…';
    return new Promise(function (resolve) {
      var script = document.createElement('script');
      script.setAttribute('src', '/app/conformite.js');
      script.addEventListener('load', function () {
        var make = globalThis.AIMMO_CONFORMITE;
        try { delete globalThis.AIMMO_CONFORMITE; } catch (e) { /* rien à retirer */ }
        if (mine !== session || typeof make !== 'function') { resolve(false); return; }
        conformiteScreen = make({ $: $, el: el, clear: clear, send: send, field: field, checkbox: checkbox, button: button, section: section, block: block, line: line, date: date, hour: hour, show: show, cToday: cToday, cSelect: cSelect, cSeq: cSeq, cState: cState, prove: proveAction, session: function () { return session; } });
        resolve(conformiteScreen.open());
      });
      script.addEventListener('error', function () {
        if (mine === session) $('conformite-etat').textContent = 'Pas de réseau. Réessayez dans un moment.';
        resolve(false);
      });
      $('conformite').appendChild(script);
    });
  }
`;

/**
 * BR102 · Le dépôt d'une pièce au coffre depuis la fiche (L10), servi à part (`/app/coffre.js`) et chargé au geste par
 * le chargeur commun, pour que l'application tienne son budget [R201]. Il ne lit que les preuves de dépôt de la fiche et
 * n'écrit que le dépôt : l'agent ne demande jamais une pièce [R90]. La pièce part par `send`, en corps brut avec son
 * type ; une clé refusée ou un agent sorti y est retiré comme partout [R16].
 */
export const COFFRE_SCRIPT = `'use strict';
globalThis.AIMMO_COFFRE = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, date = t.date, hour = t.hour;
  var PIECES = ${JSON.stringify(PIECES)};
  var TYPES = ${JSON.stringify(VAULT_CONTENT_TYPES)};
  var MAX = ${VAULT_MAX_BYTES};
  var REFUSALS = {
    role: 'Réservé à l’agent du client.',
    not_assigned: 'Ce client est suivi par un autre agent.',
    bad_date: 'Date non valable.',
    unknown_piece: 'Choisissez la sorte de pièce.',
    empty_content: 'Choisissez le fichier de la pièce.',
    bad_content_type: 'Seuls les PDF, JPEG et PNG entrent au coffre.',
    too_large: 'La pièce dépasse 10 Mo.',
    vault_not_configured: 'Le coffre n’est pas encore ouvert : aucune pièce ne peut y être déposée pour le moment.',
  };
  var seq = 0;
  function refusal(res, fallback) {
    if (res && res.offline) return 'Pas de réseau. Réessayez dans un moment.';
    var b = res && res.body;
    return (b && typeof b.code === 'string' && Object.prototype.hasOwnProperty.call(REFUSALS, b.code) && REFUSALS[b.code]) || fallback;
  }
  function today() {
    try { return new Date().toLocaleDateString('en-CA', { timeZone: 'Europe/Paris' }); } catch (e) { return new Date().toISOString().slice(0, 10); }
  }
  function state() { var p = el('p', null, 'etat'); p.setAttribute('role', 'status'); return p; }
  return function (personId, corps, said) {
    clear(corps);
    said.textContent = '';
    var box = el('div', null, 'coffre');
    box.appendChild(el('p', 'La pièce part au coffre, que seul le responsable de la conformité ouvre. Vous gardez la preuve de dépôt.', 'doux'));
    var receipts = el('ul', null, 'liste');
    var listState = state();
    box.appendChild(listState);
    box.appendChild(receipts);
    var base = '/v1/conformite/personnes/' + encodeURIComponent(personId) + '/coffre';
    function load() {
      return send(base + '/recus', 'GET').then(function (res) {
        if (res.gone) return;
        clear(receipts);
        if (!res.ok) { listState.textContent = refusal(res, 'Preuves indisponibles pour le moment.'); return; }
        var rows = Array.isArray(res.body.data) ? res.body.data : [];
        listState.textContent = rows.length ? '' : 'Aucune pièce déposée.';
        rows.forEach(function (p) {
          if (!p || typeof p.label !== 'string' || typeof p.sha256 !== 'string') return;
          var li = el('li', p.label + ', déposée le ' + date(p.depositedAt) + ' à ' + hour(p.depositedAt));
          li.appendChild(el('p', 'Empreinte : ' + p.sha256, 'empreinte'));
          receipts.appendChild(li);
        });
      });
    }
    var form = el('div', null, 'decision');
    var id = 'coffre-' + (++seq);
    var kind = field(form, id + '-sorte', 'Sorte de pièce', 'select');
    PIECES.forEach(function (p) { var o = el('option', p.label); o.setAttribute('value', p.kind); kind.appendChild(o); });
    kind.value = PIECES[0].kind;
    var checked = field(form, id + '-verifie', 'Vérifiée le');
    checked.setAttribute('type', 'date');
    checked.value = today();
    var until = field(form, id + '-valide', 'Valable jusqu’au (si la pièce le dit)');
    until.setAttribute('type', 'date');
    var file = field(form, id + '-fichier', 'Fichier (PDF, JPEG ou PNG, 10 Mo au plus)');
    file.setAttribute('type', 'file');
    file.setAttribute('accept', TYPES.join(','));
    var st = state();
    form.appendChild(button('Déposer au coffre', function () {
      var f = file.files && file.files[0];
      if (!f) { st.textContent = REFUSALS.empty_content; return; }
      if (TYPES.indexOf(f.type) === -1) { st.textContent = REFUSALS.bad_content_type; return; }
      if (f.size > MAX) { st.textContent = REFUSALS.too_large; return; }
      var q = '?sorte=' + encodeURIComponent(kind.value) + '&verifie=' + encodeURIComponent(checked.value) + (until.value ? '&valide=' + encodeURIComponent(until.value) : '');
      st.textContent = 'Dépôt…';
      send(base + q, 'POST', f, { 'content-type': f.type }).then(function (res) {
        if (res.gone) return;
        if (!res.ok) { st.textContent = refusal(res, 'Pièce refusée. Vérifiez la saisie.'); return; }
        file.value = '';
        var receipt = res.body.receipt;
        st.textContent = receipt && typeof receipt.label === 'string' ? 'Déposée : ' + receipt.label + '. Empreinte : ' + receipt.sha256 : 'Déposée.';
        load();
      });
    }));
    form.appendChild(st);
    box.appendChild(form);
    corps.appendChild(box);
    return load();
  };
};
`;

/**
 * Le script de l'écran du responsable, servi à part (`/app/conformite.js`) et chargé seulement pour sa clé. Il ne
 * lit et n'écrit que par les routes `/v1/conformite`, avec les outils que l'application lui passe.
 */
/* Ce qui manque à une cession de fonds [R118]. */
const CESSION_MISSING: Record<TransferVigilanceMissing, string> = {
  beneficiaires_effectifs: 'bénéficiaires effectifs',
  origine_des_fonds: 'origine des fonds',
};

export const CONFORMITE_SCRIPT = `'use strict';
globalThis.AIMMO_CONFORMITE = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, field = t.field, checkbox = t.checkbox, button = t.button, section = t.section, block = t.block, line = t.line, date = t.date, hour = t.hour, show = t.show;
  var cToday = t.cToday, cSelect = t.cSelect, cSeq = t.cSeq, cState = t.cState;
  var C_LEVELS = ${JSON.stringify(LEVELS)};
  var C_VIGILANCE = ${JSON.stringify(VIGILANCE)};
  var C_CESSION_MISSING = ${JSON.stringify(CESSION_MISSING)};
  var C_SUSPICION = ${JSON.stringify(SUSPICION)};
  var C_REQUEST_KINDS = ${JSON.stringify(REQUEST_KINDS)};
  var C_REQUEST_CHANNELS = ${JSON.stringify(REQUEST_CHANNELS)};
  var C_RISKS = ${JSON.stringify(RISKS)};
  var C_NATURES = ${JSON.stringify(NATURES)};
  var C_CATEGORIES = ${JSON.stringify(CATEGORIES)};
  var C_LATE = ${JSON.stringify(LATE_CAUSES)};
  var C_RELATIONS = { mandat: 'Mandat', offre: 'Offre' };
  var C_OUTCOMES = { contact_repris: 'La personne a repris contact : gardée', devenu_client: 'Devenue cliente : gardée', effacement: 'Effacement préparé (essai)' };
  var C_BLOCKED = { R02: 'demande non préparée : la personne est exclue', R04: 'demande non préparée : la personne a demandé l’arrêt' };
  var C_REFUSALS = {
    role: 'Réservé au responsable de la conformité.',
    not_assigned: 'Ce client est suivi par un autre agent.',
    agent_inactive: 'Votre accès d’agent n’est plus actif.',
    missing_name: 'Écrivez votre nom : il signe la décision.',
    bad_name: 'Écrivez votre nom : il signe la décision.',
    missing_reason: 'Écrivez la raison de la décision.',
    bad_reason: 'La raison compte 1 000 caractères au plus.',
    bad_level: 'Choisissez un niveau dans la liste.',
    bad_decision: 'Choisissez une décision dans la liste.',
    already_validated: 'Cette fiche est déjà validée.',
    already_decided: 'Cette décision est déjà prise.',
    already_answered: 'Cette demande a déjà sa réponse.',
    already_notified: 'Cette notification est déjà notée.',
    already_restored: 'Cet accès est déjà rétabli.',
    not_prepared: 'Préparez d’abord la réponse.',
    not_evaluated: 'Évaluez d’abord la fuite.',
    late_cause_required: 'L’échéance de 72 heures est passée : choisissez la cause du retard.',
    bad_date: 'Date non valable.',
    future_date: 'Cette date est dans l’avenir.',
    before_request: 'La réponse ne peut pas précéder la demande.',
    before_breach: 'Cette date précède la fuite.',
    before_last_review: 'Cette date précède la dernière relecture.',
    bad_kind: 'Choisissez la sorte de demande.',
    bad_channel: 'Choisissez le canal de la demande.',
    unknown_person: 'Aucune fiche ne porte cet identifiant.',
    bad_risk: 'Choisissez le risque pour les personnes.',
    bad_nature: 'Cochez au moins une atteinte.',
    bad_categories: 'Cochez au moins une catégorie de données.',
    bad_scope: 'Périmètre non valable.',
    unknown_piece: 'Choisissez la sorte de pièce.',
    empty_content: 'Choisissez le fichier de la pièce.',
    bad_content_type: 'Seuls les PDF, JPEG et PNG entrent au coffre.',
    too_large: 'La pièce dépasse 10 Mo.',
    vault_not_configured: 'Le coffre n’est pas encore ouvert : aucune pièce ne peut y être déposée pour le moment.',
    unknown_replaced: 'La pièce à remplacer est introuvable.',
    already_replaced: 'Cette pièce a déjà été remplacée.',
  };
  function cRefusal(res, fallback) {
    if (res && res.offline) return 'Pas de réseau. Réessayez dans un moment.';
    var b = res && res.body;
    return (b && C_REFUSALS[b.code]) || fallback;
  }
  // Un client nommé sans rien de lui : la fin de l'identifiant de sa fiche.
  // Un fichier enregistré sur l'appareil, sans passer par le stockage du navigateur.
  function cSave(name, content) {
    try {
      var url = URL.createObjectURL(new Blob([JSON.stringify(content, null, 2)], { type: 'application/json' }));
      var a = el('a', 'Enregistrer');
      a.href = url;
      a.download = name;
      $('conformite').appendChild(a);
      a.click();
      $('conformite').removeChild(a);
      setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
      return true;
    } catch (e) {
      return false;
    }
  }
  function cRef(id) { return 'Client …' + String(id || '').slice(-6); }
  function cChecks(box, prefix, legend, labels) {
    // Un groupe de cases nommé par sa légende, pour les lecteurs d'écran.
    var wrap = el('fieldset', null, 'cases');
    wrap.appendChild(el('legend', legend));
    var boxes = {};
    Object.keys(labels).forEach(function (k) { boxes[k] = checkbox(wrap, prefix + '-' + k, labels[k]); });
    box.appendChild(wrap);
    return function () { return Object.keys(boxes).filter(function (k) { return boxes[k].checked; }); };
  }
  // Une décision : envoyée, puis l'écran relu en entier ; un refus est dit à côté du bouton, rien n'est gardé.
  function cAct(state, path, body, done) {
    state.textContent = 'Envoi…';
    return send(path, 'POST', body).then(function (res) {
      if (res.gone) return false;
      if (!res.ok) { state.textContent = cRefusal(res, 'Refusé. Vérifiez la saisie.'); return false; }
      return openConformite(done);
    });
  }
  function wipeConformite() {
    ['conformite-corps', 'conformite-registres', 'conformite-resume'].forEach(function (id) { clear($(id)); });
    $('conformite-etat').textContent = $('conformite-echeance').textContent = '';
  }
  function quiet(b) { b.className = 'secondaire'; return b; }
  // DS009 · une rubrique à la fois ; un geste dans l'écran garde la rubrique ouverte, une nouvelle entrée rouvre la première.
  var C_TABS = ${JSON.stringify(CONFORMITE_RUBRIQUES)}, cTab = C_TABS[0][0];
  function cShow(name) {
    cTab = name;
    $('conformite-rubriques').hidden = false;
    C_TABS.forEach(function (r) {
      $('conformite-r-' + r[0]).setAttribute('aria-pressed', r[0] === name ? 'true' : 'false');
      $(r[2]).hidden = r[0] !== name;
    });
  }
  C_TABS.forEach(function (r) { $('conformite-r-' + r[0]).addEventListener('click', function () { cShow(r[0]); }); });
  // DS009 · l'échéance légale qui tombe la première, tous registres confondus : la réponse à une personne (un mois),
  // la CNIL après une fuite (72 heures), la relecture du registre. Une échéance passée se dit passée. Si une de ces
  // trois lectures a manqué, la phrase dit qu'elle n'est pas sûre : elle ne donne jamais pour première une échéance
  // qui ne l'est peut-être pas.
  // Un jour du calendrier finit à Paris, quel que soit le fuseau de l'appareil : le serveur compte ses jours à Paris,
  // et l'écran les écrit à Paris. L'écart de Paris ce jour-là est lu dans Intl ; sans lui, la fin du jour universel.
  function cDayEnd(day) {
    var utc = Date.parse(day + 'T23:59:59Z');
    try {
      var v = {};
      new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Paris', hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }).formatToParts(new Date(utc)).forEach(function (x) { v[x.type] = Number(x.value); });
      return 2 * utc - Date.UTC(v.year, v.month - 1, v.day, v.hour, v.minute, v.second);
    } catch (e) { return utc; }
  }
  function cDeadline(data) {
    var first = null;
    function due(ms, text) {
      if (isFinite(ms) && (!first || ms < first.ms)) first = { ms: ms, text: text };
    }
    (data.demandes || []).forEach(function (d) {
      if (!d.answeredOn) due(cDayEnd(d.dueOn), 'répondre à une demande d’une personne avant le ' + date(d.dueOn));
    });
    (data.fuites || []).forEach(function (f) {
      if (!f.notified.cnil && f.due.cnil) due(Date.parse(f.deadlineAt), 'prévenir la CNIL d’une fuite avant le ' + date(f.deadlineAt) + ' à ' + hour(f.deadlineAt));
    });
    if (data.registre) due(cDayEnd(data.registre.dueOn), 'relire le registre des traitements avant le ' + date(data.registre.dueOn));
    var sure = Array.isArray(data.demandes) && Array.isArray(data.fuites) && !!data.registre;
    var said = first ? (first.ms < Date.now() ? 'Échéance passée : ' : sure ? 'Première échéance : ' : 'Échéance connue : ') + first.text + '.' : '';
    $('conformite-echeance').textContent = said + (sure ? '' : (said ? ' ' : '') + 'Une partie n’a pas pu être lue : une échéance plus proche est possible.');
  }
  // Les lectures de l'écran, toutes sous /v1/conformite [R16], plus les alertes de cession de M16 [R118], dans l'ordre où l'écran les montre.
  var C_PARTS = ['risque', 'vigilance', 'cessions', 'signalements', 'demandes', 'demandesAlertes', 'prospects', 'fuites', 'fuitesAlertes', 'registre', 'registreAlertes'];
  function cReads() {
    return [
      send('/v1/conformite/risque', 'GET'),
      send('/v1/conformite/vigilance', 'GET'),
      send('/v1/commerces/vigilance', 'GET'),
      send('/v1/conformite/signalements', 'GET'),
      send('/v1/conformite/demandes', 'GET'),
      send('/v1/conformite/demandes/alertes', 'GET'),
      send('/v1/conformite/prospects', 'GET'),
      send('/v1/conformite/fuites', 'GET'),
      send('/v1/conformite/fuites/alertes', 'GET'),
      send('/v1/conformite/registre', 'GET'),
      send('/v1/conformite/registre/alertes', 'GET'),
    ];
  }
  function openConformite(message) {
    show('conformite');
    var mine = t.session();
    $('conformite-etat').textContent = 'Chargement…';
    return Promise.all(cReads()).then(function (all) {
      if (mine !== t.session() || all.some(function (r) { return r.gone; })) return false;
      wipeConformite();
      var data = {};
      var missing = 0;
      all.forEach(function (r, i) { if (r.ok) data[C_PARTS[i]] = r.body.data; else missing += 1; });
      if (missing === all.length) {
        $('conformite-etat').textContent = all.some(function (r) { return r.status === 403; }) ? 'Cet écran est réservé au responsable de la conformité.' : 'Indisponible pour le moment. Réessayez plus tard.';
        return false;
      }
      $('conformite-etat').textContent = message || (missing ? 'Une partie de l’écran n’a pas pu être lue : actualisez dans un moment.' : '');
      renderConformite(data);
      cDeadline(data);
      cShow(cTab);
      return true;
    });
  }
  function cSummary(data) {
    var list = $('conformite-resume');
    function count(n, one, many, urgent) {
      var li = el('li', null, n === 0 ? 'calme' : urgent ? 'urgent' : '');
      li.appendChild(el('b', n));
      li.appendChild(el('span', n === 1 ? one : many));
      list.appendChild(li);
    }
    // Une lecture qui n'a pas abouti ne compte jamais pour zéro : son compteur dit qu'il n'est pas connu.
    function open(rows, test, one, many, urgent) {
      if (!Array.isArray(rows)) {
        var li = el('li', null, 'urgent');
        li.appendChild(el('b', '?'));
        li.appendChild(el('span', many + ' : non lu'));
        list.appendChild(li);
        return;
      }
      count(rows.filter(test).length, one, many, urgent);
    }
    open(data.risque, function () { return true; }, 'fiche à valider', 'fiches à valider', false);
    open(data.vigilance, function (a) { return !a.decision; }, 'alerte de vigilance', 'alertes de vigilance', false);
    open(data.cessions, function (a) { return !a.decision; }, 'alerte de cession', 'alertes de cession', false);
    open(data.signalements, function (s) { return !s.decision; }, 'signalement à décider', 'signalements à décider', true);
    open(data.demandes, function (d) { return !d.answeredOn; }, 'demande en cours', 'demandes en cours', false);
    open(data.fuites, function (f) { return !f.notified.cnil && f.due.cnil; }, 'fuite à notifier', 'fuites à notifier', true);
  }
  function renderConformite(data) {
    cSummary(data);
    var body = $('conformite-corps');
    body.appendChild(cAlerts(data));
    if (data.risque) body.appendChild(cRisk(data.risque));
    if (data.vigilance) body.appendChild(cVigilance(data.vigilance));
    if (data.cessions) body.appendChild(cCessions(data.cessions));
    if (data.signalements) body.appendChild(cSuspicions(data.signalements));
    if (data.demandes) body.appendChild(cRequests(data.demandes));
    if (data.prospects) body.appendChild(cProspects(data.prospects));
    if (data.fuites) body.appendChild(cBreaches(data.fuites));
    var kept = $('conformite-registres');
    if (data.registre) kept.appendChild(cRegistry(data.registre));
    kept.appendChild(cGels());
    kept.appendChild(cLcb());
  }
  /* BR114 : le dossier anti-blanchiment de l'agence sous licence, script servi à part, chargé au geste [R201, R662]. */
  var lcbScreen = null;
  function cLcb() {
    var box = section('Dossier anti-blanchiment de l’agence');
    var inner = el('div');
    var state = cState();
    var say = function (x) { state.textContent = x; };
    var b = quiet(button('Ouvrir le dossier anti-blanchiment', function () {
      if (b.disabled) return;
      if (lcbScreen) { lcbScreen.show(inner, say); return; }
      b.disabled = true;
      var mine = t.session();
      var s = el('script');
      s.setAttribute('src', '/app/dossier-lcb.js');
      s.addEventListener('load', function () {
        var make = globalThis.AIMMO_DOSSIER_LCB;
        try { delete globalThis.AIMMO_DOSSIER_LCB; } catch (e) { /* rien */ }
        b.disabled = false;
        if (mine !== t.session()) return;
        if (typeof make !== 'function') { say('Indisponible pour le moment. Réessayez dans un moment.'); return; }
        lcbScreen = make({ el: el, clear: clear, send: send, button: button, prove: t.prove, session: t.session });
        lcbScreen.show(inner, say);
      });
      s.addEventListener('error', function () { b.disabled = false; if (mine === t.session()) say('Pas de réseau. Réessayez dans un moment.'); });
      box.appendChild(s);
    }));
    box.appendChild(b);
    box.appendChild(inner);
    box.appendChild(state);
    return box;
  }
  /* BR85 : l'import du registre des gels, script servi à part et chargé au premier geste [R201]. */
  var gelScreen = null;
  function cGels() {
    var box = section('Registre des gels');
    box.appendChild(el('p', 'Le registre national des gels de la DG Trésor, importé en un appui ; chaque dossier en cours est recontrôlé aussitôt.', 'doux'));
    var inner = el('div');
    var b = quiet(button('Ouvrir l’import du registre', function () {
      if (b.disabled) return;
      if (gelScreen) { gelScreen.show(inner); return; }
      b.disabled = true;
      var mine = t.session();
      var s = el('script');
      s.setAttribute('src', '/app/gel-registre.js');
      s.addEventListener('load', function () {
        var make = globalThis.AIMMO_GEL_REGISTRE;
        try { delete globalThis.AIMMO_GEL_REGISTRE; } catch (e) { /* rien */ }
        b.disabled = false;
        if (mine !== t.session()) return;
        if (typeof make !== 'function') { clear(inner); inner.appendChild(el('p', 'Indisponible pour le moment. Réessayez dans un moment.', 'etat')); return; }
        gelScreen = make({ el: el, clear: clear, send: send, button: button, field: field, session: t.session });
        gelScreen.show(inner);
      });
      s.addEventListener('error', function () { b.disabled = false; if (mine === t.session()) { clear(inner); inner.appendChild(el('p', 'Pas de réseau. Réessayez dans un moment.', 'etat')); } });
      box.appendChild(s);
    }));
    box.appendChild(b);
    box.appendChild(inner);
    return box;
  }
  // Les alertes rangées par les passages du planificateur : leur phrase est celle du code, posée en texte.
  function cAlerts(data) {
    // Les fuites d'abord, puis les demandes, puis le registre, chacune dans l'ordre reçu.
    var rows = [].concat(data.fuitesAlertes || [], data.demandesAlertes || [], data.registreAlertes || []);
    return block('Alertes', rows.map(function (a) { return line(a.text, 'Rangée le ' + date(a.createdAt) + ' à ' + hour(a.createdAt)); }));
  }
  function cRisk(sheets) {
    var box = section('Fiches de risque à valider');
    box.appendChild(el('p', 'La grille propose un niveau ; elle ne trie aucun client et ne refuse rien. Vous validez ou corrigez, avec la raison.', 'doux'));
    if (!sheets.length) box.appendChild(el('p', 'Aucune fiche n’attend votre validation.', 'etat'));
    var ul = el('ul', null, 'liste');
    sheets.forEach(function (s) {
      var li = el('li');
      li.appendChild(el('p', cRef(s.personId) + ' · ' + (C_RELATIONS[s.relation] || 'Dossier') + ', préparée le ' + date(s.preparedAt)));
      var crit = el('ul', null, 'criteres');
      (s.criteria || []).forEach(function (c) { crit.appendChild(el('li', c.label + ' : ' + c.observed + ' (' + (C_LEVELS[c.level] || c.level) + ')')); });
      li.appendChild(crit);
      li.appendChild(el('p', 'Niveau proposé par la grille : ' + (C_LEVELS[s.computedLevel] || s.computedLevel), 'compte'));
      if (s.trialGrid) li.appendChild(el('p', 'Grille d’essai, en attente de validation par l’avocat.', 'doux'));
      var form = el('div', null, 'decision');
      var id = cSeq();
      var level = cSelect(form, id + '-niveau', 'Niveau retenu', C_LEVELS, s.computedLevel);
      var reason = field(form, id + '-raison', 'Raison (obligatoire si vous corrigez le niveau)', 'textarea');
      var name = field(form, id + '-nom', 'Votre nom');
      var state = cState();
      form.appendChild(button('Valider la fiche', function () {
        var b = { validatorName: name.value.trim(), level: level.value };
        if (reason.value.trim()) b.reason = reason.value.trim();
        cAct(state, '/v1/conformite/risque/' + encodeURIComponent(s.sheetId) + '/valider', b, 'Fiche validée.');
      }));
      form.appendChild(quiet(button('Rejouer la fiche', function () {
        state.textContent = 'Calcul…';
        send('/v1/conformite/risque/' + encodeURIComponent(s.sheetId) + '/rejouer', 'GET').then(function (res) {
          if (res.gone) return;
          if (!res.ok) { state.textContent = cRefusal(res, 'Indisponible pour le moment.'); return; }
          state.textContent = res.body.same ? 'Rejouée à l’identique : même calcul, même empreinte.' : 'Rejouée avec un écart : ' + (res.body.differences || []).join(', ') + '.';
        });
      })));
      form.appendChild(state);
      li.appendChild(form);
      ul.appendChild(li);
    });
    box.appendChild(ul);
    return box;
  }
  function cVigilance(alerts) {
    var box = section('Vigilance renforcée');
    if (!alerts.length) box.appendChild(el('p', 'Aucune alerte.', 'etat'));
    var ul = el('ul', null, 'liste');
    alerts.forEach(function (a) {
      var li = line(a.text, cRef(a.personId) + ' · levée le ' + date(a.raisedAt));
      if (a.decision) {
        li.appendChild(el('p', (C_VIGILANCE[a.decision.decision] || 'Décidée') + ' · ' + a.decision.validatorName + ', le ' + date(a.decision.decidedOn), 'decision'));
      } else {
        var form = el('div', null, 'decision');
        var id = cSeq();
        var decision = cSelect(form, id + '-decision', 'Décision', C_VIGILANCE);
        var reason = field(form, id + '-raison', 'Raison', 'textarea');
        var name = field(form, id + '-nom', 'Votre nom');
        var state = cState();
        form.appendChild(button('Signer la décision', function () {
          cAct(state, '/v1/conformite/vigilance/' + encodeURIComponent(a.alertId) + '/decider', { decision: decision.value, reason: reason.value.trim(), validatorName: name.value.trim() }, 'Décision rangée.');
        }));
        form.appendChild(state);
        li.appendChild(form);
      }
      ul.appendChild(li);
    });
    box.appendChild(ul);
    return box;
  }
  // La vigilance de la cession d'un fonds (CE21) : ce qui manque, jamais une pièce ni un montant [R15] ; le responsable décide seul, avec son nom [R14, R118].
  function cCessions(alerts) {
    var box = section('Vigilance des cessions de fonds');
    if (!alerts.length) box.appendChild(el('p', 'Aucune alerte.', 'etat'));
    var ul = el('ul', null, 'liste');
    alerts.forEach(function (a) {
      var names = function (list) { return list.map(function (m) { return C_CESSION_MISSING[m] || 'une pièce'; }).join(', '); };
      var missing = a.missing || [];
      var li = line('Cession d’un fonds : à la levée de l’alerte, il manquait au coffre : ' + names(missing) + '.', cRef(a.personId) + ' · levée le ' + date(a.raisedAt));
      /* RC58 : relue au coffre par son seul état à cette lecture ; nulle ou absente, rien n'est dit déposé [R10, R15]. */
      var still = Array.isArray(a.stillMissing) ? a.stillMissing : null;
      var at = still && a.checkedAt && date(a.checkedAt) && hour(a.checkedAt) ? ' le ' + date(a.checkedAt) + ' à ' + hour(a.checkedAt) : null;
      if (!still || !at) {
        li.appendChild(el('p', 'Coffre non relu : vérifiez-le avant de décider.', 'etat'));
      } else {
        var since = missing.filter(function (m) { return still.indexOf(m) < 0; });
        li.appendChild(el('p', still.length ? 'Relu au coffre' + at + ' : il manque encore ' + names(still) + '.' : 'Relu au coffre' + at + ' : tout ce qui manquait est déposé depuis. La décision reste la vôtre.', still.length ? 'etat' : 'doux'));
        if (still.length && since.length) li.appendChild(el('p', 'Déposé depuis la levée : ' + names(since) + '.', 'doux'));
      }
      if (a.buyerCurrent === false) li.appendChild(el('p', 'L’acquéreur de cette alerte a été remplacé depuis sur le dossier.', 'etat'));
      if (a.decision) {
        li.appendChild(el('p', (C_VIGILANCE[a.decision.decision] || 'Décidée') + ' · ' + a.decision.validatorName + ', le ' + date(a.decision.decidedAt), 'decision'));
      } else {
        var form = el('div', null, 'decision');
        var id = cSeq();
        var decision = cSelect(form, id + '-decision', 'Décision', C_VIGILANCE);
        var reason = field(form, id + '-raison', 'Raison', 'textarea');
        var name = field(form, id + '-nom', 'Votre nom');
        var state = cState();
        var mine = t.session();
        var go = button('Signer la décision', function () {
          if (go.disabled) return;
          if (!reason.value.trim() || !name.value.trim()) { state.textContent = 'La raison et votre nom sont à remplir.'; return; }
          go.disabled = true;
          state.textContent = 'Envoi…';
          return send('/v1/commerces/vigilance/' + encodeURIComponent(a.id) + '/decision', 'POST', { decision: decision.value, reason: reason.value.trim(), validatorName: name.value.trim() }).then(function (res) {
            if (res.gone || mine !== t.session()) return false;
            go.disabled = false;
            /* Une décision est définitive : une réponse perdue ne se dit pas refusée. */
            if (res.offline || res.status >= 500 || !res.body) { state.textContent = 'Réponse perdue : la décision est peut-être rangée. Actualisez avant de recommencer.'; return false; }
            if (res.ok) return openConformite('Décision rangée.');
            if (res.status === 403) { state.textContent = 'Cet écran est réservé au responsable de la conformité.'; return false; }
            if (res.body.code === 'already_decided') return openConformite('Cette alerte était déjà décidée : voici la décision rangée.');
            state.textContent = cRefusal(res, 'Refusé. Vérifiez la saisie.');
            return false;
          });
        });
        form.appendChild(go);
        form.appendChild(state);
        li.appendChild(form);
      }
      ul.appendChild(li);
    });
    box.appendChild(ul);
    return box;
  }
  function cSuspicions(reports) {
    var box = section('Signalements');
    box.appendChild(el('p', 'Le dossier signalé reste figé ; le client n’en sait rien.', 'doux'));
    if (!reports.length) box.appendChild(el('p', 'Aucun signalement.', 'etat'));
    var ul = el('ul', null, 'liste');
    reports.forEach(function (r) {
      var li = line(r.note, cRef(r.personId) + ' · signalé le ' + date(r.reportedAt) + ', ' + r.lines + ' lignes figées');
      li.appendChild(el('p', 'Empreinte de la copie figée : ' + r.snapshotSha256, 'empreinte'));
      var state = cState();
      li.appendChild(button('Vérifier que le dossier est resté figé', function () {
        state.textContent = 'Vérification…';
        send('/v1/conformite/signalements/' + encodeURIComponent(r.reportId) + '/fige', 'GET').then(function (res) {
          if (res.gone) return;
          if (!res.ok) { state.textContent = cRefusal(res, 'Indisponible pour le moment.'); return; }
          var f = res.body.data;
          state.textContent = f.intact ? 'Intact : aucune ligne changée ni disparue depuis le signalement.' : 'Changé depuis le signalement : ' + f.changed.length + ' lignes modifiées, ' + f.missing.length + ' disparues.';
        });
      }));
      if (r.decision) {
        li.appendChild(el('p', (C_SUSPICION[r.decision.decision] || 'Décidé') + ' · ' + r.decision.validatorName + ', le ' + date(r.decision.decidedOn), 'decision'));
      } else {
        var form = el('div', null, 'decision');
        var id = cSeq();
        var decision = cSelect(form, id + '-decision', 'Décision', C_SUSPICION);
        var reason = field(form, id + '-raison', 'Raison', 'textarea');
        var name = field(form, id + '-nom', 'Votre nom');
        form.appendChild(button('Signer la décision', function () {
          cAct(state, '/v1/conformite/signalements/' + encodeURIComponent(r.reportId) + '/decider', { decision: decision.value, reason: reason.value.trim(), validatorName: name.value.trim() }, 'Décision rangée.');
        }));
        li.appendChild(form);
      }
      li.appendChild(state);
      ul.appendChild(li);
    });
    box.appendChild(ul);
    return box;
  }
  function cRequests(requests) {
    var box = section('Demandes des personnes');
    box.appendChild(el('p', 'Réponse complète en un mois au plus. L’échéance est calculée par le code, le rappel part 7 jours avant.', 'doux'));
    if (!requests.length) box.appendChild(el('p', 'Aucune demande.', 'etat'));
    var ul = el('ul', null, 'liste');
    requests.forEach(function (d) {
      var title = (C_REQUEST_KINDS[d.kind] || 'Demande') + ' · ' + cRef(d.personId);
      var note = 'Reçue le ' + date(d.receivedOn) + ' (' + (C_REQUEST_CHANNELS[d.channel] || 'autre canal') + ')';
      var li = line(title, d.answeredOn ? note + ' · répondue le ' + date(d.answeredOn) + (d.late ? ', en retard' : ', dans le délai') : note + ' · à répondre avant le ' + date(d.dueOn));
      if (!d.answeredOn) {
        var state = cState();
        var path = '/v1/conformite/demandes/' + encodeURIComponent(d.id);
        if (d.kind === 'acces' || d.kind === 'effacement') {
          li.appendChild(button(d.kind === 'acces' ? 'Assembler la réponse d’accès' : 'Préparer le plan d’effacement (essai)', function () {
            state.textContent = 'Préparation…';
            send(path + (d.kind === 'acces' ? '/acces' : '/effacement'), 'GET').then(function (res) {
              if (res.gone) return;
              if (!res.ok) { state.textContent = cRefusal(res, 'Indisponible pour le moment.'); return; }
              var data = res.body.data;
              state.textContent = (d.kind === 'acces' ? 'Réponse assemblée depuis chaque table du registre. Empreinte : ' : 'Plan prêt, rien n’est effacé. Empreinte : ') + data.sha256;
              // La réponse complète, à remettre à la personne : un fichier sur l'appareil du responsable, jamais gardé
              // par l'application ; la réponse ne se note qu'une fois ce fichier enregistré.
              var file = d.kind === 'acces' ? 'reponse-acces-' : 'plan-effacement-essai-';
              var save = button(d.kind === 'acces' ? 'Enregistrer la réponse complète' : 'Enregistrer le plan d’effacement', function () {
                if (cSave(file + d.id + '.json', { demande: d.id, sorte: d.kind, empreinte: data.sha256, contenu: d.kind === 'acces' ? data.response : data.plan })) {
                  state.textContent = 'Fichier enregistré. Empreinte : ' + data.sha256;
                  answer.hidden = false;
                } else state.textContent = 'Cet appareil ne peut pas enregistrer le fichier.';
              });
              li.insertBefore ? li.insertBefore(save, answer) : li.appendChild(save);
            });
          }));
        }
        var answer = button('Noter la réponse envoyée aujourd’hui', function () { cAct(state, path + '/repondre', { answeredOn: cToday() }, 'Réponse notée.'); });
        // Une demande d'accès ou d'effacement ne se note répondue qu'après l'enregistrement de sa réponse complète.
        answer.hidden = d.kind === 'acces' || d.kind === 'effacement';
        li.appendChild(answer);
        li.appendChild(state);
      }
      ul.appendChild(li);
    });
    box.appendChild(ul);
    var form = el('details', null, 'decision');
    form.appendChild(el('summary', 'Enregistrer une demande reçue'));
    var id = cSeq();
    var person = field(form, id + '-fiche', 'Identifiant de la fiche');
    person.setAttribute('autocomplete', 'off');
    var kind = cSelect(form, id + '-sorte', 'Sorte', C_REQUEST_KINDS);
    var channel = cSelect(form, id + '-canal', 'Canal', C_REQUEST_CHANNELS);
    var received = field(form, id + '-recue', 'Reçue le');
    received.setAttribute('type', 'date');
    received.value = cToday();
    var state = cState();
    form.appendChild(button('Enregistrer la demande', function () {
      cAct(state, '/v1/conformite/demandes', { personId: person.value.trim(), kind: kind.value, channel: channel.value, receivedOn: received.value }, 'Demande enregistrée.');
    }));
    form.appendChild(state);
    box.appendChild(form);
    return box;
  }
  function cProspects(cycles) {
    var box = section('Prospects arrivés à 3 ans');
    box.appendChild(el('p', 'Sans contact venu d’eux depuis 3 ans et sans accord : demande d’accord préparée, puis effacement en essai sans réponse.', 'doux'));
    if (!cycles.length) box.appendChild(el('p', 'Aucun prospect listé.', 'etat'));
    var ul = el('ul', null, 'liste');
    cycles.forEach(function (c) {
      var note = 'Dernier contact le ' + date(c.lastContactAt) + ' · réponse attendue avant le ' + date(c.answerDueOn);
      if (c.request && c.request.blockedBy) note += ' · ' + (C_BLOCKED[c.request.blockedBy] || 'demande non préparée');
      if (c.outcome) note += ' · ' + (C_OUTCOMES[c.outcome] || 'clos');
      ul.appendChild(line(cRef(c.personId) + ' · listé le ' + date(c.listedOn), note));
    });
    box.appendChild(ul);
    return box;
  }
  function cHoursLeft(deadline) {
    var ms = Date.parse(deadline) - Date.now();
    if (!isFinite(ms)) return '';
    if (ms <= 0) return 'échéance passée';
    return 'dans ' + Math.floor(ms / 3600000) + ' h';
  }
  function cBreaches(breaches) {
    var box = section('Fuites et coupures');
    box.appendChild(el('p', 'La CNIL est prévenue dans les 72 heures après la connaissance de la fuite. Couper les accès ne coupe jamais le vôtre.', 'doux'));
    var ul = el('ul', null, 'liste');
    breaches.forEach(function (f) {
      var li = el('li');
      var path = '/v1/conformite/fuites/' + encodeURIComponent(f.id);
      li.appendChild(el('p', 'Fuite connue le ' + date(f.awareAt) + ' à ' + hour(f.awareAt)));
      var left = f.notified.cnil ? 'CNIL prévenue le ' + date(f.notified.cnil.at) + (f.notified.cnil.late ? ', en retard' : '') : f.due.cnil ? 'CNIL à prévenir avant le ' + date(f.deadlineAt) + ' à ' + hour(f.deadlineAt) + ' · ' + cHoursLeft(f.deadlineAt) : 'CNIL : pas de notification due d’après l’évaluation';
      li.appendChild(el('p', left, 'compte' + (!f.notified.cnil && f.due.cnil ? ' urgent' : '')));
      if (f.evaluation) li.appendChild(el('p', 'Évaluée : ' + (C_RISKS[f.evaluation.risk] || 'évaluation rangée') + (f.due.personnes ? ' · les personnes concernées sont à informer' : ''), 'doux'));
      var state = cState();
      (f.cuts || []).forEach(function (c) {
        var cut = el('p', (c.scope === 'tous' ? 'Tous les accès coupés' : 'Un accès coupé') + ' le ' + date(c.cutAt) + ' à ' + hour(c.cutAt) + (c.restoredAt ? ', rétabli le ' + date(c.restoredAt) : ''), 'doux');
        li.appendChild(cut);
        if (!c.restoredAt) li.appendChild(quiet(button('Rétablir cet accès', function () { cAct(state, path + '/retablir', { cutId: c.id }, 'Accès rétabli.'); })));
      });
      var cutting = button('Couper tous les accès maintenant', function () { cAct(state, path + '/couper', { scope: 'tous' }, 'Accès coupés, sauf le vôtre.'); });
      // DS022 · une fuite a un pas à la fois : l'évaluer, puis prévenir la CNIL. Couper reste le geste d'urgence, en
      // rouge, tant que tout n'est pas coupé ; rétablir un accès n'est jamais le pas à faire.
      cutting.className = (f.cuts || []).some(function (c) { return c.scope === 'tous' && !c.restoredAt; }) ? 'secondaire' : 'danger';
      li.appendChild(cutting);
      // L'évaluation est le pas à faire tant qu'elle manque : ouverte. Une fois rangée, elle se rouvre au geste.
      var form = el('details', null, 'decision');
      form.open = !f.evaluation;
      form.appendChild(el('summary', f.evaluation ? 'Revoir l’évaluation' : 'Évaluer la fuite'));
      var id = cSeq();
      var risk = cSelect(form, id + '-risque', 'Risque', C_RISKS, f.evaluation ? f.evaluation.risk : 'eleve');
      var natures = cChecks(form, id + '-nature', 'Atteinte', C_NATURES);
      var categories = cChecks(form, id + '-cat', 'Données touchées', C_CATEGORIES);
      form.appendChild(button('Ranger l’évaluation (tout le réseau)', function () {
        cAct(state, path + '/evaluer', { risk: risk.value, nature: natures(), categories: categories(), scope: { kind: 'reseau' } }, 'Évaluation rangée.');
      }));
      li.appendChild(form);
      if (!f.notified.cnil && f.due.cnil) {
        var notify = el('div', null, 'decision');
        var late = cSelect(notify, id + '-retard', 'Cause du retard, si l’échéance est passée', C_LATE);
        var told = notify.appendChild(button('Noter la CNIL prévenue maintenant', function () {
          var b = { target: 'cnil', notifiedAt: new Date().toISOString() };
          if (Date.now() > Date.parse(f.deadlineAt)) b.lateCause = late.value;
          cAct(state, path + '/notification', b, 'Notification notée.');
        }));
        // Tant que l'évaluation manque, c'est elle le pas à faire : prévenir reste possible, filaire.
        if (!f.evaluation) quiet(told);
        li.appendChild(notify);
      }
      li.appendChild(state);
      ul.appendChild(li);
    });
    if (!breaches.length) box.appendChild(el('p', 'Aucune fuite déclarée.', 'etat'));
    box.appendChild(ul);
    var declare = el('div', null, 'decision');
    var dState = cState();
    declare.appendChild(quiet(button('Déclarer une fuite connue maintenant', function () { cAct(dState, '/v1/conformite/fuites', { awareAt: new Date().toISOString() }, 'Fuite déclarée : l’échéance de 72 heures court.'); })));
    declare.appendChild(dState);
    box.appendChild(declare);
    return box;
  }
  function cRegistry(r) {
    var box = section('Registre des traitements');
    box.appendChild(el('p', (r.initial ? 'Écrit le ' : 'Relu le ') + date(r.lastReviewOn) + ' · prochaine relecture avant le ' + date(r.dueOn)));
    if (r.changedSinceReview) box.appendChild(el('p', 'Le registre a changé depuis la dernière relecture.', 'alerte'));
    box.appendChild(el('p', 'Empreinte du registre : ' + r.registryHash, 'empreinte'));
    var form = el('details', null, 'decision');
    form.appendChild(el('summary', 'Noter une relecture'));
    var id = cSeq();
    var name = field(form, id + '-nom', 'Votre nom');
    var day = field(form, id + '-jour', 'Relu le');
    day.setAttribute('type', 'date');
    day.value = cToday();
    var state = cState();
    form.appendChild(button('Noter la relecture', function () { cAct(state, '/v1/conformite/registre/relecture', { reviewedOn: day.value, validatorName: name.value.trim() }, 'Relecture notée.'); }));
    form.appendChild(state);
    box.appendChild(form);
    return box;
  }

  /* Sur la fiche d'un client : son agent dépose une pièce au coffre et lit la preuve de dépôt, jamais la pièce [R90]. */
  return { open: function (fresh) { if (fresh) cTab = C_TABS[0][0]; return openConformite(); } };
};
`;
