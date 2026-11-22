import { ADJUSTMENT_LABELS, AGENT_ADJUSTMENT_MOTIVES } from '../../core/src/estimation/fourchette.ts';
import { SALE_EXCLUSION_REASONS } from '../../core/src/estimation/avis.ts';

/**
 * L'écran « Avis de valeur » de l'application de l'agent (E10), en morceaux posés dans `fichiers.ts` : sa section, son
 * chargeur et son script, servi à part (`/app/avis.js`) et chargé à la première ouverture pour tenir le budget [R201].
 * Il s'ouvre depuis un bien de la liste « Mes biens ».
 *
 * L'écran ne lit et n'écrit que par les routes de l'avis [R16, R30]. Il ne calcule rien : la fourchette vient du code,
 * et l'agent l'ajuste. L'adresse saisie part à la préparation ; vérifiée, le serveur la garde pour le prochain avis, et
 * l'écran ne la remontre jamais : laissée vide, elle est reprise, donnée, elle la remplace (AU052, R695) [R46]. Sans
 * fourchette possible, l'agent ouvre un avis motivé par ses propres ventes vérifiées (AU046, R690). L'avis validé se
 * télécharge en page à imprimer ; rien ne part d'ici vers le vendeur [R26]. Tout texte reçu est posé avec `textContent`.
 * Un brouillon calculé montre les ventes qu'il cite, sans numéro de voie [R29] : l'agent en écarte une avec un motif de
 * la liste [R692], ou retient son propre coefficient avec un motif [R693] ; cela prépare une nouvelle version, et les
 * versions précédentes restent listées, telles quelles (AU049b).
 */

/** Les raisons d'un refus, dites à l'agent : jamais un code interne. */
const REFUSALS = {
  invalid: 'Vérifiez l’adresse et le type de logement.',
  not_configured: 'Les ventes ne sont pas encore branchées : l’avis ne peut pas se préparer.',
  sales_unavailable: 'Les ventes ne répondent pas : réessayez dans un moment.',
  not_a_home: 'Un avis de valeur se prépare ici pour un logement, un terrain ou un immeuble.',
  address_needed: 'Donnez l’adresse du bien : aucune adresse vérifiée n’est encore gardée pour lui.',
  invalid_references: 'Vérifiez vos ventes : de 3 à 20, chacune avec son mois (moins de 5 ans), sa surface, son prix et sa preuve ; la voie sans numéro.',
  not_verified: 'Cochez la case : chaque vente doit avoir été vérifiée par vous.',
  range_far_from_references: 'Cette fourchette s’écarte trop de vos ventes vérifiées.',
  range_available: 'Le calcul donne une fourchette pour ce bien : préparez l’avis sans vos ventes.',
  no_surface: 'Renseignez d’abord la surface du bien.',
  address_not_found: 'Adresse introuvable ou incertaine : précisez-la.',
  other_town: 'Cette adresse n’est pas dans la commune du bien.',
  type: 'Le calcul ne traite que les appartements et les maisons : donnez vos ventes vérifiées.',
  adresse: 'Il manque l’adresse ou la surface pour calculer.',
  hors_zone: 'Ce département n’est pas encore couvert par nos ventes.',
  dvf_non_couvert: 'Les ventes publiques ne couvrent pas ce département.',
  donnees_absentes: 'Les ventes ne sont pas disponibles pour le moment.',
  peu_de_ventes: 'Trop peu de ventes comparables pour une fourchette fiable.',
  not_following_agent: 'Seul l’agent qui suit ce bien prépare et valide son avis.',
  already_validated: 'Cet avis est déjà validé : il ne change plus.',
  changed_meanwhile: 'L’avis a changé entre-temps : relisez-le, puis recommencez.',
  invalid_range: 'La fourchette doit aller d’un montant à un montant plus haut.',
  text_refused: 'Ce texte est refusé : il porte un chiffre qui ne vient pas du calcul, ou ne convient pas à un client.',
  range_not_in_text: 'Le texte doit dire la fourchette retenue, telle quelle.',
  other_range_in_text: 'Le texte dit encore la fourchette du calcul : corrigez-le.',
  invalid_exclusion: 'Cette vente ne peut pas être écartée : choisissez une vente citée par cet avis et un motif.',
  unknown_previous: 'Cette version de l’avis n’existe plus : rouvrez l’écran.',
  too_many_exclusions: 'Dix ventes écartées au plus : l’avis ne serait plus fiable.',
  invalid_adjustment: 'Ajustement refusé : une caractéristique du barème, un pourcentage entier de -15 à +15 et un motif.',
  too_many_adjustments: 'Cinq ajustements de votre part au plus.',
};

/** Les listes fermées des motifs, reprises du calcul : l'écran n'en invente aucun [R692, R693]. */
const CHOICES = {
  reasons: Object.entries(SALE_EXCLUSION_REASONS),
  motives: Object.entries(AGENT_ADJUSTMENT_MOTIVES),
  labels: [...ADJUSTMENT_LABELS],
};

export const AVIS_HTML = `<section id="avis" hidden>
<button id="avis-retour" type="button" class="retour">Retour à ma journée</button>
<h2 id="avis-titre">Avis de valeur</h2>
<p id="avis-etat" class="etat" role="status"></p>
<div id="avis-corps"></div>
</section>
`;

/** Le chargeur posé dans le script de l'application : l'écran est servi à part, chargé une fois, jamais gardé. */
export const AVIS_JS = `
  /* ---------- M04 : l'écran « Avis de valeur » (E10), chargé à la demande [R16, R30, R201]. ---------- */
  var avisScreen = null;
  function wipeAvis() {
    if (avisScreen) { avisScreen.wipe(); return; }
    clear($('avis-corps'));
    $('avis-etat').textContent = '';
  }
  function openAvis(id, reference) {
    if (!currentKey || !ID.test(id)) return Promise.resolve(false);
    if (avisScreen) return avisScreen.open(id, reference);
    session += 1;
    var mine = session;
    wipeAvis();
    show('avis', [id, reference]);
    $('avis-etat').textContent = 'Chargement…';
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.setAttribute('src', '/app/avis.js');
      s.addEventListener('load', function () {
        var make = globalThis.AIMMO_AVIS;
        try { delete globalThis.AIMMO_AVIS; } catch (e) { /* rien */ }
        if (mine !== session || typeof make !== 'function') { resolve(false); return; }
        avisScreen = make({ $: $, el: el, clear: clear, send: send, api: api, button: button, field: field, show: show, ID: ID, key: function () { return currentKey; }, session: function () { return session; }, bump: function () { session += 1; }, lost: function () { forgetKey(currentKey); refuse('Clé refusée. Vérifiez-la ou demandez-en une nouvelle.'); } });
        resolve(avisScreen.open(id, reference));
      });
      s.addEventListener('error', function () {
        if (mine === session) $('avis-etat').textContent = 'Pas de réseau. Réessayez dans un moment.';
        resolve(false);
      });
      $('avis').appendChild(s);
    });
  }
`;

/** Le script de l'écran, servi à part (`/app/avis.js`). Il ne garde rien une fois l'écran quitté. */
export const AVIS_SCRIPT = `'use strict';
globalThis.AIMMO_AVIS = function (t) {
  // AU105 · les brouillons de cet appareil, rangés par ce qu'ils concernent ; la sortie les efface.
  var DRAFTS = 'aimmo.brouillons';
  function dAll() { try { var a = JSON.parse(localStorage.getItem(DRAFTS) || '{}'); return a && typeof a === 'object' && !Array.isArray(a) ? a : {}; } catch (e) { return {}; } }
  function dPut(a) { try { localStorage.setItem(DRAFTS, JSON.stringify(a)); return true; } catch (e) { return false; } }
  var drafts = {
    get: function (k) { var d = dAll()[k]; return d && typeof d === 'object' ? d : null; },
    set: function (k, v) { var a = dAll(); a[k] = { at: new Date().toISOString(), value: v }; return dPut(a); },
    drop: function (k) { var a = dAll(); if (k in a) { delete a[k]; dPut(a); } },
  };
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, show = t.show, ID = t.ID;
  var NO = ${JSON.stringify(REFUSALS)};
  var CH = ${JSON.stringify(CHOICES)};
  var cur = null, seq = 0;
  function state(x) { $('avis-etat').textContent = x; }
  function body() { return $('avis-corps'); }
  function money(n) { return String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ' ') + ' €'; }
  function why(res, fallback) {
    if (res.offline) return 'La réponse n’est pas arrivée : rien n’est sûr. Relisez avant de recommencer.';
    return (res.body && NO[res.body.code]) || (res.status === 403 || res.status === 404 ? 'Ce bien n’est pas dans vos droits.' : fallback);
  }
  function wipe() { seq += 1; clear(body()); state(''); $('avis-titre').textContent = 'Avis de valeur'; cur = null; }
  function open(id, reference) {
    if (!t.key() || !ID.test(id)) return Promise.resolve(false);
    t.bump();
    wipe();
    cur = { id: id, reference: reference || 'ce bien' };
    $('avis-titre').textContent = 'Avis de valeur · ' + cur.reference;
    show('avis', [id, reference]);
    return load();
  }
  function base() { return '/v1/biens/' + encodeURIComponent(cur.id) + '/avis'; }
  // Le plus récent est le seul montré : le serveur les rend du plus récent au plus ancien.
  function load(message) {
    var mine = ++seq;
    state('Chargement…');
    return send(base(), 'GET').then(function (res) {
      if (res.gone || mine !== seq) return false;
      // Le geste a réussi, seule la relecture manque : on le dit, sans laisser un formulaire périmé à l'écran.
      if (!res.ok && message) { clear(body()); state(message + ' Rouvrez cet écran pour le relire.'); return true; }
      if (!res.ok) { state(why(res, 'Indisponible pour le moment. Réessayez plus tard.')); return false; }
      var list = Array.isArray(res.body.data) ? res.body.data : [];
      clear(body());
      state(message || '');
      if (list[0] && ID.test(list[0].id)) draw(list[0], list); else form();
      return true;
    });
  }
  function form() {
    var box = el('section', null, 'bloc');
    box.appendChild(el('h3', 'Préparer un avis'));
    box.appendChild(el('p', 'L’adresse sert au calcul et aux données publiques. Vérifiée, elle est gardée pour le prochain avis : laissez vide pour la reprendre, donnez-en une autre pour la changer. Le reste vient de la fiche du bien.', 'doux'));
    var address = field(box, 'avis-adresse', 'Adresse du bien (vide : celle déjà vérifiée)');
    address.setAttribute('autocomplete', 'off');
    var kind = field(box, 'avis-type', 'Type de logement', 'select');
    [['', 'À choisir'], ['apartment', 'Appartement'], ['house', 'Maison'], ['land', 'Terrain'], ['building', 'Immeuble']].forEach(function (k) {
      var o = el('option', k[1]);
      o.value = k[0];
      kind.appendChild(o);
    });
    var condition = field(box, 'avis-etat-bien', 'État général', 'select');
    [['bon', 'Bon état'], ['neuf', 'Neuf ou rénové'], ['rafraichir', 'À rafraîchir'], ['travaux', 'Travaux à prévoir']].forEach(function (k) {
      var o = el('option', k[1]);
      o.value = k[0];
      condition.appendChild(o);
    });
    // Ce que le formulaire dit au moment du geste : l'avis motivé relit la sorte, l'état et l'adresse à son envoi.
    function current() {
      var p = { kind: kind.value, condition: condition.value };
      if (address.value.trim() !== '') p.address = address.value;
      return p;
    }
    box.appendChild(button('Préparer le brouillon', function () {
      state('Calcul en cours…');
      var mine = ++seq;
      var payload = current();
      return send(base(), 'POST', payload).then(function (res) {
        if (res.gone || mine !== seq) return false;
        if (!res.ok) {
          state(why(res, 'Le brouillon n’a pas pu être préparé.'));
          // Sans fourchette du calcul : l'avis motivé par les ventes vérifiées de l'agent [R690].
          if (res.body && res.body.manualPossible === true) manual(box, current);
          return false;
        }
        address.value = '';
        return load('Brouillon prêt : relisez-le, ajustez-le, puis validez.');
      });
    }));
    body().appendChild(box);
  }
  var PROOFS = [['agence', 'Vente conclue par l’agence'], ['acte', 'Acte de vente consulté'], ['notaire', 'Référence notariale'], ['confrere', 'Vente d’un confrère, preuve vue']];
  function manual(box, current) {
    if (box.motive) return;
    box.motive = true;
    var m = el('section', null, 'bloc');
    m.setAttribute('id', 'avis-motive');
    m.appendChild(el('h3', 'Avis motivé par vos ventes'));
    m.appendChild(el('p', 'Pas de fourchette automatique : donnez de 3 à 20 ventes réelles que vous avez vérifiées, et votre fourchette. L’avis dira que la fourchette est la vôtre, et pourquoi.', 'doux'));
    var low = field(m, 'avis-motive-bas', 'Bas de votre fourchette, en euros');
    var high = field(m, 'avis-motive-haut', 'Haut de votre fourchette, en euros');
    low.setAttribute('inputmode', 'numeric');
    high.setAttribute('inputmode', 'numeric');
    var rows = [];
    function row() {
      var n = rows.length + 1;
      var r = {
        month: field(m, 'avis-vente-mois-' + n, 'Vente ' + n + ' : mois (AAAA-MM)'),
        surface: field(m, 'avis-vente-surface-' + n, 'Vente ' + n + ' : surface en m²'),
        price: field(m, 'avis-vente-prix-' + n, 'Vente ' + n + ' : prix en euros'),
        proof: field(m, 'avis-vente-preuve-' + n, 'Vente ' + n + ' : preuve', 'select'),
        town: field(m, 'avis-vente-commune-' + n, 'Vente ' + n + ' : commune (facultatif)'),
      };
      r.surface.setAttribute('inputmode', 'decimal');
      r.price.setAttribute('inputmode', 'numeric');
      PROOFS.forEach(function (k) { var o = el('option', k[1]); o.value = k[0]; r.proof.appendChild(o); });
      rows.push(r);
    }
    row(); row(); row();
    m.appendChild(button('Ajouter une vente', function () { if (rows.length < 20) row(); return Promise.resolve(true); }));
    var check = el('input');
    check.setAttribute('id', 'avis-motive-verifie');
    check.setAttribute('type', 'checkbox');
    var lab = el('label', 'J’ai vérifié chacune de ces ventes');
    lab.setAttribute('for', 'avis-motive-verifie');
    m.appendChild(check);
    m.appendChild(lab);
    function num(x) { var v = String(x.value).replace(/[\\s\\u00a0\\u202f]/g, '').replace(',', '.'); return v === '' ? null : Number(v); }
    m.appendChild(button('Préparer l’avis motivé', function () {
      var refs = rows.filter(function (r) { return r.month.value.trim() !== '' || r.price.value.trim() !== ''; }).map(function (r) {
        var x = { month: r.month.value.trim(), surface: num(r.surface), price: num(r.price), proof: r.proof.value };
        if (r.town.value.trim() !== '') x.town = r.town.value.trim();
        return x;
      });
      var payload = current();
      var body2 = { kind: payload.kind, condition: payload.condition, manual: { low: num(low), high: num(high), verified: check.checked === true, references: refs } };
      if (payload.address) body2.address = payload.address;
      state('Préparation en cours…');
      var mine = ++seq;
      return send(base(), 'POST', body2).then(function (res) {
        if (res.gone || mine !== seq) return false;
        if (!res.ok) { state(why(res, 'L’avis motivé n’a pas pu être préparé.')); return false; }
        return load('Brouillon de l’avis motivé prêt : relisez-le, puis validez.');
      });
    }));
    box.appendChild(m);
  }
  /*
   * AU105 · les corrections gardées sur cet appareil pour un avis qui n'est plus celui qu'on corrige (validé depuis
   * ailleurs, ou remplacé par un avis plus récent) : lisibles, pour un nouvel avis, jusqu'à ce que l'agent les abandonne.
   */
  function lateNotes(box, list, editingId) {
    list.forEach(function (x) {
      if (!x || !ID.test(String(x.id)) || x.id === editingId) return;
      var late = drafts.get('avis:' + x.id);
      if (!late || !late.value || typeof late.value.text !== 'string') return;
      var note = el('div', null, 'retard');
      note.setAttribute('role', 'status');
      note.appendChild(el('p', 'Une correction d’un avis précédent n’a pas été enregistrée sur cet appareil, et cet avis ne se corrige plus : la voici, pour l’avis en cours.'));
      note.appendChild(el('p', 'Fourchette : ' + late.value.low + ' à ' + late.value.high + ' €.', 'doux'));
      note.appendChild(el('p', late.value.text, 'brouillon'));
      note.appendChild(button('Abandonner cette correction', function () { drafts.drop('avis:' + x.id); box.removeChild(note); }));
      box.insertBefore(note, box.firstChild);
    });
  }
  function draw(r, list) {
    var box = el('section', null, 'bloc');
    box.appendChild(el('h3', r.status === 'validated' ? 'Avis validé' : 'Brouillon à relire'));
    box.appendChild(el('strong', money(r.low) + ' à ' + money(r.high)));
    box.appendChild(el('p', 'Calcul du code : ' + money(r.computedLow) + ' à ' + money(r.computedHigh) + '.', 'doux'));
    if (r.status === 'validated') {
      box.appendChild(el('p', r.text, 'brouillon'));
      box.appendChild(button('Télécharger la page à imprimer', function () { return download(r.id); }));
      box.appendChild(button('Préparer un nouvel avis', function () { seq += 1; clear(body()); state(''); form(); }));
      // AU105 · une correction gardée sur cet appareil, l'avis validé depuis ailleurs : elle reste lisible, pour la
      // reporter dans un nouvel avis, jusqu'à ce que l'agent dise l'abandonner.
      lateNotes(box, list, null);
      body().appendChild(box);
      return;
    }
    // Un avis validé plus ancien reste à portée tant que le brouillon n'est pas validé.
    var older = list.filter(function (x) { return x.status === 'validated' && ID.test(x.id); })[0];
    var low = field(box, 'avis-bas', 'Bas de la fourchette, en euros');
    var high = field(box, 'avis-haut', 'Haut de la fourchette, en euros');
    [low, high].forEach(function (f) { f.setAttribute('inputmode', 'numeric'); });
    low.value = String(r.low);
    high.value = String(r.high);
    var text = field(box, 'avis-texte', 'Texte de l’avis', 'textarea');
    text.value = r.text;
    text.setAttribute('rows', '12');
    function amount(f) { return Number(String(f.value).replace(/[\\s€]/g, '')); }
    // AU105 · une correction non enregistrée reste sur cet appareil, pour cet avis, jusqu'à l'enregistrer ou l'abandonner.
    var key = 'avis:' + r.id;
    var waiting = false;
    function keep() {
      if (waiting) return;
      if (low.value === String(r.low) && high.value === String(r.high) && text.value === r.text) drafts.drop(key);
      else if (!drafts.set(key, { updatedAt: r.updatedAt, low: low.value, high: high.value, text: text.value })) state('Cet appareil ne peut pas garder cette correction : enregistrez-la avant de quitter l’écran.');
    }
    [low, high, text].forEach(function (f) { f.addEventListener('input', keep); });
    lateNotes(box, list, r.id);
    var kept = drafts.get(key);
    if (kept && kept.value && typeof kept.value.text === 'string') {
      var note = el('div', null, 'retard');
      note.setAttribute('role', 'status');
      note.appendChild(el('p', kept.value.updatedAt === r.updatedAt ? 'Une correction de cet avis n’a pas été enregistrée sur cet appareil.' : 'Une correction de cet avis n’a pas été enregistrée sur cet appareil, mais l’avis a changé depuis : relisez-la avant de l’enregistrer.'));
      note.appendChild(el('p', 'Choisissez d’abord : l’avis se corrige une fois la correction reprise ou abandonnée.', 'doux'));
      var settle = function () { waiting = false; [low, high, text].forEach(function (f) { f.disabled = false; }); box.removeChild(note); };
      note.appendChild(button('Reprendre la correction', function () { low.value = String(kept.value.low); high.value = String(kept.value.high); text.value = kept.value.text; settle(); }));
      note.appendChild(button('Abandonner la correction', function () { drafts.drop(key); settle(); }));
      box.insertBefore(note, box.firstChild);
      waiting = true;
      [low, high, text].forEach(function (f) { f.disabled = true; });
    }
    function change() {
      var c = {};
      if (amount(low) !== r.low) c.low = amount(low);
      if (amount(high) !== r.high) c.high = amount(high);
      if (text.value !== r.text) c.text = text.value;
      return c;
    }
    // Seule la correction envoyée s'efface : une correction plus récente, d'un autre onglet, reste gardée.
    function dropIfSent(sent) {
      var stored = drafts.get(key);
      if (!stored || !stored.value || (stored.value.low === sent.low && stored.value.high === sent.high && stored.value.text === sent.text)) drafts.drop(key);
    }
    function save(c) {
      return send('/v1/avis/' + encodeURIComponent(r.id) + '/ajustement', 'POST', c);
    }
    // Pendant un envoi, rien ne se tape ni ne se clique : une correction ne se perd jamais en silence [R30].
    var parts = [low, high, text];
    function lock(on) { parts.forEach(function (p) { p.disabled = on; }); }
    function add(b) { parts.push(b); box.appendChild(b); }
    add(button('Enregistrer', function () {
      if (waiting) { state('Choisissez d’abord : reprendre ou abandonner la correction gardée.'); return Promise.resolve(false); }
      var c = change();
      if (Object.keys(c).length === 0) { state('Rien à enregistrer.'); return Promise.resolve(false); }
      if (Number.isNaN(amount(low)) || Number.isNaN(amount(high))) { state('La fourchette s’écrit en euros, en chiffres seulement.'); return Promise.resolve(false); }
      state('Enregistrement…');
      var sent = { low: low.value, high: high.value, text: text.value };
      lock(true);
      var mine = ++seq;
      return save(c).then(function (res) {
        if (res.gone || mine !== seq) return false;
        if (!res.ok) { lock(false); state(why(res, 'Rien n’est enregistré : réessayez.')); return false; }
        dropIfSent(sent);
        return load('Enregistré.');
      });
    }));
    // Une modification à l'écran, encore non enregistrée, ne se valide jamais à l'insu de l'agent [R30].
    // La version lue à l'écran part avec le geste : celle d'un autre appareil n'est jamais validée à l'aveugle.
    add(button('Valider l’avis', function () {
      if (waiting) { state('Choisissez d’abord : reprendre ou abandonner la correction gardée.'); return Promise.resolve(false); }
      if (Object.keys(change()).length > 0) { state('Enregistrez d’abord vos changements : c’est ce texte qui sera validé.'); return Promise.resolve(false); }
      state('Validation…');
      var sent = { low: low.value, high: high.value, text: text.value };
      lock(true);
      var mine = ++seq;
      return send('/v1/avis/' + encodeURIComponent(r.id) + '/validation', 'POST', { updatedAt: r.updatedAt }).then(function (res) {
        if (res.gone || mine !== seq) return false;
        if (!res.ok) { lock(false); state(why(res, 'L’avis n’est pas validé : réessayez.')); return false; }
        dropIfSent(sent);
        return load('Avis validé.');
      });
    }));
    if (r.method === 'computed') selection(box, r, function () { return waiting || Object.keys(change()).length > 0; });
    versions(box, r, list);
    // Un brouillon faux se remplace ; il reste rangé, jamais validé.
    add(button('Refaire le calcul', function () { seq += 1; clear(body()); state(''); form(); }));
    if (older) box.appendChild(button('Télécharger le dernier avis validé', function () { return download(older.id); }));
    body().appendChild(box);
  }
  function pick(box, id, label, pairs) {
    var f = field(box, id, label, 'select');
    pairs.forEach(function (k) { var o = el('option', k[1]); o.value = k[0]; f.appendChild(o); });
    return f;
  }
  function sale(c) {
    var where = [c.street, c.town].filter(function (x) { return typeof x === 'string' && x !== ''; }).join(', ');
    return [c.month, c.surface + ' m²', money(c.pricePerM2) + ' le m²', 'à ' + c.distance + ' m'].concat(where ? [where] : []).join(' · ');
  }
  // AU049b · une nouvelle version recalculée depuis celle-ci ; elle reste rangée, telle quelle [R692, R693].
  function again(r, extra, done) {
    var p = { kind: r.kind, previous: r.id };
    if (r.condition) p.condition = r.condition;
    Object.keys(extra).forEach(function (k) { p[k] = extra[k]; });
    state('Nouveau calcul…');
    var mine = ++seq;
    return send(base(), 'POST', p).then(function (res) {
      if (res.gone || mine !== seq) return false;
      if (!res.ok) { state(why(res, 'La nouvelle version n’a pas pu être préparée.')); return false; }
      return load(done);
    });
  }
  function selection(box, r, busy) {
    var cited = (Array.isArray(r.cited) ? r.cited : []).filter(function (c) { return c && typeof c.id === 'string'; });
    var excluded = Array.isArray(r.excluded) ? r.excluded : [];
    var adjustments = Array.isArray(r.adjustments) ? r.adjustments : [];
    var m = el('section', null, 'bloc');
    m.setAttribute('id', 'avis-ventes');
    m.appendChild(el('h3', 'Ventes citées'));
    m.appendChild(el('p', 'Écartez une vente qui ne ressemble pas au bien : le calcul est refait sans elle, dans une nouvelle version. Celle-ci reste rangée.', 'doux'));
    function guard() {
      if (busy()) { state('Enregistrez ou abandonnez d’abord votre correction : la nouvelle version repart du calcul.'); return true; }
      return false;
    }
    var ul = el('ul');
    cited.forEach(function (c, i) {
      var li = el('li');
      li.appendChild(el('p', sale(c)));
      var why2 = pick(li, 'avis-motif-' + (i + 1), 'Motif pour écarter cette vente', [['', 'À choisir']].concat(CH.reasons));
      li.appendChild(button('Écarter cette vente', function () {
        if (guard()) return Promise.resolve(false);
        if (!why2.value) { state('Choisissez le motif avant d’écarter la vente.'); return Promise.resolve(false); }
        return again(r, { exclude: [{ id: c.id, reason: why2.value }] }, 'Vente écartée : voici la nouvelle version, à relire puis valider.');
      }));
      ul.appendChild(li);
    });
    m.appendChild(ul);
    if (excluded.length > 0) {
      m.appendChild(el('h3', 'Ventes écartées'));
      var ex = el('ul');
      var names = {};
      CH.reasons.forEach(function (k) { names[k[0]] = k[1]; });
      excluded.forEach(function (e) { ex.appendChild(el('li', [e.month, e.surface + ' m²', money(e.pricePerM2) + ' le m²', names[e.reason] || 'motif inconnu'].join(' · '))); });
      m.appendChild(ex);
    }
    var mot = {};
    CH.motives.forEach(function (k) { mot[k[0]] = k[1]; });
    if (adjustments.length > 0) {
      m.appendChild(el('h3', 'Ajustements'));
      var aj = el('ul');
      adjustments.forEach(function (a) { aj.appendChild(el('li', a.label + ' : ' + (a.pct > 0 ? '+' : '') + a.pct + ' % · ' + (a.source === 'agent' ? 'le vôtre, ' + (mot[a.motive] || 'motif inconnu') : 'barème du réseau'))); });
      m.appendChild(aj);
    }
    var label = pick(m, 'avis-ajust-car', 'Caractéristique à ajuster', [['', 'À choisir']].concat(CH.labels.map(function (l) { return [l, l]; })));
    var pct = field(m, 'avis-ajust-pct', 'Votre coefficient, en % (de -15 à +15)');
    pct.setAttribute('inputmode', 'numeric');
    var motive = pick(m, 'avis-ajust-motif', 'Motif', [['', 'À choisir']].concat(CH.motives));
    m.appendChild(button('Retenir cet ajustement', function () {
      if (guard()) return Promise.resolve(false);
      var n = Number(String(pct.value).replace(/[\\s%]/g, '').replace('+', '').replace('−', '-'));
      if (!label.value || !motive.value || String(pct.value).trim() === '' || !Number.isInteger(n) || Math.abs(n) > 15) { state('Choisissez la caractéristique, un pourcentage entier de -15 à +15 et le motif.'); return Promise.resolve(false); }
      return again(r, { adjust: [{ label: label.value, pct: n, motive: motive.value }] }, 'Ajustement retenu : voici la nouvelle version, à relire puis valider.');
    }));
    box.appendChild(m);
  }
  function versions(box, r, list) {
    var older = list.filter(function (x) { return x && x.id !== r.id && ID.test(String(x.id)); });
    if (older.length === 0) return;
    var v = el('section', null, 'bloc');
    v.setAttribute('id', 'avis-versions');
    v.appendChild(el('h3', 'Versions précédentes'));
    var ul = el('ul');
    older.forEach(function (x) {
      var n = Array.isArray(x.excluded) ? x.excluded.length : 0;
      ul.appendChild(el('li', String(x.createdAt).slice(0, 10) + ' · ' + money(x.low) + ' à ' + money(x.high) + ' · ' + (x.status === 'validated' ? 'validée' : 'brouillon') + (n > 0 ? ' · ' + n + (n === 1 ? ' vente écartée' : ' ventes écartées') : '') + (x.id === r.previous ? ' · celle que cette version recalcule' : '')));
    });
    v.appendChild(ul);
    box.appendChild(v);
  }
  function download(id) {
    var mine = t.session();
    state('Préparation…');
    return t.api('/v1/avis/' + encodeURIComponent(id) + '/imprimable', t.key()).then(function (r) {
      if (mine !== t.session()) return false;
      if (r.status === 401) { t.lost(); return false; }
      if (!r.ok) {
        return r.json().then(function (b) { return b; }, function () { return null; }).then(function (b) {
          if (mine === t.session()) state(why({ status: r.status, body: b }, 'Page indisponible pour le moment.'));
          return false;
        });
      }
      return r.blob().then(function (blob) {
        if (mine !== t.session()) return false;
        var url = URL.createObjectURL(blob);
        var a = el('a', 'Enregistrer');
        a.href = url;
        a.download = 'avis-de-valeur.html';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
        state('Page téléchargée : ouvrez-la pour l’imprimer ou l’enregistrer en PDF.');
        return true;
      });
    }, function () {
      if (mine === t.session()) state('Pas de réseau. Réessayez dans un moment.');
      return false;
    });
  }
  return { open: open, wipe: wipe };
};
`;
