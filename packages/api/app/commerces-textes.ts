import { DOSSIER_DOCUMENT_KINDS, MAX_DOSSIER_TEXT, type DossierDocumentKind } from '../../core/src/commerces/dossier.ts';
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

/* Le dépôt d'un document (CE20) : le dossier ne sert que du texte, pour y porter le filigrane du lecteur [R114]. */
const DOC_KINDS: Record<DossierDocumentKind, string> = {
  bilan: 'Bilan',
  compte_resultat: 'Compte de résultat',
  bail: 'Bail',
  liste_materiel: 'Liste du matériel',
  autorisation: 'Autorisation',
  autre: 'Autre',
};
const DOC_REFUSALS = {
  kind: 'Choisissez la sorte de document.',
  title: 'Le titre est à remplir, en 120 caractères au plus.',
  content: 'Le texte est à remplir, en 1 million de caractères au plus.',
  stockage_absent: 'Le stockage des documents n’est pas encore ouvert : rien n’est rangé, votre texte reste ici.',
  autre_bien: 'Ce document appartient à un autre bien.',
  sorte: 'Ce bien n’est pas un commerce.',
};

export const COMMERCES_TEXTES_SCRIPT = `'use strict';
globalThis.AIMMO_CE_TEXTES = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, say = t.say;
  var REFUSALS = ${JSON.stringify(REFUSALS)}, PROBLEMS = ${JSON.stringify(PROBLEMS)};
  function known(map, code) { return Object.prototype.hasOwnProperty.call(map, code) ? map[code] : null; }
  function fix(box, base, p) {
    clear(box);
    say('');
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
  var DOC_KINDS = ${JSON.stringify(DOC_KINDS)}, DOC_KEYS = ${JSON.stringify(DOSSIER_DOCUMENT_KINDS)}, DOC_REFUSALS = ${JSON.stringify(DOC_REFUSALS)};
  function documents(box, base) {
    clear(box);
    say('Chargement…');
    var mine = t.session();
    return send(base + '/documents', 'GET').then(function (res) {
      if (res.gone || mine !== t.session()) return false;
      if (!res.ok || !Array.isArray(res.body.data)) {
        say(res.status === 403 ? 'Ce commerce n’est pas dans vos droits.' : 'Les documents ne se lisent pas pour le moment.');
        box.appendChild(button('Relire les documents', function () { documents(box, base); }));
        return false;
      }
      say('');
      if (!res.body.data.length) box.appendChild(el('p', 'Aucun document rangé : le dossier ne porte que la fiche du commerce.', 'doux'));
      var ul = el('ul', null, 'liste');
      res.body.data.forEach(function (d) { ul.appendChild(el('li', (known(DOC_KINDS, d.kind) || 'Document') + ' · ' + d.title + ' · rangé le ' + t.day(d.addedAt))); });
      box.appendChild(ul);
      deposit(box, base);
      return true;
    });
  }
  function deposit(box, base) {
    var kind = field(box, 'ce-document-sorte', 'Sorte de document', 'select');
    t.option(kind, '', 'À choisir');
    DOC_KEYS.forEach(function (k) { t.option(kind, k, DOC_KINDS[k]); });
    var title = field(box, 'ce-document-titre', 'Titre du document');
    title.setAttribute('maxlength', '120');
    var text = field(box, 'ce-document-texte', 'Texte du document', 'textarea');
    text.setAttribute('maxlength', '${MAX_DOSSIER_TEXT}');
    box.appendChild(el('p', 'Le dossier ne sert que du texte, pour y porter le nom du lecteur : collez le contenu du document. Il part à chaque lecteur dont l’engagement est signé.', 'doux'));
    var sending = false;
    var go = button('Ranger le document', function () {
      if (sending) return;
      var nt = String(title.value || '').trim(), body = String(text.value || '');
      if (!kind.value) { say(DOC_REFUSALS.kind); return; }
      if (!nt) { say(DOC_REFUSALS.title); return; }
      if (!body.trim()) { say(DOC_REFUSALS.content); return; }
      var mine = t.session();
      sending = true;
      go.disabled = true;
      say('Envoi…');
      return send(base + '/documents/texte', 'POST', { kind: kind.value, title: nt, content: body }).then(function (res) {
        if (res.gone || mine !== t.session()) return false;
        sending = false;
        go.disabled = false;
        /* Recommencer le même texte n'ajoute rien : le socle rend la ligne déjà rangée. */
        if (res.offline || res.status >= 500 || !res.body) { say('Réponse perdue : le document a peut-être été rangé. Appuyez de nouveau : le même texte ne s’ajoute pas deux fois.'); return false; }
        if (res.ok) return t.reload(res.body.data && res.body.data.already ? 'Ce texte était déjà rangé : rien n’est ajouté.' : 'Document rangé.');
        if (res.status === 403 && res.body.code !== 'autre_bien') { say('Ce commerce n’est pas dans vos droits.'); return false; }
        say(known(DOC_REFUSALS, res.body.code) || 'Le document n’est pas rangé.');
        return false;
      });
    });
    box.appendChild(go);
  }
  return { fix: fix, documents: documents };
};
`;
