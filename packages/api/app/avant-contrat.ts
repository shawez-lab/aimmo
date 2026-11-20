/**
 * BR91 · L'avant-contrat préparé à l'écran du dossier de vente (HX45, RC39, RC40, RC54, BR89).
 * Posé sur l'écran « Dossier de vente » : script servi à part (`/app/avant-contrat.js`), chargé au premier geste, sans
 * rien ajouter au script de l'application ni à celui du dossier [R201]. Il n'appelle que `/v1/dossiers/<id>/avant-contrat`
 * et, pour déposer un fichier tel quel, `…/preuves` du dossier [R16].
 *
 * - L'état (`GET …`) : la note, le dernier projet et ses différences écrites par le serveur, le dépôt, en mots [R511, R512].
 * - La note (`POST …/note`) : dépôt prévu, date limite du prêt (vide sans prêt), date de l'acte ; le prix et les
 *   conditions viennent du dossier et de l'offre acceptée, jamais de l'écran [R510].
 * - Le projet : le PDF reçu du notaire est déposé tel quel au dossier (`…/preuves`), puis prélu sous la référence rendue
 *   (`…/pdf?documentRef=`), le même fichier ; l'agent relit chaque terme avec sa page et confirme (`…/projet`) [R511].
 * - Les dates (`POST …/dates`) : reportées à l'échéancier une fois le compromis signé [R513].
 * - Le dépôt reçu (`POST …/depot`) : montant, jour, attestation déposée ; reçu par le notaire, jamais un autre choix [R512].
 *
 * Jamais vu : rien de deviné ne part. Un terme proposé dit sa page et qu'il a été retrouvé sur elle ; un terme que le
 * serveur n'a pas retrouvé reste vide et nommé « à lire vous-même » [R12] ; le destinataire du dépôt n'est jamais
 * pré-rempli [R512] ; rien n'est rangé avant que l'agent confirme le projet relu, terme par terme avec sa page.
 */
import { DEPOSIT_HOLDERS } from '../../core/src/avant-contrat/avant-contrat.ts';
import { ALL_TERMS } from '../../core/src/avant-contrat/lecture-projet.ts';
import { CONDITION_KINDS, LOAN_TYPE_LABEL } from '../../core/src/offres/registre-offres.ts';

/** Les termes à lire, en mots, dans l'ordre du cœur (testé égal). */
export const AC_TERMS: Readonly<Record<(typeof ALL_TERMS)[number], string>> = Object.freeze({
  prix: 'le prix',
  conditions: 'les conditions suspensives',
  date_limite_pret: 'la date limite du prêt',
  acte_prevu: 'la date de l’acte',
  'depot_garantie.montant': 'le montant du dépôt de garantie',
  'depot_garantie.detenteur': 'qui reçoit le dépôt de garantie',
});

export const AC_CONDITIONS: Readonly<Record<(typeof CONDITION_KINDS)[number], string>> = Object.freeze({
  pret: 'Obtention du prêt',
  vente_autre_bien: 'Vente d’un autre bien',
  permis_construire: 'Obtention du permis de construire',
  certificat_urbanisme: 'Certificat d’urbanisme',
  autre: 'Autre condition',
});

export const AC_HOLDERS: Readonly<Record<(typeof DEPOSIT_HOLDERS)[number], string>> = Object.freeze({
  notaire: 'le notaire',
  agence: 'l’agence',
  vendeur: 'le vendeur',
  autre: 'un autre',
});

/** Les refus du serveur, en mots : jamais un code à l'écran. */
export const AC_REFUSALS: Readonly<Record<string, string>> = Object.freeze({
  compromis_not_started: 'La note attend que l’identité de l’acquéreur soit vérifiée et le compromis lancé.',
  closed: 'Ce dossier est clos : l’avant-contrat ne change plus.',
  file_stopped: 'Ce dossier est arrêté : l’avant-contrat ne change plus.',
  busy: 'Un autre geste est en cours sur ce dossier : réessayez dans un moment.',
  no_brief: 'Rangez d’abord la note au notaire.',
  no_draft: 'Rangez d’abord le projet du notaire.',
  unknown_offer: 'L’offre acceptée de ce dossier est introuvable.',
  bad_deposit: 'Le dépôt de garantie est un nombre entier d’euros, au plus le prix.',
  bad_loan_deadline: 'La date limite du prêt est exigée avec une condition de prêt, et seulement avec elle.',
  bad_deed_day: 'Donnez la date prévue de l’acte.',
  bad_order: 'Les dates viennent dans l’ordre : aujourd’hui, la date limite du prêt, puis l’acte.',
  compromis_not_signed: 'Les dates passent à l’échéancier une fois la signature du compromis saisie.',
  blocking_difference: 'Le projet confie le dépôt de garantie à un autre que le notaire : faites-le corriger, ses dates ne passent pas.',
  notary_only: 'Le dépôt de garantie est reçu par le notaire seul.',
  bad_amount: 'Le montant reçu est un nombre entier d’euros.',
  bad_day: 'Le jour de réception ne peut pas être dans le futur.',
  not_stored: 'Le fichier n’est pas rangé au dossier : déposez-le de nouveau.',
  bad_proof: 'Le fichier n’est pas rangé au dossier : déposez-le de nouveau.',
  bad_document: 'Le fichier n’est pas rangé au dossier : déposez-le de nouveau.',
});

export const AC_ROLE = 'Ce dossier n’est pas dans vos droits.';
export const AC_WRITER = 'Seul l’agent du bien range l’avant-contrat.';
export const AC_OFFLINE = 'Pas de réseau : rien n’est rangé.';
export const AC_FAILED = 'Rien n’est rangé : réessayez dans un moment.';
export const AC_READ_FAILED = 'L’avant-contrat n’a pas pu être lu. Rouvrez le bloc dans un moment.';
export const AC_BAD_TERM = 'Un terme du projet est mal saisi : vérifiez chaque valeur et sa page.';
export const AC_NO_BRIEF = 'Aucune note au notaire n’est encore rangée.';
export const AC_NO_DRAFT = 'Aucun projet du notaire n’est encore rangé.';
export const AC_NO_DIFF = 'Aucune différence entre le projet et la note.';
export const AC_STALE = 'Ce projet avait été rangé contre une note plus ancienne : ses différences sont recalculées contre la dernière.';
export const AC_BLOCKED = 'Les dates de ce projet ne passent pas à l’échéancier tant qu’il n’est pas corrigé.';
export const AC_MANUAL = 'Rien n’a été prélu : lisez le projet et remplissez chaque terme avec sa page.';
export const AC_TO_READ = 'À lire vous-même';
export const AC_FOUND = 'Proposé, retrouvé page';
export const AC_PDF_FAILED = 'Le projet est déposé au dossier, mais n’a pas pu être prélu : lisez-le et remplissez chaque terme avec sa page.';

/** Le script servi à part. */
export const AVANT_CONTRAT_SCRIPT = `'use strict';
globalThis.AIMMO_AVANT_CONTRAT = function (t) {
  var el = t.el, clear = t.clear, send = t.send;
  var LOAN_TYPES = ${JSON.stringify(LOAN_TYPE_LABEL)};
  var TERMS = ${JSON.stringify(AC_TERMS)}, CONDS = ${JSON.stringify(AC_CONDITIONS)}, HOLDERS = ${JSON.stringify(AC_HOLDERS)}, NO = ${JSON.stringify(AC_REFUSALS)};
  var ROLE = ${JSON.stringify(AC_ROLE)}, WRITER = ${JSON.stringify(AC_WRITER)}, OFFLINE = ${JSON.stringify(AC_OFFLINE)}, FAILED = ${JSON.stringify(AC_FAILED)}, READ_FAILED = ${JSON.stringify(AC_READ_FAILED)}, BAD_TERM = ${JSON.stringify(AC_BAD_TERM)};
  var NO_BRIEF = ${JSON.stringify(AC_NO_BRIEF)}, NO_DRAFT = ${JSON.stringify(AC_NO_DRAFT)}, NO_DIFF = ${JSON.stringify(AC_NO_DIFF)}, STALE = ${JSON.stringify(AC_STALE)}, BLOCKED = ${JSON.stringify(AC_BLOCKED)};
  var MANUAL = ${JSON.stringify(AC_MANUAL)}, TO_READ = ${JSON.stringify(AC_TO_READ)}, FOUND = ${JSON.stringify(AC_FOUND)}, PDF_FAILED = ${JSON.stringify(AC_PDF_FAILED)};
  var ID = /^[A-Za-z0-9_-]{1,64}$/, DAY = /^\\d{4}-\\d{2}-\\d{2}$/, reads = 0, uid = 0;
  function own(o, k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null; }
  function text(v) { return typeof v === 'string' && v.length > 0 ? v : null; }
  function whole(v) { return typeof v === 'number' && Math.floor(v) === v && v >= 0 ? v : null; }
  function euros(n) { return String(n).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ' ') + ' €'; }
  function day(d) {
    if (typeof d !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}(T|$)/.test(d)) return null;
    var x = new Date(d.length === 10 ? d + 'T12:00:00Z' : d);
    if (isNaN(x.getTime())) return null;
    try { return x.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) { return null; }
  }
  function said(res, write) {
    if (res.refused) return res.refused;
    if (res.offline) return OFFLINE;
    var code = res.body && res.body.code;
    if (res.status === 403 && code !== 'notary_only') return write ? WRITER : ROLE;
    if (res.status === 404) return ROLE;
    if (own(NO, code)) return NO[code];
    if (typeof code === 'string' && /^bad_/.test(code)) return BAD_TERM;
    return FAILED;
  }
  function labelled(box, label, tag, type) {
    var id = 'ac-' + (++uid), l = el('label', label), f = el(tag || 'input');
    l.setAttribute('for', id);
    f.setAttribute('id', id);
    if (type) f.setAttribute('type', type);
    box.appendChild(l);
    box.appendChild(f);
    return f;
  }
  function act(box, label) { var b = el('button', label); b.setAttribute('type', 'button'); box.appendChild(b); return b; }
  function status(box) { var s = el('p', '', 'etat'); s.setAttribute('role', 'status'); box.appendChild(s); return s; }
  /** Un taux écrit « 3,85 » ou « 3.85 % », en centièmes de point ; vide : null ; illisible ou hors de 0,01 à 20 % : NaN. */
  function rateBp(v) {
    var s = String(v || '').replace(/[\\s%]/g, '').replace(',', '.');
    if (!s) return null;
    if (!/^\\d{1,2}(\\.\\d{1,2})?$/.test(s)) return NaN;
    var bp = Math.round(Number(s) * 100);
    return bp >= 1 && bp <= 2000 ? bp : NaN;
  }
  function int(v) { var s = String(v || '').trim(); if (!/^\\d{1,10}$/.test(s)) return null; return Number(s); }

  function drawState(box, s) {
    box.appendChild(el('h4', 'Note au notaire'));
    var b = s.brief;
    if (b && whole(b.version) !== null && text(b.text)) {
      box.appendChild(el('p', 'Version ' + b.version + (day(b.preparedAt) ? ', préparée le ' + day(b.preparedAt) : '') + '.', 'doux'));
      b.text.split('\\n').forEach(function (l) { if (l) box.appendChild(el('p', l)); });
    } else box.appendChild(el('p', NO_BRIEF, 'doux'));
    box.appendChild(el('h4', 'Projet du notaire'));
    var d = s.draft;
    if (d && whole(d.version) !== null) {
      box.appendChild(el('p', 'Version ' + d.version + (day(d.recordedAt) ? ', rangée le ' + day(d.recordedAt) : '') + '.', 'doux'));
      var texts = Array.isArray(s.texts) ? s.texts : [], diffs = Array.isArray(s.differences) ? s.differences : [];
      if (!texts.length) box.appendChild(el('p', NO_DIFF));
      else {
        var ul = el('ul');
        texts.forEach(function (x, i) { if (typeof x === 'string') ul.appendChild(el('li', x, diffs[i] && diffs[i].blocking === true ? 'alerte' : null)); });
        box.appendChild(ul);
      }
      if (s.comparedToEarlierBrief === true) box.appendChild(el('p', STALE, 'doux'));
      if (s.blocked === true) box.appendChild(el('p', BLOCKED, 'alerte'));
    } else box.appendChild(el('p', NO_DRAFT, 'doux'));
    box.appendChild(el('h4', 'Dépôt de garantie'));
    var p = s.deposit || {}, exp = whole(p.expectedEur), got = whole(p.receivedEur), on = day(p.receivedOn);
    var line = p.status === 'recu' && got !== null ? 'Reçu par le notaire : ' + euros(got) + (on ? ', le ' + on : '') + '.'
      : p.status === 'ecart' && got !== null && exp !== null ? 'Écart : ' + euros(got) + ' reçus par le notaire' + (on ? ' le ' + on : '') + ', ' + euros(exp) + ' attendus.'
      : p.status === 'attendu' && exp !== null ? 'Attendu : ' + euros(exp) + ', reçu par le notaire seul.'
      : p.status === 'sans_objet' ? 'Aucun dépôt de garantie prévu.' : 'Dépôt de garantie : illisible.';
    box.appendChild(el('p', line, p.status === 'ecart' ? 'alerte' : null));
  }

  function show(box, fileId, message) {
    var n = ++reads, mine = t.session();
    clear(box);
    if (typeof fileId !== 'string' || !ID.test(fileId)) { box.appendChild(el('p', READ_FAILED, 'etat')); return Promise.resolve(false); }
    var top = status(box);
    top.textContent = 'Chargement…';
    var base = '/v1/dossiers/' + encodeURIComponent(fileId) + '/avant-contrat';
    function live() { return n === reads && mine === t.session(); }
    return send(base, 'GET').then(function (res) {
      if (res.gone || !live()) return false;
      if (!res.ok) { top.textContent = res.offline ? 'Pas de réseau. Réessayez dans un moment.' : res.status === 403 || res.status === 404 ? ROLE : READ_FAILED; return false; }
      var s = res.body && res.body.data;
      if (!s || typeof s !== 'object' || (s.brief && s.brief.fileId !== fileId) || (s.draft && s.draft.fileId !== fileId)) { top.textContent = READ_FAILED; return false; }
      top.textContent = message || '';
      drawState(box, s);
      forms(box, base, fileId, live);
      return true;
    });
  }

  function post(base, path, body, out, live, box, fileId, done) {
    return send(base + path, 'POST', body).then(function (res) {
      if (res.gone || !live()) return false;
      if (!res.ok) { out.textContent = said(res, true); return false; }
      var data = res.body && res.body.data, m = done(data);
      /* Une date écrite à l'échéancier : tout le dossier se relit, pour ne jamais montrer l'ancien échéancier (remarque de Codex). */
      var dates = path === '/dates' ? data : path === '/projet' ? data && data.dates : null;
      if (dates && typeof t.refresh === 'function' && Object.keys(dates).some(function (k) { return dates[k] === 'ecrite'; })) return t.refresh(m);
      return show(box, fileId, m);
    });
  }

  function forms(box, base, fileId, live) {
    var busy = false;
    function once(fn) { return function () { if (busy || !live()) return; busy = true; var p = fn(); return Promise.resolve(p).then(function (r) { busy = false; return r; }, function () { busy = false; return false; }); }; }

    /* La note : le prix et les conditions viennent du dossier ; l'écran ne donne que le dépôt et les dates [R510]. */
    var note = el('div');
    note.appendChild(el('h4', 'Ranger la note au notaire'));
    note.appendChild(el('p', 'Le prix et les conditions suspensives sont repris du dossier et de l’offre acceptée.', 'doux'));
    var dep = labelled(note, 'Dépôt de garantie prévu, en euros (0 si aucun)', 'input', 'number');
    var loan = labelled(note, 'Date limite d’obtention du prêt (vide s’il n’y a pas de prêt)', 'input', 'date');
    var deed = labelled(note, 'Signature de l’acte au plus tard le', 'input', 'date');
    var noteGo = act(note, 'Ranger la note');
    var noteOut = status(note);
    noteGo.addEventListener('click', once(function () {
      var e = int(dep.value), l = String(loan.value || ''), a = String(deed.value || '');
      if (e === null) { noteOut.textContent = 'Donnez le dépôt de garantie prévu, 0 s’il n’y en a pas.'; return false; }
      if (l && !DAY.test(l)) { noteOut.textContent = 'La date limite du prêt est un jour.'; return false; }
      if (!DAY.test(a)) { noteOut.textContent = NO.bad_deed_day; return false; }
      noteOut.textContent = 'Envoi…';
      return post(base, '/note', { depositEur: e, loanDeadline: l || null, deedBy: a }, noteOut, live, box, fileId, function (b) { return 'Note rangée' + (b && whole(b.version) !== null ? ', version ' + b.version : '') + '.'; });
    }));
    box.appendChild(note);

    /* Le projet : déposé tel quel, prélu sous sa référence, relu terme par terme, confirmé [R511]. */
    var proj = el('div');
    proj.appendChild(el('h4', 'Ranger le projet du notaire'));
    var file = labelled(proj, 'Le projet reçu du notaire, en PDF', 'input', 'file');
    file.setAttribute('accept', 'application/pdf');
    var read = act(proj, 'Déposer et prélire');
    var readOut = status(proj);
    var terms = el('div');
    proj.appendChild(terms);
    box.appendChild(proj);
    read.addEventListener('click', once(function () {
      var f = file.files && file.files[0];
      if (!f) { readOut.textContent = 'Choisissez le PDF du projet.'; return false; }
      if (String(f.type || '').toLowerCase() !== 'application/pdf') { readOut.textContent = 'Déposez le projet en PDF.'; return false; }
      clear(terms);
      readOut.textContent = 'Dépôt du projet au dossier…';
      return t.proof(f).then(function (res) {
        if (res.gone || !live()) return false;
        var ref = res.ok && res.body && res.body.data && res.body.data.ref;
        if (typeof ref !== 'string' || !/^preuves\\/[0-9a-f-]{36}\\.pdf$/.test(ref)) { readOut.textContent = res.ok ? FAILED : said(res, true); return false; }
        readOut.textContent = 'Prélecture…';
        /* Le même fichier, sous la référence rendue : le serveur vérifie qu'il est celui déposé, octet pour octet. */
        return t.sendPdf(base + '/pdf?documentRef=' + encodeURIComponent(ref), f).then(function (r) {
          if (r.gone || !live()) return false;
          var data = r.ok && r.body && r.body.data, reading = data && data.reading;
          if (r.ok && (!data || data.documentRef !== ref || !reading || !reading.proposal)) { readOut.textContent = PDF_FAILED; termsForm(terms, ref, null, null); return true; }
          if (!r.ok) {
            var m = r.body && text(r.body.message);
            readOut.textContent = r.status === 403 || r.status === 404 || r.offline ? said(r, true) : (m ? m + ' ' : '') + PDF_FAILED;
            if (r.status === 403 || r.status === 404 || r.offline) return false;
            termsForm(terms, ref, null, null);
            return true;
          }
          var lines = [];
          if (text(data.pagesToReadText)) lines.push(data.pagesToReadText);
          if (reading.source !== 'ia') lines.push(MANUAL);
          readOut.textContent = lines.join(' ') || 'Projet prélu : relisez chaque terme avant de confirmer.';
          termsForm(terms, ref, reading.proposal, Array.isArray(reading.toRead) ? reading.toRead : []);
          return true;
        });
      });
    }));

    function termsForm(box2, ref, proposal, toRead) {
      clear(box2);
      var pr = proposal || {}, todo = toRead || Object.keys(TERMS);
      var unread = todo.map(function (k) { return own(TERMS, k); }).filter(Boolean);
      if (unread.length) box2.appendChild(el('p', TO_READ + ' : ' + unread.join(', ') + '.', 'alerte'));
      function hint(b, paged) { box2.appendChild(el('p', paged ? FOUND + ' ' + paged.page + ' : vérifiez.' : TO_READ + '.', 'doux')); }
      function paged(p, isDay) { return p && typeof p === 'object' && whole(p.page) !== null && p.page > 0 && (isDay ? typeof p.value === 'string' && DAY.test(p.value) : whole(p.value) !== null) ? p : null; }
      var price = paged(pr.priceEur, false);
      var priceIn = labelled(box2, 'Prix, en euros', 'input', 'number');
      var pricePage = labelled(box2, 'Page du prix', 'input', 'number');
      if (price) { priceIn.value = String(price.value); pricePage.value = String(price.page); }
      hint(box2, price);
      box2.appendChild(el('h5', 'Conditions suspensives du projet'));
      var conds = Object.keys(CONDS).map(function (k) {
        var p = (Array.isArray(pr.conditions) ? pr.conditions : []).filter(function (c) { return c && c.kind === k && whole(c.page) !== null && c.page > 0; })[0] || null;
        var line = el('div', null, 'case'), c = el('input'), cid = 'ac-' + (++uid);
        c.setAttribute('type', 'checkbox');
        c.setAttribute('id', cid);
        c.checked = !!p;
        var l = el('label', CONDS[k] + ' : dans le projet');
        l.setAttribute('for', cid);
        line.appendChild(c);
        line.appendChild(l);
        box2.appendChild(line);
        var page = labelled(box2, 'Page : ' + CONDS[k], 'input', 'number');
        var amount = null, months = null, rate = null, type = null;
        if (k === 'pret') {
          amount = labelled(box2, 'Montant du prêt, en euros', 'input', 'number');
          months = labelled(box2, 'Durée du prêt, en mois', 'input', 'number');
          /* Le taux maximal et le type, comparés à ceux de l'offre acceptée (AU079). */
          rate = labelled(box2, 'Taux nominal maximal hors assurance, en % (vide si le projet n’en dit pas)', 'input');
          rate.setAttribute('inputmode', 'decimal');
          type = labelled(box2, 'Type de prêt selon le projet', 'select');
          var t0 = el('option', 'Non précisé');
          t0.setAttribute('value', '');
          type.appendChild(t0);
          Object.keys(LOAN_TYPES).forEach(function (t) { var o = el('option', LOAN_TYPES[t]); o.setAttribute('value', t); type.appendChild(o); });
          type.value = '';
        }
        if (p) {
          page.value = String(p.page);
          if (amount && whole(p.amountEur) !== null) amount.value = String(p.amountEur);
          if (months && whole(p.durationMonths) !== null) months.value = String(p.durationMonths);
          if (rate && whole(p.maxRateBp) !== null) rate.value = Math.floor(p.maxRateBp / 100) + ',' + String(p.maxRateBp % 100).padStart(2, '0');
          if (type && own(LOAN_TYPES, p.loanType) !== null) type.value = p.loanType;
        }
        if (p) hint(box2, p);
        return { kind: k, box: c, page: page, amount: amount, months: months, rate: rate, type: type };
      });
      var loanP = paged(pr.loanDeadline, true), deedP = paged(pr.deedBy, true);
      var loanIn = labelled(box2, 'Date limite d’obtention du prêt (vide si le projet n’en dit pas)', 'input', 'date');
      var loanPage = labelled(box2, 'Page de la date limite du prêt', 'input', 'number');
      if (loanP) { loanIn.value = loanP.value; loanPage.value = String(loanP.page); }
      hint(box2, loanP);
      var deedIn = labelled(box2, 'Date de l’acte (vide si le projet n’en dit pas)', 'input', 'date');
      var deedPage = labelled(box2, 'Page de la date de l’acte', 'input', 'number');
      if (deedP) { deedIn.value = deedP.value; deedPage.value = String(deedP.page); }
      hint(box2, deedP);
      var depP = pr.deposit && whole(pr.deposit.eur) !== null && whole(pr.deposit.page) !== null && pr.deposit.page > 0 ? pr.deposit : null;
      var depIn = labelled(box2, 'Dépôt de garantie du projet, en euros (vide s’il n’en dit pas)', 'input', 'number');
      var depPage = labelled(box2, 'Page du dépôt de garantie', 'input', 'number');
      if (depP) { depIn.value = String(depP.eur); depPage.value = String(depP.page); }
      hint(box2, depP);
      /* Le destinataire n'est jamais proposé : l'agent le lit lui-même [R512]. */
      var holder = labelled(box2, 'Selon le projet, le dépôt est reçu par', 'select');
      var o0 = el('option', 'À lire dans le projet');
      o0.setAttribute('value', '');
      holder.appendChild(o0);
      Object.keys(HOLDERS).forEach(function (k) { var o = el('option', HOLDERS[k]); o.setAttribute('value', k); holder.appendChild(o); });
      holder.value = '';
      var check = act(box2, 'Relire avant de ranger');
      var out = status(box2);
      var sure = el('div');
      box2.appendChild(sure);
      function pg(f) { var n = int(f.value); return n !== null && n >= 1 && n <= 999 ? n : null; }
      function dayTerm(v, p, name) {
        var d = String(v.value || ''), n = String(p.value || '').trim();
        if (!d && !n) return { ok: true, value: null };
        if (!DAY.test(d) || pg(p) === null) return { ok: false, why: 'Donnez ' + name + ' et sa page, ou laissez les deux vides.' };
        return { ok: true, value: { value: d, page: pg(p) } };
      }
      check.addEventListener('click', function () {
        if (!live()) return;
        clear(sure);
        var v = int(priceIn.value), p = pg(pricePage);
        if (v === null || v < 1 || p === null) { out.textContent = 'Donnez le prix lu dans le projet et sa page.'; return; }
        var body = { documentRef: ref, priceEur: { value: v, page: p }, conditions: [] }, lines = ['Prix : ' + euros(v) + ', page ' + p + '.'];
        for (var i = 0; i < conds.length; i++) {
          var c = conds[i];
          if (!c.box.checked) continue;
          var cp = pg(c.page);
          if (cp === null) { out.textContent = 'Donnez la page : ' + CONDS[c.kind] + '.'; return; }
          var item = { kind: c.kind, page: cp };
          if (c.kind === 'pret') {
            var am = int(c.amount.value), mo = int(c.months.value);
            if (am === null || am < 1 || mo === null || mo < 1) { out.textContent = 'Donnez le montant et la durée du prêt lus dans le projet.'; return; }
            item.amountEur = am;
            item.durationMonths = mo;
            var bp = rateBp(c.rate.value);
            if (Number.isNaN(bp)) { out.textContent = 'Le taux maximal du prêt s’écrit en %, de 0,01 à 20, deux décimales au plus, ou se laisse vide.'; return; }
            if (bp !== null) item.maxRateBp = bp;
            if (c.type.value) item.loanType = c.type.value;
          }
          body.conditions.push(item);
          lines.push(CONDS[c.kind] + (item.loanType ? ' ' + LOAN_TYPES[item.loanType] : '') + (item.amountEur ? ' de ' + euros(item.amountEur) + ' sur ' + item.durationMonths + ' mois' : '') +
            (item.maxRateBp ? ', taux hors assurance ' + Math.floor(item.maxRateBp / 100) + ',' + String(item.maxRateBp % 100).padStart(2, '0') + ' % au plus' : '') + ', page ' + cp + '.');
        }
        if (!body.conditions.length) lines.push('Aucune condition suspensive.');
        var lo = dayTerm(loanIn, loanPage, 'la date limite du prêt'), de = dayTerm(deedIn, deedPage, 'la date de l’acte');
        if (!lo.ok) { out.textContent = lo.why; return; }
        if (!de.ok) { out.textContent = de.why; return; }
        body.loanDeadline = lo.value;
        body.deedBy = de.value;
        lines.push(lo.value ? 'Date limite du prêt : ' + day(lo.value.value) + ', page ' + lo.value.page + '.' : 'Aucune date limite du prêt.');
        lines.push(de.value ? 'Date de l’acte : ' + day(de.value.value) + ', page ' + de.value.page + '.' : 'Aucune date de l’acte.');
        var de2 = String(depIn.value || '').trim();
        if (de2) {
          var eur = int(de2), dp = pg(depPage), h = own(HOLDERS, holder.value) ? holder.value : null;
          if (eur === null || dp === null) { out.textContent = 'Donnez le dépôt de garantie lu dans le projet et sa page.'; return; }
          if (!h) { out.textContent = 'Lisez dans le projet qui reçoit le dépôt de garantie.'; return; }
          body.deposit = { eur: eur, holder: h, page: dp };
          lines.push('Dépôt de garantie : ' + euros(eur) + ', reçu par ' + HOLDERS[h] + ', page ' + dp + '.');
        } else { body.deposit = null; lines.push('Aucun dépôt de garantie.'); }
        out.textContent = 'Relisez : c’est ce qui sera rangé, et comparé à la note.';
        var ul = el('ul');
        lines.forEach(function (x) { ul.appendChild(el('li', x)); });
        sure.appendChild(ul);
        var frozen = JSON.parse(JSON.stringify(body));
        var go = act(sure, 'Confirmer : c’est ce que dit le projet');
        go.addEventListener('click', once(function () {
          out.textContent = 'Envoi…';
          return post(base, '/projet', frozen, out, live, box, fileId, function (b) { var d = b && b.draft; return 'Projet rangé' + (d && whole(d.version) !== null ? ', version ' + d.version : '') + '.'; });
        }));
      });
    }

    /* Les dates du dernier projet, reportées à l'échéancier une fois le compromis signé [R513]. */
    var dates = el('div');
    dates.appendChild(el('h4', 'Dates du projet à l’échéancier'));
    var datesGo = act(dates, 'Reporter les dates du projet à l’échéancier');
    var datesOut = status(dates);
    datesGo.addEventListener('click', once(function () {
      datesOut.textContent = 'Envoi…';
      return post(base, '/dates', {}, datesOut, live, box, fileId, function (r) {
        var names = { date_limite_pret: 'Date limite du prêt', acte_prevu: 'Date de l’acte' }, out = [];
        Object.keys(names).forEach(function (k) {
          var v = r && own(r, k);
          if (v) out.push(names[k] + (v === 'ecrite' ? ' : écrite à l’échéancier.' : v === 'deja_la' ? ' : déjà à l’échéancier.' : ' : pas écrite, voyez l’échéancier.'));
        });
        return out.join(' ') || 'Aucune date à reporter.';
      });
    }));
    box.appendChild(dates);

    /* Le dépôt reçu : par le notaire seul, avec son attestation [R512]. */
    var depo = el('div');
    depo.appendChild(el('h4', 'Dépôt de garantie reçu par le notaire'));
    depo.appendChild(el('p', 'Le dépôt de garantie est reçu par le notaire seul : ni l’agence ni le vendeur ne reçoivent de fonds.', 'doux'));
    var amt = labelled(depo, 'Montant reçu par le notaire, en euros', 'input', 'number');
    var on = labelled(depo, 'Reçu le', 'input', 'date');
    var att = labelled(depo, 'L’attestation du notaire', 'input', 'file');
    att.setAttribute('accept', 'application/pdf,image/jpeg,image/png');
    var depoGo = act(depo, 'Ranger le dépôt reçu');
    var depoOut = status(depo);
    depoGo.addEventListener('click', once(function () {
      var a = int(amt.value), d = String(on.value || ''), f = att.files && att.files[0];
      if (a === null || a < 1) { depoOut.textContent = NO.bad_amount; return false; }
      if (!DAY.test(d)) { depoOut.textContent = 'Donnez le jour de réception.'; return false; }
      if (!f) { depoOut.textContent = 'Joignez l’attestation du notaire.'; return false; }
      depoOut.textContent = 'Dépôt de l’attestation…';
      return t.proof(f).then(function (res) {
        if (res.gone || !live()) return false;
        var ref = res.ok && res.body && res.body.data && res.body.data.ref;
        if (typeof ref !== 'string') { depoOut.textContent = res.ok ? FAILED : said(res, true); return false; }
        return post(base, '/depot', { amountEur: a, receivedBy: 'notaire', receivedOn: d, proofRef: ref }, depoOut, live, box, fileId, function () { return 'Dépôt reçu par le notaire, rangé.'; });
      });
    }));
    box.appendChild(depo);
  }
  return { show: function (box, fileId) { return show(box, fileId); } };
};
`;
