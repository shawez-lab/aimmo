import { ACTIVITY_LABEL } from '../../core/src/commerces/presentation.ts';

/**
 * L'écran « Commerces » de l'application de l'agent (CE11), en morceaux posés dans `fichiers.ts` : sa section de page,
 * son entrée sur l'accueil et son script. Il reprend la mise en page de l'écran « Louer » (même système de design).
 *
 * L'écran ne lit et n'écrit que par les routes `/v1/commerces` [R16]. Il ne montre que ce que l'API rend à ce lecteur :
 * la vue publique, l'estimation et la présentation du bien, l'état de la porte de chaque demande (jamais un chiffre de
 * la fiche), les ouvertures du dossier et les étapes de la cession [R110]. Tout texte reçu est posé avec
 * `textContent` ; l'écran ne calcule rien, il montre ce que le code a calculé.
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

/** Le script de l'écran : posé dans le script de l'application, il en reprend les outils (`el`, `send`, `field`…). */
export const COMMERCES_JS = `
  /* ---------- M16 : l'écran « Commerces » (CE11). Rien que ce que l'API rend à ce lecteur [R110, R16]. ---------- */
  var CE_ACT = ${JSON.stringify(ACTIVITY_LABEL)};
  var CE_STEPS = ${JSON.stringify(STEP_LABELS)};
  var CE_STATUS = ${JSON.stringify(STATUS_LABELS)};
  var CE_GATE = ${JSON.stringify(GATE_LABELS)};
  var CE_OPEN = ${JSON.stringify(OPENING_LABELS)};
  var CE_KINDS = ${JSON.stringify(KIND_LABELS)};
  var CE_METHODS = { business: { revenue_pct: 'Part du chiffre d’affaires', ebitda_multiple: 'Multiple de l’excédent brut' }, business_walls: { rent_yield: 'Rendement du loyer' }, commercial: { rent_yield: 'Rendement du loyer' } };
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
    if (!currentKey) return Promise.resolve(false);
    session += 1;
    wipeCommerces();
    show('commerces');
    ceState('Chargement…');
    return send('/v1/commerces', 'GET').then(function (res) {
      if (res.gone) return false;
      if (!res.ok) { ceState(res.offline ? 'Pas de réseau. Réessayez dans un moment.' : 'Indisponible pour le moment. Réessayez plus tard.'); return false; }
      var list = Array.isArray(res.body.data) ? res.body.data : [];
      var body = $('commerces-corps');
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
    if (!currentKey || !ID.test(id)) return Promise.resolve(false);
    session += 1;
    var mine = session;
    clear($('commerces-corps'));
    ceId = id;
    ceKind = kind;
    $('commerces-titre').textContent = title || 'Commerce';
    show('commerces');
    ceState('Chargement…');
    var base = '/v1/commerces/' + encodeURIComponent(id);
    var reads = ['/public', '/estimations', '/presentation', '/demandes', '/ouvertures', '/cession'].map(function (p) { return send(base + p, 'GET'); });
    return Promise.all(reads).then(function (all) {
      if (mine !== session || all.some(function (x) { return x.gone; })) return false;
      if (all[0].offline) { ceState('Pas de réseau. Réessayez dans un moment.'); return false; }
      if (!all[0].ok) { ceState(all[0].status === 403 ? 'Ce commerce n’est pas dans vos droits.' : 'Indisponible pour le moment. Réessayez plus tard.'); return false; }
      var d = all.map(function (x) { return x.ok ? x.body.data : null; });
      ceFiche(d[0]);
      ceEstimation(base, kind, Array.isArray(d[1]) ? d[1] : []);
      cePresentation(base, d[2]);
      if (all[3].ok) ceDemandes(base, Array.isArray(d[3]) ? d[3] : []);
      ceOuvertures(Array.isArray(d[4]) ? d[4] : []);
      ceCession(d[5]);
      ceState(message || '');
      return true;
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
          var t = String(proof.value || '').trim();
          if (!t) { ceState('Notez d’abord l’accord du repreneur.'); return; }
          ceAct(base + '/dossiers', { personId: r.personId, consentProof: t }, 'Le dossier n’est pas parti.', 'Dossier envoyé par le contrôle central, en mode essai.');
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
  function ceCession(v) {
    var b = ceBlock('Étapes de la cession');
    if (!v) { b.appendChild(el('p', 'Pas de dossier de cession ouvert.', 'doux')); return; }
    var ol = el('ol', null, 'parcours');
    (v.lines || []).forEach(function (l) {
      var li = el('li', (CE_STEPS[l.step] || l.step) + ' : ' + (CE_STATUS[l.status] || l.status) + (l.due ? ', le ' + ceDay(l.due) : ''));
      if (l.status === 'fait' || l.status === 'sans_objet') li.className = 'fait';
      else if (l.status === 'en_retard' || l.status === 'preemptee') li.className = 'bloque';
      ol.appendChild(li);
    });
    b.appendChild(ol);
    b.appendChild(el('p', v.ready ? 'Cession prête.' : 'Étapes bloquantes à finir avant la cession.', v.ready ? 'fait' : 'doux'));
  }
`;
