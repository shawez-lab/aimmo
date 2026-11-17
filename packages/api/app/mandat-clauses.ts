import { CLAUSES, CLAUSE_CODES, QUESTIONS } from '../../core/src/mandat-questionnaire/questionnaire.ts';

/**
 * Les textes des clauses du mandat par questionnaire à l'écran (BR118 ; M06 Mandats et documents) [R440, R442, R443, R16].
 *
 * Une partie du script des modèles de mandat (`/app/mandat-modeles.js`, D18), déjà servi à part et chargé au geste : aucun
 * chargeur de plus dans l'application [R201]. Elle lit les versions (`GET /v1/questionnaire-mandat/clauses`) et dit, pour
 * chaque clause de la liste fermée, la réponse qui la fait entrer au mandat et le texte de loi qui la fonde [R440], le texte
 * en vigueur (comme au serveur : la dernière version validée, sinon la dernière d'essai) et la dernière rangée si elle n'est
 * pas en vigueur. La direction range une nouvelle version, l'ancienne reste [R443] ; la conformité valide en deux appuis la
 * seule dernière version d'essai, jamais un texte qu'elle a écrit [R442]. Le serveur décide de tout ; l'écran dit ses refus.
 * Tout texte reçu est posé en texte ; rien n'est gardé sur l'appareil, et l'adresse ne porte qu'un identifiant [R13].
 */
const CATALOGUE = CLAUSE_CODES.map((code) => {
  const c = CLAUSES[code];
  const when = c.when.map(([q, a]) => {
    const question = QUESTIONS[q];
    return `${question.label} → ${(question.answers as Record<string, string>)[a] ?? a}`;
  });
  return { code, title: c.title, basis: c.basis, when, evidence: c.evidence };
});

const REFUSALS = {
  empty_body: 'Le texte est vide : rien n’est rangé.',
  body_too_long: 'Le texte dépasse 5 000 caractères : rien n’est rangé.',
  invalid_body: 'Le texte est trop long ou illisible : rien n’est rangé.',
  field_in_clause: 'Une clause ne se remplit pas : retirez les doubles accolades. Rien n’est rangé.',
  own_clause: 'Vous avez écrit ce texte : une autre personne de la conformité le valide.',
};
const STALE = {
  already_validated: 'Ce texte est déjà validé.',
  unknown_clause: 'Ce texte n’existe plus : clauses relues.',
};

export const MANDAT_CLAUSES_PART = `
  var CLAUSES = ${JSON.stringify(CATALOGUE)};
  var CLAUSE_NO = ${JSON.stringify(REFUSALS)};
  var CLAUSE_STALE = ${JSON.stringify(STALE)};
  var clauseReads = 0, clauseBusy = null;
  function clauseVersionText(v) {
    return v.status === 'valide'
      ? 'Version ' + v.version + ', validée le ' + date(v.validatedAt) + '.'
      : 'Version ' + v.version + ', texte d’essai, pas validé : le mandat qui l’appelle reste un document d’essai.';
  }
  function clauseAct(list, said, mode, path, body, fallback, done) {
    var mine = t.session();
    if (clauseBusy === mine) return;
    clauseBusy = mine;
    said.textContent = 'Envoi…';
    return send(path, 'POST', body).then(function (res) {
      if (clauseBusy === mine) clauseBusy = null;
      if (res.gone || mine !== t.session()) { clear(list); said.textContent = ''; return; }
      if (res.ok) return clausesFill(list, said, mode, done(res.body.data));
      if (res.offline || !res.body || res.status >= 500) {
        clear(list);
        list.appendChild(button('Relire les clauses', function () { clausesFill(list, said, mode); }));
        said.textContent = 'Réponse perdue : ce geste est peut-être rangé. Relisez avant de recommencer.';
        return;
      }
      var code = res.body.code;
      if (CLAUSE_NO[code]) { said.textContent = CLAUSE_NO[code]; return; }
      if (res.status === 403) { said.textContent = 'Ce geste n’est pas dans vos droits.'; return; }
      if (CLAUSE_STALE[code]) return clausesFill(list, said, mode, CLAUSE_STALE[code]);
      said.textContent = fallback;
    });
  }
  function clauseBlock(list, said, mode, c, all) {
    var mineCode = all.filter(function (v) { return v.code === c.code; }).sort(function (a, b) { return a.version - b.version; });
    var last = mineCode[mineCode.length - 1] || null;
    var valid = mineCode.filter(function (v) { return v.status === 'valide'; });
    var cur = valid.length ? valid[valid.length - 1] : last;
    var part = el('div', null, 'vente');
    part.appendChild(el('h5', c.title));
    part.appendChild(el('p', 'Entre au mandat quand : ' + c.when.join(' ; ou ') + '.'));
    part.appendChild(el('p', 'Fondement : ' + c.basis + (c.evidence ? '. Mise en évidence dans le mandat.' : '.'), 'doux'));
    if (!cur) part.appendChild(el('p', 'Pas encore de texte : un mandat qui appelle cette clause ne peut pas être signé.', 'alerte'));
    else {
      part.appendChild(el('p', 'En vigueur. ' + clauseVersionText(cur), cur.status === 'valide' ? 'fait' : 'alerte'));
      part.appendChild(el('p', String(cur.body), 'brouillon'));
    }
    if (last && cur && last.version !== cur.version) {
      part.appendChild(el('p', 'Dernière version rangée, pas en vigueur tant qu’elle n’est pas validée. ' + clauseVersionText(last), 'doux'));
      part.appendChild(el('p', String(last.body), 'brouillon'));
    }
    var kept = mineCode.length - (last && cur && last.version !== cur.version ? 2 : cur ? 1 : 0);
    if (kept > 0) part.appendChild(el('p', kept === 1 ? 'Une version plus ancienne est gardée.' : kept + ' versions plus anciennes sont gardées.', 'doux'));
    if (mode.validate && last && last.status === 'essai' && typeof last.id === 'string' && ID.test(last.id)) {
      if (last.ownText === true) part.appendChild(el('p', 'Vous avez écrit la version ' + last.version + ' : une autre personne de la conformité la valide.', 'doux'));
      else {
        var armed = false;
        var b = button('Valider la version ' + last.version, function () {
          if (!armed) { armed = true; b.textContent = 'Confirmer : texte relu par l’avocat'; said.textContent = 'Appuyez encore pour valider la version ' + last.version + ' de la clause « ' + c.title + ' ».'; return; }
          clauseAct(list, said, mode, '/v1/questionnaire-mandat/clauses/' + encodeURIComponent(last.id) + '/validation', {}, 'Le texte n’est pas validé.', function () { return 'Clause « ' + c.title + ' » : version ' + last.version + ' validée.'; });
        });
        part.appendChild(b);
      }
    }
    if (mode.store) {
      var text = field(part, 'mandat-clause-' + c.code, 'Texte de la nouvelle version', 'textarea');
      text.setAttribute('rows', '5');
      text.setAttribute('maxlength', '5000');
      var held = last ? String(last.body) : '';
      text.value = held;
      part.appendChild(el('p', 'Écrit tel qu’il paraîtra au mandat, sans champ entre doubles accolades ; 5 000 caractères au plus.', 'doux'));
      part.appendChild(button('Ranger ce texte de clause', function () {
        var typed = String(text.value || '').trim();
        if (!typed) { said.textContent = CLAUSE_NO.empty_body; return; }
        if (typed === held.trim()) { said.textContent = 'Le texte n’a pas changé : aucune version ajoutée.'; return; }
        clauseAct(list, said, mode, '/v1/questionnaire-mandat/clauses', { code: c.code, body: typed }, 'Le texte n’est pas rangé.', function (r) {
          return 'Clause « ' + c.title + ' » : ' + (r && r.version > 1 ? 'version ' + r.version + ' rangée, texte d’essai. L’ancienne version reste.' : 'version rangée, texte d’essai.');
        });
      }));
    }
    list.appendChild(part);
  }
  function clausesReadable(all) {
    return Array.isArray(all) && all.every(function (v) { return v && typeof v.code === 'string' && typeof v.version === 'number' && typeof v.status === 'string'; });
  }
  function clausesFill(list, said, mode, message) {
    var mine = t.session(), r = ++clauseReads;
    clear(list);
    said.textContent = 'Chargement des clauses…';
    return send('/v1/questionnaire-mandat/clauses', 'GET').then(function (res) {
      if (r !== clauseReads) return;
      if (res.gone || mine !== t.session()) { clear(list); said.textContent = ''; return; }
      clear(list);
      if (res.status === 403) { said.textContent = 'Ce geste n’est pas dans vos droits.'; return; }
      if (res.offline) { said.textContent = 'Pas de réseau. Réessayez dans un moment.'; return; }
      if (!res.ok || !clausesReadable(res.body.data)) { said.textContent = 'Les clauses ne se lisent pas pour le moment.'; return; }
      said.textContent = message || '';
      CLAUSES.forEach(function (c) { clauseBlock(list, said, mode, c, res.body.data); });
    });
  }
  function clausesPart(box, mode) {
    var part = el('div');
    part.appendChild(el('h4', 'Clauses du mandat par questionnaire'));
    part.appendChild(el('p', mode.store
      ? 'Le questionnaire ajoute une clause selon les réponses du vendeur. La direction écrit son texte, la conformité le valide ; tant qu’il ne l’est pas, le mandat reste un document d’essai.'
      : 'Valider seulement un texte relu par l’avocat, jamais un texte que vous avez écrit.', 'doux'));
    var said = el('p', null, 'etat');
    said.setAttribute('role', 'status');
    var list = el('div');
    part.appendChild(said);
    part.appendChild(list);
    box.appendChild(part);
    return clausesFill(list, said, mode);
  }
`;
