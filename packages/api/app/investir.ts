import { DEADLINES } from '../../core/src/qualification/regles.ts';
import { COMMUNE_RULE_LABELS } from '../../core/src/investir/contraintes.ts';
import { LINE_LABELS, RENTAL_TARGETS } from '../../core/src/investir/index.ts';

/**
 * L'écran « Investir » de l'application de l'agent (Y09), en morceaux posés dans `fichiers.ts` : sa section de page, son
 * entrée sur l'accueil, sa mise en page et son script.
 *
 * L'écran ne lit et n'écrit que par les routes `/v1/investir` [R16]. Aucun chiffre n'est calculé sur le téléphone : le
 * rendement, sa fourchette, chaque ligne et sa preuve viennent du code du serveur, l'écran les met seulement en forme
 * [R121]. L'alerte d'un bien interdit à la location est posée en tête, avant le calcul [R124]. La note se relit puis se
 * valide par son empreinte : l'agent valide exactement le texte qu'il a lu [R126]. Aucun champ de revenus, d'emploi, de
 * patrimoine ni de crédit [R123]. Tout texte reçu est posé avec `textContent`.
 */

const TARGET_LABELS: Record<(typeof RENTAL_TARGETS)[number], string> = {
  none: 'Ne pas louer',
  unfurnished: 'Location vide',
  furnished: 'Location meublée',
  shared: 'Colocation',
};
const DEADLINE_LABELS: Record<(typeof DEADLINES)[number], string> = {
  now: 'Tout de suite',
  within_3_months: 'Dans les 3 mois',
  within_6_months: 'Dans les 6 mois',
  within_1_year: 'Dans l’année',
  later: 'Plus tard',
};

export const INVESTIR_HOME_HTML = `<section class="bloc" aria-labelledby="titre-investir-accueil">
<h3 id="titre-investir-accueil">Mes investisseurs</h3>
<p class="etat">Le rendement d’un bien, chaque chiffre prouvé, et une note à valider.</p>
<button id="investir-ouvrir" type="button" class="secondaire">Ouvrir mes investisseurs</button>
</section>
`;

export const INVESTIR_HTML = `<section id="investir" hidden>
<button id="investir-retour" type="button" class="retour">Retour à ma journée</button>
<h2 id="investir-titre">Investir</h2>
<p class="doux">Chaque chiffre vient du serveur avec sa source, sa date et son hypothèse.</p>
<p id="investir-etat" class="etat" role="status"></p>
<div id="investir-corps"></div>
</section>
`;

export const INVESTIR_CSS = `
#investir { padding-top: var(--e-2); }
.alerte-energie { margin: 0 0 var(--e-4); padding: var(--e-3) var(--e-4); border-left: 4px solid var(--danger); border-radius: var(--r-m); background: var(--papier); color: var(--danger); font-weight: 600; }
.rendement { display: flex; flex-wrap: wrap; align-items: baseline; gap: var(--e-2) var(--e-4); margin: var(--e-2) 0 var(--e-4); }
.rendement .central { font: 600 var(--t-xl)/1.1 var(--police-titre); color: var(--encre); }
.rendement .fourchette { color: var(--doux); font-size: var(--t-s); }
.lignes { margin: 0; padding: 0; list-style: none; }
.lignes > li { display: grid; grid-template-columns: 1fr auto; gap: var(--e-1) var(--e-3); padding: var(--e-3) 0; border-top: 1px solid var(--trait); }
.lignes > li:first-child { border-top: 0; }
.lignes .valeur { font-variant-numeric: tabular-nums; font-weight: 600; text-align: right; }
.lignes .preuve { grid-column: 1 / -1; color: var(--doux); font-size: var(--t-s); }
.note-texte { white-space: pre-wrap; margin: var(--e-2) 0; padding: var(--e-3) var(--e-4); border: 1.5px solid var(--trait); border-radius: var(--r-m); background: var(--papier); font-size: var(--t-s); line-height: 1.55; }
.curseur { width: 100%; accent-color: var(--accent); min-height: 44px; }
`;

/**
 * Ce que l'application garde de l'écran : son chargement à la première ouverture. Une réponse d'une autre session,
 * ou un script en retard, est ignorée ; sans réseau, l'écran le dit.
 */
export const INVESTIR_JS = `
  var investirScreen = null;
  function wipeInvestir() {
    if (investirScreen) return investirScreen.wipe();
    clear($('investir-corps'));
    $('investir-etat').textContent = '';
  }
  function openInvestir(message) {
    if (!currentKey) return Promise.resolve(false);
    if (investirScreen) return investirScreen.open(message);
    session += 1;
    var mine = session;
    wipeInvestir();
    show('investir');
    $('investir-etat').textContent = 'Chargement…';
    return new Promise(function (resolve) {
      var script = document.createElement('script');
      script.setAttribute('src', '/app/investir.js');
      script.addEventListener('load', function () {
        var make = globalThis.AIMMO_INVESTIR;
        try { delete globalThis.AIMMO_INVESTIR; } catch (e) { /* rien à retirer */ }
        if (mine !== session || typeof make !== 'function') { resolve(false); return; }
        investirScreen = make({ $: $, el: el, clear: clear, send: send, show: show, button: button, field: field, select: select, details: details, centsText: centsText, euros: euros, toCents: toCents, whole: whole, date: date, ID: ID, key: function () { return currentKey; }, session: function () { return session; }, next: function () { session += 1; return session; } });
        resolve(investirScreen.open(message));
      });
      script.addEventListener('error', function () {
        if (mine === session) $('investir-etat').textContent = 'Pas de réseau. Réessayez dans un moment.';
        resolve(false);
      });
      $('investir').appendChild(script);
    });
  }
`;

/**
 * Le script de l'écran, servi à part (`/app/investir.js`) et chargé à sa première ouverture : l'application garde
 * son budget. Il reçoit les outils de l'application (`el`, `send`, `field`, `select`, `toCents`…), ne lit et n'écrit
 * que par les routes `/v1/investir` [R16], et ne garde aucune donnée.
 */
export const INVESTIR_SCRIPT = `'use strict';
globalThis.AIMMO_INVESTIR = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, show = t.show, button = t.button, field = t.field, select = t.select, details = t.details;
  var centsText = t.centsText, euros = t.euros, toCents = t.toCents, whole = t.whole, date = t.date, ID = t.ID;
  var LINE_LABELS = ${JSON.stringify(LINE_LABELS)};
  var TARGETS = ${JSON.stringify(TARGET_LABELS)};
  var DEADLINE_LABELS = ${JSON.stringify(DEADLINE_LABELS)};
  var RULES = ${JSON.stringify(COMMUNE_RULE_LABELS)};
  var INVESTIR_REFUSALS = {
    not_assigned: 'Cette fiche est suivie par un autre agent.',
    solvabilite: 'Aucun champ de revenus, d’emploi, de patrimoine ni de crédit.',
    loyer_saisi: 'Le loyer de marché vient de la base, il ne se saisit pas.',
    tournure_interdite: 'Une hypothèse contient une promesse ou un conseil : reformulez-la.',
    alerte_absente: 'Une alerte d’énergie est apparue : rédigez la note de nouveau.',
    texte_change: 'La note a changé : relisez la dernière version.',
    insee: 'Le code INSEE : cinq caractères, par exemple 21231.',
    regle: 'Choisissez la règle.',
    source: 'Écrivez la source de la règle : d’où elle vient, en 300 caractères au plus.',
    date_source: 'La date de la source : un jour déjà passé.',
    date: 'Les dates de la règle : un début, et une fin qui ne vient pas avant lui.',
    role: 'Ce n’est pas dans vos droits.',
  };
  function investirRefusal(body, fallback) { return (body && INVESTIR_REFUSALS[body.code]) || fallback; }
  function investirState(text) { $('investir-etat').textContent = text; }
  var investirProject = null;
  function wipeInvestir() {
    clear($('investir-corps'));
    $('investir-etat').textContent = '';
    $('investir-titre').textContent = 'Investir';
    investirProject = null;
  }
  function bpText(bp) {
    if (typeof bp !== 'number' || !isFinite(bp)) return '';
    var neg = bp < 0;
    var a = String(Math.abs(Math.round(bp)));
    while (a.length < 3) a = '0' + a;
    return (neg ? '−' : '') + a.slice(0, -2) + ',' + a.slice(-2) + ' %';
  }
  function areaText(h) { return typeof h === 'number' ? centsText(h) + ' m²' : ''; }
  function lineValue(l) {
    if (l.unit === 'cents') return euros(l.value);
    if (l.unit === 'cents_per_m2') return euros(l.value) + '/m²';
    if (l.unit === 'bp') return bpText(l.value);
    if (l.unit === 'm2_hundredths') return areaText(l.value);
    if (l.unit === 'months') return String(l.value) + ' mois';
    return String(l.value);
  }
  function toBp(text) {
    var v = String(text || '').replace(/[\\s%]/g, '').replace(',', '.');
    if (!/^\\d{1,3}(\\.\\d{1,2})?$/.test(v)) return null;
    return Math.round(Number(v) * 100);
  }
  function profileSummary(p) {
    if (!p) return 'Profil à remplir.';
    var parts = [];
    if (typeof p.budgetCents === 'number') parts.push('Budget ' + euros(p.budgetCents));
    if (p.rentalTarget && TARGETS[p.rentalTarget]) parts.push(TARGETS[p.rentalTarget]);
    if (typeof p.targetGrossYieldBp === 'number') parts.push('Rendement brut attendu ' + bpText(p.targetGrossYieldBp));
    if (Array.isArray(p.sectors) && p.sectors.length) parts.push('Secteurs ' + p.sectors.join(', '));
    return parts.length ? parts.join(' · ') : 'Profil à remplir.';
  }
  function openInvestir(message) {
    if (!t.key()) return Promise.resolve(false);
    var mine = t.next();
    wipeInvestir();
    show('investir');
    investirState('Chargement…');
    return send('/v1/investir/projets', 'GET').then(function (res) {
      if (res.gone || mine !== t.session()) return false;
      if (!res.ok) { investirState(res.offline ? 'Pas de réseau. Réessayez dans un moment.' : investirRefusal(res.body, 'Indisponible pour le moment. Réessayez plus tard.')); return false; }
      var list = Array.isArray(res.body.data) ? res.body.data : [];
      var body = $('investir-corps');
      if (!list.length) body.appendChild(el('p', 'Aucun investisseur pour le moment.', 'doux'));
      var ul = el('ul', null, 'liste');
      list.forEach(function (x) {
        if (!ID.test(x.projectId)) return;
        var li = el('li');
        li.appendChild(el('strong', x.firstName || 'Investisseur'));
        li.appendChild(el('p', profileSummary(x.profile), 'doux'));
        li.appendChild(button('Ouvrir', function () { openInvestor(x); }));
        ul.appendChild(li);
      });
      body.appendChild(ul);
      renderCommuneRules(body);
      investirState(message || '');
      return true;
    });
  }
  /* Y11 · les règles d'une commune : lues par tous, rangées par la direction seule, chacune avec sa source [R16]. */
  function day(d) { return date(d + 'T12:00:00Z'); }
  function renderCommuneRules(body) {
    var box = details(body, 'Règles de location d’une commune');
    var insee = field(box, 'inv-regle-insee', 'Code INSEE de la commune');
    insee.setAttribute('maxlength', '5');
    var said = el('p', null, 'etat');
    said.setAttribute('role', 'status');
    var out = el('div');
    var busy = false;
    function once(work) {
      if (busy) return false;
      busy = true;
      return work().then(function (r) { busy = false; return r; }, function () { busy = false; return false; });
    }
    function read(code, message) {
      said.textContent = 'Chargement…';
      clear(out);
      return send('/v1/investir/regles?insee=' + encodeURIComponent(code), 'GET').then(function (res) {
        if (res.gone) return false;
        if (res.offline) { said.textContent = 'Pas de réseau. Réessayez dans un moment.'; return false; }
        var data = res.ok && res.body.data;
        if (!data || !Array.isArray(data.rules)) { said.textContent = investirRefusal(res.body, 'Indisponible pour le moment.'); return false; }
        said.textContent = message || '';
        if (!data.rules.length) out.appendChild(el('p', 'Aucune règle rangée en vigueur pour cette commune. Cela ne prouve pas qu’il n’y en a pas : vérifiez auprès de la mairie.', 'doux'));
        var ul = el('ul', null, 'liste');
        data.rules.forEach(function (r) {
          var li = el('li');
          li.appendChild(el('strong', RULES[r.rule] || r.label || 'Règle'));
          li.appendChild(el('p', 'Depuis le ' + day(r.effectiveFrom) + (r.effectiveUntil ? ', jusqu’au ' + day(r.effectiveUntil) : ''), 'doux'));
          li.appendChild(el('p', 'Source : ' + r.source + ', ' + day(r.sourceDate), 'doux'));
          ul.appendChild(li);
        });
        out.appendChild(ul);
        if (data.canRecord) renderRuleForm(out, code);
        return true;
      });
    }
    function renderRuleForm(into, code) {
      var form = el('div');
      form.appendChild(el('h4', 'Ranger une règle pour cette commune'));
      var kind = select(form, 'inv-regle-sorte', 'Règle', Object.assign({ '': 'Choisissez la règle' }, RULES), '');
      var from = field(form, 'inv-regle-debut', 'En vigueur depuis');
      from.setAttribute('type', 'date');
      var until = field(form, 'inv-regle-fin', 'Jusqu’au, si elle a une fin');
      until.setAttribute('type', 'date');
      var source = field(form, 'inv-regle-source', 'Source : la délibération ou le texte');
      source.setAttribute('maxlength', '300');
      var sourceDate = field(form, 'inv-regle-source-date', 'Date de la source');
      sourceDate.setAttribute('type', 'date');
      form.appendChild(button('Ranger cette règle', function () {
        return once(function () {
          said.textContent = 'Envoi…';
          return send('/v1/investir/regles', 'POST', { inseeCode: code, rule: kind.value, effectiveFrom: from.value, effectiveUntil: until.value || null, source: source.value, sourceDate: sourceDate.value }).then(function (res) {
            if (res.gone) return false;
            if (res.offline || !res.body || res.status >= 500) { said.textContent = 'La réponse n’est pas arrivée : rien n’est sûr. Relisez la commune avant de recommencer.'; return false; }
            if (!res.ok) { said.textContent = investirRefusal(res.body, 'La règle n’est pas rangée.'); return false; }
            var v = res.body.data || {};
            return read(code, 'Règle rangée, en vigueur à partir du ' + day(v.effectiveFrom) + '.');
          });
        });
      }));
      into.appendChild(form);
    }
    box.appendChild(button('Lire les règles de cette commune', function () {
      var code = String(insee.value || '').trim().toUpperCase();
      if (!/^(\\d{5}|2[AB]\\d{3})$/.test(code)) { said.textContent = INVESTIR_REFUSALS.insee; return false; }
      return once(function () { return read(code); });
    }));
    box.appendChild(said);
    box.appendChild(out);
  }
  function openInvestor(x, message) {
    if (!t.key() || !ID.test(x.projectId)) return Promise.resolve(false);
    var mine = t.next();
    clear($('investir-corps'));
    investirProject = x.projectId;
    $('investir-titre').textContent = x.firstName || 'Investisseur';
    show('investir');
    investirState('Chargement…');
    var base = '/v1/investir/projets/' + encodeURIComponent(x.projectId);
    return Promise.all([send(base + '/profil', 'GET'), send('/v1/investir/biens', 'GET')]).then(function (all) {
      if (mine !== t.session() || all.some(function (r) { return r.gone; })) return false;
      if (!all[0].ok) { investirState(all[0].offline ? 'Pas de réseau. Réessayez dans un moment.' : investirRefusal(all[0].body, 'Cette fiche n’est pas dans vos droits.')); return false; }
      var current = (all[0].body.data && all[0].body.data.current) || null;
      var biens = all[1].ok && Array.isArray(all[1].body.data) ? all[1].body.data : [];
      renderInvestor(x, base, current, biens);
      investirState(message || '');
      return true;
    });
  }
  function renderInvestor(x, base, current, biens) {
    var body = $('investir-corps');
    var p = (current && current.profile) || {};
    var box = details(body, 'Profil de l’investisseur');
    var budget = field(box, 'inv-budget', 'Budget, en euros');
    budget.value = centsText(p.budgetCents);
    budget.setAttribute('inputmode', 'decimal');
    var apport = field(box, 'inv-apport', 'Apport déclaré, en euros');
    apport.value = centsText(p.declaredDownPaymentCents);
    apport.setAttribute('inputmode', 'decimal');
    var target = select(box, 'inv-location', 'Location visée', Object.assign({ '': 'Pas encore dit' }, TARGETS), p.rentalTarget || '');
    var sectors = field(box, 'inv-secteurs', 'Secteurs : codes INSEE des communes, séparés par des virgules');
    sectors.value = Array.isArray(p.sectors) ? p.sectors.join(', ') : '';
    var yieldWanted = field(box, 'inv-rendement', 'Rendement brut attendu, en %');
    yieldWanted.value = typeof p.targetGrossYieldBp === 'number' ? bpText(p.targetGrossYieldBp).replace(' %', '') : '';
    yieldWanted.setAttribute('inputmode', 'decimal');
    var deadline = select(box, 'inv-delai', 'Délai', Object.assign({ '': 'Pas encore dit' }, DEADLINE_LABELS), p.deadline || '');
    var from = select(box, 'inv-source', 'D’où vient ce qui est écrit', { client_dit: 'Le client l’a dit', agent: 'Je l’écris moi-même' }, 'client_dit');
    box.appendChild(button('Ranger le profil', function () {
      var changes = {};
      var b = budget.value.trim() === '' ? null : toCents(budget.value);
      var a = apport.value.trim() === '' ? null : toCents(apport.value);
      var y = yieldWanted.value.trim() === '' ? null : toBp(yieldWanted.value);
      if ((budget.value.trim() !== '' && b === null) || (apport.value.trim() !== '' && a === null) || (yieldWanted.value.trim() !== '' && y === null)) { investirState('Un montant ou un pourcentage n’est pas valable.'); return; }
      changes.budgetCents = b;
      changes.declaredDownPaymentCents = a;
      changes.targetGrossYieldBp = y;
      changes.rentalTarget = target.value || null;
      changes.deadline = deadline.value || null;
      changes.sectors = sectors.value.split(',').map(function (s) { return s.trim().toUpperCase(); }).filter(function (s) { return s.length > 0; });
      investirState('Envoi…');
      send(base + '/profil', 'POST', { changes: changes, from: from.value }).then(function (res) {
        if (res.gone) return;
        if (!res.ok) { investirState(res.offline ? 'La réponse n’est pas arrivée : rien n’est sûr. Relisez avant de recommencer.' : investirRefusal(res.body, 'Le profil n’est pas rangé.')); return; }
        openInvestor(x, 'Profil rangé : une nouvelle version, l’ancienne reste lisible.');
      });
    }));

    var calc = el('section', null, 'bloc');
    calc.appendChild(el('h3', 'Calculer un bien'));
    if (!biens.length) calc.appendChild(el('p', 'Aucun bien calculable.', 'doux'));
    var options = {};
    biens.forEach(function (b) { if (ID.test(b.propertyId)) options[b.propertyId] = 'Bien ' + b.reference + (b.city ? ', ' + b.city : '') + (typeof b.priceCents === 'number' ? ' · ' + euros(b.priceCents) : ''); });
    var bien = select(calc, 'inv-bien', 'Bien', options, Object.keys(options)[0] || '');
    var energy = select(calc, 'inv-energie', 'Classe énergie, si la fiche du bien ne la porte pas', { '': 'Celle de la fiche', A: 'A', B: 'B', C: 'C', D: 'D', E: 'E', F: 'F', G: 'G' }, '');
    function said(box, id, label, hypothesis) {
      var v = field(box, id, label);
      v.setAttribute('inputmode', 'decimal');
      var h = field(box, id + '-h', 'Hypothèse');
      h.value = hypothesis;
      return { value: v, hypothesis: h };
    }
    var fees = said(calc, 'inv-frais', 'Frais d’acquisition, en % du prix', 'barème des frais d’acquisition');
    var works = said(calc, 'inv-travaux', 'Travaux estimés, en euros', 'devis estimé');
    var charges = said(calc, 'inv-charges', 'Charges non récupérables par an, en euros', 'déclarées par le vendeur');
    var tax = said(calc, 'inv-taxe', 'Taxe foncière par an, en euros', 'avis de taxe foncière déclaré');
    var vacancy = said(calc, 'inv-vacance', 'Vacance, en mois par an', 'vacance réglée');
    var result = el('div');
    calc.appendChild(button('Calculer', function () {
      var chosen = biens.filter(function (b) { return b.propertyId === bien.value; })[0];
      if (!chosen) { investirState('Choisissez un bien.'); return; }
      var r = toBp(fees.value.value), w = toCents(works.value.value), c = toCents(charges.value.value), tx = toCents(tax.value.value), m = whole(vacancy.value.value, 12);
      if (r === null || w === null || c === null || tx === null || m === null) { investirState('Un champ n’est pas valable : vérifiez la saisie.'); return; }
      var day = new Date().toISOString().slice(0, 10);
      function entry(value, h) { return { value: value, source: 'agent', asOf: day, hypothesis: h.value || 'saisi par l’agent' }; }
      var energyBody = energy.value ? { energyClass: energy.value } : undefined;
      investirState('Calcul…');
      send('/v1/investir/calculs', 'POST', {
        propertyId: chosen.propertyId,
        projectId: x.projectId,
        marketRentQuery: { inseeCode: chosen.inseeCode, kind: chosen.rentKind },
        inputs: { acquisitionFeesRateBp: entry(r, fees.hypothesis), works: entry(w, works.hypothesis), nonRecoverableCharges: entry(c, charges.hypothesis), propertyTax: entry(tx, tax.hypothesis), vacancyMonths: entry(m, vacancy.hypothesis) },
      }).then(function (res) {
        if (res.gone) return;
        if (!res.ok) { investirState(res.offline ? 'Pas de réseau : rien n’est calculé.' : investirRefusal(res.body, 'Le calcul n’a pas abouti.')); return; }
        var stored = res.body.data;
        send('/v1/investir/biens/' + encodeURIComponent(chosen.propertyId) + '/contraintes', 'POST', Object.assign({ projectId: x.projectId, inseeCode: chosen.inseeCode }, energyBody || {})).then(function (cres) {
          if (cres.gone) return;
          renderCalculation(result, x, stored, cres.ok ? cres.body.data : null, chosen, energyBody);
          investirState(stored.result && stored.result.status === 'complet' ? 'Calcul rangé : chaque chiffre avec sa preuve.' : 'Calcul incomplet : il manque des données.');
        });
      });
    }));
    calc.appendChild(result);
    body.appendChild(calc);
  }
  function renderCalculation(box, x, stored, constraints, chosen, energyBody) {
    clear(box);
    if (!constraints) box.appendChild(el('p', 'Contraintes indisponibles : aucune proposition sans elles.', 'alerte-energie'));
    else (Array.isArray(constraints.alertsFirst) ? constraints.alertsFirst : []).forEach(function (a) {
      var p = el('p', a, 'alerte-energie');
      p.setAttribute('role', 'alert');
      box.appendChild(p);
    });
    var r = stored.result || {};
    if (r.status !== 'complet') {
      var miss = el('p', 'Il manque : ' + (Array.isArray(r.missing) ? r.missing.map(function (k) { return LINE_LABELS[k] || 'une donnée'; }).join(', ') : 'des données') + '. Aucun rendement sans elles.', 'etat');
      box.appendChild(miss);
      return;
    }
    var head = el('div', null, 'rendement');
    head.appendChild(el('span', 'Brut ' + bpText(r.grossYieldBp.central), 'central'));
    head.appendChild(el('span', 'de ' + bpText(r.grossYieldBp.low) + ' à ' + bpText(r.grossYieldBp.high), 'fourchette'));
    head.appendChild(el('span', 'Net avant impôt ' + bpText(r.netYieldBp.central), 'central'));
    head.appendChild(el('span', 'de ' + bpText(r.netYieldBp.low) + ' à ' + bpText(r.netYieldBp.high), 'fourchette'));
    box.appendChild(head);
    var ul = el('ul', null, 'lignes');
    (Array.isArray(r.lines) ? r.lines : []).forEach(function (l) {
      var li = el('li');
      li.appendChild(el('span', LINE_LABELS[l.key] || l.key));
      li.appendChild(el('span', lineValue(l), 'valeur'));
      li.appendChild(el('span', 'Source : ' + (l.source === 'calcul' ? 'calcul du serveur' : l.source) + ', au ' + date(l.asOf + (l.asOf.length === 10 ? 'T12:00:00Z' : '')) + '. Hypothèse : ' + l.hypothesis + '.', 'preuve'));
      ul.appendChild(li);
    });
    box.appendChild(ul);
    (constraints && Array.isArray(constraints.constraints) ? constraints.constraints : []).forEach(function (c) {
      if (!Array.isArray(constraints.alertsFirst) || constraints.alertsFirst.indexOf(c.text) === -1) box.appendChild(el('p', c.text + ' Source : ' + c.source + '.', 'doux'));
    });

    var h = details(box, 'Changer une hypothèse et rédiger la note');
    var vac = field(h, 'inv-curseur-vacance', 'Vacance, en mois par an');
    vac.setAttribute('type', 'range');
    vac.setAttribute('min', '0');
    vac.setAttribute('max', '12');
    vac.setAttribute('step', '1');
    vac.className = 'curseur';
    var current = (r.lines || []).filter(function (l) { return l.key === 'vacancyMonths'; })[0];
    vac.value = current ? String(current.value) : '1';
    var shown = el('p', vac.value + ' mois', 'doux');
    vac.addEventListener('input', function () { shown.textContent = vac.value + ' mois'; });
    h.appendChild(shown);
    var wk = field(h, 'inv-curseur-travaux', 'Travaux, en euros');
    var w0 = (r.lines || []).filter(function (l) { return l.key === 'works'; })[0];
    wk.value = w0 ? centsText(w0.value) : '';
    var rent = select(h, 'inv-curseur-loyer', 'Loyer de marché retenu', { central: 'Central', low: 'Bas de l’intervalle', high: 'Haut de l’intervalle' }, 'central');
    var noteBox = el('div');
    h.appendChild(button('Rédiger la note', function () {
      var m = whole(vac.value, 12);
      var w = toCents(wk.value);
      if (m === null || w === null) { investirState('Une hypothèse n’est pas valable.'); return; }
      investirState('Rédaction…');
      send('/v1/investir/notes', 'POST', Object.assign({ calculationId: stored.id, projectId: x.projectId, inseeCode: chosen.inseeCode, hypotheses: { vacancyMonths: m, worksCents: w, rent: rent.value } }, energyBody ? { energy: energyBody } : {})).then(function (res) {
        if (res.gone) return;
        if (!res.ok) { investirState(res.offline ? 'Pas de réseau : aucune note.' : investirRefusal(res.body, 'La note n’a pas pu être rédigée.')); return; }
        renderNote(noteBox, res.body.data, chosen, energyBody);
        investirState('Note rédigée : relisez-la avant de la valider.');
      });
    }));
    h.appendChild(noteBox);
  }
  function renderNote(box, note, chosen, energyBody) {
    clear(box);
    if (!note || !ID.test(note.id) || typeof note.textSha256 !== 'string') { investirState('Note illisible.'); return; }
    box.appendChild(el('h4', note.status === 'validee' ? 'Note validée' : 'Note à relire'));
    box.appendChild(el('div', note.text, 'note-texte'));
    if (note.status === 'validee') return;
    box.appendChild(button('Je l’ai relue : valider la note', function () {
      investirState('Validation…');
      send('/v1/investir/notes/' + encodeURIComponent(note.id) + '/validation', 'POST', Object.assign({ textSha256: note.textSha256, inseeCode: chosen.inseeCode }, energyBody ? { energy: energyBody } : {})).then(function (res) {
        if (res.gone) return;
        if (!res.ok) { investirState(res.offline ? 'Pas de réseau : la note n’est pas validée.' : investirRefusal(res.body, 'La note n’est pas validée.')); return; }
        renderNote(box, res.body.data, chosen, energyBody);
        investirState('Note validée : elle peut être montrée au client.');
      });
    }));
  }
  return { open: openInvestir, wipe: wipeInvestir, inside: function () { return investirProject !== null; } };
};
`;
