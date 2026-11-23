import { TEMPLATE_FIELDS } from '../../core/src/documents/modeles.ts';
import { MANDAT_CLAUSES_PART } from './mandat-clauses.ts';
import { MANDAT_REGLAGE_PART } from './mandat-reglage.ts';

/**
 * Les modèles de mandat et d'avenant à l'écran (D18), servis à part (`/app/mandat-modeles.js`), chargés au premier geste
 * [R201]. La direction lit et range une nouvelle version, qui s'ajoute sans toucher à l'ancienne [R17] ; seule la conformité
 * valide [H08]. Sans modèle, ni mandat ni avenant ne se prépare : c'est le manque que D17 a trouvé. Le serveur décide de
 * tout [R40] ; l'écran ne fait que dire ses refus. Tout texte reçu est posé en texte ; rien n'est gardé sur l'appareil.
 * Sous les modèles, au même geste, les textes des clauses du mandat par questionnaire (BR118, `mandat-clauses.ts`),
 * puis l'écart de prix toléré (BR119, `mandat-reglage.ts`).
 */
const MANDATE_ONLY = ['honoraires.montant', 'honoraires.charge', 'mandat.duree_mois', 'registre.numero'];
const AVENANT_ONLY = ['mandat.numero', 'avenant.objet', 'avenant.prix', 'avenant.duree_mois', 'avenant.honoraires', 'avenant.honoraires_charge', 'avenant.type', 'avenant.date_effet'];
const fieldsOf = (hidden: string[]): string =>
  Object.entries(TEMPLATE_FIELDS).filter(([name]) => !hidden.includes(name)).map(([name, f]) => `{{${name}}} : ${f.label}`).join(' · ');
const MANDATE_NEEDS = 'Places obligatoires : {{registre.numero}}, {{honoraires.montant}}, {{honoraires.charge}}, {{mandat.duree_mois}}, et la désignation : {{bien.adresse}}, {{bien.cadastre}} et {{mandant.domicile}}.';
const AVENANT_NEEDS = 'Places obligatoires : {{mandat.numero}}, et {{avenant.objet}} ou bien {{avenant.prix}} avec {{avenant.duree_mois}}. {{avenant.objet}} écrit aussi les honoraires, leur charge, le type du mandat et la date d’effet. Pour rendre un mandat exclusif, la clause d’exclusivité forme un paragraphe qui commence par « !! » suivi d’une espace.';
// Ce que l'écran de l'agent envoie toujours : le serveur refuse toute saisie qui n'a pas sa place sur le document (`bad_input`).
// Pour un mandat de vente, s'y ajoute la désignation, sans laquelle le document reste incomplet (AU002).
const MANDATE_INPUTS = [['honoraires.montant', 'honoraires.charge', 'mandat.duree_mois', 'bien.adresse', 'bien.cadastre', 'mandant.domicile']];
const AVENANT_INPUTS = [['avenant.objet'], ['avenant.prix', 'avenant.duree_mois']];
const RENTAL_NEEDS = 'Places obligatoires : {{registre.numero}}, {{honoraires.montant}} (les honoraires du bailleur), {{mandat.duree_mois}}, et la désignation : {{bien.adresse}}, {{bien.cadastre}} et {{mandant.domicile}}. Pas de {{honoraires.charge}} : ceux du locataire suivent le barème plafonné.';
const RENTAL_INPUTS = [['honoraires.montant', 'mandat.duree_mois', 'bien.adresse', 'bien.cadastre', 'mandant.domicile']];
const KINDS = [
  { kind: 'mandat_vente_simple', title: 'Mandat de vente simple', needs: MANDATE_NEEDS, inputs: MANDATE_INPUTS, fields: fieldsOf(AVENANT_ONLY) },
  { kind: 'mandat_vente_exclusif', title: 'Mandat de vente exclusif', needs: `${MANDATE_NEEDS} La clause d’exclusivité forme un paragraphe qui commence par « !! » suivi d’une espace.`, inputs: MANDATE_INPUTS, fields: fieldsOf(AVENANT_ONLY) },
  { kind: 'avenant_mandat', title: 'Avenant au mandat', needs: AVENANT_NEEDS, inputs: AVENANT_INPUTS, fields: fieldsOf(MANDATE_ONLY) },
  // AU014 : le mandat de location, honoraires du bailleur seuls ; ceux du locataire suivent le barème plafonné de la mise en location.
  { kind: 'mandat_location', title: 'Mandat de location', needs: RENTAL_NEEDS, inputs: RENTAL_INPUTS, fields: fieldsOf([...AVENANT_ONLY, 'honoraires.charge']) },
];
const REFUSALS = {
  no_designation_field: 'Il manque la désignation : {{bien.adresse}}, {{bien.cadastre}} et {{mandant.domicile}} ont chacun leur place dans un mandat de vente. Rien n’est rangé.',
  empty_body: 'Le modèle est vide : rien n’est rangé.',
  body_too_long: 'Le modèle est trop long : rien n’est rangé.',
  invalid_body: 'Le modèle est trop long ou illisible : rien n’est rangé.',
  unknown_field: 'Le modèle porte un champ entre accolades que le mandat ne connaît pas : rien n’est rangé.',
  no_evidence: 'Un mandat exclusif met sa clause d’exclusivité en évidence : commencez son paragraphe par « !! » suivi d’une espace. Rien n’est rangé.',
};
const STALE = {
  not_essai: 'Cette version est déjà validée.',
  unknown_template: 'Cette version n’existe plus : modèles relus.',
};

const entry = (p: string, about: string): string => `<section class="bloc" aria-labelledby="${p}-titre">
<h3 id="${p}-titre">Modèles et clauses du mandat</h3>
<p class="doux">${about}</p>
<button id="${p}-ouvrir" type="button" class="secondaire">Lire les modèles et les clauses</button>
<p id="${p}-etat" class="etat" role="status"></p>
<div id="${p}-corps"></div>
</section>
`;
export const MANDAT_MODELES_ENTRY_HTML = entry('mandat-modeles', 'Sans modèle, aucun mandat ni avenant ne se prépare ; sans texte validé, une clause du questionnaire laisse le mandat d’essai. La direction range les versions, la conformité les valide. L’ancienne version reste.');
export const MANDAT_MODELES_CONFORMITE_HTML = entry('mandat-modeles-c', 'Valider seulement un texte relu par l’avocat.');

/** Le chargeur posé dans le script de l'application : l'écran est servi à part, chargé une fois, jamais gardé. */
export const MANDAT_MODELES_JS = `
  /* ---------- Les modèles de mandat (D18), chargés au premier geste [R201]. ---------- */
  var mandatModeles = null, mandatModelesLoading = false;
  function wipeMandatModeles() {
    ['mandat-modeles', 'mandat-modeles-c'].forEach(function (p) { clear($(p + '-corps')); $(p + '-etat').textContent = ''; });
  }
  function openMandatModeles(p) {
    if (!currentKey) return;
    var box = $(p + '-corps');
    var say = function (x) { $(p + '-etat').textContent = x; };
    var mode = { store: p === 'mandat-modeles', validate: p === 'mandat-modeles-c' };
    if (mandatModeles) return mandatModeles.open(box, say, mode);
    if (mandatModelesLoading) return;
    mandatModelesLoading = true;
    var mine = session;
    say('Chargement…');
    var s = document.createElement('script');
    s.setAttribute('src', '/app/mandat-modeles.js');
    s.addEventListener('load', function () {
      mandatModelesLoading = false;
      var make = globalThis.AIMMO_MANDAT_MODELES;
      try { delete globalThis.AIMMO_MANDAT_MODELES; } catch (e) { /* rien */ }
      if (typeof make !== 'function') { if (mine === session) say('Pas de réseau. Réessayez dans un moment.'); return; }
      mandatModeles = make({ el: el, clear: clear, send: send, button: button, field: field, date: date, ID: ID, session: function () { return session; } });
      if (mine === session) mandatModeles.open(box, say, mode); else say('');
    });
    s.addEventListener('error', function () {
      mandatModelesLoading = false;
      if (mine === session) say('Pas de réseau. Réessayez dans un moment.');
    });
    $('reseau').appendChild(s);
  }
`;

export const MANDAT_MODELES_SCRIPT = `'use strict';
globalThis.AIMMO_MANDAT_MODELES = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, date = t.date, ID = t.ID;
  var KINDS = ${JSON.stringify(KINDS)};
  var REFUSALS = ${JSON.stringify(REFUSALS)};
  var STALE = ${JSON.stringify(STALE)};
  var busy = null;
  var seq = 0;
  var reads = 0;
  function act(box, say, mode, path, body, fallback, done) {
    var mine = t.session();
    if (busy === mine) return;
    busy = mine;
    say('Envoi…');
    return send(path, 'POST', body).then(function (res) {
      if (busy === mine) busy = null;
      if (res.gone) { clear(box); say(''); return; }
      if (res.ok) return open(box, say, mode, done(res.body.data));
      if (res.offline || !res.body || res.status >= 500) {
        clear(box);
        box.appendChild(button('Relire les modèles de mandat', function () { open(box, say, mode); }));
        say('Réponse perdue : ce geste est peut-être rangé. Relisez avant de recommencer.');
        return;
      }
      if (res.status === 403) { say('Ce geste n’est pas dans vos droits.'); return; }
      if (STALE[res.body.code]) return open(box, say, mode, STALE[res.body.code]);
      if (res.body.code === 'no_number_field') { say(body && body.kind === 'avenant_mandat' ? 'Il manque le champ {{mandat.numero}}, la place du numéro du mandat modifié : rien n’est rangé.' : 'Il manque le champ {{registre.numero}}, la place du numéro au registre : rien n’est rangé.'); return; }
      say(REFUSALS[res.body.code] || fallback);
    });
  }
  function versionText(v) {
    return v.status === 'valide'
      ? 'Version ' + v.version + ', validée le ' + date(v.validatedAt) + '.'
      : 'Version ' + v.version + ', modèle d’essai, pas validé : le document qu’il fait reste un document d’essai.';
  }
  function validateButton(part, box, say, mode, v) {
    if (typeof v.id !== 'string' || !ID.test(v.id)) return;
    var armed = false;
    var b = button('Valider la version ' + v.version, function () {
      if (!armed) { armed = true; b.textContent = 'Confirmer : texte relu par l’avocat'; say('Appuyez encore pour valider la version ' + v.version + '.'); return; }
      act(box, say, mode, '/v1/modeles/' + encodeURIComponent(v.id) + '/validation', undefined, 'La version n’est pas validée.', function () { return 'Version ' + v.version + ' validée.'; });
    });
    part.appendChild(b);
  }
  function warn(part, k, v) {
    if (!Array.isArray(v.fields)) return;
    var works = k.inputs.some(function (set) { return set.every(function (f) { return v.fields.indexOf(f) !== -1; }); });
    if (!works) part.appendChild(el('p', 'Version ' + v.version + ' : il manque des places, l’agent ne pourra pas préparer de document avec elle. ' + k.needs, 'alerte'));
  }
  function kindBlock(box, say, mode, k, list) {
    var mineKind = list.filter(function (v) { return v.kind === k.kind; }).sort(function (a, b) { return a.version - b.version; });
    var last = mineKind[mineKind.length - 1] || null;
    var valid = mineKind.filter(function (v) { return v.status === 'valide'; });
    /* Comme le serveur : la dernière version validée, sinon la dernière d'essai. */
    var cur = valid.length ? valid[valid.length - 1] : last;
    var part = el('div', null, 'vente');
    part.appendChild(el('h4', k.title));
    if (!cur) part.appendChild(el('p', 'Aucun modèle : aucun document de cette sorte ne peut se préparer.', 'alerte'));
    else {
      part.appendChild(el('p', 'En vigueur. ' + versionText(cur), cur.status === 'valide' ? 'fait' : 'alerte'));
      part.appendChild(el('p', String(cur.body), 'brouillon'));
      warn(part, k, cur);
    }
    if (last && cur && last.version !== cur.version) {
      part.appendChild(el('p', 'Dernière version rangée, pas en vigueur tant qu’elle n’est pas validée. ' + versionText(last), 'doux'));
      part.appendChild(el('p', String(last.body), 'brouillon'));
      warn(part, k, last);
    }
    var kept = mineKind.length - (last && cur && last.version !== cur.version ? 2 : cur ? 1 : 0);
    if (kept > 0) part.appendChild(el('p', kept === 1 ? 'Une version plus ancienne est gardée.' : kept + ' versions plus anciennes sont gardées.', 'doux'));
    if (mode.validate && last && last.status === 'essai') validateButton(part, box, say, mode, last);
    if (mode.store) {
      part.appendChild(el('p', k.needs, 'doux'));
      var text = field(part, 'mandat-modele-' + (++seq), 'Texte de la nouvelle version', 'textarea');
      text.setAttribute('rows', '8');
      var held = last ? String(last.body) : '';
      text.value = held;
      part.appendChild(el('p', 'Champs possibles, écrits entre doubles accolades : ' + k.fields + '.', 'doux'));
      part.appendChild(button('Ranger une nouvelle version', function () {
        var typed = String(text.value || '').trim();
        if (!typed) { say(REFUSALS.empty_body); return; }
        if (typed === held.trim()) { say('Le texte n’a pas changé : aucune version ajoutée.'); return; }
        act(box, say, mode, '/v1/modeles', { kind: k.kind, body: typed }, 'Le modèle n’est pas rangé.', function (r) {
          return r && r.version > 1 ? 'Version ' + r.version + ' rangée, modèle d’essai. L’ancienne version reste.' : 'Version rangée, modèle d’essai.';
        });
      }));
    }
    box.appendChild(part);
  }
  function readable(list) {
    return Array.isArray(list) && list.every(function (v) { return v && typeof v.kind === 'string' && typeof v.version === 'number' && typeof v.status === 'string'; });
  }
  function open(box, say, mode, said) {
    clear(box);
    var mine = t.session();
    var r = ++reads;
    say('Chargement…');
    return send('/v1/modeles', 'GET').then(function (res) {
      if (r !== reads) return;
      if (res.gone || mine !== t.session()) { clear(box); say(''); return; }
      clear(box);
      if (res.status === 403) say('Ce geste n’est pas dans vos droits.');
      else if (res.offline) say('Pas de réseau. Réessayez dans un moment.');
      /* Une liste illisible ne se lit jamais comme « aucun modèle ». */
      else if (!res.ok || !readable(res.body.data)) say('Les modèles ne se lisent pas pour le moment.');
      else {
        say(said || '');
        KINDS.forEach(function (k) { kindBlock(box, say, mode, k, res.body.data); });
      }
      /* BR118 et BR119 : les clauses et l'écart se lisent à part, chacun avec son état, même si les modèles ne se lisent pas. */
      var clauses = clausesPart(box, mode);
      return Promise.all([clauses, gapPart(box, mode)]);
    });
  }
${MANDAT_CLAUSES_PART}
${MANDAT_REGLAGE_PART}
  return { open: open };
};
`.replace(/^[ \t]*(?:\/\/.*|\/\*.*\*\/)[ \t]*\n/gm, '');
