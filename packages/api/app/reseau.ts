/**
 * DS068 · l'écran « Le réseau » de la direction (K09), dessiné par un script servi à part (`/app/reseau.js`) : il
 * n'arrive que sur l'appareil de la direction, à l'ouverture de son écran. Le script de l'application, que chaque agent
 * télécharge, n'en garde que l'entrée, l'effacement à la sortie et le chargeur.
 *
 * Les rubriques (DS008) : cinq, une seule à la fois ; sous le titre, une phrase dit ce qui attend la direction
 * (`sayDue`) : chaque compte vient de sa lecture, dans un ordre fixe ; une lecture manquée se dit, et la phrase ne dit
 * jamais « rien » à sa place ; une facture validée la fait baisser. Les blocs qui se relisent avec le rapport du matin
 * le sont à l'ouverture de leur rubrique (`showRubrique`), chacun jugé pour lui-même : pas encore lu, ou lu en panne
 * (son état dit « Réessayez… »), la rubrique relit ; un bloc lu, même sans rien à montrer, ne redemande rien.
 */
export const RESEAU_RUBRIQUES: readonly (readonly [id: string, name: string])[] = [['jour', 'Aujourd’hui'], ['chiffres', 'Chiffres'], ['agents', 'Agents'], ['reglages', 'Réglages'], ['technique', 'Technique']];

/** La part posée dans le script de l'application : l'entrée, l'effacement, le chargeur. */
export const RESEAU_JS = `
  /* ---------- M13 : l'écran « Le réseau » de la direction (K09), dessiné par un script servi à part (DS068). Les agents dans l'ordre de leur identifiant, jamais classés [R14] ; chaque total montre ses lignes et dit s'il leur est égal [R69]. ---------- */
  var reseauRange = 'mois';
  function count(n) { var x = Number(n); return isFinite(x) ? x : 0; }
  function wipeReseau() {
    wipeModeles();
    wipeMandatModeles();
    ['reseau-corps', 'reseau-alertes', 'reseau-reversements', 'reseau-brouillons'].forEach(function (id) { clear($(id)); });
    ['reseau-attend', 'reseau-etat', 'reseau-sans-agent', 'reseau-alertes-etat', 'reseau-reversements-etat', 'reseau-brouillons-etat', 'reseau-export-etat', 'reseau-cas-etat'].forEach(function (id) { $(id).textContent = ''; });
    wipeReprise();
    wipeBascule();
    wipeReglagesMandat();
    wipeLoyers();
    wipeMesureSources();
    wipeAnnuaire();
    wipeProspection();
    wipeBibliotheque();
    wipeEngagements();
    wipePhases();
    wipeLicences();
    wipeGuidesPhoto();
    wipeFinances();
  }
  // Une entrée ouvre une nouvelle session de l'écran : une réponse d'avant n'y a plus sa place. Le script de la direction
  // arrive une fois, puis dessine ; pendant qu'il arrive, le dernier geste gagne.
  function openReseau(range, part) {
    if (!currentKey) return Promise.resolve(false);
    reseauRange = range || reseauRange;
    session += 1;
    wipeReseau();
    show('reseau');
    return withTool('reseau', 'AIMMO_RESEAU', 'reseau-attend', 'reseau', function (r) { return r.open(reseauRange, part); }, function () {
      return { $: $, el: el, clear: clear, send: send, date: date, hour: hour, euros: euros, plural: plural, count: count, button: button, channel: channel, ID: ID, periodOf: periodOf, shiftDay: shiftDay, parisToday: parisToday, saveCsv: saveCsv, withFinances: withFinances, session: function () { return session; } };
    });
  }
`;

/**
 * Le script servi à part (`/app/reseau.js`). Il ne lit que les routes du pilotage [R16], ne garde rien d'une session
 * à l'autre que la rubrique ouverte, et n'écrit aucun HTML [R13].
 */
export const RESEAU_SCRIPT = `'use strict';
globalThis.AIMMO_RESEAU = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, date = t.date, hour = t.hour, euros = t.euros, plural = t.plural, count = t.count, button = t.button, channel = t.channel, ID = t.ID;
  var COUNTERS = [
    { key: 'contacts', one: 'Contact reçu', many: 'Contacts reçus' },
    { key: 'appointments', one: 'Rendez-vous tenu', many: 'Rendez-vous tenus' },
    { key: 'mandates', one: 'Mandat signé', many: 'Mandats signés' },
    { key: 'sales', one: 'Vente', many: 'Ventes' },
  ];
  var MANDATE_SOURCES = { site: 'site', online_valuation: 'estimation en ligne', value_tracking: 'suivi de la valeur', referral: 'recommandation', social: 'réseaux sociaux', portal: 'portail', agent_network: 'réseau de l’agent', neighbourhood_letter: 'lettre de quartier', other: 'autre origine' };
  var INDICATORS = { contacts: 'les contacts reçus', appointments: 'les rendez-vous tenus', mandates: 'les mandats signés', sales: 'les ventes' };
  var PIECES = { contrat_agent_commercial: 'contrat d’agent commercial', attestation_habilitation: 'attestation d’habilitation', immatriculation_rsac: 'immatriculation au RSAC', assurance_rcp: 'assurance de responsabilité civile professionnelle', attestation_vigilance: 'attestation de vigilance' };
  var rubrique = 'jour', due = [], RUBRIQUES = ${JSON.stringify(RESEAU_RUBRIQUES.map(([id]) => id))};
  function agentName(id) { return id ? 'Agent ' + id : 'Direction, sans agent'; }
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
      if (res.gone || mine !== t.session()) return false;
      if (!res.ok) {
        b.disabled = false;
        state.textContent = res.offline ? 'Pas de réseau : rien n’est émis. Réessayez dans un moment.' : (res.body && DRAFT_PROBLEMS[res.body.code]) || 'La facture n’est pas émise. Réessayez plus tard.';
        return false;
      }
      var v = res.body.data;
      li.removeChild(b);
      if (due[3]) { due[3][0] -= 1; sayDue(); }
      state.textContent = 'Facture émise en mode essai' + (v && v.content && typeof v.content.label === 'string' ? ' : ' + v.content.label : '') + '.';
      return true;
    });
  }
  function reseauPart(stateId, request, render, mine) {
    $(stateId).textContent = 'Chargement…';
    return request.then(function (res) {
      if (res.gone || mine !== t.session()) return false;
      if (!res.ok) { $(stateId).textContent = res.offline ? 'Pas de réseau. Réessayez dans un moment.' : 'Indisponible pour le moment. Réessayez plus tard.'; return false; }
      $(stateId).textContent = '';
      render(res.body.data, mine);
      return true;
    });
  }
  function sayDue() {
    var said = [], missed = 0;
    for (var i = 0; i < 4; i += 1) {
      var d = due[i];
      if (!d) missed = 1;
      else if (d[0] > 0) said.push((d[3] ? 'au moins ' : '') + d[0] + ' ' + plural(d[0], d[1], d[2]));
    }
    var out = said.length ? ['En attente : ' + said.join(', ') + '.'] : missed ? [] : ['Rien en attente.'];
    if (missed) out.push('Une partie n’a pas pu être relue.');
    $('reseau-attend').textContent = out.join(' ');
  }
  function showRubrique(name) {
    rubrique = name;
    RUBRIQUES.forEach(function (r) {
      $('reseau-r-' + r).setAttribute('aria-pressed', r === name ? 'true' : 'false');
      $('reseau-p-' + r).hidden = r !== name;
    });
    var ids = name === 'chiffres' ? ['preuve', 'indicateurs', 'engagements-tenus', 'temps-reseau'] : name === 'technique' ? ['disponibilite', 'copies', 'restauration', 'parcours-mois'] : [];
    var said = ids.map(function (id) { return $(id + '-etat').textContent; });
    if (said.indexOf('Chargement…') === -1 && ids.some(function (id, i) { return /Réessayez/.test(said[i]) || (!said[i] && !$(id + '-corps').firstChild); })) t.withFinances(ids[0] + '-etat', 'reseau', function (f) { return f.report('direction'); });
  }
  function open(range, part) {
    var mine = t.session();
    due = [];
    ['mois', 'precedent', 'annee'].forEach(function (r) { $('reseau-' + r).setAttribute('aria-pressed', r === range ? 'true' : 'false'); });
    if (!$('reseau-export-jour').value) $('reseau-export-jour').value = t.shiftDay(t.parisToday(), -1);
    var p = t.periodOf(range);
    var list = function (x) { return Array.isArray(x) ? x : []; };
    var all = Promise.all([
      reseauPart('reseau-etat', send('/v1/pilotage/reseau?du=' + p.from + '&au=' + p.to, 'GET'), function (data) {
        $('reseau-etat').textContent = 'Du ' + date(p.from + 'T12:00:00Z') + ' au ' + date(p.to + 'T12:00:00Z') + '.';
        renderReseau(data || {});
      }, mine),
      reseauPart('reseau-alertes-etat', send('/v1/pilotage/alertes', 'GET'), function (d) { renderAlertes(list(d)); due[0] = [list(d).length, 'alerte', 'alertes']; }, mine),
      reseauPart('reseau-sans-agent', send('/v1/alertes-agent/sans-agent', 'GET'), function (d) {
        var some = d && (d.total || d.more);
        $('reseau-sans-agent').textContent = some ? 'Conversations à reprendre sans agent : ' + (d.more ? 'au moins ' : '') + d.total + '. Attribuez leurs fiches.' : '';
        due[1] = [some ? count(d.total) : 0, 'conversation sans agent', 'conversations sans agent', some && d.more];
      }, mine),
      reseauPart('reseau-reversements-etat', send('/v1/pilotage/reversements', 'GET'), function (d) { renderReversements(list(d)); due[2] = [list(d).length, 'reversement à faire', 'reversements à faire']; }, mine),
      reseauPart('reseau-brouillons-etat', send('/v1/pilotage/factures/brouillons', 'GET'), function (d, m) { renderBrouillons(list(d), m); due[3] = [list(d).length, 'facture à valider', 'factures à valider']; }, mine),
    ]).then(function (done) {
      if (mine === t.session()) sayDue();
      return done.every(function (x) { return x; });
    });
    showRubrique(part || rubrique);
    return all;
  }
  /** L'export se télécharge avec la clé dans l'en-tête, jamais dans l'adresse [R13] ; le fichier reste sur l'appareil de la direction. */
  function downloadExport() {
    var day = $('reseau-export-jour').value;
    var state = $('reseau-export-etat');
    if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(day)) { state.textContent = 'Choisissez un jour.'; return Promise.resolve(false); }
    return t.saveCsv('/v1/pilotage/export-quotidien?jour=' + day, 'chiffres-' + day + '.csv', state, 'Export indisponible pour ce jour. Réessayez plus tard.', 'Export du ' + date(day + 'T12:00:00Z') + ' téléchargé.');
  }
  RUBRIQUES.forEach(function (r) { $('reseau-r-' + r).addEventListener('click', function () { showRubrique(r); }); });
  $('reseau-export').addEventListener('click', function () { downloadExport(); });
  return { open: open };
};
`;
