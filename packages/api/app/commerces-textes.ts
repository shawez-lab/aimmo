import type { PresentationProblemCode } from '../../core/src/commerces/presentation.ts';

/**
 * Corriger le texte de la présentation anonyme (CE19), servi à part (`/app/commerces-textes.js`), chargé au premier
 * geste [R201]. Le socle contrôle le texte phrase par phrase [R110] : l'écran montre chaque phrase en cause et son
 * problème, et ce qui est tapé reste tant que ce n'est pas rangé. Une présentation validée dit, avant de ranger, que sa
 * validation tombe : `publishable` ne regarde que le dernier texte.
 */

const REFUSALS = {
  refused_text: 'Une phrase ne peut pas être publiée : corrigez-la.',
  bad_text: 'Le titre tient en 120 caractères, le texte en 3 000.',
  busy: 'Une autre version vient d’arriver : rouvrez le commerce pour la relire. Votre texte reste ici.',
  incomplet: 'Il faut d’abord une estimation validée et une fiche complète.',
  sorte: 'Ce bien n’est pas un commerce.',
};
const PROBLEMS: Record<PresentationProblemCode, string> = {
  nombre_hors_vue_publique: 'nombre absent de la vue publique',
  chiffre_confidentiel: 'chiffre confidentiel',
  enseigne: 'nomme l’enseigne',
  champ_confidentiel: 'donnée confidentielle de la fiche',
  adresse: 'situe le commerce trop précisément',
  critere_discriminant: 'critère discriminant',
  mot_interdit: 'mot interdit',
};

export const COMMERCES_TEXTES_SCRIPT = `'use strict';
globalThis.AIMMO_CE_TEXTES = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, say = t.say;
  var REFUSALS = ${JSON.stringify(REFUSALS)}, PROBLEMS = ${JSON.stringify(PROBLEMS)};
  function known(map, code) { return Object.prototype.hasOwnProperty.call(map, code) ? map[code] : null; }
  function fix(box, base, p) {
    clear(box);
    var title = field(box, 'ce-presentation-titre', 'Titre');
    title.setAttribute('maxlength', '120');
    title.value = p.title || '';
    var text = field(box, 'ce-presentation-texte', 'Texte', 'textarea');
    text.setAttribute('maxlength', '3000');
    text.value = p.body || '';
    if (p.validated) box.appendChild(el('p', 'Cette présentation est validée. Un texte corrigé annule cette validation : le commerce n’a plus de présentation publiable tant que l’agent du bien n’a pas validé le nouveau texte.', 'retard'));
    var said = el('ul', null, 'liste');
    var sending = false;
    var go = button('Ranger la correction', function () {
      if (sending) return;
      clear(said);
      var nt = String(title.value || '').trim(), nb = String(text.value || '').trim();
      if (!nt || !nb) { say('Le titre et le texte sont à remplir.'); return; }
      if (nt === String(p.title || '').trim() && nb === String(p.body || '').trim()) { say('Rien n’a changé : aucune version ajoutée.'); return; }
      var mine = t.session();
      sending = true;
      go.disabled = true;
      say('Envoi…');
      return send(base + '/presentations/texte', 'POST', { title: nt, body: nb }).then(function (res) {
        if (res.gone || mine !== t.session()) return false;
        sending = false;
        go.disabled = false;
        /* Coupée ou en panne, la réponse ne dit pas si le texte a été rangé : seul un refus du socle le dit. */
        if (res.offline || res.status >= 500 || !res.body) { say('Réponse perdue : la correction a peut-être été rangée. Rouvrez le commerce pour le voir, votre texte reste ici.'); return false; }
        if (res.ok) return t.reload('Correction rangée : l’agent du bien la relit, puis la valide.');
        if (res.status === 403) { say('Ce commerce n’est pas dans vos droits.'); return false; }
        say(known(REFUSALS, res.body.code) || 'La correction n’est pas rangée.');
        (Array.isArray(res.body.sentences) ? res.body.sentences : []).forEach(function (s) {
          var li = el('li', s.text);
          (s.problems || []).forEach(function (pb) { li.appendChild(el('p', 'À corriger : ' + (known(PROBLEMS, pb.code) || 'phrase refusée') + ' (« ' + pb.value + ' »)', 'retard')); });
          said.appendChild(li);
        });
        return false;
      });
    });
    box.appendChild(go);
    box.appendChild(said);
  }
  return { fix: fix };
};
`;
