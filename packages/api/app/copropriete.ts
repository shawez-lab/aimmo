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
 */
import { COOWNERSHIP_TOPICS, URBANISM_TOPICS } from '../../core/src/documents/copropriete-urbanisme.ts';

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

/** Le script servi à part. Il n'appelle que les deux lectures de `/v1/dossiers/<id>/copropriete` [R16]. */
export const COPROPRIETE_SCRIPT = `'use strict';
globalThis.AIMMO_COPROPRIETE = function (t) {
  var el = t.el, clear = t.clear, send = t.send;
  var TOPICS = ${JSON.stringify(COPRO_TOPICS)}, DOCS = ${JSON.stringify(COPRO_DOCUMENTS)}, MISSING = ${JSON.stringify(COPRO_MISSING)};
  var NONE = ${JSON.stringify(COPRO_NONE)}, NO_WORKS = ${JSON.stringify(COPRO_NO_WORKS)}, ROLE = ${JSON.stringify(COPRO_ROLE)}, OFFLINE = ${JSON.stringify(COPRO_OFFLINE)}, FAILED = ${JSON.stringify(COPRO_FAILED)};
  var ID = /^[A-Za-z0-9_-]{1,64}$/, reads = 0;
  function own(o, k) { return typeof k === 'string' && Object.prototype.hasOwnProperty.call(o, k) ? o[k] : null; }
  function text(v) { return typeof v === 'string' && v.length > 0 ? v : null; }
  function whole(v) { return typeof v === 'number' && Math.floor(v) === v && v >= 0 ? v : null; }
  function day(d) {
    if (typeof d !== 'string' || !/^\\d{4}-\\d{2}-\\d{2}/.test(d)) return null;
    var x = new Date(d.slice(0, 10) + 'T12:00:00Z');
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
  function works(box, res) {
    box.appendChild(el('h4', 'À dire à l’acquéreur'));
    if (!res.ok) { box.appendChild(el('p', res.offline ? OFFLINE : FAILED, 'etat')); return; }
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
      works(box, all[1]);
      return true;
    });
  }
  return { show: show };
};
`;
