import type { Category, Route } from '@aimmo/core';

/**
 * Le bloc « Classement » de la fiche (Q08) [R16, R17, R201], servi à part (`/app/classement.js`) et chargé à l'ouverture
 * d'une fiche classée. Il dit ce que la personne demande, jamais ce qu'elle vaut : ni note, ni température. L'agent corrige
 * dans deux listes fermées, sans identifiant à saisir ; le serveur décide qui peut corriger. L'origine reste affichée à côté
 * de sa correction. La correction nourrit la mesure et ne change ni le projet ni les rappels : l'écran le dit.
 */
export const CATEGORY_LABELS: Readonly<Record<Category, string>> = Object.freeze({
  seller: 'Vendre',
  buyer: 'Chercher un bien',
  valuation: 'Faire estimer',
  rent_out: 'Mettre en location',
  professional: 'Demande d’un professionnel',
  partner: 'Demande d’un partenaire',
  curious: 'Simple question',
  spam: 'Message indésirable',
});

export const ROUTE_LABELS: Readonly<Record<Route, string>> = Object.freeze({
  M15: 'Location',
  M16: 'Commerce ou entreprise',
  M17: 'Investissement',
});

const NO_ROUTE = 'aucune';

/**
 * La suite qui va d'elle-même avec une catégorie, comme aux règles du socle (`routeOf`) ; `buyer` et `curious` restent au
 * choix. Sans ce recalage, changer la seule catégorie enverrait une suite fausse dans les cas de mesure.
 */
export const ROUTE_OF_CATEGORY: Readonly<Partial<Record<Category, Route | typeof NO_ROUTE>>> = Object.freeze({
  seller: NO_ROUTE,
  valuation: NO_ROUTE,
  rent_out: 'M15',
  professional: 'M16',
  partner: NO_ROUTE,
  spam: NO_ROUTE,
});

export const CLASSEMENT_SCRIPT = `'use strict';
globalThis.AIMMO_CLASSEMENT = function (t) {
  var el = t.el;
  var CATS = ${JSON.stringify(CATEGORY_LABELS)};
  var SUITES = Object.assign({ ${NO_ROUTE}: 'Aucune' }, ${JSON.stringify(ROUTE_LABELS)});
  var ROUTE_OF = ${JSON.stringify(ROUTE_OF_CATEGORY)};
  function says(category, route) {
    return (CATS[category] || 'Autre demande') + (route ? ', suite : ' + (SUITES[route] || 'autre') : '');
  }
  return function (box, personId, q) {
    if (typeof q.id !== 'string' || !t.ID.test(q.id)) return;
    var section = el('section', null, 'bloc');
    section.appendChild(el('h3', 'Classement de la demande'));
    var fixed = q.correction;
    if (fixed) {
      section.appendChild(el('p', 'Corrigé le ' + t.date(fixed.correctedAt) + ' : ' + says(fixed.category, fixed.route) + '.'));
      section.appendChild(el('p', 'Classement d’origine, gardé : ' + says(q.category, q.route) + '.', 'doux'));
    } else {
      section.appendChild(el('p', says(q.category, q.route) + ', d’après son message du ' + t.date(q.classifiedAt) + '.'));
    }
    var current = fixed || q;
    var form = el('div', null, 'decision');
    var id = t.cSeq();
    var state = t.cState();
    var category = t.cSelect(form, id + '-classe', 'Sa demande', CATS, current.category);
    var route = t.cSelect(form, id + '-suite', 'Suite', SUITES, current.route || '${NO_ROUTE}');
    category.addEventListener('change', function () { if (ROUTE_OF[category.value]) route.value = ROUTE_OF[category.value]; });
    form.appendChild(t.accordButton('Corriger le classement', function () {
      var nextRoute = route.value === '${NO_ROUTE}' ? null : route.value;
      if (category.value === current.category && nextRoute === (current.route || null)) {
        state.textContent = 'C’est déjà ce classement : rien à corriger.';
        return Promise.resolve(false);
      }
      state.textContent = 'Enregistrement…';
      return t.send('/v1/qualifications/' + encodeURIComponent(q.id) + '/correction', 'POST', { category: category.value, route: nextRoute }).then(function (res) {
        if (res.gone) return false;
        if (!res.ok) return t.accordFailed(res, personId, state, 'La correction n’est pas enregistrée : réessayez.');
        return t.openFiche(personId).then(function (read) {
          if (read) t.$('fiche-etat').textContent = 'Correction enregistrée.';
          return read;
        });
      });
    }));
    form.appendChild(el('p', 'La correction est gardée pour mesurer le classement. Elle ne change ni le projet ni les rappels.', 'doux'));
    form.appendChild(state);
    // DS010 · la correction ne s'ouvre qu'au geste : le bloc dit d'abord le classement.
    var more = el('details');
    more.appendChild(el('summary', 'Corriger'));
    more.appendChild(form);
    section.appendChild(more);
    box.appendChild(section);
  };
};
`;
