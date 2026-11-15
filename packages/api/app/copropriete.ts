/**
 * BR88 · Copropriété et urbanisme relus à l'écran du dossier de vente (HX35, RC52, BR87).
 * Posé sur l'écran « Dossier de vente » : script servi à part (`/app/copropriete.js`), chargé au premier geste, sans
 * rien ajouter au script de l'application ni à celui du dossier [R201].
 *
 * Lecture seule : le bloc lit le dernier résumé (`GET /v1/dossiers/<id>/copropriete/resume`) et les travaux votés à dire
 * à l'acquéreur (`GET …/copropriete/acquereur`), puis les dit en mots. Il n'a aucun champ et n'envoie rien : une donnée
 * publique ne vient jamais de l'écran [R449]. La préparation du résumé à l'écran attend la route du PDF (RC53).
 *
 * Chaque phrase se lit avec son document, sa page et l'extrait qui la fonde [R448] ; une rubrique vide dit « non
 * trouvé » et sa raison [R450] ; le registre et la zone disent leur source, la date de la donnée et le jour de leur
 * lecture, ou « non trouvé » et pourquoi [R449, R450] ; les lignes de l'acquéreur sont celles du serveur [R451]. Tout
 * texte reçu est posé en texte ; un refus se dit en mots, jamais un code ; une réponse d'un autre dossier est jetée.
 *
 * Jamais vu : la zone du plan d'urbanisme se lit avec sa source, la date de la donnée et le jour où le serveur l'a lue
 * au point du bien ; l'écran n'offre aucun moyen de la taper.
 *
 * BR90 · La préparation, second geste du bloc (`prepare`), pour l'agent du bien : chaque PDF part tel quel à
 * `POST …/copropriete/pdf` (sorte et jour d'assemblée dans l'adresse) ; le serveur en tire le texte sans IA et rend le
 * document sous l'empreinte du fichier, les phrases proposées et ce qui reste à lire [R12, R450]. Aucune phrase proposée
 * n'est cochée d'avance : seules celles que l'agent coche partent [R448] ; il peut ajouter la sienne (rubrique,
 * document, page, extrait). Le corps de `POST …/copropriete/resume` ne porte que les documents, les phrases et, s'il
 * le veut, l'adresse du bien : jamais une zone ni un registre [R449]. Chaque phrase écartée revient avec sa raison.
 */
import { COOWNERSHIP_TOPICS, DOCUMENT_KINDS, TOPICS, URBANISM_TOPICS, type RejectReason } from '../../core/src/documents/copropriete-urbanisme.ts';

export const COPRO_TOPICS: Readonly<Record<(typeof COOWNERSHIP_TOPICS)[number] | (typeof URBANISM_TOPICS)[number], string>> = Object.freeze({
  travaux_votes: 'Travaux votés',
  travaux_a_l_etude: 'Travaux à l’étude',
  procedures: 'Procédures',
  impayes: 'Impayés',
  charges: 'Charges',
  fonds_travaux: 'Fonds de travaux',
  syndic: 'Syndic',
  zone: 'Zone, au règlement d’urbanisme',
  servitudes: 'Servitudes',
  droit_de_preemption: 'Droit de préemption',
});

export const COPRO_DOCUMENTS = Object.freeze({
  pv_assemblee: 'procès-verbal d’assemblée',
  reglement_copropriete: 'règlement de copropriété',
  fiche_synthetique: 'fiche synthétique',
  carnet_entretien: 'carnet d’entretien',
  appels_de_fonds: 'appels de fonds',
  plu_reglement: 'règlement d’urbanisme',
});

/** Pourquoi une donnée manque, en mots [R450]. */
export const COPRO_MISSING = Object.freeze({
  aucun_document: 'aucun document déposé pour cette rubrique',
  absent_des_documents: 'rien ne le dit dans les documents déposés',
  introuvable: 'introuvable au point du bien',
  panne: 'le service ne répondait pas au moment du résumé',
  non_collecte: 'non collecté : aucune adresse donnée ou service non branché',
});

export const COPRO_NONE = 'Aucun résumé de copropriété et d’urbanisme n’est encore préparé pour ce dossier.';
export const COPRO_NO_WORKS = 'Aucuns travaux votés à venir à signaler à l’acquéreur.';
export const COPRO_ROLE = 'Ce dossier n’est pas dans vos droits.';
export const COPRO_OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
export const COPRO_FAILED = 'Le résumé n’a pas pu être lu. Rouvrez le bloc dans un moment.';
/** Un résumé préparé pendant la lecture : rien n'est mélangé, l'agent relit. */
export const COPRO_CHANGED = 'Un nouveau résumé vient d’être préparé pendant la lecture : rouvrez le bloc pour lire les travaux à dire à l’acquéreur.';

/** BR90 · Les mots de la préparation. */
export const COPRO_PREP_ROLE = 'Seul l’agent du bien prépare ce résumé.';
export const COPRO_PREP_STOPPED = 'Ce dossier est arrêté : son résumé ne se prépare plus.';
export const COPRO_PREP_BUSY = 'Un autre résumé se prépare en ce moment pour ce dossier : réessayez dans un moment.';
export const COPRO_PREP_FAILED = 'Le résumé n’a pas pu être préparé. Réessayez dans un moment.';
export const COPRO_PDF_FAILED = 'Ce PDF n’a pas pu être lu. Réessayez, ou lisez-le vous-même.';
export const COPRO_PDF_TWICE = 'Ce fichier est déjà déposé : il ne compte qu’une fois.';
export const COPRO_NO_DOC = 'Déposez au moins un document avant de préparer le résumé.';
export const COPRO_MANUAL = 'Aucune phrase proposée pour ce document : lisez-le et ajoutez vos phrases.';
export const COPRO_TOO_BIG = 'Trop de texte pour un seul résumé : décochez des phrases, ou préparez un autre résumé.';
/** Un document qui ne tient plus dans le résumé n'est pas gardé : rien ne bloque ensuite la préparation (remarque de Codex). */
export const COPRO_DOC_TOO_BIG = 'Ce document ne tient plus dans ce résumé, avec ceux déjà déposés : déposez-le en plusieurs parties, ou préparez-le dans un autre résumé.';
/** La place laissée aux phrases et à l'adresse dans le corps de `POST …/resume`. */
export const COPRO_SENTENCES_ROOM = 256 * 1024;
/** Le plafond du corps de `POST …/resume` (`MAX_COPROPRIETE_BODY_BYTES`, testé égal). */
export const COPRO_PREP_MAX_BYTES = 4 * 1024 * 1024;
export const COPRO_MAX_DOCS = 30;
/** Les rubriques et les sortes, dans l'ordre du cœur (testé égal). */
export const COPRO_TOPIC_ORDER: readonly string[] = [...TOPICS];
export const COPRO_KIND_ORDER: readonly string[] = [...DOCUMENT_KINDS];

/** Pourquoi le serveur a écarté une phrase, en mots [R448]. */
export const COPRO_REJECTED: Readonly<Record<RejectReason, string>> = Object.freeze({
  sujet_inconnu: 'rubrique inconnue',
  texte_vide: 'phrase vide ou trop longue',
  plusieurs_phrases: 'une seule phrase à la fois',
  document_inconnu: 'document inconnu',
  document_hors_sujet: 'ce document ne parle pas de cette rubrique',
  page_inexistante: 'cette page n’existe pas dans le document',
  extrait_trop_court: 'extrait trop court ou trop long',
  extrait_absent_de_la_page: 'l’extrait ne se lit pas dans cette page',
  montant_absent_de_l_extrait: 'le montant ne se lit pas dans l’extrait',
  echeance_absente_de_l_extrait: 'l’échéance ne se lit pas dans l’extrait',
  travaux_mal_formes: 'montant ou échéance mal formés',
  phrase_sans_rapport_avec_l_extrait: 'la phrase ne dit pas ce que dit l’extrait',
  vote_absent_de_l_extrait: 'le vote ne se lit pas dans l’extrait',
});

/** Le script servi à part. Il n'appelle que `/v1/dossiers/<id>/copropriete` : deux lectures, le dépôt d'un PDF et la préparation [R16]. */
export const COPROPRIETE_SCRIPT = `'use strict';
globalThis.AIMMO_COPROPRIETE = function (t) {
  var el = t.el, clear = t.clear, send = t.send;
  var TOPICS = ${JSON.stringify(COPRO_TOPICS)}, DOCS = ${JSON.stringify(COPRO_DOCUMENTS)}, MISSING = ${JSON.stringify(COPRO_MISSING)};
  var NONE = ${JSON.stringify(COPRO_NONE)}, NO_WORKS = ${JSON.stringify(COPRO_NO_WORKS)}, ROLE = ${JSON.stringify(COPRO_ROLE)}, OFFLINE = ${JSON.stringify(COPRO_OFFLINE)}, FAILED = ${JSON.stringify(COPRO_FAILED)}, CHANGED = ${JSON.stringify(COPRO_CHANGED)};
  var ID = /^[A-Za-z0-9_-]{1,64}$/, reads = 0;
  var P_ROLE = ${JSON.stringify(COPRO_PREP_ROLE)}, P_STOPPED = ${JSON.stringify(COPRO_PREP_STOPPED)}, P_BUSY = ${JSON.stringify(COPRO_PREP_BUSY)}, P_FAILED = ${JSON.stringify(COPRO_PREP_FAILED)}, PDF_FAILED = ${JSON.stringify(COPRO_PDF_FAILED)};
  var TWICE = ${JSON.stringify(COPRO_PDF_TWICE)}, NO_DOC = ${JSON.stringify(COPRO_NO_DOC)}, MANUAL = ${JSON.stringify(COPRO_MANUAL)}, TOO_BIG = ${JSON.stringify(COPRO_TOO_BIG)}, DOC_TOO_BIG = ${JSON.stringify(COPRO_DOC_TOO_BIG)}, ROOM = ${COPRO_SENTENCES_ROOM}, REJECTED = ${JSON.stringify(COPRO_REJECTED)};
  var MAX_BYTES = ${COPRO_PREP_MAX_BYTES}, MAX_DOCS = ${COPRO_MAX_DOCS}, TOPIC_ORDER = ${JSON.stringify(COPRO_TOPIC_ORDER)}, KIND_ORDER = ${JSON.stringify(COPRO_KIND_ORDER)}, uid = 0;
  function own(o, k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null; }
  function text(v) { return typeof v === 'string' && v.length > 0 ? v : null; }
  function whole(v) { return typeof v === 'number' && Math.floor(v) === v && v >= 0 ? v : null; }
  function day(d) {
    if (typeof d !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}(T|$)/.test(d)) return null;
    /* Un jour seul se lit à midi ; un instant garde son heure, pour tomber sur le bon jour de Paris (remarque de Codex). */
    var x = new Date(d.length === 10 ? d + 'T12:00:00Z' : d);
    if (isNaN(x.getTime())) return null;
    try { return x.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) { return null; }
  }
  function docName(c) {
    var name = own(DOCS, c && c.kind) || 'document';
    var met = c && day(c.meetingDay);
    return met ? name + ' du ' + met : name;
  }
  function why(res) {
    if (res.offline) return OFFLINE;
    return res.status === 403 || res.status === 404 ? ROLE : FAILED;
  }
  function sentence(s) {
    var said = text(s && s.text), c = s && s.cite, page = c && whole(c.page), quote = c && text(c.quote);
    if (!said || page === null || !quote) return null;
    var li = el('li', said);
    li.appendChild(el('p', docName(c) + ', page ' + page + ' : « ' + quote + ' »', 'doux'));
    return li;
  }
  function topics(box, list) {
    var ul = el('ul');
    (Array.isArray(list) ? list : []).forEach(function (line) {
      var name = own(TOPICS, line && line.topic);
      if (!name) return;
      if (line.found === true) {
        var li = el('li', name);
        var inner = el('ul');
        (Array.isArray(line.sentences) ? line.sentences : []).forEach(function (s) { var x = sentence(s); if (x) inner.appendChild(x); });
        li.appendChild(inner);
        ul.appendChild(li);
      } else {
        ul.appendChild(el('li', name + ' : non trouvé, ' + (own(MISSING, line && line.reason) || 'sans raison connue') + '.'));
      }
    });
    box.appendChild(ul);
  }
  function publicLine(name, l, describe) {
    var source = text(l && l.source) || 'source inconnue';
    if (l && l.found === true) {
      var value = describe(l.value), data = day(l.dataDate), read = day(l.collectedOn);
      if (value && data && read) return el('p', name + ' : ' + value + '. Source : ' + source + ', donnée du ' + data + ', lue par le serveur le ' + read + '.');
      return el('p', name + ' : illisible.', 'etat');
    }
    return el('p', name + ' : non trouvé, ' + (own(MISSING, l && l.reason) || 'sans raison connue') + ' (' + source + ').', 'doux');
  }
  function registry(v) {
    var id = text(v && v.immatriculation), lots = v && whole(v.lots);
    if (!id || lots === null) return null;
    var syndic = v.syndicType === 'professionnel' && text(v.syndicName) ? 'syndic ' + v.syndicName : v.syndicType === 'benevole' ? 'syndic bénévole' : v.syndicType === 'cooperatif' ? 'syndic coopératif' : 'syndic non connu';
    return id + ', ' + lots + ' lots, ' + syndic;
  }
  function urbanism(v) {
    var kind = text(v && v.documentType), zone = text(v && v.zone), label = text(v && v.label);
    if (!kind || !zone) return null;
    return (kind === 'carte_communale' ? 'carte communale' : kind) + ', zone ' + zone + (label ? ' (' + label + ')' : '');
  }
  function summary(box, s) {
    var version = whole(s && s.version), when = day(s && s.preparedAt), hash = text(s && s.hash);
    if (version === null || !when) { box.appendChild(el('p', FAILED, 'etat')); return false; }
    box.appendChild(el('p', 'Résumé, version ' + version + ', préparé le ' + when + '.'));
    if (hash && /^[0-9a-f]{64}$/.test(hash)) box.appendChild(el('p', 'Empreinte : ' + hash.match(/.{8}/g).join(' '), 'doux'));
    var docs = (Array.isArray(s.documents) ? s.documents : []).map(function (d) { var n = whole(d && d.pages); return n === null ? null : docName(d) + ', ' + n + (n > 1 ? ' pages' : ' page'); }).filter(Boolean);
    box.appendChild(el('p', docs.length ? 'Documents lus : ' + docs.join(' ; ') + '.' : 'Aucun document lu.', 'doux'));
    box.appendChild(el('h4', 'Ce que disent les documents'));
    topics(box, s.topics);
    var out = Array.isArray(s.rejected) ? s.rejected.length : 0;
    if (out) box.appendChild(el('p', out + (out > 1 ? ' phrases proposées écartées' : ' phrase proposée écartée') + ' : elles ne se lisaient pas dans leur page.', 'doux'));
    box.appendChild(el('h4', 'Données publiques'));
    box.appendChild(publicLine('Registre des copropriétés', s.registry, registry));
    box.appendChild(publicLine('Plan d’urbanisme, lu au point du bien', s.urbanism, urbanism));
    return true;
  }
  function works(box, res, summaryId) {
    box.appendChild(el('h4', 'À dire à l’acquéreur'));
    if (!res.ok) { box.appendChild(el('p', res.offline ? OFFLINE : FAILED, 'etat')); return; }
    /* Les deux lectures doivent porter sur le même résumé : un résumé préparé entre elles ne se mélange jamais (remarque de Codex). */
    if (!res.body || !res.body.data || res.body.data.summaryId !== summaryId) { box.appendChild(el('p', CHANGED, 'etat')); return; }
    var lines = (res.body && res.body.data && Array.isArray(res.body.data.lines) ? res.body.data.lines : []).filter(function (l) { return typeof l === 'string' && l.length > 0; });
    if (!lines.length) { box.appendChild(el('p', NO_WORKS, 'doux')); return; }
    var ul = el('ul');
    lines.forEach(function (l) { ul.appendChild(el('li', l)); });
    box.appendChild(ul);
  }
  function show(box, fileId) {
    var n = ++reads, mine = t.session();
    clear(box);
    if (typeof fileId !== 'string' || !ID.test(fileId)) { box.appendChild(el('p', FAILED, 'etat')); return Promise.resolve(false); }
    var status = el('p', 'Chargement…', 'etat');
    status.setAttribute('role', 'status');
    box.appendChild(status);
    var base = '/v1/dossiers/' + encodeURIComponent(fileId) + '/copropriete';
    return Promise.all([send(base + '/resume', 'GET'), send(base + '/acquereur', 'GET')]).then(function (all) {
      if (n !== reads || mine !== t.session() || all[0].gone || all[1].gone) return false;
      var res = all[0], got = res.ok && res.body ? res.body.data : null;
      if (res.ok && got && got.fileId !== fileId) return false;
      if (!res.ok && !res.offline && res.status === 404 && res.body && res.body.code === 'no_summary') { status.textContent = NONE; return true; }
      if (!res.ok) { status.textContent = why(res); return false; }
      status.textContent = '';
      if (!summary(box, got)) return false;
      works(box, all[1], got.id);
      return true;
    });
  }
  /* BR90 : préparer un nouveau résumé depuis les PDF déposés, pour l'agent du bien. */
  function labelled(box, label, tag, type) {
    var id = 'copro-' + (++uid), l = el('label', label), f = el(tag || 'input');
    l.setAttribute('for', id);
    f.setAttribute('id', id);
    if (type) f.setAttribute('type', type);
    box.appendChild(l);
    box.appendChild(f);
    return f;
  }
  function options(sel, keys, names, first) {
    clear(sel);
    if (first) { var o0 = el('option', first); o0.setAttribute('value', ''); sel.appendChild(o0); }
    keys.forEach(function (k) { var o = el('option', names(k)); o.setAttribute('value', String(k)); sel.appendChild(o); });
  }
  function refusal(res, pdf) {
    if (res.offline) return OFFLINE;
    var code = res.body && res.body.code, said = res.body && text(res.body.message);
    if (res.status === 403) return P_ROLE;
    if (res.status === 404) return ROLE;
    if (code === 'file_stopped') return P_STOPPED;
    if (code === 'busy') return P_BUSY;
    if (pdf && said && (res.status === 413 || res.status === 415 || res.status === 422)) return said;
    return pdf ? PDF_FAILED : P_FAILED;
  }
  function bytes(v) { var j = JSON.stringify(v); return typeof TextEncoder === 'function' ? new TextEncoder().encode(j).length : j.length * 3; }
  function citeLine(s, d) { return docName(d) + ', page ' + s.page + ' : « ' + s.quote + ' »'; }
  function topicNames(list) { return (Array.isArray(list) ? list : []).map(function (k) { return own(TOPICS, k); }).filter(Boolean); }
  function prepare(box, fileId) {
    var mine = t.session();
    clear(box);
    if (typeof fileId !== 'string' || !ID.test(fileId)) { box.appendChild(el('p', P_FAILED, 'etat')); return false; }
    var base = '/v1/dossiers/' + encodeURIComponent(fileId) + '/copropriete';
    var docs = [], picks = [], busy = false;
    function live() { return mine === t.session(); }
    box.appendChild(el('h4', 'Préparer un nouveau résumé'));
    box.appendChild(el('p', 'Déposez chaque document en PDF : le serveur en lit le texte et le désigne par l’empreinte du fichier. Aucune phrase ne part sans que vous l’ayez cochée.', 'doux'));
    var kind = labelled(box, 'Sorte du document', 'select');
    options(kind, KIND_ORDER, function (k) { return own(DOCS, k); }, 'Choisir');
    var met = labelled(box, 'Jour de l’assemblée, pour un procès-verbal', 'input', 'date');
    var file = labelled(box, 'Fichier PDF', 'input', 'file');
    file.setAttribute('accept', 'application/pdf');
    var depState = el('p', '', 'etat');
    depState.setAttribute('role', 'status');
    var list = el('ul'), found = el('div');
    var dep = el('button', 'Déposer et prélire');
    dep.setAttribute('type', 'button');
    box.appendChild(dep);
    box.appendChild(depState);
    box.appendChild(el('h4', 'Documents déposés'));
    box.appendChild(list);
    box.appendChild(el('h4', 'Phrases à garder'));
    box.appendChild(found);

    function pick(s, checked) {
      var d = docs[s.document], line = el('div', null, 'case'), c = el('input'), cid = 'copro-' + (++uid);
      c.setAttribute('type', 'checkbox');
      c.setAttribute('id', cid);
      c.checked = checked === true;
      var l = el('label', own(TOPICS, s.topic) + ' : ' + s.text);
      l.setAttribute('for', cid);
      line.appendChild(c);
      line.appendChild(l);
      line.appendChild(el('p', citeLine(s, d), 'doux'));
      found.appendChild(line);
      picks.push({ s: s, box: c });
    }
    function proposed(raw, at) {
      var topic = raw && raw.topic, said = text(raw && raw.text), page = raw && whole(raw.page), quote = text(raw && raw.quote);
      if (!own(TOPICS, topic) || !said || page === null || page < 1 || page > docs[at].pages.length || !quote || raw.document !== 0) return null;
      var s = { topic: topic, text: said, document: at, page: page, quote: quote };
      var w = raw.works;
      if (w && typeof w === 'object') {
        var ww = {};
        if (typeof w.amountEur === 'number') ww.amountEur = w.amountEur;
        if (typeof w.dueOn === 'string') ww.dueOn = w.dueOn;
        if (ww.amountEur !== undefined || ww.dueOn !== undefined) s.works = ww;
      }
      return s;
    }
    dep.addEventListener('click', function () {
      if (busy || !live()) return;
      var k = kind.value, day0 = met.value, f = file.files && file.files[0];
      if (!own(DOCS, k)) { depState.textContent = 'Choisissez la sorte du document.'; return; }
      if (k === 'pv_assemblee' && !/^\\d{4}-\\d{2}-\\d{2}$/.test(day0 || '')) { depState.textContent = 'Donnez le jour de l’assemblée du procès-verbal.'; return; }
      if (!f) { depState.textContent = 'Choisissez le fichier PDF.'; return; }
      if (String(f.type || '').toLowerCase() !== 'application/pdf') { depState.textContent = 'Déposez le document en PDF.'; return; }
      if (docs.length >= MAX_DOCS) { depState.textContent = 'Trente documents au plus par résumé.'; return; }
      busy = true;
      depState.textContent = 'Lecture du PDF…';
      var q = '?kind=' + encodeURIComponent(k) + (k === 'pv_assemblee' ? '&meetingDay=' + encodeURIComponent(day0) : '');
      return t.sendPdf(base + '/pdf' + q, f).then(function (res) {
        busy = false;
        if (res.gone || !live()) return false;
        if (!res.ok) { depState.textContent = refusal(res, true); return false; }
        var data = res.body && res.body.data, d = data && data.document, reading = data && data.reading;
        var pages = d && Array.isArray(d.pages) && d.pages.length > 0 && d.pages.every(function (x) { return typeof x === 'string'; }) ? d.pages : null;
        if (!d || d.kind !== k || typeof d.ref !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(d.ref) || !pages || (k === 'pv_assemblee' ? d.meetingDay !== day0 : d.meetingDay !== undefined)) { depState.textContent = PDF_FAILED; return false; }
        if (docs.some(function (x) { return x.ref === d.ref; })) { depState.textContent = TWICE; return false; }
        var doc = { kind: d.kind, ref: d.ref, pages: pages };
        if (k === 'pv_assemblee') doc.meetingDay = d.meetingDay;
        if (bytes({ documents: docs.concat([doc]) }) > MAX_BYTES - ROOM) { depState.textContent = DOC_TOO_BIG; return false; }
        var at = docs.push(doc) - 1;
        list.appendChild(el('li', docName(doc) + ', ' + pages.length + (pages.length > 1 ? ' pages' : ' page')));
        var said = [];
        if (text(data.pagesToReadText)) said.push(data.pagesToReadText);
        var todo = topicNames(reading && reading.toRead);
        if (todo.length) said.push('À lire vous-même : ' + todo.join(', ') + '.');
        var got = (reading && Array.isArray(reading.sentences) ? reading.sentences : []).map(function (r) { return proposed(r, at); }).filter(Boolean);
        if (!got.length) said.push(MANUAL);
        got.forEach(function (s) { pick(s, false); });
        depState.textContent = said.join(' ');
        options(docSel, docs.map(function (x, i) { return i; }), function (i) { return docName(docs[i]); });
        file.value = '';
        return true;
      });
    });

    box.appendChild(el('h4', 'Ajouter votre phrase'));
    var topicSel = labelled(box, 'Rubrique', 'select');
    options(topicSel, TOPIC_ORDER, function (k) { return own(TOPICS, k); }, 'Choisir');
    var docSel = labelled(box, 'Document', 'select');
    var pageIn = labelled(box, 'Page', 'input', 'number');
    var quoteIn = labelled(box, 'Extrait, tel qu’il se lit dans la page', 'textarea');
    var textIn = labelled(box, 'Votre phrase, une seule', 'input');
    var amountIn = labelled(box, 'Montant des travaux en euros, s’il se lit dans l’extrait', 'input', 'number');
    var dueIn = labelled(box, 'Échéance des travaux, si elle se lit dans l’extrait', 'input', 'date');
    var addState = el('p', '', 'etat');
    addState.setAttribute('role', 'status');
    var add = el('button', 'Ajouter la phrase');
    add.setAttribute('type', 'button');
    box.appendChild(add);
    box.appendChild(addState);
    add.addEventListener('click', function () {
      if (!live()) return;
      var topic = topicSel.value, at = Number(docSel.value), d = docs[at], page = Number(pageIn.value), quote = text((quoteIn.value || '').trim()), said = text((textIn.value || '').trim());
      if (!own(TOPICS, topic)) { addState.textContent = 'Choisissez la rubrique.'; return; }
      if (!d || docSel.value === '') { addState.textContent = 'Déposez puis choisissez le document.'; return; }
      if (!(Math.floor(page) === page && page >= 1 && page <= d.pages.length)) { addState.textContent = 'Ce document a ' + d.pages.length + (d.pages.length > 1 ? ' pages.' : ' page.'); return; }
      if (!quote || !said) { addState.textContent = 'Donnez l’extrait et votre phrase.'; return; }
      var s = { topic: topic, text: said, document: at, page: page, quote: quote };
      if (topic === 'travaux_votes' || topic === 'travaux_a_l_etude') {
        var w = {}, amount = (amountIn.value || '').trim(), due = (dueIn.value || '').trim();
        if (amount) { var n = Number(amount); if (!(Math.floor(n) === n && n > 0)) { addState.textContent = 'Le montant est un nombre entier d’euros.'; return; } w.amountEur = n; }
        if (due) { if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(due)) { addState.textContent = 'L’échéance est un jour.'; return; } w.dueOn = due; }
        if (w.amountEur !== undefined || w.dueOn !== undefined) s.works = w;
      }
      pick(s, true);
      quoteIn.value = '';
      textIn.value = '';
      amountIn.value = '';
      dueIn.value = '';
      addState.textContent = 'Phrase ajoutée, cochée.';
    });

    box.appendChild(el('h4', 'Préparer'));
    var address = labelled(box, 'Adresse du bien, pour lire la zone au Géoportail (facultatif)', 'input');
    var state = el('p', '', 'etat');
    state.setAttribute('role', 'status');
    var go = el('button', 'Préparer le résumé');
    go.setAttribute('type', 'button');
    var after = el('div');
    box.appendChild(go);
    box.appendChild(state);
    box.appendChild(after);
    go.addEventListener('click', function () {
      if (busy || !live()) return;
      if (!docs.length) { state.textContent = NO_DOC; return; }
      var chosen = picks.filter(function (p) { return p.box.checked === true; }).map(function (p) { return p.s; });
      var body = { documents: docs, sentences: chosen };
      var where = (address.value || '').trim();
      if (where) body.address = where.slice(0, 200);
      if (bytes(body) > MAX_BYTES) { state.textContent = TOO_BIG; return; }
      busy = true;
      state.textContent = 'Préparation…';
      return send(base + '/resume', 'POST', body).then(function (res) {
        busy = false;
        if (res.gone || !live()) return false;
        if (!res.ok) { state.textContent = refusal(res, false); return false; }
        var s = res.body && res.body.data, version = whole(s && s.version);
        if (!s || s.fileId !== fileId || version === null) { state.textContent = P_FAILED; return false; }
        state.textContent = 'Résumé préparé, version ' + version + '.';
        clear(after);
        var out = (Array.isArray(s.rejected) ? s.rejected : []).map(function (r) {
          var p = r && whole(r.index) !== null ? chosen[r.index] : null;
          return p ? p.text + ' : écartée, ' + (own(REJECTED, r.reason) || 'raison inconnue') + '.' : null;
        }).filter(Boolean);
        if (out.length) {
          after.appendChild(el('p', out.length > 1 ? 'Phrases écartées par le serveur :' : 'Phrase écartée par le serveur :'));
          var ul = el('ul');
          out.forEach(function (o) { ul.appendChild(el('li', o)); });
          after.appendChild(ul);
        }
        var read = el('div');
        after.appendChild(read);
        return show(read, fileId);
      });
    });
    return true;
  }
  return { show: show, prepare: prepare };
};
`;
