/**
 * L'écran de la pige des annonces de particuliers (BR33), servi à part (`/app/pige.js`) et chargé seulement quand
 * l'agent ouvre la partie « Annonces de particuliers » de l'écran « Gagner des mandats » : l'application tient ainsi
 * son budget de poids [R201]. Il ne lit et n'écrit que par les routes `/v1/pige` [R16] ; il ne calcule, ne trie ni ne
 * décide rien : il montre la file dans l'ordre reçu. L'écart au marché n'est montré qu'avec sa source, sinon « marché
 * non chiffré » [R274]. Le premier message validé est montré à copier : l'agent le colle lui-même dans la messagerie de
 * l'annonce, rien ne part d'AIMMO, et seul ce canal est proposé [R275]. Chaque adresse probable dit sa confiance, son
 * niveau et ses points, chacun avec sa source et sa date [R294] ; la fiche du bien se crée d'un geste, avec une
 * adresse proposée ou sans adresse [R295]. Ce que la pige rapporte : des nombres, par niveau [R296]. Un refus se dit en
 * mots, jamais par son code. La date de la dernière relève et son alerte de panne sont dites en tête (AU034, R671). Tout texte reçu est posé avec `textContent` ; rien n'est gardé sur l'appareil.
 */

const KINDS: Readonly<Record<string, string>> = { apartment: 'Appartement', house: 'Maison' };
const LEVELS: Readonly<Record<string, string>> = { forte: 'confiance forte', moyenne: 'confiance moyenne', faible: 'confiance faible', sans_adresse: 'sans adresse' };
/** Les raisons d'un refus, dites à l'agent : jamais un code interne. */
export const PIGE_REFUSALS: Readonly<Record<string, string>> = {
  role: 'Ce n’est pas dans vos droits.',
  actif: 'Votre accès d’agent n’est pas actif.',
  agent_inactive: 'Votre accès d’agent n’est pas actif.',
  direction: 'Ce geste revient à l’agent de la zone.',
  pas_son_message: 'Ce message a été préparé par un autre agent.',
  pas_son_bien: 'Ce bien est suivi par un autre agent.',
  hors_zone: 'Cette annonce n’est plus dans vos zones.',
  unknown_ad: 'Cette annonce n’est plus dans la file : relisez-la.',
  unknown_draft: 'Ce message n’existe plus : relisez la file.',
  inconnu: 'Introuvable : relisez la file.',
  bien_trop_relie: 'Ce bien est vu sur trop d’annonces pour être suivi en entier : il est fermé.',
  pas_agence: 'Le particulier ne veut pas d’agence : aucun message, jamais.',
  opposition: 'Le particulier a dit non : le bien est fermé sur tous ses sites.',
  deja_prepare: 'Le premier message de ce bien est déjà préparé : relisez la file.',
  deja_remis: 'Ce message vous a déjà été remis.',
  bien_deja_contacte: 'Ce bien a déjà reçu son premier message, sur ce site ou un autre.',
  annonce_remplacee: 'L’annonce a changé depuis la dernière relève : relisez la file.',
  texte: 'Le texte préparé ne passe pas la vérification des textes : rien n’est remis.',
  controle: 'Le contrôle central des envois refuse ce message.',
  hors_heures: 'Hors des heures d’envoi : le message pourra être remis demain matin.',
  bad_channel: 'Ce canal n’est pas prévu.',
  adresse_inconnue: 'Cette adresse n’est plus proposée : relisez les adresses probables.',
  deja_cree: 'La fiche de ce bien existe déjà.',
  invalid_body: 'La demande n’a pas pu être lue.',
  unknown_field: 'La demande n’a pas pu être lue.',
};

/** L'alerte de la relève (AU034), dite à l'agent : jamais un code [R671]. */
export const PIGE_ALERTS: Readonly<Record<string, string>> = {
  panne: 'La dernière relève des annonces a échoué : la direction est prévenue. La file peut manquer les annonces récentes.',
  en_retard: 'Les annonces n’ont pas été relevées depuis plus d’un jour : la file peut manquer les annonces récentes.',
  jamais_relevee: 'Aucune relève des annonces n’a encore réussi : la file est vide tant que le fournisseur n’a rien envoyé.',
  non_reglee: 'Aucun fournisseur d’annonces n’est encore raccordé : la file ne se remplit pas d’elle-même.',
};

export const PIGE_SCRIPT = `'use strict';
globalThis.AIMMO_PIGE = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, date = t.date, ID = t.ID;
  var KINDS = ${JSON.stringify(KINDS)};
  var LEVELS = ${JSON.stringify(LEVELS)};
  var REFUSALS = ${JSON.stringify(PIGE_REFUSALS)};
  var ALERTS = ${JSON.stringify(PIGE_ALERTS)};
  var root = null, note = null, load = 0;
  function euros(n) { return typeof n === 'number' && isFinite(n) ? String(Math.round(n)).replace(/\\B(?=(\\d{3})+(?!\\d))/g, ' ') + ' €' : ''; }
  function said(res, fallback) {
    if (res.offline) return 'La réponse n’est pas arrivée : rien n’est sûr. Relisez la file avant de recommencer.';
    var b = res.body || {};
    return REFUSALS[b.code] || fallback;
  }
  function say(box, text) { box.appendChild(el('p', text, 'alerte')); }
  function day(iso) { return typeof iso === 'string' ? (date(iso) || iso) : ''; }
  function market(m) {
    if (!m || m.unpriced) return 'Marché non chiffré : aucune case publiée des prix regroupés pour cette commune.';
    var gap = Number(m.gapPct);
    var side = gap === 0 ? 'au prix du marché' : (gap > 0 ? gap + ' % au-dessus' : (-gap) + ' % au-dessous') + ' du marché';
    return euros(m.adPerM2) + '/m², ' + side + ' (médiane ' + euros(m.medianPerM2) + '/m² sur ' + m.sales + ' ventes ; source : ' + m.source + ', dernière vente ' + m.dvfLastSale + ').';
  }
  function report(res) {
    var box = el('section', null, 'bloc');
    box.appendChild(el('h4', 'Ce que la pige vous a rapporté'));
    var r = res.ok && res.body.data;
    if (!r) { box.appendChild(el('p', res.offline ? 'Pas de réseau pour cette partie.' : said(res, 'Indisponible pour le moment.'), 'etat')); return box; }
    box.appendChild(el('p', r.properties + ' fiche(s) créée(s), ' + r.mandates + ' mandat(s) signé(s) ensuite.'));
    var ul = el('ul', null, 'liste');
    (Array.isArray(r.rows) ? r.rows : []).forEach(function (row) { ul.appendChild(el('li', (LEVELS[row.level] || 'autre') + ' : ' + row.properties + ' fiche(s), ' + row.mandates + ' mandat(s)')); });
    box.appendChild(ul);
    return box;
  }
  /** La date de la dernière relève réussie et, s'il y en a une, l'alerte de panne [R671]. */
  function freshness(res) {
    var e = res.ok && res.body.data;
    if (!e) return null;
    var box = el('div', null, 'releve');
    box.appendChild(el('p', e.lastCollectedAt ? 'Annonces relevées le ' + day(e.lastCollectedAt) + '.' : 'Annonces jamais relevées.', 'doux'));
    if (e.alert && ALERTS[e.alert]) {
      var a = el('p', ALERTS[e.alert], 'alerte');
      a.setAttribute('role', 'alert');
      box.appendChild(a);
    }
    return box;
  }
  /** Le texte remis, à copier : jamais envoyé d'ici [R275]. */
  function toPaste(li, text) {
    var area = el('textarea');
    area.setAttribute('readonly', 'readonly');
    area.setAttribute('aria-label', 'Premier message à coller dans la messagerie de l’annonce');
    area.value = text;
    li.appendChild(area);
    li.appendChild(button('Copier le texte', function () {
      var c = globalThis.navigator && globalThis.navigator.clipboard;
      if (c && typeof c.writeText === 'function') c.writeText(text).then(function () { say(li, 'Texte copié.'); }, function () { say(li, 'Copie impossible : sélectionnez le texte à la main.'); });
      else say(li, 'Copie impossible : sélectionnez le texte à la main.');
    }));
    li.appendChild(el('p', 'Collez-le vous-même dans la messagerie de l’annonce : rien n’est parti d’AIMMO.', 'doux'));
  }
  function act(b, li, path, body, done, fallback) {
    if (b.disabled) return;
    b.disabled = true;
    send(path, 'POST', body).then(function (res) {
      if (res.gone) return;
      b.disabled = false;
      if (!res.ok) { say(li, said(res, fallback)); return; }
      done(res.body.data);
    });
  }
  function draftPart(li, a) {
    var d = a.draft;
    if (d && d.handed) { li.appendChild(el('p', 'Premier message déjà remis : vous l’avez collé dans la messagerie de l’annonce.', 'doux')); return; }
    if (!d) {
      var p = button('Préparer le premier message', function () {
        act(p, li, '/v1/pige/annonces/' + a.adId + '/message', undefined, function (v) { open('Premier message préparé : relisez-le avant de le valider.'); }, 'Le message n’a pas pu être préparé.');
      });
      li.appendChild(p);
      return;
    }
    li.appendChild(el('p', 'Premier message préparé, à relire :', 'doux'));
    li.appendChild(el('blockquote', d.body));
    if (!ID.test(d.id)) return;
    var v = button('Je l’ai relu : le copier pour la messagerie de l’annonce', function () {
      act(v, li, '/v1/pige/messages/' + d.id + '/validation', { channel: 'annonce' }, function (x) {
        li.removeChild(v);
        toPaste(li, x && typeof x.body === 'string' ? x.body : d.body);
      }, 'Le message n’a pas pu être validé.');
    });
    li.appendChild(v);
  }
  function created(p) { open(p && p.reference ? 'Fiche créée : bien ' + p.reference + ', source « pige ».' : 'Fiche créée, source « pige ».'); }
  function addresses(li, a, b) {
    act(b, li, '/v1/pige/annonces/' + a.adId + '/adresses', undefined, function (prop) {
      li.removeChild(b);
      var box = el('div');
      var cands = prop && Array.isArray(prop.candidates) ? prop.candidates : [];
      if (!cands.length) box.appendChild(el('p', 'Aucune adresse probable dans les diagnostics publiés.', 'doux'));
      var ul = el('ul', null, 'liste');
      cands.forEach(function (c) {
        var item = el('li');
        item.appendChild(el('strong', (c.streetNumber ? c.streetNumber + ' ' : '') + c.street + ', ' + c.postcode + ' ' + c.commune));
        item.appendChild(el('p', 'Confiance ' + c.confidence + ' sur 100, ' + (LEVELS[c.level] || 'niveau inconnu') + '.'));
        var pts = el('ul');
        (Array.isArray(c.points) ? c.points : []).forEach(function (pt) { pts.appendChild(el('li', pt.fact + ' (' + pt.points + ' points ; source : ' + pt.source + ', ' + day(pt.date) + ')')); });
        item.appendChild(pts);
        var k = button('Créer la fiche avec cette adresse', function () {
          act(k, item, '/v1/pige/annonces/' + a.adId + '/bien', { proposalId: prop.proposalId, diagnosisNumber: c.diagnosisNumber }, created, 'La fiche n’a pas pu être créée.');
        });
        item.appendChild(k);
        ul.appendChild(item);
      });
      box.appendChild(ul);
      (prop && Array.isArray(prop.missing) ? prop.missing : []).forEach(function (m) { box.appendChild(el('p', 'Sans réponse : ' + m.source + ' (' + m.reason + ').', 'doux')); });
      var none = button('Créer la fiche sans adresse', function () {
        act(none, box, '/v1/pige/annonces/' + a.adId + '/bien', {}, created, 'La fiche n’a pas pu être créée.');
      });
      box.appendChild(none);
      li.appendChild(box);
    }, 'Les adresses probables ne sont pas disponibles.');
  }
  function row(a) {
    var li = el('li');
    li.appendChild(el('strong', [KINDS[a.kind] || 'Bien', a.commune + ' (' + a.postalCode + ')', a.surfaceM2 + ' m²', a.rooms ? a.rooms + ' pièce(s)' : null, euros(a.priceEur)].filter(Boolean).join(' · ')));
    li.appendChild(el('p', 'Vue sur ' + a.source + (a.sites > 1 ? ' et ' + (a.sites - 1) + ' autre(s) site(s)' : '') + ', publiée le ' + day(a.publishedAt) + '.', 'doux'));
    li.appendChild(el('p', market(a.market)));
    if (!ID.test(a.adId)) return li;
    draftPart(li, a);
    var b = button('Adresses probables', function () { addresses(li, a, b); });
    li.appendChild(b);
    var no = button('Le particulier a dit non', function () {
      act(no, li, '/v1/pige/annonces/' + a.adId + '/opposition', undefined, function () { open('Bien fermé : plus aucun message, sur aucun site.'); }, 'Le refus n’a pas pu être noté.');
    });
    li.appendChild(no);
    return li;
  }
  /** La file, dans l'ordre reçu ; chaque partie qui manque est dite à part. */
  function open(message) {
    if (!root) return Promise.resolve(false);
    var box = root, mine = ++load;
    clear(box);
    note = el('p', 'Chargement…', 'etat');
    note.setAttribute('role', 'status');
    box.appendChild(note);
    return Promise.all([send('/v1/pige/rapport', 'GET'), send('/v1/pige', 'GET'), send('/v1/pige/etat', 'GET')]).then(function (all) {
      // Seule la dernière lecture dessine : une réponse plus ancienne, arrivée après, est oubliée.
      if (box !== root || mine !== load || all.some(function (r) { return r.gone; })) return false;
      if (all.every(function (r) { return r.offline; })) { note.textContent = 'Pas de réseau. Réessayez dans un moment.'; return false; }
      note.textContent = message || '';
      var fresh = freshness(all[2]);
      if (fresh) box.appendChild(fresh);
      box.appendChild(report(all[0]));
      var q = all[1];
      var items = q.ok && Array.isArray(q.body.data) ? q.body.data : null;
      if (!items) { box.appendChild(el('p', q.offline ? 'Pas de réseau pour la file.' : said(q, 'La file est indisponible pour le moment.'), 'etat')); return true; }
      box.appendChild(el('h4', 'Ma file (' + items.length + ')'));
      if (!items.length) { box.appendChild(el('p', 'Aucune annonce de particulier dans vos communes pour le moment.', 'doux')); return true; }
      var ul = el('ul', null, 'liste');
      items.forEach(function (a) { ul.appendChild(row(a)); });
      box.appendChild(ul);
      return true;
    });
  }
  return { show: function (box) { root = box; return open(''); } };
};
`;
