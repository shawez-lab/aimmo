import { CANDIDATE_EXPERIENCES, CANDIDATE_SOURCES, CANDIDATE_STATUSES } from '../../core/src/reseau/candidatures.ts';

/**
 * Les écrans de M14 dans l'application (J14), en morceaux posés dans `fichiers.ts` : leurs entrées (sur l'accueil de
 * l'agent, et sur l'écran du réseau pour la direction), leur section de page, leur chargeur, et leur script servi à
 * part (`/app/integration.js`), chargé à la première ouverture pour tenir le budget de l'application [R201].
 *
 * Trois écrans, une seule section :
 * - « Mon intégration », pour l'agent : son dossier d'agent pièce par pièce [R82], son référent, son premier parcours ;
 * - « Académie », pour l'agent : son compteur d'heures calculé par le code, ses parcours et ses modules faits [R85] ;
 * - « Candidatures », pour la direction : l'ordre d'arrivée tel que reçu, sans tri, sans filtre, sans note ; la fiche
 *   d'entretien, l'entretien fixé puis tenu, la décision d'un humain nommé avec son motif [R81].
 *
 * L'écran ne lit et n'écrit que par les routes `/v1/reseau` [R16] ; il ne calcule rien, ne trie rien, ne garde rien. Un
 * refus est dit en français, sans rien garder. Aucun texte ne promet de revenus [R80]. Tout texte reçu est posé avec
 * `textContent`.
 */

const STATUS_LABELS: Record<(typeof CANDIDATE_STATUSES)[number], string> = {
  agent_commercial: 'Déjà agent commercial',
  salarie_immobilier: 'Salarié de l’immobilier',
  autre_metier: 'Autre métier',
  sans_emploi: 'Sans emploi',
  etudiant: 'Étudiant',
  autre: 'Autre situation',
};
const EXPERIENCE_LABELS: Record<(typeof CANDIDATE_EXPERIENCES)[number], string> = {
  aucune: 'aucune expérience de l’immobilier',
  moins_de_2_ans: 'moins de 2 ans d’immobilier',
  de_2_a_5_ans: '2 à 5 ans d’immobilier',
  plus_de_5_ans: 'plus de 5 ans d’immobilier',
};
const SOURCE_LABELS: Record<(typeof CANDIDATE_SOURCES)[number], string> = {
  video: 'venu par une vidéo',
  podcast: 'venu par un podcast',
  page: 'venu par la page de recrutement',
  parrain: 'venu par un agent du réseau',
  autre: 'venu autrement',
};
const DECISION_LABELS = { oui: 'Oui, il entre', non: 'Non', a_revoir: 'À revoir' };
const PIECE_STATES = { manquante: 'Manquante', projet: 'Projet, à déposer signé', echue: 'Échue', valide: 'Valide' };
const TRACK_LABELS = { entree: 'Parcours d’entrée', vente: 'Vente', location: 'Location', commerces: 'Commerces', investissement: 'Investissement', conformite: 'Conformité' };
const TOPIC_LABELS = { general: '', deontologie: 'déontologie', non_discrimination: 'non-discrimination' };
const OBLIGATION_LABELS = { annuelle: 'Formation de l’année', triennale: 'Formation sur 3 ans', deontologie: 'Dont déontologie, sur 3 ans', non_discrimination: 'Dont non-discrimination, sur 3 ans' };

/** Les raisons d'un refus, dites à la personne : jamais un code interne. */
const REFUSALS: Record<string, string> = {
  role: 'Ce n’est pas dans vos droits.',
  not_assigned: 'Ce n’est pas dans vos droits.',
  unknown: 'Introuvable : la liste a changé, rouvrez l’écran.',
  unknown_candidate: 'Candidature introuvable : rouvrez la liste.',
  unknown_module: 'Ce module n’existe plus : rouvrez l’académie.',
  unavailable: 'Pas encore en service.',
  not_opened: 'Votre premier parcours n’est pas encore ouvert : la direction l’ouvre à votre entrée.',
  broken_journal: 'Votre premier parcours est illisible : la direction est prévenue.',
  agent_file_incomplete: 'Votre dossier d’agent est incomplet : la direction doit le compléter.',
  bad_date: 'Date illisible : choisissez le jour et l’heure.',
  past_date: 'Un entretien se fixe à une date à venir.',
  bad_interviewer: 'Nommez la personne qui mènera l’entretien.',
  no_interviewer: 'Nommez la personne qui a mené l’entretien.',
  not_yet: 'L’entretien n’a pas encore eu lieu : il se marque tenu une fois passé.',
  bad_decision: 'Choisissez la décision.',
  no_reason: 'Écrivez le motif de la décision.',
  no_decider: 'Nommez la personne qui décide.',
  no_interview: 'Un « oui » demande un entretien déjà tenu.',
  not_accepted: 'L’intégration s’ouvre seulement après un « oui ».',
};

export const INTEGRATION_HOME_HTML = `<section class="bloc" aria-labelledby="titre-integration-accueil">
<h3 id="titre-integration-accueil">Mon intégration</h3>
<p class="etat">Votre dossier d’agent pièce par pièce, votre référent, votre premier parcours, et l’académie à votre rythme.</p>
<div class="periodes">
<button id="integration-ouvrir" type="button" class="secondaire">Mon dossier</button>
<button id="academie-ouvrir" type="button" class="secondaire">Académie</button>
</div>
</section>
`;

/** L'entrée de la direction, posée sur l'écran du réseau (K09). */
export const CANDIDATURES_ENTRY_HTML = `<section class="bloc" aria-labelledby="titre-reseau-candidatures">
<h3 id="titre-reseau-candidatures">Candidatures</h3>
<p class="doux">Dans l’ordre d’arrivée, sans note ni tri. Chaque décision est prise par une personne nommée, avec son motif.</p>
<button id="candidatures-ouvrir" type="button" class="secondaire">Lire les candidatures</button>
</section>
`;

export const INTEGRATION_HTML = `<section id="integration" hidden>
<button id="integration-retour" type="button" class="retour">Retour</button>
<h2 id="integration-titre">Mon intégration</h2>
<p id="integration-etat" class="etat" role="status"></p>
<div id="integration-corps"></div>
</section>
`;

export const INTEGRATION_CSS = `
.piece-valide { color: var(--encre); }
.piece-manque { color: var(--accent); font-weight: 600; }
.module-fait { color: var(--doux); }
`;

/** Le chargeur posé dans le script de l'application : l'écran est servi à part, chargé une fois, jamais gardé. */
export const INTEGRATION_JS = `
  /* ---------- M14 : « Mon intégration », « Académie » et « Candidatures » (J14), chargés à la demande [R16, R81, R201]. ---------- */
  var integrationScreen = null;
  var integrationMode = 'integration';
  function wipeIntegration() {
    if (integrationScreen) { integrationScreen.wipe(); return; }
    clear($('integration-corps'));
    $('integration-etat').textContent = '';
  }
  function openIntegration(mode) {
    if (!currentKey) return Promise.resolve(false);
    integrationMode = mode;
    if (integrationScreen) return integrationScreen.open(mode);
    session += 1;
    var mine = session;
    wipeIntegration();
    show('integration');
    $('integration-etat').textContent = 'Chargement…';
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.setAttribute('src', '/app/integration.js');
      s.addEventListener('load', function () {
        var make = globalThis.AIMMO_INTEGRATION;
        try { delete globalThis.AIMMO_INTEGRATION; } catch (e) { /* rien */ }
        if (mine !== session || typeof make !== 'function') { resolve(false); return; }
        integrationScreen = make({ $: $, el: el, clear: clear, send: send, show: show, button: button, field: field, select: select, details: details, date: date, hour: hour, ID: ID, key: function () { return currentKey; }, session: function () { return session; }, next: function () { session += 1; return session; } });
        resolve(integrationScreen.open(integrationMode));
      });
      s.addEventListener('error', function () {
        if (mine === session) $('integration-etat').textContent = 'Pas de réseau. Réessayez dans un moment.';
        resolve(false);
      });
      $('integration').appendChild(s);
    });
  }
`;

/**
 * Le script des écrans, servi à part (`/app/integration.js`). Il reçoit les outils de l'application, ne lit et n'écrit
 * que par les routes `/v1/reseau` [R16], et ne garde aucune donnée. Les candidatures sont montrées dans l'ordre reçu du
 * serveur : aucun tri, aucun filtre, aucune note, ni ici ni ailleurs [R81].
 */
export const INTEGRATION_SCRIPT = `'use strict';
globalThis.AIMMO_INTEGRATION = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, show = t.show, button = t.button, field = t.field, select = t.select, details = t.details, date = t.date, hour = t.hour, ID = t.ID;
  var STATUSES = ${JSON.stringify(STATUS_LABELS)};
  var EXPERIENCES = ${JSON.stringify(EXPERIENCE_LABELS)};
  var SOURCES = ${JSON.stringify(SOURCE_LABELS)};
  var DECISIONS = ${JSON.stringify(DECISION_LABELS)};
  var PIECES = ${JSON.stringify(PIECE_STATES)};
  var TRACKS = ${JSON.stringify(TRACK_LABELS)};
  var TOPICS = ${JSON.stringify(TOPIC_LABELS)};
  var OBLIGATIONS = ${JSON.stringify(OBLIGATION_LABELS)};
  var INTEGRATION_REFUSALS = ${JSON.stringify(REFUSALS)};
  var VIDEO = /^[A-Za-z0-9_-]{11}$/;
  var TITLES = { integration: 'Mon intégration', academie: 'Académie', candidatures: 'Candidatures' };
  var mode = 'integration';
  var inside = false;
  function state(text) { $('integration-etat').textContent = text; }
  function refusal(res, fallback) {
    if (res.offline) return 'La réponse n’est pas arrivée : rien n’est sûr. Relisez avant de recommencer.';
    var b = res.body || {};
    return INTEGRATION_REFUSALS[b.code] || fallback;
  }
  function wipe() {
    clear($('integration-corps'));
    state('');
    inside = false;
  }
  function when(iso) { var d = date(iso), h = hour(iso); return d ? d + (h ? ' à ' + h : '') : ''; }
  function day(d) { return typeof d === 'string' && /^\\d{4}-\\d{2}-\\d{2}$/.test(d) ? date(d + 'T12:00:00Z') : ''; }
  function hours(minutes) { var h = Math.floor(minutes / 60), m = minutes % 60; return h + ' h' + (m ? ' ' + (m < 10 ? '0' : '') + m : ''); }
  function part(title) {
    var box = el('section', null, 'bloc');
    box.appendChild(el('h3', title));
    return box;
  }
  function gauge(box, value, max, label) {
    var m = el('meter', null, 'jauge');
    m.setAttribute('min', '0');
    m.setAttribute('max', String(max));
    m.setAttribute('value', String(Math.min(value, max)));
    m.setAttribute('aria-label', label);
    box.appendChild(m);
  }
  function missing(box, res) { box.appendChild(el('p', res.offline ? 'Pas de réseau pour cette partie.' : refusal(res, 'Indisponible pour le moment.'), 'etat')); return box; }
  function data(res) { return res.ok && res.body && res.body.data !== undefined ? res.body.data : undefined; }

  function open(m, message) {
    if (!t.key()) return Promise.resolve(false);
    mode = TITLES[m] ? m : 'integration';
    var mine = t.next();
    wipe();
    show('integration');
    $('integration-titre').textContent = TITLES[mode];
    $('integration-retour').textContent = mode === 'candidatures' ? 'Retour au réseau' : 'Retour à ma journée';
    state('Chargement…');
    var reads = mode === 'candidatures' ? ['/v1/reseau/candidatures'] : mode === 'academie' ? ['/v1/reseau/ma-formation', '/v1/reseau/academie'] : ['/v1/reseau/mon-dossier', '/v1/reseau/mon-referent', '/v1/reseau/mon-bac-a-sable'];
    return Promise.all(reads.map(function (p) { return send(p, 'GET'); })).then(function (all) {
      if (mine !== t.session() || all.some(function (r) { return r.gone; })) return false;
      if (all.every(function (r) { return r.offline; })) { state('Pas de réseau. Réessayez dans un moment.'); return false; }
      var body = $('integration-corps');
      if (mode === 'candidatures') renderCandidates(body, all[0]);
      else if (mode === 'academie') { body.appendChild(renderCounter(all[0])); renderTracks(body, all[1]); }
      else { body.appendChild(renderFile(all[0])); body.appendChild(renderReferent(all[1])); body.appendChild(renderSandbox(all[2])); }
      state(message || '');
      return true;
    });
  }

  /* « Mon intégration » · le dossier d'agent, pièce par pièce [R82]. */
  function renderFile(res) {
    var box = part('Mon dossier d’agent');
    var f = data(res);
    if (!f || !Array.isArray(f.lines)) return missing(box, res);
    var ok = f.lines.filter(function (l) { return l.state === 'valide'; }).length;
    box.appendChild(el('p', f.nextStep, f.complete ? 'doux' : 'piece-manque'));
    box.appendChild(el('p', ok + ' pièce(s) valide(s) sur ' + f.lines.length, 'compte'));
    gauge(box, ok, f.lines.length || 1, ok + ' pièces valides sur ' + f.lines.length);
    var ul = el('ul', null, 'liste');
    f.lines.forEach(function (l) {
      var li = el('li');
      li.appendChild(el('strong', l.label));
      var s = PIECES[l.state] || '';
      if (l.state === 'valide' && l.validUntil) s += ' jusqu’au ' + day(l.validUntil);
      if (l.state === 'echue' && l.validUntil) s += ' le ' + day(l.validUntil);
      li.appendChild(el('p', s, l.state === 'valide' ? 'piece-valide' : 'piece-manque'));
      ul.appendChild(li);
    });
    box.appendChild(ul);
    if (!f.complete) box.appendChild(el('p', 'Tant que le dossier n’est pas complet et valide, l’accès aux clients reste fermé. L’académie et le premier parcours restent ouverts.', 'doux'));
    return box;
  }
  /* Le référent en cours : un prénom et une date. */
  function renderReferent(res) {
    var box = part('Mon référent');
    if (!res.ok) return missing(box, res);
    var r = data(res);
    if (!r) box.appendChild(el('p', 'Pas encore de référent : la direction vous en attribue un pour vos 90 premiers jours.', 'doux'));
    else {
      box.appendChild(el('strong', r.firstName));
      box.appendChild(el('p', 'Votre référent jusqu’au ' + day(r.until) + '. Posez-lui vos questions, sans attendre.', 'doux'));
      // AU112 · ses coordonnées professionnelles : un toucher pour l'appeler ou lui écrire.
      var ways = [['tel:', r.phone, 'Appeler '], ['mailto:', r.email, 'Écrire à ']].map(function (w) { return [w[0], typeof w[1] === 'string' ? w[1].replace(/\\s/g, '') : '', w[2] + r.firstName]; }).filter(function (w) { return /^[^<>"'\\s]{3,120}$/.test(w[1]); });
      ways.forEach(function (w) { var a = el('a', w[2], 'bouton'); a.setAttribute('href', w[0] + w[1]); box.appendChild(a); });
      if (!ways.length) box.appendChild(el('p', 'Ses coordonnées ne sont pas encore réglées : demandez-les à la direction.', 'doux'));
    }
    return box;
  }
  /* Le premier parcours complet, du contact à l'avis de valeur, sur des cas inventés. */
  function renderSandbox(res) {
    var box = part('Mon premier parcours');
    var p = data(res);
    if (!p || !Array.isArray(p.steps)) return missing(box, res);
    box.appendChild(el('p', 'Sur un contact inventé, du premier message à l’avis de valeur : rien ne part jamais d’ici.', 'doux'));
    var ol = el('ol', null, 'liste');
    p.steps.forEach(function (s) {
      var li = el('li');
      li.appendChild(el('strong', s.label));
      li.appendChild(el('p', s.done ? 'Fait le ' + when(s.at) : 'À faire', s.done ? 'module-fait' : 'piece-manque'));
      ol.appendChild(li);
    });
    box.appendChild(ol);
    box.appendChild(el('p', p.completed ? 'Parcours complet' + (p.countedAtAcademy ? ', compté à l’académie.' : '.') : p.next || '', 'compte'));
    return box;
  }

  /* « Académie » · le compteur des heures, calculé par le code [R85]. */
  function renderCounter(res) {
    var box = part('Mes heures de formation');
    var c = data(res);
    if (!c || !Array.isArray(c.obligations)) return missing(box, res);
    box.appendChild(el('p', 'Comptées par la base depuis vos modules faits et vos présences. Aucun horaire imposé.', 'doux'));
    c.obligations.forEach(function (o) {
      box.appendChild(el('h4', OBLIGATIONS[o.obligation] || ''));
      box.appendChild(el('p', hours(o.doneMinutes) + ' sur ' + hours(o.requiredMinutes), 'compte'));
      gauge(box, o.doneMinutes, o.requiredMinutes || 1, hours(o.doneMinutes) + ' sur ' + hours(o.requiredMinutes));
      box.appendChild(el('p', o.missingMinutes > 0 ? 'Il reste ' + hours(o.missingMinutes) + ' avant le ' + day(o.until) + ' (' + o.daysLeft + ' jours).' : 'Obligation remplie pour la période du ' + day(o.from) + ' au ' + day(o.until) + '.', o.missingMinutes > 0 ? 'piece-manque' : 'doux'));
    });
    return box;
  }
  /* Les parcours, dans l'ordre reçu ; chaque module dit s'il est fait. */
  function renderTracks(body, res) {
    var tracks = data(res);
    if (!Array.isArray(tracks)) { body.appendChild(missing(part('Les parcours'), res)); return; }
    if (!tracks.length) body.appendChild(missing(part('Les parcours'), { body: { code: 'unavailable' } }));
    tracks.forEach(function (tr) {
      var mods = Array.isArray(tr.modules) ? tr.modules : [];
      var done = mods.filter(function (m) { return m.done; }).length;
      var box = part(TRACKS[tr.track] || '');
      box.appendChild(el('p', done + ' module(s) fait(s) sur ' + mods.length, 'compte'));
      var ol = el('ol', null, 'liste');
      mods.forEach(function (m) {
        if (!ID.test(m.id)) return;
        var li = el('li');
        li.appendChild(el('strong', m.title));
        li.appendChild(el('p', m.durationMinutes + ' min' + (TOPICS[m.topic] ? ' · ' + TOPICS[m.topic] : '') + (m.mandatory ? ' · obligatoire' : ''), 'doux'));
        if (VIDEO.test(m.videoId)) {
          var a = el('a', 'Regarder la vidéo');
          a.setAttribute('href', 'https://www.youtube-nocookie.com/embed/' + m.videoId);
          a.setAttribute('target', '_blank');
          a.setAttribute('rel', 'noopener noreferrer');
          li.appendChild(a);
        }
        if (m.done) li.appendChild(el('p', 'Fait', 'module-fait'));
        else li.appendChild(button('J’ai fini ce module', function () {
          state('Envoi…');
          send('/v1/reseau/academie/modules/' + encodeURIComponent(m.id) + '/fait', 'POST').then(function (x) {
            if (x.gone) return;
            if (!x.ok) { state(refusal(x, 'Le module n’est pas noté.')); return; }
            open('academie', 'Module noté : vos heures sont recomptées.');
          });
        }));
        ol.appendChild(li);
      });
      box.appendChild(ol);
      body.appendChild(box);
    });
  }

  /* « Candidatures » · la liste dans l'ordre d'arrivée, telle que reçue : aucun tri, aucun filtre, aucune note [R81]. */
  function renderCandidates(body, res) {
    var list = data(res);
    var box = part('Dans l’ordre d’arrivée');
    if (!Array.isArray(list)) { body.appendChild(missing(box, res)); return; }
    box.appendChild(el('p', list.length + ' candidature(s)', 'compte'));
    if (!list.length) box.appendChild(el('p', 'Aucune candidature pour le moment.', 'doux'));
    var ol = el('ol', null, 'liste');
    list.forEach(function (c) {
      if (!ID.test(c.id)) return;
      var li = el('li');
      li.appendChild(el('strong', c.firstName + (c.lastName ? ' ' + c.lastName : '')));
      li.appendChild(el('p', 'Reçue le ' + when(c.createdAt) + (c.town ? ' · ' + c.town : ''), 'doux'));
      li.appendChild(el('p', (STATUSES[c.currentStatus] || '') + ', ' + (EXPERIENCES[c.experience] || '') + ', ' + (SOURCES[c.source] || '') + '.'));
      var contact = [c.email, c.phone].filter(function (x) { return typeof x === 'string' && x; }).join(' · ');
      if (contact) li.appendChild(el('p', contact + (c.contactable ? '' : ' · ne pas recontacter : pas d’accord'), c.contactable ? 'doux' : 'piece-manque'));
      li.appendChild(button('Fiche d’entretien', function () { openSheet(c.id); }));
      ol.appendChild(li);
    });
    box.appendChild(ol);
    body.appendChild(box);
  }
  function openSheet(id, message) {
    var mine = t.next();
    clear($('integration-corps'));
    inside = true;
    state('Chargement…');
    var base = '/v1/reseau/candidatures/' + encodeURIComponent(id);
    return send(base + '/entretien', 'GET').then(function (res) {
      if (res.gone || mine !== t.session()) return false;
      var s = data(res);
      if (!s || !s.declared) { state(res.offline ? 'Pas de réseau. Réessayez dans un moment.' : refusal(res, 'Fiche indisponible.')); return false; }
      $('integration-titre').textContent = 'Entretien de ' + s.declared.firstName;
      renderSheet($('integration-corps'), s, id, base);
      state(message || 'Le déclaré tel quel, les mêmes questions pour tous : aucune note, aucun avis.');
      return true;
    });
  }
  function post(path, body, done, fallback) {
    state('Envoi…');
    return send(path, 'POST', body).then(function (x) {
      if (x.gone) return;
      if (!x.ok) { state(refusal(x, fallback)); return; }
      done(x);
    });
  }
  function renderSheet(body, s, id, base) {
    var d = s.declared;
    var who = part('Ce que la personne a déclaré');
    who.appendChild(el('p', (STATUSES[d.currentStatus] || '') + ', ' + (EXPERIENCES[d.experience] || '') + ', ' + (SOURCES[d.source] || '') + (d.town ? ', ' + d.town : '') + '.'));
    if (d.question) { who.appendChild(el('h4', 'Sa question')); who.appendChild(el('p', d.question)); }
    body.appendChild(who);
    var q = part('Les questions, les mêmes pour tous');
    var ol = el('ol', null, 'liste');
    (Array.isArray(s.questions) ? s.questions : []).forEach(function (x) { ol.appendChild(el('li', x)); });
    q.appendChild(ol);
    body.appendChild(q);
    var p = part('Les pièces à fournir si elle entre');
    var pl = el('ul', null, 'liste');
    (Array.isArray(s.pieces) ? s.pieces : []).forEach(function (x) { pl.appendChild(el('li', x.label)); });
    p.appendChild(pl);
    body.appendChild(p);

    var iv = part('Entretiens');
    var interviews = Array.isArray(s.interviews) ? s.interviews : [];
    if (!interviews.length) iv.appendChild(el('p', 'Aucun entretien fixé.', 'doux'));
    interviews.forEach(function (i, n) {
      if (!ID.test(i.interviewId)) return;
      iv.appendChild(el('p', when(i.scheduledAt) + ', mené par ' + i.interviewer + (i.held ? ' · tenu' : ''), i.held ? 'module-fait' : ''));
      if (!i.held) {
        var by = field(iv, 'entretien-tenu-' + n, 'Personne qui a mené l’entretien');
        iv.appendChild(button('Marquer tenu', function () {
          post('/v1/reseau/entretiens/' + encodeURIComponent(i.interviewId) + '/tenu', { heldByName: by.value.trim() }, function () { openSheet(id, 'Entretien marqué tenu.'); }, 'L’entretien n’est pas marqué tenu.');
        }));
      }
    });
    var plan = details(iv, 'Fixer un entretien');
    var at = field(plan, 'entretien-quand', 'Jour et heure');
    at.setAttribute('type', 'datetime-local');
    var lead = field(plan, 'entretien-qui', 'Personne qui le mènera');
    plan.appendChild(button('Fixer l’entretien', function () {
      var stamp = at.value ? new Date(at.value) : null;
      if (!stamp || isNaN(stamp.getTime())) { state(INTEGRATION_REFUSALS.bad_date); return; }
      post(base + '/entretien', { at: stamp.toISOString(), interviewer: lead.value.trim() }, function () { openSheet(id, 'Entretien fixé.'); }, 'L’entretien n’est pas fixé.');
    }));
    body.appendChild(iv);

    var dec = part('Décision');
    if (s.decision) {
      dec.appendChild(el('p', (DECISIONS[s.decision.decision] || '') + ' · par ' + s.decision.deciderName + ', le ' + when(s.decision.decidedAt), 'compte'));
      dec.appendChild(el('p', 'Motif : ' + s.decision.reason));
      if (s.decision.decision === 'oui') {
        var zone = field(dec, 'integration-zone', 'Secteur de l’agent (facultatif)');
        dec.appendChild(button('Ouvrir son intégration', function () {
          var z = zone.value.trim();
          post(base + '/admettre', z ? { zone: z } : {}, function () { openSheet(id, 'Intégration ouverte : son dossier d’agent l’attend.'); }, 'L’intégration n’est pas ouverte.');
        }));
      }
    }
    var form = s.decision ? details(dec, 'Prendre une nouvelle décision') : dec;
    form.appendChild(el('p', 'Une décision ne s’efface pas : une nouvelle s’ajoute, la dernière compte.', 'doux'));
    var choice = select(form, 'decision-choix', 'Décision', { '': 'Choisir', oui: DECISIONS.oui, non: DECISIONS.non, a_revoir: DECISIONS.a_revoir }, '');
    var reason = field(form, 'decision-motif', 'Motif', 'textarea');
    var decider = field(form, 'decision-qui', 'Personne qui décide');
    form.appendChild(button('Ranger la décision', function () {
      if (!choice.value) { state(INTEGRATION_REFUSALS.bad_decision); return; }
      post(base + '/decision', { decision: choice.value, reason: reason.value.trim(), deciderName: decider.value.trim() }, function () { openSheet(id, 'Décision rangée.'); }, 'La décision n’est pas rangée.');
    }));
    body.appendChild(dec);
  }
  return { open: open, wipe: wipe, inside: function () { return inside; }, mode: function () { return mode; } };
};
`;
