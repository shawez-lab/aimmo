import { ACTIVITY_LABEL } from '../../core/src/commerces/presentation.ts';
import { OFFER_DEPOSIT_MAX_BYTES, OFFER_DEPOSIT_TYPES } from '../../core/src/offres/depot-offres.ts';

/**
 * L'écran « Commerces » de l'application de l'agent (CE11), en morceaux posés dans `fichiers.ts` : sa section de page,
 * son entrée sur l'accueil et son script. Il reprend la mise en page de l'écran « Louer » (même système de design).
 *
 * L'écran ne lit et n'écrit que par les routes `/v1/commerces` [R16]. Il ne montre que ce que l'API rend à ce lecteur :
 * la vue publique, l'estimation et la présentation du bien, l'état de la porte de chaque demande (jamais un chiffre de
 * la fiche), les ouvertures du dossier et les étapes de la cession [R110]. Tout texte reçu est posé avec
 * `textContent` ; l'écran ne calcule rien, il montre ce que le code a calculé.
 *
 * CE12 : depuis la fiche, l'agent du bien ou la direction fait avancer la cession : dates et preuves, séquestre,
 * acquéreur, cession déclarée prête, puis signature et avis. Une preuve se dépose par la route de dépôt des offres, qui
 * range sous `preuves/` et contrôle les droits ; l'acquéreur se choisit dans les contacts que l'agent a le droit de voir :
 * personne ne saisit d'identifiant ni de référence.
 */

const STEP_LABELS = {
  cession_prevue: 'Date de cession prévue',
  sequestre: 'Séquestre nommé',
  information_salaries: 'Information des salariés',
  preemption: 'Préemption de la commune',
  autorisations: 'Autorisations de l’activité',
  publication_jal: 'Avis au journal d’annonces légales',
  publication_bodacc: 'Avis au BODACC',
  fin_oppositions: 'Fin des oppositions',
};
const STATUS_LABELS = { fait: 'fait', a_faire: 'à faire', a_saisir: 'à saisir', en_retard: 'en retard', sans_objet: 'sans objet', apres_cession: 'après la cession', preemptee: 'préemptée par la commune' };
const GATE_LABELS = {
  engagement_absent: 'pas d’engagement',
  engagement_revoque: 'engagement révoqué',
  engagement_non_signe: 'engagement à signer',
  engagement_modifie: 'engagement modifié depuis sa signature',
  identite_non_verifiee: 'pièce d’identité à vérifier',
};
const OPENING_LABELS = { ouvert: 'Ouvert', expire: 'Refusé : lien expiré', revoque: 'Refusé : lien révoqué', epuise: 'Refusé : ouvertures épuisées', autre_lecteur: 'Refusé : autre lecteur', porte_fermee: 'Refusé : porte fermée' };
const DATE_LABELS = {
  cession_prevue: 'Cession prévue',
  information_salaries: 'Salariés informés',
  declaration_preemption: 'Déclaration faite à la commune',
  renonciation_commune: 'Renonciation de la commune',
  preemption_exercee: 'Préemption exercée par la commune',
  autorisations_verifiees: 'Autorisations vérifiées',
  cession_signee: 'Cession signée',
  publication_jal: 'Avis au journal d’annonces légales',
  publication_bodacc: 'Avis au BODACC',
};
/** Ce qui ne se reprend pas : la date se confirme en deux appuis, et l'écran dit pourquoi. */
const FINAL_DATES = {
  preemption_exercee: 'La commune achète à la place du repreneur : cette cession ne sera plus jamais prête. Appuyez de nouveau pour confirmer.',
  cession_signee: 'Les délais des avis légaux partent de ce jour. Appuyez de nouveau pour confirmer.',
};
const CESSION_REFUSALS = {
  already_open: 'Le dossier de cession était déjà ouvert : le voici.',
  sorte: 'La cession ne concerne que les fonds de commerce.',
  kind: 'Choisissez la date dans la liste.',
  bad_day: 'Ce jour n’existe pas.',
  bad_proof: 'La preuve n’est pas rangée : choisissez de nouveau le fichier.',
  future_day: 'Ce jour est à venir : seule la cession prévue peut être dans le futur.',
  cession_non_declaree: 'Déclarez d’abord la cession prête : la signature vient après.',
  sequestre_interdit: 'Le séquestre est un avocat, un notaire ou une banque nommés, jamais le réseau ni un agent.',
  bad_name: 'Écrivez le nom du séquestre : 3 à 160 caractères.',
  unknown_file: 'Ce dossier de cession n’existe plus : relisez le commerce.',
  unknown_person: 'Ce contact n’existe plus : relisez la liste.',
  bad_buyer: 'Choisissez le contact et dites s’il s’agit d’une société.',
  bad_commune: 'Dites si la commune a un périmètre de sauvegarde.',
  bad_source: 'Écrivez la source, de 3 à 300 caractères, et sa date.',
  depot_ferme: 'Le dépôt des preuves n’est pas encore branché : aucune date ne peut être rangée.',
  type_refuse: 'Ce fichier n’est pas admis : PDF, JPEG, PNG ou texte.',
  trop_lourd: 'Ce fichier dépasse 20 Mo.',
  fichier_vide: 'Ce fichier est vide.',
  empreinte_differente: 'Le fichier a mal voyagé : réessayez.',
  stockage_indisponible: 'Le stockage ne répond pas : réessayez plus tard.',
  unknown_property: 'Ce bien n’a pas d’agent : aucune preuve ne peut s’y déposer.',
};
const KIND_LABELS = { business: 'Fonds de commerce', business_walls: 'Murs commerciaux', commercial: 'Local professionnel' };

export const COMMERCES_HOME_HTML = `<section class="bloc" aria-labelledby="titre-commerces-accueil">
<h3 id="titre-commerces-accueil">Mes commerces</h3>
<p class="etat">Estimation, présentation anonyme, demandes des repreneurs, dossier protégé et étapes de la cession.</p>
<button id="commerces-ouvrir" type="button" class="secondaire">Ouvrir mes commerces</button>
</section>
`;

export const COMMERCES_HTML = `<section id="commerces" hidden>
<button id="commerces-retour" type="button" class="retour">Retour à ma journée</button>
<h2 id="commerces-titre">Commerces</h2>
<p class="doux">Aucun chiffre confidentiel ne part sans engagement signé et pièce vérifiée.</p>
<p id="commerces-etat" class="etat" role="status"></p>
<div id="commerces-corps"></div>
</section>
`;

/**
 * Le chargeur posé dans le script de l'application : l'écran lui-même est servi à part (`/app/commerces.js`), chargé une
 * seule fois et seulement quand l'agent l'ouvre, pour que l'application tienne son budget [R201]. Il n'est jamais gardé
 * sur l'appareil.
 */
export const COMMERCES_JS = `
  /* ---------- M16 : l'écran « Commerces » (CE11), chargé à la demande [R110, R16, R201]. ---------- */
  var commercesScreen = null;
  function commercesInside() { return commercesScreen ? commercesScreen.inside() : false; }
  function wipeCommerces() {
    if (commercesScreen) { commercesScreen.wipe(); return; }
    clear($('commerces-corps'));
    $('commerces-etat').textContent = '';
    $('commerces-titre').textContent = 'Commerces';
  }
  function openCommerces(message) {
    if (!currentKey) return Promise.resolve(false);
    if (commercesScreen) return commercesScreen.open(message);
    session += 1;
    var mine = session;
    wipeCommerces();
    show('commerces');
    $('commerces-etat').textContent = 'Chargement…';
    return new Promise(function (resolve) {
      var script = document.createElement('script');
      script.setAttribute('src', '/app/commerces.js');
      script.addEventListener('load', function () {
        var make = globalThis.AIMMO_COMMERCES;
        try { delete globalThis.AIMMO_COMMERCES; } catch (e) { /* rien à retirer */ }
        if (mine !== session || typeof make !== 'function') { resolve(false); return; }
        commercesScreen = make({ $: $, el: el, clear: clear, send: send, button: button, field: field, show: show, ID: ID, key: function () { return currentKey; }, session: function () { return session; }, bump: function () { session += 1; return session; } });
        resolve(commercesScreen.open(message));
      });
      script.addEventListener('error', function () {
        if (mine === session) $('commerces-etat').textContent = 'Pas de réseau. Réessayez dans un moment.';
        resolve(false);
      });
      $('commerces').appendChild(script);
    });
  }
`;

/**
 * Le script de l'écran, servi à part (`/app/commerces.js`) : il reçoit les outils de l'application (`el`, `send`,
 * `field`…) et ne garde aucune donnée. Il ne lit et n'écrit que par les routes `/v1/commerces` [R16].
 */
export const COMMERCES_SCRIPT = `'use strict';
globalThis.AIMMO_COMMERCES = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, show = t.show, ID = t.ID;
  var CE_ACT = ${JSON.stringify(ACTIVITY_LABEL)};
  var CE_STEPS = ${JSON.stringify(STEP_LABELS)};
  var CE_STATUS = ${JSON.stringify(STATUS_LABELS)};
  var CE_GATE = ${JSON.stringify(GATE_LABELS)};
  var CE_OPEN = ${JSON.stringify(OPENING_LABELS)};
  var CE_KINDS = ${JSON.stringify(KIND_LABELS)};
  var CE_METHODS = { business: { revenue_pct: 'Part du chiffre d’affaires', ebitda_multiple: 'Multiple de l’excédent brut' }, business_walls: { rent_yield: 'Rendement du loyer' }, commercial: { rent_yield: 'Rendement du loyer' } };
  var CE_DATES = ${JSON.stringify(DATE_LABELS)};
  var CE_FINAL = ${JSON.stringify(FINAL_DATES)};
  var CE_SAY = ${JSON.stringify(CESSION_REFUSALS)};
  var CE_PROOF = ${JSON.stringify(OFFER_DEPOSIT_TYPES.preuve)}, CE_MAX = ${OFFER_DEPOSIT_MAX_BYTES};
  var ceId = null;
  function ceState(t) { $('commerces-etat').textContent = t; }
  function wipeCommerces() { clear($('commerces-corps')); ceState(''); $('commerces-titre').textContent = 'Commerces'; ceId = null; }
  function ceEur(c) { return typeof c === 'number' ? String(Math.round(c / 100)).replace(/\\B(?=(\\d{3})+(?!\\d))/g, '\\u202f') + '\\u00a0€' : ''; }
  function ceDay(iso) { return typeof iso === 'string' ? iso.slice(8, 10) + '/' + iso.slice(5, 7) + '/' + iso.slice(0, 4) : ''; }
  function ceBlock(title) {
    var b = el('section', null, 'bloc');
    b.appendChild(el('h3', title));
    $('commerces-corps').appendChild(b);
    return b;
  }
  function openCommerces(message) {
    if (!t.key()) return Promise.resolve(false);
    t.bump();
    wipeCommerces();
    show('commerces');
    ceState('Chargement…');
    /* Les tâches sont réservées aux agents : la direction ne les demande pas, pour n'écrire aucun refus au journal. */
    var tasks = send('/v1/moi', 'GET').then(function (me) {
      return me.ok && me.body.data && me.body.data.role === 'agent' ? send('/v1/commerces/taches-cession', 'GET') : null;
    });
    return Promise.all([send('/v1/commerces', 'GET'), tasks]).then(function (both) {
      var res = both[0];
      if (res.gone) return false;
      if (!res.ok) { ceState(res.offline ? 'Pas de réseau. Réessayez dans un moment.' : 'Indisponible pour le moment. Réessayez plus tard.'); return false; }
      var list = Array.isArray(res.body.data) ? res.body.data : [];
      var body = $('commerces-corps');
      ceTasks(body, both[1], list);
      if (!list.length) body.appendChild(el('p', 'Aucun commerce pour le moment.', 'doux'));
      var ul = el('ul', null, 'liste');
      list.forEach(function (c) {
        if (!ID.test(c.propertyId)) return;
        var li = el('li');
        var title = 'Bien ' + c.reference;
        li.appendChild(el('strong', title + (c.city ? ', ' + c.city : '')));
        li.appendChild(el('p', CE_KINDS[c.kind] || '', 'doux'));
        li.appendChild(button('Ouvrir', function () { openCommerce(c.propertyId, title, c.kind); }));
        ul.appendChild(li);
      });
      body.appendChild(ul);
      ceState(message || '');
      return true;
    });
  }
  function ceTasks(body, res, list) {
    if (!res || res.gone) return;
    if (!res.ok) { body.appendChild(el('p', 'Vos étapes de cession ne se lisent pas pour le moment.', 'doux')); return; }
    var tasks = Array.isArray(res.body.data) ? res.body.data : [];
    if (!tasks.length) return;
    var b = el('section', null, 'bloc');
    b.appendChild(el('h3', 'Mes étapes de cession à faire'));
    var ul = el('ul', null, 'liste');
    tasks.forEach(function (k) {
      var c = list.filter(function (x) { return x.propertyId === k.propertyId; })[0];
      if (!c || !ID.test(c.propertyId)) return;
      var title = 'Bien ' + c.reference;
      var li = el('li');
      li.appendChild(el('strong', title));
      li.appendChild(el('p', (CE_STEPS[k.step] || 'Étape') + (k.due ? ', avant le ' + ceDay(k.due) : ' : à saisir')));
      li.appendChild(button('Ouvrir ce commerce', function () { openCommerce(c.propertyId, title, c.kind); }));
      ul.appendChild(li);
    });
    b.appendChild(ul);
    body.appendChild(b);
  }
  function ceAct(path, body, fallback, done) {
    var id = ceId, title = $('commerces-titre').textContent, kind = ceKind;
    ceState('Envoi…');
    return send(path, 'POST', body).then(function (res) {
      if (res.gone) return null;
      if (!res.ok) { ceState(res.offline ? 'Pas de réseau : rien n’est enregistré.' : res.status === 403 ? 'Ce geste n’est pas dans vos droits.' : fallback); return null; }
      return openCommerce(id, title, kind, done);
    });
  }
  var ceKind = null;
  function openCommerce(id, title, kind, message) {
    if (!t.key() || !ID.test(id)) return Promise.resolve(false);
    var mine = t.bump();
    clear($('commerces-corps'));
    ceId = id;
    ceKind = kind;
    $('commerces-titre').textContent = title || 'Commerce';
    show('commerces');
    ceState('Chargement…');
    var base = '/v1/commerces/' + encodeURIComponent(id);
    var reads = ['/public', '/estimations', '/presentation', '/demandes', '/ouvertures', '/cession'].map(function (p) { return send(base + p, 'GET'); });
    return Promise.all(reads).then(function (all) {
      if (mine !== t.session() || all.some(function (x) { return x.gone; })) return false;
      /* Un geste réussi reste dit, même si la relecture échoue. */
      var unread = function (said) { ceState(message ? message + ' L’écran n’a pas pu être relu : réessayez dans un moment.' : said); return false; };
      if (all[0].offline) return unread('Pas de réseau. Réessayez dans un moment.');
      if (!all[0].ok) return unread(all[0].status === 403 ? 'Ce commerce n’est pas dans vos droits.' : 'Indisponible pour le moment. Réessayez plus tard.');
      var d = all.map(function (x) { return x.ok ? x.body.data : null; });
      ceFiche(d[0]);
      ceEstimation(base, kind, Array.isArray(d[1]) ? d[1] : []);
      cePresentation(base, d[2]);
      if (all[3].ok) ceDemandes(base, Array.isArray(d[3]) ? d[3] : []);
      ceOuvertures(Array.isArray(d[4]) ? d[4] : []);
      return ceCession(base, all[5], all[3].ok, (d[0] && d[0].publicView) || {}, mine).then(function (shown) {
        if (!shown) return false;
        ceState(message || '');
        return true;
      });
    });
  }
  function ceFiche(p) {
    var b = ceBlock('Le commerce');
    var v = (p && p.publicView) || {};
    b.appendChild(el('p', [CE_KINDS[v.kind] || '', v.activity ? CE_ACT[v.activity] : 'activité à saisir', v.city || '', v.surfaceM2 ? v.surfaceM2 + '\\u00a0m²' : ''].filter(Boolean).join(' · ')));
  }
  function ceEstimation(base, kind, list) {
    var b = ceBlock('Estimation');
    var last = list[list.length - 1];
    if (last) {
      b.appendChild(el('p', 'Fourchette : ' + ceEur(last.lowCents) + ' à ' + ceEur(last.highCents), last.validated ? 'fait' : ''));
      b.appendChild(el('p', last.validated ? 'Validée le ' + ceDay(last.validated.at) : 'À valider : relisez chaque ligne et sa source.', 'doux'));
      var ul = el('ul', null, 'liste');
      (last.lines || []).forEach(function (l) { ul.appendChild(el('li', l.hypothesis + ' : ' + l.source)); });
      b.appendChild(ul);
      if (!last.validated && ID.test(last.id)) b.appendChild(button('Valider l’estimation', function () { ceAct('/v1/commerces/estimations/' + encodeURIComponent(last.id) + '/validation', undefined, 'L’estimation n’est pas validée : la fiche ou le barème a changé.', 'Estimation validée.'); }));
    } else b.appendChild(el('p', 'Aucune estimation pour le moment.', 'doux'));
    var methods = CE_METHODS[kind] || {};
    var keys = Object.keys(methods);
    if (!keys.length) return;
    var m = field(b, 'ce-methode', 'Méthode', 'select');
    keys.forEach(function (k) { var o = el('option', methods[k]); o.value = k; m.appendChild(o); });
    b.appendChild(button('Estimer', function () {
      send(base + '/estimations', 'POST', { method: m.value }).then(function (res) {
        if (res.gone) return;
        if (res.ok && res.body.data === null) { ceState('Estimation incomplète : complétez la fiche ou demandez le barème à la direction.'); return; }
        if (!res.ok) { ceState(res.offline ? 'Pas de réseau : rien n’est enregistré.' : 'L’estimation n’est pas faite.'); return; }
        openCommerce(ceId, $('commerces-titre').textContent, ceKind, 'Estimation faite : validez-la après relecture.');
      });
    }));
  }
  function cePresentation(base, p) {
    var b = ceBlock('Présentation anonyme');
    if (p) {
      b.appendChild(el('strong', p.title));
      b.appendChild(el('p', p.body));
      b.appendChild(el('p', p.validated ? 'Validée : publiable' : 'À valider', p.validated ? 'fait' : 'doux'));
      if (!p.validated && ID.test(p.id)) b.appendChild(button('Valider la présentation', function () { ceAct('/v1/commerces/presentations/' + encodeURIComponent(p.id) + '/validation', undefined, 'La présentation n’est pas validée : préparez-en une nouvelle.', 'Présentation validée.'); }));
    }
    b.appendChild(button(p ? 'Préparer une nouvelle présentation' : 'Préparer la présentation', function () { ceAct(base + '/presentations', undefined, 'Il faut d’abord une estimation validée.', 'Présentation préparée : relisez-la avant de la valider.'); }));
  }
  function ceDemandes(base, list) {
    var b = ceBlock('Demandes des repreneurs');
    if (!list.length) { b.appendChild(el('p', 'Aucune demande pour le moment.', 'doux')); return; }
    var ul = el('ul', null, 'liste');
    list.forEach(function (r, i) {
      var li = el('li');
      li.appendChild(el('strong', (r.firstName || 'Repreneur') + ', le ' + ceDay(r.requestedAt)));
      li.appendChild(el('p', r.open ? 'Porte ouverte : le dossier peut partir.' : 'Porte fermée : ' + (r.codes || []).map(function (c) { return CE_GATE[c] || c; }).join(', ') + '.', r.open ? 'fait' : 'doux'));
      if (r.open && ID.test(r.personId)) {
        var proof = field(li, 'ce-accord-' + i, 'Accord pour recevoir le lien par mail (où, quand)', 'input');
        li.appendChild(button('Envoyer le dossier', function () {
          var said = String(proof.value || '').trim();
          if (!said) { ceState('Notez d’abord l’accord du repreneur.'); return; }
          ceAct(base + '/dossiers', { personId: r.personId, consentProof: said }, 'Le dossier n’est pas parti.', 'Dossier envoyé par le contrôle central, en mode essai.');
        }));
      }
      ul.appendChild(li);
    });
    b.appendChild(ul);
  }
  function ceOuvertures(list) {
    var b = ceBlock('Ouvertures du dossier');
    if (!list.length) { b.appendChild(el('p', 'Aucune ouverture pour le moment.', 'doux')); return; }
    var ul = el('ul', null, 'liste');
    list.forEach(function (o) { ul.appendChild(el('li', (CE_OPEN[o.outcome] || o.outcome) + ', le ' + ceDay(o.at), o.outcome === 'ouvert' ? '' : 'retard')); });
    b.appendChild(ul);
  }
  /* Pourquoi un geste n'a pas abouti : le refus du serveur, ou une réponse perdue, qui ne dit pas que rien n'est rangé. */
  function ceWhy(res, fallback) {
    var b = res.body, code = b && b.code;
    if (code === 'etapes_bloquantes') return 'Pas encore : il reste ' + ceSteps(b.missing) + '.';
    if (code && Object.prototype.hasOwnProperty.call(CE_SAY, code)) return CE_SAY[code];
    if (res.status === 403) return 'Ce geste n’est pas dans vos droits.';
    if (res.offline || !b || res.status >= 500) return 'Réponse perdue : ce geste est peut-être rangé. Relisez les étapes avant de recommencer.';
    return fallback;
  }
  function ceSteps(list) { return (Array.isArray(list) ? list : []).map(function (s) { return (CE_STEPS[s] || 'une étape').toLowerCase(); }).join(', ') || 'à déclarer la cession prête'; }
  function ceDo(path, body, done, btn, refused) {
    var id = ceId, title = $('commerces-titre').textContent, kind = ceKind, mine = t.session();
    if (btn) btn.disabled = true;
    ceState('Envoi…');
    return send(path, 'POST', body).then(function (res) {
      if (res.gone || mine !== t.session()) return false;
      if (res.ok) return openCommerce(id, title, kind, done);
      if (btn) btn.disabled = false;
      var code = res.body && res.body.code;
      if (refused) refused(code);
      if (code === 'already_open') return openCommerce(id, title, kind, CE_SAY.already_open);
      ceState(ceWhy(res, 'Ce geste n’est pas rangé.'));
      return false;
    });
  }
  function ceHex(buf) { return Array.from(new Uint8Array(buf), function (b) { return (b + 256).toString(16).slice(1); }).join(''); }
  function ceUpload(path, file, type, sha) {
    var key = t.key();
    if (!key) return Promise.resolve({ gone: true });
    var mine = t.session();
    return fetch(path, { method: 'POST', headers: { authorization: 'Bearer ' + key, 'content-type': type, 'x-aimmo-sha256': sha }, body: file, cache: 'no-store', credentials: 'omit', referrerPolicy: 'no-referrer' }).then(function (r) {
      return r.json().then(function (b) { return b; }, function () { return null; }).then(function (b) {
        if (mine !== t.session()) return { gone: true };
        /* Une clé refusée passe par send, qui sait la retirer et le dire. */
        if (r.status === 401 || (r.status === 403 && b && b.code === 'agent_inactive')) return send('/v1/moi', 'GET').then(function () { return { gone: true }; });
        return { status: r.status, ok: r.ok && !!b && b.ok === true, body: b };
      });
    }, function () { return mine !== t.session() ? { gone: true } : { offline: true }; });
  }
  /* La preuve d'une date : déposée une seule fois tant que le fichier reste le même ; personne ne saisit de référence. */
  function cePicker(box, id, label, propertyId) {
    var pick = field(box, id, label);
    pick.setAttribute('type', 'file');
    pick.setAttribute('accept', Object.keys(CE_PROOF).join(','));
    var kept = null;
    return {
      has: function () { return !!(pick.files && pick.files[0]); },
      forget: function () { kept = null; },
      get: function () {
        var file = pick.files[0];
        if (kept && kept.file === file) return Promise.resolve(kept.ref);
        var type = String(file.type || '').toLowerCase();
        if (!Object.prototype.hasOwnProperty.call(CE_PROOF, type)) { ceState(CE_SAY.type_refuse); return Promise.resolve(null); }
        if (file.size > CE_MAX) { ceState(CE_SAY.trop_lourd); return Promise.resolve(null); }
        var mine = t.session();
        ceState('Envoi du fichier…');
        return file.arrayBuffer().then(function (buf) { return crypto.subtle.digest('SHA-256', buf); }).then(function (sum) {
          if (mine !== t.session()) return null;
          return ceUpload('/v1/offres/biens/' + encodeURIComponent(propertyId) + '/fichiers/preuve', file, type, ceHex(sum)).then(function (res) {
            if (res.gone) return null;
            var ref = res.ok && res.body.data && res.body.data.ref;
            if (typeof ref === 'string') { kept = { file: file, ref: ref }; return ref; }
            var code = res.body && res.body.code;
            ceState(code && CE_SAY[code] ? CE_SAY[code] : res.status === 403 ? 'Ce geste n’est pas dans vos droits.' : 'Le fichier n’est pas rangé : réessayez.');
            return null;
          });
        }, function () { if (mine === t.session()) ceState('Ce fichier ne se lit pas sur ce téléphone.'); return null; });
      },
    };
  }
  function ceFold(box, title) {
    var f = el('details');
    f.appendChild(el('summary', title));
    box.appendChild(f);
    return f;
  }
  function ceOption(select, value, label) { var o = el('option', label); o.value = value; select.appendChild(o); }
  /* Les dates à proposer maintenant : les étapes que le code a calculées disent lesquelles ont un sens. */
  function ceKinds(v, st) {
    var d = v.dates || {}, out = ['cession_prevue'];
    if (st.information_salaries && st.information_salaries !== 'sans_objet') out.push('information_salaries');
    if (v.inPerimeter === true && st.preemption !== 'preemptee') {
      out.push('declaration_preemption');
      if (d.declaration_preemption) out.push('renonciation_commune', 'preemption_exercee');
    }
    if (st.autorisations && st.autorisations !== 'sans_objet') out.push('autorisations_verifiees');
    if (d.cession_signee || (v.ready && v.declaredReady)) out.push('cession_signee');
    if (d.cession_signee) out.push('publication_jal', 'publication_bodacc');
    return out;
  }
  function ceDateForm(box, v, st, path) {
    var f = ceFold(box, 'Ranger une date');
    var which = field(f, 'ce-date-sorte', 'Quelle date', 'select');
    ceKinds(v, st).forEach(function (k) { ceOption(which, k, CE_DATES[k]); });
    var day = field(f, 'ce-date-jour', 'Le jour');
    day.setAttribute('type', 'date');
    var pick = cePicker(f, 'ce-date-preuve', 'Sa preuve : courrier, accusé de réception, acte', v.propertyId);
    var armed = null, armedAt = 0, label = 'Ranger la date';
    var go = button(label, function () {
      var kind = which.value, chosen = day.value;
      if (!chosen) { ceState('Choisissez le jour.'); return; }
      if (!pick.has()) { ceState('Joignez la preuve de cette date.'); return; }
      var now = Date.now();
      if (CE_FINAL[kind] && (armed !== kind + chosen || now - armedAt > 15000)) {
        armed = kind + chosen;
        armedAt = now;
        go.textContent = 'Confirmer : ' + CE_DATES[kind].toLowerCase();
        ceState(CE_FINAL[kind]);
        return;
      }
      armed = null;
      go.textContent = label;
      go.disabled = true;
      pick.get().then(function (ref) {
        if (!ref) { go.disabled = false; return false; }
        return ceDo(path + '/dates', { kind: kind, day: chosen, proofRef: ref }, CE_DATES[kind] + ' : date rangée.', go, function (code) { if (code === 'bad_proof') pick.forget(); });
      });
    });
    f.appendChild(go);
    var d = v.dates || {}, seen = Object.keys(CE_DATES).filter(function (k) { return d[k]; });
    if (seen.length) {
      var ul = el('ul', null, 'liste');
      seen.forEach(function (k) { ul.appendChild(el('li', CE_DATES[k] + ' : ' + ceDay(d[k].day) + (d[k].version > 1 ? ', corrigée' : ''))); });
      f.appendChild(ul);
    }
    if (!d.cession_signee && !(v.ready && v.declaredReady)) f.appendChild(el('p', 'La signature se range une fois la cession déclarée prête.', 'doux'));
  }
  function ceEscrowForm(box, v, path) {
    var f = ceFold(box, v.escrow ? 'Séquestre : ' + v.escrow.name : 'Nommer le séquestre');
    var kind = field(f, 'ce-sequestre-sorte', 'Qui garde le prix', 'select');
    ceOption(kind, 'notaire', 'Notaire');
    ceOption(kind, 'avocat', 'Avocat');
    ceOption(kind, 'banque', 'Banque');
    if (v.escrow) kind.value = v.escrow.kind;
    var name = field(f, 'ce-sequestre-nom', 'Son nom');
    var go = button('Ranger le séquestre', function () {
      ceDo(path + '/sequestre', { kind: kind.value, name: String(name.value || '').trim() }, 'Séquestre rangé.', go);
    });
    f.appendChild(go);
  }
  function ceBuyerForm(box, v, path, read) {
    var buyer = read && read.ok ? read.body.data : null;
    var shown = buyer ? [buyer.firstName, buyer.lastName].filter(Boolean).join(' ') || 'contact rangé' : '';
    var f = ceFold(box, buyer ? 'Acquéreur : ' + shown : 'Ranger l’acquéreur');
    if (read && !read.ok) f.appendChild(el('p', 'L’acquéreur rangé ne se lit pas pour le moment.', 'doux'));
    var load = button('Choisir dans mes contacts', function () {
      load.disabled = true;
      ceState('Chargement…');
      var mine = t.session();
      send('/v1/offres/biens/' + encodeURIComponent(v.propertyId) + '/contacts', 'GET').then(function (res) {
        if (res.gone || mine !== t.session()) return;
        if (!res.ok) { load.disabled = false; ceState(res.offline ? 'Pas de réseau. Réessayez dans un moment.' : 'Vos contacts ne se lisent pas pour le moment.'); return; }
        var list = res.body.data && Array.isArray(res.body.data.contacts) ? res.body.data.contacts : [];
        ceState('');
        if (!list.length) { f.appendChild(el('p', 'Aucun contact à proposer : ajoutez d’abord l’acquéreur à vos contacts.', 'doux')); return; }
        var who = field(f, 'ce-acquereur', 'L’acquéreur', 'select');
        list.forEach(function (c) { ceOption(who, c.personId, [c.firstName, c.lastName].filter(Boolean).join(' ') || 'Contact sans nom'); });
        if (res.body.data.more) f.appendChild(el('p', 'Liste coupée : seuls les premiers contacts sont proposés.', 'doux'));
        var legal = field(f, 'ce-acquereur-sorte', 'Il achète', 'select');
        ceOption(legal, '', 'À choisir');
        ceOption(legal, 'non', 'En son nom');
        ceOption(legal, 'oui', 'Par une société');
        var go = button('Ranger l’acquéreur', function () {
          if (!legal.value) { ceState(CE_SAY.bad_buyer); return; }
          ceDo(path + '/acquereur', { personId: who.value, legalPerson: legal.value === 'oui' }, 'Acquéreur rangé.', go);
        });
        f.appendChild(go);
      });
    });
    f.appendChild(load);
  }
  function ceCommuneForm(box, v, pub, base) {
    var f = ceFold(box, 'Périmètre de sauvegarde de la commune');
    if (!pub.city || !pub.postalCode) { f.appendChild(el('p', 'Le bien n’a pas encore de commune.', 'doux')); return; }
    var yes = field(f, 'ce-commune', pub.city + ' a-t-elle un périmètre de sauvegarde ?', 'select');
    ceOption(yes, '', 'À choisir');
    ceOption(yes, 'oui', 'Oui');
    ceOption(yes, 'non', 'Non');
    var src = field(f, 'ce-commune-source', 'La source : délibération, arrêté');
    var when = field(f, 'ce-commune-jour', 'Sa date');
    when.setAttribute('type', 'date');
    var go = button('Ranger la commune', function () {
      if (!yes.value) { ceState(CE_SAY.bad_commune); return; }
      ceDo('/v1/commerces/perimetres', { postalCode: pub.postalCode, city: pub.city, inPerimeter: yes.value === 'oui', source: String(src.value || '').trim(), sourceDate: when.value }, 'Commune rangée.', go);
    });
    f.appendChild(go);
  }
  function ceEmployeesForm(box, base) {
    var f = el('div');
    var n = field(f, 'ce-salaries', 'Combien de salariés a l’entreprise ?');
    n.setAttribute('inputmode', 'numeric');
    var go = button('Ranger le nombre', function () {
      var said = String(n.value || '').trim();
      if (!/^\\d{1,6}$/.test(said)) { ceState('Écrivez un nombre entier, 0 s’il n’y a aucun salarié.'); return; }
      ceDo(base + '/fiche', { employees: Number(said) }, 'Nombre de salariés rangé.', go);
    });
    f.appendChild(go);
    box.appendChild(f);
  }
  function ceFunds(res) {
    if (!res || res.gone) return;
    if (!res.ok) { ceBlock('Origine des fonds').appendChild(el('p', 'Cette partie ne se lit pas pour le moment.', 'doux')); return; }
    var q = res.body.data;
    if (!q) return;
    var b = ceBlock('Origine des fonds');
    b.appendChild(el('p', q.text));
    var ul = el('ul', null, 'liste');
    (q.documents || []).forEach(function (x) { ul.appendChild(el('li', x)); });
    b.appendChild(ul);
    b.appendChild(el('p', 'À remettre vous-même à l’acquéreur : rien n’est parti.', 'doux'));
  }
  function ceCession(base, read, writer, pub, mine) {
    var b = ceBlock('Étapes de la cession');
    /* Une lecture manquée n'est pas l'absence d'un dossier : aucun geste n'est proposé sur ce qu'on n'a pas lu. */
    if (!read.ok && read.body && read.body.code === 'sorte') { b.appendChild(el('p', 'La cession ne concerne que les fonds de commerce.', 'doux')); return Promise.resolve(true); }
    if (!read.ok) { b.appendChild(el('p', 'Les étapes ne se lisent pas pour le moment. Réessayez dans un moment.', 'doux')); return Promise.resolve(true); }
    var v = read.body.data;
    if (!v) {
      b.appendChild(el('p', 'Pas de dossier de cession ouvert.', 'doux'));
      if (writer && ceKind === 'business') {
        var open = button('Ouvrir le dossier de cession', function () { ceDo(base + '/cession', undefined, 'Dossier de cession ouvert.', open); });
        b.appendChild(open);
      }
      return Promise.resolve(true);
    }
    var ol = el('ol', null, 'parcours'), st = {};
    (v.lines || []).forEach(function (l) {
      st[l.step] = l.status;
      var li = el('li', (CE_STEPS[l.step] || l.step) + ' : ' + (CE_STATUS[l.status] || l.status) + (l.due ? ', le ' + ceDay(l.due) : ''));
      if (l.status === 'fait' || l.status === 'sans_objet') li.className = 'fait';
      else if (l.status === 'en_retard' || l.status === 'preemptee') li.className = 'bloque';
      ol.appendChild(li);
    });
    b.appendChild(ol);
    if (st.preemption === 'preemptee') b.appendChild(el('p', 'La commune a préempté : cette cession ne se fera pas.', 'retard'));
    else if (v.ready) b.appendChild(el('p', v.declaredReady ? 'Cession déclarée prête le ' + ceDay(v.declaredReady) + '.' : 'Toutes les étapes bloquantes sont faites.', 'fait'));
    else if ((v.missing || []).length) b.appendChild(el('p', (v.declaredReady ? 'Déclarée prête le ' + ceDay(v.declaredReady) + ', mais il manque de nouveau : ' : 'Encore à faire avant la cession : ') + ceSteps(v.missing) + '.', v.declaredReady ? 'retard' : 'doux'));
    else b.appendChild(el('p', 'Étapes bloquantes à finir avant la cession.', 'doux'));
    if (v.inPerimeter === null) b.appendChild(el('p', 'La direction doit dire si la commune a un périmètre de sauvegarde.', 'doux'));
    if (!writer || !ID.test(v.fileId) || !ID.test(v.propertyId)) return Promise.resolve(true);
    var path = '/v1/commerces/cessions/' + encodeURIComponent(v.fileId);
    if (st.information_salaries === 'a_saisir' && v.dates && v.dates.cession_prevue) ceEmployeesForm(b, base);
    return Promise.all([send(path + '/acquereur', 'GET'), send(path + '/demande-fonds', 'GET'), send('/v1/moi', 'GET')]).then(function (more) {
      if (mine !== t.session() || more.some(function (x) { return x.gone; })) return false;
      ceDateForm(b, v, st, path);
      ceEscrowForm(b, v, path);
      ceBuyerForm(b, v, path, more[0]);
      if (more[2].ok && more[2].body.data && more[2].body.data.role === 'direction') ceCommuneForm(b, v, pub, base);
      if (!(v.ready && v.declaredReady)) {
        var ready = button('Déclarer la cession prête', function () { ceDo(path + '/prete', undefined, 'Cession déclarée prête.', ready); });
        b.appendChild(ready);
      }
      ceFunds(more[1]);
      return true;
    });
  }
  return { open: openCommerces, wipe: wipeCommerces, inside: function () { return ceId !== null; } };
};
`;
