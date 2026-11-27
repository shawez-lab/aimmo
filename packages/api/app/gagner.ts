import { LETTER_RECIPIENT_LABELS } from '../../core/src/mandats/gagner/lettres-quartier.ts';

/**
 * L'écran « Gagner des mandats » de l'application de l'agent (G13), en morceaux posés dans `fichiers.ts` : son entrée
 * sur l'accueil, sa section de page, son chargeur, et son script servi à part (`/app/gagner.js`), chargé à la première
 * ouverture pour tenir le budget de l'application [R201].
 *
 * Quatre parties, dans l'ordre de la journée : les rendez-vous d'estimation à venir et leur dossier de présentation
 * (G07), les recommandations à appeler (G08), les relances d'anciens contacts à valider (G09), les lettres de quartier
 * à préparer, imprimer et noter déposées (G06) ; puis l'entrée de la pige (BR33), dont le script `/app/pige.js` est
 * servi à part et lit `/v1/pige`, et celle de la tournée (BR35), `/app/tournee.js`, qui lit `/v1/tournee`, et celle de la veille des diagnostics (BR36),
 * `/app/veille-dpe.js`, qui lit `/v1/veille-dpe`, et celle de « Mon site » (BR42), `/app/site.js`, qui lit `/v1/site`, et celle des programmes neufs (BR78), `/app/neuf.js`, qui lit `/v1/neuf`, et celle du viager (BR81), `/app/viager.js`, qui lit `/v1/viager`. L'écran lui-même ne lit et n'écrit que par les routes `/v1/gagner` [R16] ; il ne
 * calcule rien, ne trie rien et ne décide rien : il montre ce que le code a décidé, dans l'ordre reçu. Aucun texte ne
 * promet de mandats [R145]. Tout texte reçu est posé avec `textContent`.
 */

const TRIGGER_LABELS = { mandat: 'Après un mandat signé', vente: 'Après une vente' };
const CHANNEL_LABELS = { email: 'Mail', sms: 'SMS', whatsapp: 'WhatsApp', phone: 'Téléphone' };
/** Les raisons d'un refus, dites à l'agent : jamais un code interne. */
const REFUSALS: Record<string, string> = {
  not_assigned: 'Ce n’est pas dans vos droits : suivi par un autre agent.',
  unknown: 'Introuvable : la liste a changé, rouvrez l’écran.',
  agent_inactive: 'Votre accès est fermé.',
  agent_file_incomplete: 'Votre dossier d’agent est incomplet : la direction doit le compléter.',
  not_a_mandate_appointment: 'Ce rendez-vous n’est pas une estimation : pas de dossier.',
  forbidden_source: 'Les adresses viennent de vous seul : jamais des ventes publiques ni d’un fichier acheté.',
  bad_recipient: 'Choisissez le destinataire dans la liste.',
  no_trigger: 'Ce bien n’a ni mandat signé ni vente rapportée : aucune lettre.',
  no_geocoder: 'La vérification des adresses n’est pas en service : aucune lettre pour le moment.',
  property_address_unknown: 'L’adresse du bien n’est pas reconnue : vérifiez-la.',
  center_not_property: 'L’adresse du bien ne correspond pas à sa commune : vérifiez-la.',
  address_unknown: 'Adresse non reconnue.',
  not_an_address: 'Ce n’est pas une adresse connue, mot pour mot.',
  property_itself: 'C’est l’adresse du bien lui-même : retirez-la.',
  out_of_radius: 'Adresse hors du rayon autour du bien.',
  name_in_address: 'Un nom s’y lit : une lettre ne s’adresse jamais à une personne.',
  bad_number: 'Le numéro est manquant ou faux.',
  bad_street: 'La voie est manquante ou incomplète.',
  bad_postcode: 'Le code postal doit avoir 5 chiffres.',
  bad_city: 'La commune est manquante.',
  duplicate_address: 'Adresse en double.',
  bad_addresses: 'De 1 à 200 adresses par campagne.',
  bad_property_address: 'Saisissez l’adresse du bien.',
  text_names_property: 'Le texte situerait le bien : aucune lettre.',
  already_decided: 'Cette relance est déjà traitée.',
  no_consent_on_channel: 'Pas d’accord en cours sur ce canal : choisissez-en un autre.',
  period: 'Une relance est déjà partie dans la période : celle-ci est close.',
  text_length: 'Le texte doit faire entre 20 et 600 caractères environ.',
  text_figure: 'Le texte ne porte aucun chiffre : rien d’inventé.',
  text_link: 'Le texte ne porte aucun lien ni adresse mail.',
  text_reward: 'Aucune récompense ni cadeau dans une relance.',
  text_wording: 'Écrivez « agent immobilier » et « offert », sans parler d’outil.',
  already_assigned: 'Cette recommandation a déjà un agent : relisez la liste.',
  bad_agent: 'Cet agent ne peut pas recevoir cette recommandation : dossier incomplet ou départ. Choisissez-en un autre.',
  awaiting_handover: 'Cette personne attend la passation d’un agent parti : elle se règle par son départ.',
  followed_by_other: 'Cette personne est déjà suivie par un autre agent : choisissez-le.',
};

export const GAGNER_HOME_HTML = `<section class="bloc" aria-labelledby="titre-gagner-accueil">
<h3 id="titre-gagner-accueil">Gagner des mandats</h3>
<p class="etat">Dossiers de vos estimations, recommandations à appeler, relances à valider, lettres à déposer.</p>
<button id="gagner-ouvrir" type="button" class="secondaire">Ouvrir</button>
</section>
`;

export const GAGNER_HTML = `<section id="gagner" hidden>
<button id="gagner-retour" type="button" class="retour">Retour</button>
<h2 id="gagner-titre">Gagner des mandats</h2>
<p class="doux">Chaque ligne vient de la base, avec sa raison. Rien ne part sans vous, et en essai rien ne part du tout.</p>
<p id="gagner-etat" class="etat" role="status"></p>
<div id="gagner-corps"></div>
</section>
`;

export const GAGNER_CSS = `
.compte { font-variant-numeric: tabular-nums; font-weight: 600; }
.jauge { display: block; width: 100%; height: 8px; margin: var(--e-1) 0 var(--e-2); accent-color: var(--accent); }
.preuve-taux { font: 600 var(--t-l)/1.2 var(--police-titre); color: var(--encre); margin: var(--e-1) 0; }
.deposee { color: var(--doux); }
`;

/** Le chargeur posé dans le script de l'application : l'écran est servi à part, chargé une fois, jamais gardé. */
export const GAGNER_JS = `
  /* ---------- M20 : l'écran « Gagner des mandats » (G13), chargé à la demande [R16, R145, R201]. ---------- */
  var gagnerScreen = null;
  function wipeGagner() {
    if (gagnerScreen) { gagnerScreen.wipe(); return; }
    clear($('gagner-corps'));
    $('gagner-etat').textContent = '';
  }
  function openGagner() {
    if (!currentKey) return Promise.resolve(false);
    if (gagnerScreen) return gagnerScreen.open('');
    session += 1;
    var mine = session;
    wipeGagner();
    show('gagner');
    $('gagner-etat').textContent = 'Chargement…';
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.setAttribute('src', '/app/gagner.js');
      s.addEventListener('load', function () {
        var make = globalThis.AIMMO_GAGNER;
        try { delete globalThis.AIMMO_GAGNER; } catch (e) { /* rien */ }
        if (mine !== session || typeof make !== 'function') { resolve(false); return; }
        gagnerScreen = make({ $: $, el: el, clear: clear, send: send, api: api, show: show, button: button, field: field, select: select, details: details, date: date, hour: hour, ficheButton: ficheButton, ID: ID, key: function () { return currentKey; }, session: function () { return session; }, next: function () { session += 1; return session; }, lost: function () { forgetKey(currentKey); refuse('Clé refusée. Vérifiez-la ou demandez-en une nouvelle.'); } });
        resolve(gagnerScreen.open(''));
      });
      s.addEventListener('error', function () {
        if (mine === session) $('gagner-etat').textContent = 'Pas de réseau. Réessayez dans un moment.';
        resolve(false);
      });
      $('gagner').appendChild(s);
    });
  }
`;

/**
 * Le script de l'écran, servi à part (`/app/gagner.js`). Il reçoit les outils de l'application, ne lit et n'écrit que
 * par les routes `/v1/gagner` [R16], et ne garde aucune donnée. Les fichiers à imprimer ou à montrer (lettres, dossier)
 * se téléchargent avec la clé dans l'en-tête, jamais dans l'adresse [R13].
 */
export const GAGNER_SCRIPT = `'use strict';
globalThis.AIMMO_GAGNER = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, show = t.show, button = t.button, field = t.field, select = t.select, details = t.details, date = t.date, hour = t.hour, ID = t.ID;
  var TRIGGERS = ${JSON.stringify(TRIGGER_LABELS)};
  var RECIPIENTS = ${JSON.stringify(LETTER_RECIPIENT_LABELS)};
  var CHANNELS = ${JSON.stringify(CHANNEL_LABELS)};
  var GAGNER_REFUSALS = ${JSON.stringify(REFUSALS)};
  var inside = false;
  function state(text) { $('gagner-etat').textContent = text; }
  function refusal(res, fallback) {
    if (res.offline) return 'La réponse n’est pas arrivée : rien n’est sûr. Relisez avant de recommencer.';
    var b = res.body || {};
    var text = GAGNER_REFUSALS[b.code] || (typeof b.code === 'string' && b.code.indexOf('no_basis') === 0 ? 'La personne n’a plus de base légale pour être relancée : la relance est close.' : fallback);
    return typeof b.index === 'number' ? 'Ligne ' + (b.index + 1) + ' : ' + text : text;
  }
  function wipe() {
    clear($('gagner-corps'));
    state('');
    $('gagner-titre').textContent = 'Gagner des mandats';
    inside = false;
  }
  function when(iso) { var d = date(iso), h = hour(iso); return d ? d + (h ? ' à ' + h : '') : ''; }
  function part(title, count) {
    var box = el('section', null, 'bloc');
    var h = el('h3', title);
    if (typeof count === 'number') h.appendChild(el('span', ' (' + count + ')', 'compte'));
    box.appendChild(h);
    return box;
  }
  /** Un fichier à garder sur l'appareil : la clé dans l'en-tête, une clé refusée efface tout [R13]. */
  function download(path, name) {
    if (!t.key()) return Promise.resolve(false);
    var mine = t.session();
    state('Préparation…');
    return t.api(path, t.key()).then(function (r) {
      if (mine !== t.session()) return false;
      if (r.status === 401) { t.lost(); return false; }
      if (!r.ok) { state('Fichier indisponible pour le moment.'); return false; }
      return r.blob().then(function (blob) {
        if (mine !== t.session()) return false;
        var url = URL.createObjectURL(blob);
        var a = el('a', 'Enregistrer le fichier');
        a.href = url;
        a.download = name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        state('Fichier téléchargé : il reste sur ce téléphone.');
        return true;
      });
    }, function () {
      if (mine === t.session()) state('Pas de réseau. Réessayez dans un moment.');
      return false;
    });
  }

  /* L'écran : quatre lectures, chacune dite à part si elle manque ; l'ordre reçu est gardé, jamais retrié [R35]. */
  function open(message) {
    if (!t.key()) return Promise.resolve(false);
    var mine = t.next();
    wipe();
    show('gagner');
    state('Chargement…');
    return Promise.all([send('/v1/gagner/rendez-vous', 'GET'), send('/v1/gagner/recommandations/a-appeler', 'GET'), send('/v1/gagner/relances', 'GET'), send('/v1/gagner/lettres', 'GET')]).then(function (all) {
      if (mine !== t.session() || all.some(function (r) { return r.gone; })) return false;
      if (all.every(function (r) { return r.offline; })) { state('Pas de réseau. Réessayez dans un moment.'); return false; }
      var body = $('gagner-corps');
      body.appendChild(renderAppointments(all[0]));
      body.appendChild(renderCalls(all[1]));
      body.appendChild(renderFollowups(all[2]));
      body.appendChild(renderLetters(all[3]));
      body.appendChild(renderPige());
      body.appendChild(renderTournee());
      body.appendChild(renderVeille());
      body.appendChild(renderSite());
      body.appendChild(renderCalendrier());
      body.appendChild(renderNeuf());
      body.appendChild(renderViager());
      state(message || '');
      return true;
    });
  }
  /* BR33 · la pige des annonces de particuliers : son script est servi à part, chargé seulement à l'ouverture [R201]. */
  var pigeScreen = null;
  function renderPige() {
    var box = part('Annonces de particuliers');
    box.appendChild(el('p', 'Votre file de pige : rien ne part d’AIMMO, vous collez vous-même le premier message.', 'doux'));
    var inner = el('div');
    var b = button('Ouvrir la pige', function () {
      if (b.disabled) return;
      if (pigeScreen) { pigeScreen.show(inner); return; }
      b.disabled = true;
      var mine = t.session();
      var s = el('script');
      s.setAttribute('src', '/app/pige.js');
      s.addEventListener('load', function () {
        var make = globalThis.AIMMO_PIGE;
        try { delete globalThis.AIMMO_PIGE; } catch (e) { /* rien */ }
        b.disabled = false;
        if (mine !== t.session() || typeof make !== 'function') return;
        pigeScreen = make({ el: el, clear: clear, send: send, button: button, date: date, ID: ID });
        pigeScreen.show(inner);
      });
      s.addEventListener('error', function () { b.disabled = false; if (mine === t.session()) { clear(inner); inner.appendChild(el('p', 'Pas de réseau. Réessayez dans un moment.', 'etat')); } });
      box.appendChild(s);
    });
    box.appendChild(b);
    box.appendChild(inner);
    return box;
  }
  /* BR35 · la tournée du jour et la carte des opportunités : script servi à part, chargé à l'ouverture [R201]. */
  var tourneeScreen = null;
  function renderTournee() {
    var box = part('Ma tournée de prospection');
    box.appendChild(el('p', 'Panneaux, lettres et portes à faire, calés entre vos rendez-vous : rien n’est réservé.', 'doux'));
    var inner = el('div');
    var b = button('Ouvrir ma tournée', function () {
      if (b.disabled) return;
      if (tourneeScreen) { tourneeScreen.show(inner); return; }
      b.disabled = true;
      var mine = t.session();
      var s = el('script');
      s.setAttribute('src', '/app/tournee.js');
      s.addEventListener('load', function () {
        var make = globalThis.AIMMO_TOURNEE;
        try { delete globalThis.AIMMO_TOURNEE; } catch (e) { /* rien */ }
        b.disabled = false;
        if (mine !== t.session() || typeof make !== 'function') return;
        tourneeScreen = make({ el: el, clear: clear, send: send, button: button, hour: hour });
        tourneeScreen.show(inner);
      });
      s.addEventListener('error', function () { b.disabled = false; if (mine === t.session()) { clear(inner); inner.appendChild(el('p', 'Pas de réseau. Réessayez dans un moment.', 'etat')); } });
      box.appendChild(s);
    });
    box.appendChild(b);
    box.appendChild(inner);
    return box;
  }
  /* BR36 · la veille des diagnostics énergétiques : script servi à part, chargé à l'ouverture [R201]. */
  var veilleScreen = null;
  function renderVeille() {
    var box = part('Veille des diagnostics énergétiques');
    box.appendChild(el('p', 'Les nouveaux diagnostics de vos communes, chaque matin ; la lettre d’un logement F ou G s’imprime.', 'doux'));
    var inner = el('div');
    var b = button('Ouvrir la veille', function () {
      if (b.disabled) return;
      if (veilleScreen) { veilleScreen.show(inner); return; }
      b.disabled = true;
      var mine = t.session();
      var s = el('script');
      s.setAttribute('src', '/app/veille-dpe.js');
      s.addEventListener('load', function () {
        var make = globalThis.AIMMO_VEILLE_DPE;
        try { delete globalThis.AIMMO_VEILLE_DPE; } catch (e) { /* rien */ }
        b.disabled = false;
        if (mine !== t.session() || typeof make !== 'function') return;
        veilleScreen = make({ el: el, clear: clear, send: send, button: button, download: download, ID: ID });
        veilleScreen.show(inner);
      });
      s.addEventListener('error', function () { b.disabled = false; if (mine === t.session()) { clear(inner); inner.appendChild(el('p', 'Pas de réseau. Réessayez dans un moment.', 'etat')); } });
      box.appendChild(s);
    });
    box.appendChild(b);
    box.appendChild(inner);
    return box;
  }
  /* BR42 · « Mon site » : quelle page amène des vendeurs, et la prochaine à écrire ; script servi à part [R201]. */
  var siteScreen = null;
  function renderSite() {
    var box = part('Mon site');
    box.appendChild(el('p', 'Quelle page amène des vendeurs, prouvé par leurs messages, et la prochaine page à écrire.', 'doux'));
    var inner = el('div');
    var b = button('Ouvrir mon site', function () {
      if (b.disabled) return;
      if (siteScreen) { siteScreen.show(inner); return; }
      b.disabled = true;
      var mine = t.session();
      var s = el('script');
      s.setAttribute('src', '/app/site.js');
      s.addEventListener('load', function () {
        var make = globalThis.AIMMO_SITE;
        try { delete globalThis.AIMMO_SITE; } catch (e) { /* rien */ }
        b.disabled = false;
        if (mine !== t.session() || typeof make !== 'function') return;
        siteScreen = make({ el: el, clear: clear, send: send, button: button });
        siteScreen.show(inner);
      });
      s.addEventListener('error', function () { b.disabled = false; if (mine === t.session()) { clear(inner); inner.appendChild(el('p', 'Pas de réseau. Réessayez dans un moment.', 'etat')); } });
      box.appendChild(s);
    });
    box.appendChild(b);
    box.appendChild(inner);
    return box;
  }
  /* BR111 · mon calendrier de publication : script servi à part (/app/calendrier.js), chargé au premier geste [R201, R581]. */
  var calScreen = null;
  function renderCalendrier() {
    var box = part('Calendrier de publication');
    box.appendChild(el('p', 'Combien de publications par réseau et par jour, à quelles heures, et les créneaux réservés pour vos biens.', 'doux'));
    var inner = el('div');
    var b = button('Ouvrir mon calendrier', function () {
      if (b.disabled) return;
      if (calScreen) { calScreen.show(inner); return; }
      b.disabled = true;
      var mine = t.session();
      var s = el('script');
      s.setAttribute('src', '/app/calendrier.js');
      s.addEventListener('load', function () {
        var make = globalThis.AIMMO_CALENDRIER;
        try { delete globalThis.AIMMO_CALENDRIER; } catch (e) { /* rien */ }
        b.disabled = false;
        if (mine !== t.session()) return;
        if (typeof make !== 'function') { clear(inner); inner.appendChild(el('p', 'Indisponible pour le moment. Réessayez dans un moment.', 'etat')); return; }
        calScreen = make({ el: el, clear: clear, send: send, button: button, field: field, session: t.session });
        calScreen.show(inner);
      });
      s.addEventListener('error', function () { b.disabled = false; if (mine === t.session()) { clear(inner); inner.appendChild(el('p', 'Pas de réseau. Réessayez dans un moment.', 'etat')); } });
      box.appendChild(s);
    });
    box.appendChild(b);
    box.appendChild(inner);
    return box;
  }
  /* BR78 · la grille de mes programmes neufs : script servi à part, chargé à l'ouverture [R201]. */
  var neufScreen = null;
  function renderNeuf() {
    var box = part('Programmes neufs');
    box.appendChild(el('p', 'Les programmes que la direction vous confie : la grille publiée, ses frais sourcés, et l’état de chaque lot.', 'doux'));
    var inner = el('div');
    var b = button('Ouvrir mes programmes', function () {
      if (b.disabled) return;
      if (neufScreen) { neufScreen.show(inner); return; }
      b.disabled = true;
      var mine = t.session();
      var s = el('script');
      s.setAttribute('src', '/app/neuf.js');
      s.addEventListener('load', function () {
        var make = globalThis.AIMMO_NEUF;
        try { delete globalThis.AIMMO_NEUF; } catch (e) { /* rien */ }
        b.disabled = false;
        if (mine !== t.session() || typeof make !== 'function') return;
        neufScreen = make({ el: el, clear: clear, send: send, button: button });
        neufScreen.show(inner);
      });
      s.addEventListener('error', function () { b.disabled = false; if (mine === t.session()) { clear(inner); inner.appendChild(el('p', 'Pas de réseau. Réessayez dans un moment.', 'etat')); } });
      box.appendChild(s);
    });
    box.appendChild(b);
    box.appendChild(inner);
    return box;
  }
  /* BR81 · le calcul de viager : script servi à part, chargé à l'ouverture [R201]. */
  var viagerScreen = null;
  function renderViager() {
    var box = part('Viager');
    box.appendChild(el('p', 'Pour le bien d’un vendeur que vous suivez : bouquet et rente estimés, chaque chiffre avec sa source, et l’expert du viager proposé.', 'doux'));
    var inner = el('div');
    var b = button('Calculer un viager', function () {
      if (b.disabled) return;
      if (viagerScreen) { viagerScreen.show(inner); return; }
      b.disabled = true;
      var mine = t.session();
      var s = el('script');
      s.setAttribute('src', '/app/viager.js');
      s.addEventListener('load', function () {
        var make = globalThis.AIMMO_VIAGER;
        try { delete globalThis.AIMMO_VIAGER; } catch (e) { /* rien */ }
        b.disabled = false;
        if (mine !== t.session() || typeof make !== 'function') return;
        viagerScreen = make({ el: el, clear: clear, send: send, button: button });
        viagerScreen.show(inner);
      });
      s.addEventListener('error', function () { b.disabled = false; if (mine === t.session()) { clear(inner); inner.appendChild(el('p', 'Pas de réseau. Réessayez dans un moment.', 'etat')); } });
      box.appendChild(s);
    });
    box.appendChild(b);
    box.appendChild(inner);
    return box;
  }
  function list(res) { return res.ok && Array.isArray(res.body.data) ? res.body.data : null; }
  function missing(box, res) { box.appendChild(el('p', res.offline ? 'Pas de réseau pour cette partie.' : refusal(res, 'Indisponible pour le moment.'), 'etat')); return box; }

  /* G07 · les rendez-vous d'estimation à venir et leur dossier. */
  function renderAppointments(res) {
    var items = list(res);
    var box = part('Mes estimations à venir', items ? items.length : undefined);
    if (!items) return missing(box, res);
    if (!items.length) box.appendChild(el('p', 'Aucune estimation prévue dans les quinze jours.', 'doux'));
    var ul = el('ul', null, 'liste');
    items.forEach(function (a) {
      if (!ID.test(a.appointmentId)) return;
      var li = el('li');
      li.appendChild(el('strong', when(a.startAt)));
      li.appendChild(el('p', (a.reference ? 'Bien ' + a.reference : 'Bien à préciser') + (a.city ? ', ' + a.city : ''), 'doux'));
      li.appendChild(button('Ouvrir le dossier', function () { openDossier(a); }));
      ul.appendChild(li);
    });
    box.appendChild(ul);
    return box;
  }
  function openDossier(a) {
    var mine = t.next();
    clear($('gagner-corps'));
    inside = true;
    $('gagner-titre').textContent = 'Dossier du ' + when(a.startAt);
    state('Chargement…');
    var base = '/v1/gagner/rendez-vous/' + encodeURIComponent(a.appointmentId) + '/dossier';
    return send(base, 'GET').then(function (res) {
      if (res.gone || mine !== t.session()) return false;
      if (!res.ok || !res.body.data) { state(res.offline ? 'Pas de réseau. Réessayez dans un moment.' : refusal(res, 'Dossier indisponible.')); return false; }
      renderDossier($('gagner-corps'), res.body.data, base);
      state('Chaque chiffre vient de la base, avec sa source. Aucune promesse de prix ni de délai.');
      return true;
    });
  }
  function renderDossier(body, d, base) {
    body.appendChild(el('p', d.welcome));
    body.appendChild(button('Télécharger le dossier à montrer au client', function () { download(base + '/page', 'dossier-de-presentation.html'); }));
    var sales = part('Les ventes du quartier');
    if (!d.sales) sales.appendChild(el('p', 'Pas encore d’avis de valeur validé pour ce bien.', 'doux'));
    else {
      sales.appendChild(el('p', 'Source : ' + (d.sales.source || 'non précisée') + '. Avis validé le ' + d.sales.validatedOn + '.' + (d.sales.recentMissing ? ' Les ventes les plus récentes ne sont pas encore publiées.' : '') + (d.sales.dvfNotCovered ? ' Département non couvert par les ventes publiques : ventes connues de l’agence.' : ''), 'doux'));
      var ul = el('ul', null, 'liste');
      (Array.isArray(d.sales.items) ? d.sales.items : []).forEach(function (s) { ul.appendChild(el('li', s.month + ' · ' + s.surfaceM2 + ' m² · ' + s.pricePerM2 + ' €/m² · à ' + s.distanceM + ' m')); });
      sales.appendChild(ul);
    }
    body.appendChild(sales);
    var plan = part('Le plan de vente');
    var pl = el('ol', null, 'liste');
    (Array.isArray(d.plan) ? d.plan : []).forEach(function (p) { pl.appendChild(el('li', p)); });
    plan.appendChild(pl);
    body.appendChild(plan);
    var eng = part('Mes engagements, et ce que j’ai réellement tenu');
    eng.appendChild(el('p', 'Du ' + d.period.from + ' au ' + d.period.to + ', recalculé depuis la base.', 'doux'));
    if (!d.commitments.length) eng.appendChild(el('p', 'Aucun engagement réglé par la direction.', 'doux'));
    d.commitments.forEach(function (c) {
      eng.appendChild(el('h4', c.label));
      eng.appendChild(el('p', c.total === 0 ? 'Aucun cas sur la période' : 'Tenu ' + c.kept + ' fois sur ' + c.total, 'preuve-taux'));
      if (c.total > 0) {
        var m = el('meter', null, 'jauge');
        m.setAttribute('min', '0');
        m.setAttribute('max', String(c.total));
        m.setAttribute('value', String(c.kept));
        m.setAttribute('aria-label', 'Tenu ' + c.kept + ' fois sur ' + c.total);
        eng.appendChild(m);
      }
      eng.appendChild(el('p', c.rule + ' Délai : ' + c.delayHours + ' h. Version ' + c.version + '.', 'doux'));
      var proof = details(eng, 'Le détail, cas par cas');
      var pu = el('ul', null, 'liste');
      c.proof.forEach(function (p) { pu.appendChild(el('li', p.day + ' : ' + (p.kept ? 'tenu' : 'non tenu'))); });
      proof.appendChild(pu);
    });
    body.appendChild(eng);
    var rev = part('Les avis de mes clients');
    rev.appendChild(el('p', d.reviews.source + '.', 'doux'));
    rev.appendChild(el('p', d.reviews.count === 0 ? 'Aucun avis sur la période.' : d.reviews.count + ' avis, note moyenne ' + String(d.reviews.average).replace('.', ',') + ' sur 5.'));
    body.appendChild(rev);
    var res = part('Mes résultats');
    res.appendChild(el('p', d.results.source + '.', 'doux'));
    res.appendChild(el('p', d.results.mandates + ' mandats signés · ' + d.results.sales + ' ventes conclues · ' + d.results.estimationsHonored + ' estimations tenues'));
    body.appendChild(res);
  }

  /* G08 · les recommandations à appeler, dans l'ordre de leur échéance. */
  function renderCalls(res) {
    var items = list(res);
    var box = part('Recommandations à appeler', items ? items.length : undefined);
    if (!items) return missing(box, res);
    if (!items.length) box.appendChild(el('p', 'Aucune recommandation à appeler.', 'doux'));
    var ul = el('ul', null, 'liste');
    items.forEach(function (r) {
      if (!ID.test(r.recommendationId) || !ID.test(r.personId)) return;
      var li = el('li');
      li.appendChild(el('strong', r.firstName || 'Prénom inconnu'));
      li.appendChild(el('p', r.sourceLabel + ' · accord pour ' + (CHANNELS[r.channel] || 'un canal') + ' · à appeler avant le ' + when(r.dueAt), 'doux'));
      li.appendChild(t.ficheButton(r.personId));
      if (r.assignable) { li.appendChild(assignBox(r)); ul.appendChild(li); return; }
      li.appendChild(button('Appel fait', function () {
        state('Envoi…');
        send('/v1/gagner/recommandations/' + encodeURIComponent(r.recommendationId) + '/appel-fait', 'POST').then(function (x) {
          if (x.gone) return;
          if (!x.ok) { state(refusal(x, 'L’appel n’est pas noté.')); return; }
          open('Appel noté.');
        });
      }));
      ul.appendChild(li);
    });
    box.appendChild(ul);
    return box;
  }

  /* G16 · une recommandation sans agent : la direction choisit l'agent dans la liste, dans l'ordre reçu [R35]. */
  function assignBox(r) {
    var box = el('div');
    box.appendChild(el('p', 'Sans agent : personne ne l’appellera tant qu’elle n’est pas attribuée.', 'doux'));
    var loading = false;
    box.appendChild(button('Choisir l’agent', function () {
      if (loading) return false;
      loading = true;
      state('Chargement…');
      return send('/v1/gagner/recommandations/agents', 'GET').then(function (res) {
        loading = false;
        if (res.gone) return;
        var agents = list(res);
        if (!agents) { state(res.offline ? 'Pas de réseau. Réessayez dans un moment.' : refusal(res, 'La liste des agents n’est pas disponible.')); return; }
        state('');
        clear(box);
        var usable = agents.filter(function (a) { return ID.test(a.agentId); });
        if (!usable.length) { box.appendChild(el('p', 'Aucun agent en activité : rien à attribuer pour le moment.', 'etat')); return; }
        var options = { '': 'Choisissez un agent' };
        usable.forEach(function (a) { options[a.agentId] = a.firstName + ' ' + a.lastName; });
        var pick = select(box, 'gagner-attribuer-' + r.recommendationId, 'Agent', options, '');
        var busy = false;
        box.appendChild(button('Attribuer', function () {
          if (busy) return false;
          if (!pick.value) { state('Choisissez un agent.'); return false; }
          busy = true;
          state('Envoi…');
          return send('/v1/gagner/recommandations/' + encodeURIComponent(r.recommendationId) + '/attribuer', 'POST', { agentId: pick.value }).then(function (x) {
            busy = false;
            if (x.gone) return false;
            if (!x.ok) { state(refusal(x, 'La recommandation n’est pas attribuée.')); return false; }
            return open('Recommandation attribuée : l’agent la voit dans sa liste.');
          });
        }));
      });
    }));
    return box;
  }

  /* G09 · les relances d'anciens contacts à valider : la raison écrite, le texte proposé, modifiable. */
  function renderFollowups(res) {
    var items = list(res);
    var box = part('Relances à valider', items ? items.length : undefined);
    if (!items) return missing(box, res);
    if (!items.length) box.appendChild(el('p', 'Aucune relance à valider ce mois-ci.', 'doux'));
    items.forEach(function (f, i) {
      if (!ID.test(f.followupId)) return;
      var item = el('article', null, 'bloc');
      item.appendChild(el('strong', f.firstName || 'Prénom inconnu'));
      item.appendChild(el('p', f.reasonLabel + ' (' + date(f.reasonDay + 'T12:00:00Z') + ')', 'doux'));
      item.appendChild(t.ficheButton(f.personId));
      var text = field(item, 'gagner-relance-' + i, 'Texte de la relance' + (f.draftBy === 'ia' ? ', proposé, à relire' : ''), 'textarea');
      text.value = f.draft;
      var channel = select(item, 'gagner-canal-' + i, 'Canal', { '': 'Le canal accordé', email: CHANNELS.email, sms: CHANNELS.sms, whatsapp: CHANNELS.whatsapp }, '');
      item.appendChild(button('Je l’ai relue : valider', function () {
        var b = {};
        if (text.value !== f.draft) b.text = text.value;
        if (channel.value) b.channel = channel.value;
        state('Envoi…');
        send('/v1/gagner/relances/' + encodeURIComponent(f.followupId) + '/valider', 'POST', b).then(function (x) {
          if (x.gone) return;
          if (!x.ok) { state(refusal(x, 'La relance n’est pas validée.')); return; }
          var st = x.body.data && x.body.data.status;
          open(st === 'attente' ? 'Hors des heures d’envoi : la relance reste à valider.' : st === 'refusee' ? 'Le contrôle des envois l’a refusée : rien n’est parti.' : 'Relance validée. En essai, rien ne part.');
        });
      }));
      box.appendChild(item);
    });
    return box;
  }

  /* G06 · les lettres de quartier : campagnes, dépôts, et une nouvelle campagne. */
  function renderLetters(res) {
    var data = res.ok && res.body.data ? res.body.data : null;
    var campaigns = data && Array.isArray(data.campaigns) ? data.campaigns : null;
    var box = part('Lettres de quartier', campaigns ? campaigns.length : undefined);
    if (!campaigns) return missing(box, res);
    if (!campaigns.length) box.appendChild(el('p', 'Aucune campagne pour le moment.', 'doux'));
    var ul = el('ul', null, 'liste');
    campaigns.forEach(function (c) {
      if (!ID.test(c.campaignId)) return;
      var li = el('li');
      li.appendChild(el('strong', 'Bien ' + c.reference + ' · ' + (TRIGGERS[c.trigger] || '')));
      li.appendChild(el('p', (RECIPIENTS[c.recipient] || '') + ' · préparée le ' + date(c.createdAt), 'doux'));
      li.appendChild(el('p', c.deposited + ' déposée(s) sur ' + c.letters, 'compte'));
      var m = el('meter', null, 'jauge');
      m.setAttribute('min', '0');
      m.setAttribute('max', String(c.letters));
      m.setAttribute('value', String(c.deposited));
      m.setAttribute('aria-label', c.deposited + ' lettres déposées sur ' + c.letters);
      li.appendChild(m);
      li.appendChild(button('Ouvrir la tournée', function () { openCampaign(c); }));
      ul.appendChild(li);
    });
    box.appendChild(ul);
    renderNewCampaign(box, Array.isArray(data.properties) ? data.properties : []);
    return box;
  }
  /** Une ligne saisie : « 12 bis rue des Lilas, 21000 Dijon ». Le serveur refait tous les contrôles [R140]. */
  function parseAddress(line) {
    var m = /^\\s*(\\d{1,4}\\s?(?:bis|ter|quater|[a-dA-D])?)\\s*,?\\s+(.+?)\\s*,?\\s+(\\d{5})\\s+(.+?)\\s*$/i.exec(line);
    return m ? { number: m[1].replace(/\\s+/g, ' '), street: m[2], postcode: m[3], city: m[4] } : null;
  }
  function renderNewCampaign(box, properties) {
    var form = details(box, 'Préparer une campagne');
    if (!properties.length) { form.appendChild(el('p', 'Aucun de vos biens n’a de mandat signé ni de vente rapportée.', 'doux')); return; }
    var options = {};
    properties.forEach(function (p) { if (ID.test(p.propertyId)) options[p.propertyId] = 'Bien ' + p.reference + (p.city ? ', ' + p.city : ''); });
    var first = Object.keys(options)[0] || '';
    var bien = select(form, 'gagner-bien', 'Bien', options, first);
    var trig = select(form, 'gagner-evenement', 'Événement', TRIGGERS, 'mandat');
    var to = select(form, 'gagner-destinataire', 'Destinataire', RECIPIENTS, 'aux_habitants');
    var center = field(form, 'gagner-adresse-bien', 'Adresse du bien, pour vérifier le rayon');
    var lines = field(form, 'gagner-adresses', 'Adresses voisines que vous avez relevées, une par ligne : numéro, voie, code postal, commune', 'textarea');
    form.appendChild(el('p', 'Jamais un nom : la lettre est adressée « Au propriétaire » ou « Aux habitants ». Jamais une adresse tirée des ventes publiques ni d’un fichier acheté.', 'doux'));
    form.appendChild(button('Préparer les lettres', function () {
      var chosen = properties.filter(function (p) { return p.propertyId === bien.value; })[0];
      if (!chosen) { state('Choisissez un bien.'); return; }
      if (!Array.isArray(chosen.triggers) || chosen.triggers.indexOf(trig.value) === -1) { state('Ce bien n’a pas cet événement : choisissez l’autre.'); return; }
      var raw = String(lines.value || '').split(/\\r?\\n/).filter(function (l) { return l.trim() !== ''; });
      if (!raw.length) { state('Saisissez au moins une adresse.'); return; }
      var addresses = [];
      for (var i = 0; i < raw.length; i++) {
        var a = parseAddress(raw[i]);
        if (!a) { state('Ligne ' + (i + 1) + ' : écrivez numéro, voie, code postal et commune.'); return; }
        addresses.push(a);
      }
      state('Vérification des adresses…');
      send('/v1/gagner/lettres', 'POST', { propertyId: chosen.propertyId, trigger: trig.value, propertyAddress: center.value.trim(), recipient: to.value, origin: 'saisie_agent', addresses: addresses }).then(function (x) {
        if (x.gone) return;
        if (!x.ok) { state(refusal(x, 'La campagne n’est pas préparée.')); return; }
        open(x.body.data.letters + ' lettre(s) prête(s) à imprimer.');
      });
    }));
  }
  function openCampaign(c, message) {
    var mine = t.next();
    clear($('gagner-corps'));
    inside = true;
    $('gagner-titre').textContent = 'Tournée du bien ' + c.reference;
    state('Chargement…');
    var base = '/v1/gagner/lettres/' + encodeURIComponent(c.campaignId);
    return send(base, 'GET').then(function (res) {
      if (res.gone || mine !== t.session()) return false;
      var letters = list(res);
      if (!letters) { state(res.offline ? 'Pas de réseau. Réessayez dans un moment.' : refusal(res, 'Tournée indisponible.')); return false; }
      var body = $('gagner-corps');
      body.appendChild(button('Télécharger les lettres à imprimer', function () { download(base + '/impression', 'lettres-' + c.reference + '.html'); }));
      var ul = el('ul', null, 'liste');
      letters.forEach(function (l) {
        if (!ID.test(l.letterId)) return;
        var li = el('li');
        li.appendChild(el('strong', l.number + ' ' + l.street));
        li.appendChild(el('p', l.postcode + ' ' + l.city + ' · à ' + l.distanceM + ' m du bien', 'doux'));
        if (l.depositedAt) li.appendChild(el('p', 'Déposée le ' + when(l.depositedAt), 'deposee'));
        else li.appendChild(button('Déposée', function () {
          state('Envoi…');
          send('/v1/gagner/lettres/lettre/' + encodeURIComponent(l.letterId) + '/deposee', 'POST').then(function (x) {
            if (x.gone) return;
            if (!x.ok) { state(refusal(x, 'Le dépôt n’est pas noté.')); return; }
            openCampaign(c, 'Dépôt noté.');
          });
        }));
        ul.appendChild(li);
      });
      body.appendChild(ul);
      var left = letters.filter(function (l) { return !l.depositedAt; }).length;
      state(message ? message + ' ' : '');
      $('gagner-etat').textContent += left === 0 ? 'Toutes les lettres sont déposées.' : left + ' lettre(s) encore à déposer.';
      return true;
    });
  }
  return { open: open, wipe: wipe, inside: function () { return inside; } };
};
`;
