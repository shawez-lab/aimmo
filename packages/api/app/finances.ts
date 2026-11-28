/**
 * Les finances à l'écran (K10) : le rapport du matin de chacun, sur « Mes chiffres » pour l'agent, sur « Le réseau » pour
 * la direction. Script servi à part (`/app/finances.js`), chargé au premier geste [R201]. Le serveur choisit le rapport du
 * lecteur d'après sa clé : l'écran ne demande jamais le rapport d'un autre [R68]. Rien n'est gardé sur l'appareil.
 *
 * Les commissions pour la direction (K11) : chaque commission, ses parts recomptées à l'écran [R69] et ce qu'elle attend.
 * L'encaissement puis le versement se rapportent avec la référence de leur preuve, en deux appuis ; aucun montant ne se
 * saisit [R67], l'échéance des 24 h ouvrées vient du serveur [R70].
 *
 * Le chemin de chaque euro (K13, Jamais vu) : l'agent suit où est son argent, dossier par dossier, avec l'heure limite
 * promise et si elle a été tenue. Il ne voit que ses parts [R68], sans comparaison avec personne [R14] ; ses totaux se
 * recomptent à l'écran depuis ses lignes [R69].
 *
 * La grille, les seuils, les factures et l'export (K12), pour la direction [R16] : une nouvelle version de la grille part
 * de la dernière et n'en perd aucun taux ; une facture ne change jamais, un avoir la corrige, en deux appuis [R71] ; l'export
 * part avec la clé dans l'en-tête [R13].
 *
 * La preuve à Dijon (IN05), pour la direction, relue à chaque rapport du matin [R16, R210, R211, R212] : où en est la
 * série, ce qui reste à inscrire, et le sceau d'un mois fini avec son comptage manuel. L'écran ne calcule rien : il
 * montre ce que le serveur compte, et un écart de comptage est dit tel quel.
 *
 * Les indicateurs du mois passé (IN06), relus de même : taux, délais et agents pour la direction [R214, R215] ; contacts
 * par zone pour chacun, l'agent ne voyant que ce que le serveur lui rend [R68]. Une donnée absente se dit absente.
 *
 * Les engagements, le temps gagné et la disponibilité (IN10), relus de même, pour la direction [R216, R217, R223] : ce que
 * le serveur ne peut pas mesurer se dit tel, jamais zéro ni 100 %. L'agent déclare ses heures de la semaine passée [R217].
 *
 * Les engagements manqués à rappeler (IN15), relus de même, pour la direction : elle ouvre la fiche et dit, en un geste,
 * rappelé, injoignable ou sans appel [R228]. Une personne exclue se dit « ne pas appeler », sans bouton « Rappelé » [R02].
 */

const SHARE_NAMES: Record<string, string> = {
  reseau: 'Part du réseau',
  agent: 'Part de l’agent',
  partage: 'Partage',
  parrainage: 'Prime de parrainage',
  agence: 'Part de l’agence partenaire',
};
const SPLIT_REASONS: Record<string, string> = {
  fichier_commun: 'fichier commun',
  binome: 'binôme pendant une absence',
};
const STEP_NAMES: Record<string, string> = {
  prevue: 'Prévue',
  due: 'Due',
  facturee: 'Facturée',
  payee: 'Payée',
};
/** Ce qui se voit en premier : ce que la direction doit faire, le plus pressé d'abord. */
const GROUPS: readonly (readonly [string, string])[] = [
  ['annulee', 'Ventes annulées par un avoir'],
  ['verser', 'À verser'],
  ['encaisser', 'À encaisser'],
  ['facturer', 'À facturer'],
  ['prevue', 'Prévues, en attente de l’acte'],
  ['payee', 'Payées'],
];
/** Pourquoi le passage laisse une vente de côté : les raisons dites au journal par `Commissions.sync`. */
const BLOCKED: Record<string, string> = {
  no_agent: 'le bien n’a pas d’agent.',
  no_grid: 'aucune grille n’était en vigueur au jour du compromis.',
  no_mandate_in_force: 'aucun mandat n’était en vigueur au jour du compromis.',
  partage_invalide: 'un partage entre agents dépasse sa part.',
  parts: 'les parts ne refont pas les honoraires, au centime.',
  honoraires: 'les honoraires de l’acte ne sont pas ceux de la commission.',
  mandat: 'le mandat de l’acte n’est pas celui de la commission.',
  compromis: 'la date du compromis a changé depuis la commission.',
};
const CREDIT_REASONS: Record<string, string> = {
  erreur_montant: 'Erreur de montant',
  erreur_destinataire: 'Erreur de destinataire',
  vente_annulee: 'Vente annulée',
  autre: 'Autre raison',
};
const KIND_NAMES: Record<string, string> = {
  honoraires: 'Honoraires',
  reversement: 'Reversement',
  avoir: 'Avoir',
};
const SETTING_REFUSALS: Record<string, string> = {
  bad_day: 'Choisissez un jour valide.',
  past_day: 'Une grille ne vaut que pour l’avenir : choisissez aujourd’hui ou un jour à venir.',
  bad_rate: 'Un taux va de 0 à 100 %.',
  unknown_agent: 'Un agent de la liste n’est plus du réseau : relisez la page.',
  duplicate_agent: 'Un agent apparaît deux fois.',
  bad_budget: 'Le budget doit être un montant positif, ou vide pour ne rien plafonner.',
  bad_threshold: 'Un seuil va de 0,01 à 100 %.',
  stale_grid: 'Une autre version vient d’être rangée : relisez la grille, puis recommencez.',
  bad_notice: 'Le préavis va de 1 à 365 jours.',
  not_creditable: 'Un avoir ne se corrige pas par un avoir.',
  already: 'Cette facture a déjà son avoir.',
  busy: 'Une autre facture est en cours d’émission. Réessayez dans un moment.',
  bad_reason: 'Choisissez une raison.',
  unknown: 'Cette facture n’existe plus dans la liste.',
  role: 'Ce n’est pas dans vos droits.',
};
const PROOF_MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const SEAL_REFUSALS: Record<string, string> = {
  month_not_finished: 'Ce mois n’est pas fini : il ne se scelle pas encore.',
  register_broken: 'Le registre des mandats est abîmé : aucun sceau tant qu’il ne l’est plus.',
  already_sealed: 'Ce mois est déjà scellé, et rien n’a changé depuis.',
  conflict: 'Un autre sceau vient de passer : relisez, puis recommencez.',
  bad_input: 'Votre comptage : un nombre entier, zéro ou plus.',
  role: 'Ce n’est pas dans vos droits.',
};
const PAY_REFUSALS: Record<string, string> = {
  sale_cancelled: 'Cette vente est annulée par un avoir : plus rien ne s’encaisse ni ne se verse ici.',
  bad_proof: 'Cette référence n’est pas lisible : lettres sans accent, chiffres, et les signes - _ : . / seulement.',
  bad_time: 'Cette date ne convient pas : elle doit suivre la facture.',
  future_time: 'Cette date est à venir : rapportez seulement ce qui a eu lieu.',
  before_receipt: 'Le versement ne peut pas précéder l’encaissement.',
  not_invoiced: 'Cette commission n’est pas encore facturée.',
  not_received: 'L’encaissement n’est pas encore rapporté.',
  already: 'C’est déjà rapporté.',
  unknown: 'Ce dossier n’existe plus dans la liste.',
  role: 'Ce n’est pas dans vos droits.',
};

/** Une entrée du rapport : `who` distingue les deux écrans, qui ne se montrent jamais ensemble. */
const reportEntry = (who: 'agent' | 'direction'): string => `<section class="bloc" aria-labelledby="rapport-${who}-titre">
<h3 id="rapport-${who}-titre">Rapport du matin</h3>
<p class="doux">Chaque jour ouvré à 7 h 30 : les chiffres de la veille, les contacts à rappeler, les alertes.</p>
<label for="rapport-${who}-jour">Un autre jour (laisser vide pour aujourd’hui)</label>
<input id="rapport-${who}-jour" type="date">
<button id="rapport-${who}-lire" type="button" class="secondaire">Lire le rapport</button>
<p id="rapport-${who}-etat" class="etat" role="status"></p>
<div id="rapport-${who}-corps"></div>
</section>
`;

const stateAndBody = (id: string, title: string, intro: string): string => `<section class="bloc" aria-labelledby="${id}-titre">
<h3 id="${id}-titre">${title}</h3>
<p class="doux">${intro}</p>
<p id="${id}-etat" class="etat" role="status"></p>
<div id="${id}-corps"></div>
</section>
`;
const ZONES_ENTRY_HTML = stateAndBody('zones', 'Contacts par zone, le mois passé', 'Se relit avec le rapport du matin. Une zone ne se montre que si elle ne dit le chiffre de personne.');
const INDICATEURS_ENTRY_HTML = stateAndBody('indicateurs', 'Le parcours, le mois passé', 'Se relit avec le rapport du matin. Tout vient de la base, pour tout le réseau.');
const TEMPS_AGENT_ENTRY_HTML = stateAndBody('temps-agent', 'Mon temps gagné, la semaine passée', 'Vous seul le déclarez, personne ne vous compare à personne. Le formulaire s’ouvre avec le rapport du matin.');
const ENGAGEMENTS_ENTRY_HTML = stateAndBody('engagements-tenus', 'Nos engagements, le mois passé', 'Se relit avec le rapport du matin. Recalculés depuis la base, sans aucun agent.');
const MANQUES_ENTRY_HTML = stateAndBody('engagements-manques', 'Les engagements manqués, à rappeler', 'Se relit avec le rapport du matin. C’est vous qui appelez : rien ne part tout seul vers le client.');
const TEMPS_RESEAU_ENTRY_HTML = stateAndBody('temps-reseau', 'Le temps gagné, la semaine passée', 'Se relit avec le rapport du matin. Ce que les agents déclarent, en comptes, sans aucun nom.');
const DISPONIBILITE_ENTRY_HTML = stateAndBody('disponibilite', 'La disponibilité, le mois passé', 'Se relit avec le rapport du matin. La part du temps où chaque service a répondu. Cible : 99,9 %.');
export const RAPPORT_AGENT_HTML = reportEntry('agent') + ZONES_ENTRY_HTML + TEMPS_AGENT_ENTRY_HTML;
const PROOF_ENTRY_HTML = `<section class="bloc" aria-labelledby="preuve-titre">
<h3 id="preuve-titre">La preuve à Dijon</h3>
<p class="doux">10 mandats de vente signés et inscrits par mois, 6 mois de suite, depuis janvier 2027. Se relit avec le rapport du matin.</p>
<p id="preuve-etat" class="etat" role="status"></p>
<div id="preuve-corps"></div>
</section>
`;
const COPIES_ENTRY_HTML = stateAndBody('copies', 'La copie de la base', 'Se relit avec le rapport du matin. Chaque nuit, une copie chiffrée, gardée à part.');
const RESTAURATION_ENTRY_HTML = stateAndBody('restauration', 'La preuve de restauration, ce mois-ci', 'Chaque mois, la dernière copie est vraiment restaurée, hors de la production, en moins d’une heure.');
const PARCOURS_MOIS_ENTRY_HTML = stateAndBody('parcours-mois', 'Le parcours complet, ce mois-ci', 'Chaque mois, un client inventé traverse tout le logiciel, du premier message à l’après-vente.');
/**
 * DS008 · le rapport de la direction, rangé par rubrique de l'écran du réseau : ce qui attend un geste aujourd'hui,
 * ce qui se compte, ce qui prouve que la machine tient. Les trois se relisent ensemble, d'une seule lecture.
 */
export const RAPPORT_DIRECTION_HTML = reportEntry('direction') + MANQUES_ENTRY_HTML;
export const RAPPORT_CHIFFRES_HTML = PROOF_ENTRY_HTML + INDICATEURS_ENTRY_HTML + ENGAGEMENTS_ENTRY_HTML + TEMPS_RESEAU_ENTRY_HTML;
export const RAPPORT_TECHNIQUE_HTML = DISPONIBILITE_ENTRY_HTML + COPIES_ENTRY_HTML + RESTAURATION_ENTRY_HTML + PARCOURS_MOIS_ENTRY_HTML;

export const GRILLE_ENTRY_HTML = `<section class="bloc" aria-labelledby="titre-grille">
<h3 id="titre-grille">Grille des commissions et alertes</h3>
<p class="doux">Une nouvelle version s’ajoute : les ventes passées gardent la leur.</p>
<button id="grille-voir" type="button" class="secondaire">Voir et régler</button>
<p id="grille-etat" class="etat" role="status"></p>
<div id="grille-corps"></div>
</section>
`;
export const FACTURES_ENTRY_HTML = `<section class="bloc" aria-labelledby="titre-factures">
<h3 id="titre-factures">Factures émises</h3>
<p class="doux">Une facture ne change plus : un avoir la corrige.</p>
<button id="factures-voir" type="button" class="secondaire">Voir les factures</button>
<p id="factures-etat" class="etat" role="status"></p>
<div id="factures-corps"></div>
<label for="factures-du">Export comptable, du</label>
<input id="factures-du" type="date">
<label for="factures-au">au</label>
<input id="factures-au" type="date">
<button id="factures-export" type="button" class="secondaire">Télécharger l’export</button>
<p id="factures-export-etat" class="etat" role="status"></p>
</section>
`;

export const EUROS_ENTRY_HTML = `<section class="bloc" aria-labelledby="titre-euros">
<h3 id="titre-euros">Où est mon argent</h3>
<p class="doux">Chaque part, de la promesse de vente à votre compte, et l’heure limite de son versement.</p>
<button id="euros-voir" type="button" class="secondaire">Suivre mes commissions</button>
<p id="euros-etat" class="etat" role="status"></p>
<div id="euros-corps"></div>
</section>
`;

export const COMMISSIONS_ENTRY_HTML = `<section class="bloc" aria-labelledby="titre-commissions">
<h3 id="titre-commissions">Commissions</h3>
<p class="doux">Ce que chaque vente doit à chacun, et ce qui attend votre geste. Aucun montant ne se saisit : tout est calculé.</p>
<button id="commissions-voir" type="button" class="secondaire">Voir les commissions</button>
<p id="commissions-etat" class="etat" role="status"></p>
<div id="commissions-corps"></div>
</section>
`;

/** Le chargeur posé dans le script de l'application : l'écran est servi à part, chargé une fois, jamais gardé. */
export const FINANCES_JS = `
  /* ---------- Les finances (K10), chargées au premier geste [R16, R201]. ---------- */
  var financesTools = null, financesLoading = false;
  /* Depuis le réseau, la fiche revient au réseau : la clé de la direction n'a pas de journée d'agent, et lire une journée la ferait croire refusée. */
  var ficheBack = null;
  function ficheBackOff() {
    if (!ficheBack) return;
    $('fiche').removeChild(ficheBack);
    ficheBack = null;
    $('retour').hidden = false;
  }
  function networkFicheButton(personId) {
    var open = button('Voir la fiche', function () {
      if (!ficheBack) {
        ficheBack = button('Retour au réseau', function () {
          ficheBackOff();
          wipeFiche();
          openReseau(reseauRange);
          readReport('direction', 'reseau');
        });
        $('fiche').insertBefore(ficheBack, $('retour'));
        $('retour').hidden = true;
      }
      openFiche(personId);
    });
    open.className = 'secondaire';
    return open;
  }
  function wipeFinances() {
    ficheBackOff();
    ['agent', 'direction'].forEach(function (who) {
      clear($('rapport-' + who + '-corps'));
      $('rapport-' + who + '-etat').textContent = '';
      $('rapport-' + who + '-jour').value = '';
    });
    ['preuve', 'zones', 'indicateurs', 'engagements-tenus', 'engagements-manques', 'temps-reseau', 'disponibilite', 'copies', 'restauration', 'parcours-mois', 'temps-agent'].forEach(function (id) {
      clear($(id + '-corps'));
      $(id + '-etat').textContent = '';
    });
    clear($('commissions-corps'));
    $('commissions-etat').textContent = '';
    clear($('euros-corps'));
    $('euros-etat').textContent = '';
    clear($('grille-corps'));
    $('grille-etat').textContent = '';
    clear($('factures-corps'));
    ['factures-etat', 'factures-export-etat'].forEach(function (id) { $(id).textContent = ''; });
    $('factures-du').value = '';
    $('factures-au').value = '';
  }
  function withFinances(stateId, hostId, act) {
    if (!currentKey) return Promise.resolve(false);
    if (financesTools) return act(financesTools);
    if (financesLoading) return Promise.resolve(false);
    financesLoading = true;
    var mine = session;
    $(stateId).textContent = 'Chargement…';
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.setAttribute('src', '/app/finances.js');
      s.addEventListener('load', function () {
        financesLoading = false;
        var make = globalThis.AIMMO_FINANCES;
        try { delete globalThis.AIMMO_FINANCES; } catch (e) { /* rien */ }
        if (mine !== session) { resolve(false); return; }
        if (typeof make !== 'function') { $(stateId).textContent = 'Indisponible pour le moment. Réessayez dans un moment.'; resolve(false); return; }
        financesTools = make({ $: $, el: el, clear: clear, send: send, date: date, hour: hour, euros: euros, button: button, saveCsv: saveCsv, ficheButton: networkFicheButton, session: function () { return session; } });
        resolve(act(financesTools));
      });
      s.addEventListener('error', function () {
        financesLoading = false;
        if (mine === session) $(stateId).textContent = 'Pas de réseau. Réessayez dans un moment.';
        resolve(false);
      });
      $(hostId).appendChild(s);
    });
  }
  function readGrille() {
    return withFinances('grille-etat', 'reseau', function (f) { return f.settings(''); });
  }
  function readFactures() {
    return withFinances('factures-etat', 'reseau', function (f) { return f.invoices(''); });
  }
  function exportFactures() {
    return withFinances('factures-export-etat', 'reseau', function (f) { return f.exportInvoices(); });
  }
  function readEuros() {
    return withFinances('euros-etat', 'chiffres', function (f) { return f.path(); });
  }
  function readCommissions() {
    return withFinances('commissions-etat', 'reseau', function (f) { return f.commissions(''); });
  }
  function readReport(who, hostId) {
    return withFinances('rapport-' + who + '-etat', hostId, function (f) { return f.report(who); });
  }
`;

/** Le script servi à part (`/app/finances.js`). Il ne lit et n'écrit que les routes de M13 [R16, R68], et ne garde rien. */
export const FINANCES_SCRIPT = `'use strict';
globalThis.AIMMO_FINANCES = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, date = t.date, hour = t.hour, euros = t.euros, button = t.button;
  var SHARE_NAMES = ${JSON.stringify(SHARE_NAMES)};
  var SPLIT_REASONS = ${JSON.stringify(SPLIT_REASONS)};
  var STEP_NAMES = ${JSON.stringify(STEP_NAMES)};
  var GROUPS = ${JSON.stringify(GROUPS)};
  var BLOCKED = ${JSON.stringify(BLOCKED)};
  var PAY_REFUSALS = ${JSON.stringify(PAY_REFUSALS)};
  var CREDIT_REASONS = ${JSON.stringify(CREDIT_REASONS)};
  var KIND_NAMES = ${JSON.stringify(KIND_NAMES)};
  var SETTING_REFUSALS = ${JSON.stringify(SETTING_REFUSALS)};
  var SEAL_REFUSALS = ${JSON.stringify(SEAL_REFUSALS)};
  var PROOF_MONTHS = ${JSON.stringify(PROOF_MONTHS)};
  var PROOF = /^[A-Za-z0-9_:.\/-]{1,200}$/;
  var reading = 0, listing = 0, uid = 0;
  function day(iso) { return date(iso + 'T12:00:00Z'); }
  function report(who) {
    var mine = t.session();
    /* Seule la dernière lecture demandée s'affiche : deux appuis ne font pas deux rapports. */
    var turn = ++reading;
    var body = $('rapport-' + who + '-corps'), state = $('rapport-' + who + '-etat');
    var chosen = $('rapport-' + who + '-jour').value;
    clear(body);
    if (who === 'direction') { proof(''); indicators(); promises(); missedPromises(''); networkTime(); availability(); copies(); restoration(); journey(); } else { zones(); myTime(''); }
    if (chosen && !/^\\d{4}-\\d{2}-\\d{2}$/.test(chosen)) { state.textContent = 'Choisissez un jour.'; return Promise.resolve(false); }
    state.textContent = 'Chargement…';
    return send('/v1/pilotage/rapport-matin' + (chosen ? '?jour=' + chosen : ''), 'GET').then(function (res) {
      if (res.gone || mine !== t.session() || turn !== reading) return false;
      if (!res.ok) {
        if (res.offline) state.textContent = 'Pas de réseau. Réessayez dans un moment.';
        else if (res.body && res.body.rule === 'R16') state.textContent = 'Ce n’est pas dans vos droits.';
        else state.textContent = 'Indisponible pour le moment. Réessayez plus tard.';
        return false;
      }
      var r = res.body.data;
      if (!r || typeof r.text !== 'string') {
        state.textContent = chosen ? 'Aucun rapport rangé pour ce jour.' : 'Aucun rapport rangé aujourd’hui pour le moment : ils s’écrivent les jours ouvrés à 7 h 30.';
        return true;
      }
      var p = r.period || {};
      state.textContent = 'Rapport du ' + day(r.day) + (p.from && p.to ? (p.from === p.to ? ', pour le ' + day(p.from) : ', du ' + day(p.from) + ' au ' + day(p.to)) : '') + '.';
      r.text.split('\\n').forEach(function (line) {
        body.appendChild(el('p', line, line.indexOf('Alerte') === 0 ? 'retard' : undefined));
      });
      return true;
    });
  }
  function monthName(m) { return PROOF_MONTHS[Number(m.slice(5, 7)) - 1] + ' ' + m.slice(0, 4); }
  function plural(n, one, many) { return n + ' ' + (n > 1 ? many : one); }
  function sealRefusal(res) {
    var b = res.body || {};
    if (res.offline) return 'Réponse perdue : ce mois est peut-être scellé. Relisez avant de recommencer.';
    if (b.code === 'count_mismatch') return 'Écart : le registre compte ' + b.counted + ', vous comptez ' + b.given + '. Rien n’est scellé : cherchez d’où vient l’écart.';
    if (b.code === 'not_inscribed') return plural(Number(b.notInscribed), 'mandat signé reste', 'mandats signés restent') + ' à inscrire au registre avant de sceller ce mois.';
    return (b.rule === 'R16' ? SEAL_REFUSALS.role : SEAL_REFUSALS[b.code]) || 'Réponse perdue : ce mois est peut-être scellé. Relisez avant de recommencer.';
  }
  function sealForm(li, m) {
    var box = el('div');
    var count = field(box, 'Votre comptage manuel de ' + monthName(m.month), 'text');
    count.setAttribute('inputmode', 'numeric');
    var state = el('p', '', 'etat');
    state.setAttribute('role', 'status');
    saveButton(box, 'Comparer et sceller', state, function () {
      var mine = t.session();
      var text = count.value.trim();
      if (!/^\\d{1,6}$/.test(text)) { state.textContent = SEAL_REFUSALS.bad_input; return null; }
      return send('/v1/pilotage/preuve/sceau', 'POST', { month: m.month, manualCount: Number(text) }).then(function (res) {
        if (res.gone || mine !== t.session()) return false;
        if (!res.ok) { state.textContent = sealRefusal(res); return false; }
        state.textContent = '';
        return proof(monthName(m.month) + ' est scellé.');
      });
    });
    box.appendChild(state);
    li.appendChild(box);
  }
  var proving = 0;
  function proof(message) {
    var mine = t.session();
    var turn = ++proving;
    var body = $('preuve-corps'), state = $('preuve-etat');
    clear(body);
    state.textContent = 'Chargement…';
    return Promise.all([send('/v1/pilotage/preuve', 'GET'), send('/v1/pilotage/preuve/sceaux', 'GET')]).then(function (all) {
      var c = all[0], s = all[1];
      if (c.gone || s.gone || mine !== t.session() || turn !== proving) return false;
      if (!c.ok || !s.ok || !c.body.data || !s.body.data) {
        var bad = !c.ok ? c : s;
        state.textContent = (message ? message + ' ' : '') + (bad.offline ? 'Pas de réseau. Réessayez dans un moment.' : bad.body && bad.body.rule === 'R16' ? SEAL_REFUSALS.role : 'Indisponible pour le moment. Réessayez plus tard.');
        return false;
      }
      var counter = c.body.data, published = s.body.data;
      if (!counter.registerSound || !published.chainSound) body.appendChild(el('p', 'Un contrôle d’intégrité a échoué : ces chiffres sont à vérifier, et la condition ne peut pas être dite remplie.', 'retard'));
      if (counter.condition.met && published.chainSound) body.appendChild(el('p', 'Condition remplie en ' + monthName(counter.condition.metOn) + '.'));
      else body.appendChild(el('p', 'Série en cours : ' + counter.currentRun.length + ' mois sur ' + counter.requiredMonths + '.'));
      if (!counter.months.length) body.appendChild(el('p', 'Le compte commence en ' + monthName(counter.startMonth) + '.'));
      var sealOf = {};
      published.months.forEach(function (m) { sealOf[m.month] = m; });
      var ul = el('ul', null, 'liste');
      counter.months.slice().reverse().forEach(function (m) {
        var li = el('li');
        li.appendChild(el('strong', monthName(m.month) + ' : ' + m.counted + ' sur ' + counter.target + (m.complete ? '' : ', mois en cours')));
        var details = [];
        if (m.exclusive) details.push(m.exclusive + ' exclusifs');
        if (m.simple) details.push(m.simple + ' simples');
        if (m.untyped) details.push(m.untyped + ' sans type connu');
        if (m.terminated) details.push(m.terminated + ' résiliés depuis');
        if (m.cancelledError) details.push(m.cancelledError + ' annulés pour erreur');
        if (m.withdrawn) details.push(m.withdrawn + ' rétractés');
        if (details.length) li.appendChild(el('p', details.join(', ') + '.', 'doux'));
        if (m.notInscribed) li.appendChild(el('p', plural(m.notInscribed, 'mandat signé reste', 'mandats signés restent') + ' à inscrire au registre.', 'retard'));
        var seal = sealOf[m.month];
        if (m.complete && seal && seal.sealSeq !== null && !seal.changedSinceSeal) li.appendChild(el('p', seal.corrected ? 'Scellé, après correction.' : 'Scellé et publié.', 'doux'));
        if (m.complete && seal && seal.changedSinceSeal) li.appendChild(el('p', 'Changé depuis son sceau : le compte public le dit, jusqu’au nouveau sceau.', 'retard'));
        if (m.complete && (!seal || seal.sealSeq === null || seal.changedSinceSeal)) sealForm(li, m);
        ul.appendChild(li);
      });
      if (counter.months.length) body.appendChild(ul);
      state.textContent = message || '';
      return true;
    });
  }
  /* Le mois fini d'avant, à Paris : c'est le serveur qui refuse un mois en cours. */
  function lastMonth() {
    var parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit' }).formatToParts(new Date());
    var part = function (type) { return Number(parts.filter(function (x) { return x.type === type; })[0].value); };
    var y = part('year'), m = part('month');
    return m === 1 ? (y - 1) + '-12' : y + '-' + String(m - 1).padStart(2, '0');
  }
  function monthEnd(m) { return new Date(Date.UTC(Number(m.slice(0, 4)), Number(m.slice(5, 7)), 0)).toISOString().slice(0, 10); }
  function failure(res) { return res.offline ? 'Pas de réseau. Réessayez dans un moment.' : res.body && res.body.rule === 'R16' ? SEAL_REFUSALS.role : 'Indisponible pour le moment. Réessayez plus tard.'; }
  function zoneList(body, v) {
    var ul = el('ul', null, 'liste');
    v.zones.forEach(function (z) { ul.appendChild(el('li', (z.zone === null ? 'Sans zone' : z.zone) + ' : ' + plural(Number(z.contacts), 'contact', 'contacts'))); });
    if (v.otherZones) ul.appendChild(el('li', 'Autres zones réunies (' + v.otherZones.zones + ') : ' + plural(Number(v.otherZones.contacts), 'contact', 'contacts')));
    if (v.zones.length || v.otherZones) body.appendChild(ul);
  }
  var zoning = 0;
  function zones() {
    var mine = t.session();
    var turn = ++zoning;
    var body = $('zones-corps'), state = $('zones-etat'), month = lastMonth();
    clear(body);
    state.textContent = 'Chargement…';
    return send('/v1/pilotage/contacts-par-zone?mois=' + month, 'GET').then(function (res) {
      if (res.gone || mine !== t.session() || turn !== zoning) return false;
      if (!res.ok || !res.body.data) { state.textContent = failure(res); return false; }
      var v = res.body.data;
      zoneList(body, v);
      state.textContent = monthName(month) + '.' + (v.zones.length || v.otherZones ? '' : ' Aucune zone à montrer pour ce mois.');
      if (!v.otherZones) body.appendChild(el('p', 'Les zones trop petites ne se montrent pas : leur chiffre dirait celui d’un autre agent.', 'doux'));
      return true;
    });
  }
  function rate(r, what) {
    if (r.bp === null || r.bp === undefined) return what + ' : pas de donnée sur ce mois.';
    return what + ' : ' + percent(r.bp) + ' % (' + r.numerator + ' sur ' + r.denominator + ').';
  }
  function lapse(d, what, unit) {
    var count = d.values.length;
    var missing = d.unmeasured ? ', ' + d.unmeasured + ' impossible à mesurer' + (d.unmeasured > 1 ? 's' : '') : '';
    if (d.median === null) return what + ' : pas de donnée sur ce mois' + missing + '.';
    return what + ' : ' + d.median + ' ' + unit + ' en médiane, sur ' + plural(count, 'dossier', 'dossiers') + missing + '.';
  }
  var indicating = 0;
  function indicators() {
    var mine = t.session();
    var turn = ++indicating;
    var body = $('indicateurs-corps'), state = $('indicateurs-etat'), month = lastMonth();
    clear(body);
    state.textContent = 'Chargement…';
    return Promise.all([
      send('/v1/pilotage/parcours?du=' + month + '-01&au=' + monthEnd(month), 'GET'),
      send('/v1/pilotage/agents-actifs?mois=' + month, 'GET'),
      send('/v1/pilotage/contacts-par-zone?mois=' + month, 'GET'),
    ]).then(function (all) {
      var a = all[0], b = all[1], c = all[2];
      if (a.gone || b.gone || c.gone || mine !== t.session() || turn !== indicating) return false;
      var bad = [a, b, c].filter(function (r) { return !r.ok || !r.body.data; })[0];
      if (bad) { state.textContent = failure(bad); return false; }
      var j = a.body.data, p = b.body.data, m = j.valuationToMandateMinutes;
      var ul = el('ul', null, 'liste');
      [
        rate(j.conversion.appointmentsPerContact, 'Contacts en rendez-vous'),
        rate(j.conversion.mandatesPerAppointment, 'Rendez-vous en mandats'),
        rate(j.conversion.salesPerMandate, 'Mandats en ventes'),
        lapse(j.mandateToOfferDays, 'Du mandat à l’offre acceptée', 'jours'),
        lapse(j.offerToActDays, 'De l’offre à l’acte', 'jours'),
        lapse(m, 'De l’avis validé à la signature', 'minutes') + (m.values.length ? ' ' + m.underTarget + ' sous ' + m.targetMinutes + ' minutes.' : ''),
        rate(j.networkReferredMandates, 'Mandats avec un client transmis par le réseau'),
        plural(Number(p.activeSigners), 'agent a signé', 'agents ont signé') + ' au moins un mandat.',
        p.retainedAfterYear.bp === null ? 'Personne n’est entré en ' + monthName(p.retainedAfterYear.cohortMonth) + '.' : rate(p.retainedAfterYear, 'Agents entrés en ' + monthName(p.retainedAfterYear.cohortMonth) + ' et toujours là'),
      ].forEach(function (line) { ul.appendChild(el('li', line)); });
      body.appendChild(ul);
      body.appendChild(el('h4', 'Contacts par zone'));
      zoneList(body, c.body.data);
      if (!c.body.data.zones.length) body.appendChild(el('p', 'Aucun contact transmis ce mois-là.', 'doux'));
      state.textContent = monthName(month) + '.';
      return true;
    });
  }
  /* Un bloc qui se relit : seule la dernière lecture de la session en cours s'affiche. */
  var blockTurns = {};
  function readBlock(id, url, render, message) {
    var mine = t.session();
    var turn = blockTurns[id] = (blockTurns[id] || 0) + 1;
    var body = $(id + '-corps'), state = $(id + '-etat');
    clear(body);
    state.textContent = 'Chargement…';
    return send(url, 'GET').then(function (res) {
      if (res.gone || mine !== t.session() || turn !== blockTurns[id]) return false;
      if (!res.ok || !res.body.data) { state.textContent = (message ? message + ' ' : '') + failure(res); return false; }
      state.textContent = render(res.body.data, body);
      return true;
    });
  }
  function promises() {
    var month = lastMonth();
    return readBlock('engagements-tenus', '/v1/pilotage/engagements-tenus?mois=' + month, function (v, body) {
      var ul = el('ul', null, 'liste');
      v.lines.forEach(function (l) {
        var li = el('li');
        li.appendChild(el('strong', l.label));
        if (!l.measurable) li.appendChild(el('p', 'Pas encore mesurable : la base ne permet pas de le juger.', 'doux'));
        else {
          li.appendChild(el('p', rate(l.kept, 'Tenu')));
          if (l.missedDays.length) li.appendChild(el('p', 'Manqué le ' + l.missedDays.map(day).join(', ') + '.', 'retard'));
          if (l.pending) li.appendChild(el('p', plural(l.pending, 'cas dont le délai court encore', 'cas dont le délai court encore') + '.', 'doux'));
          if (l.inTrial) li.appendChild(el('p', plural(l.inTrial, 'cas fait à temps, resté en essai : rien n’est parti', 'cas faits à temps, restés en essai : rien n’est parti') + '.', 'doux'));
          if (l.setAside) li.appendChild(el('p', plural(l.setAside, 'cas écarté du calcul', 'cas écartés du calcul') + '.', 'doux'));
          if (l.blindSpot) li.appendChild(el('p', l.blindSpot, 'doux'));
        }
        ul.appendChild(li);
      });
      body.appendChild(ul);
      return monthName(month) + '. ' + (v.overall.bp === null ? 'Aucun cas jugé sur ce mois.' : rate(v.overall, 'Tenus au total'));
    });
  }
  /* Le lundi de la semaine finie d'avant, à Paris : c'est le serveur qui refuse une semaine en cours. */
  function lastWeek() {
    var parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
    var part = function (type) { return Number(parts.filter(function (x) { return x.type === type; })[0].value); };
    var noon = Date.UTC(part('year'), part('month') - 1, part('day'), 12);
    return new Date(noon - (((new Date(noon).getUTCDay() + 6) % 7) + 7) * 86400000).toISOString().slice(0, 10);
  }
  function hours(minutes) {
    var m = minutes % 60;
    return Math.floor(minutes / 60) + ' h' + (m ? ' ' + String(m).padStart(2, '0') : '');
  }
  function networkTime() {
    var week = lastWeek();
    return readBlock('temps-reseau', '/v1/pilotage/temps-gagne/reseau?semaine=' + week, function (v, body) {
      var ul = el('ul', null, 'liste');
      if (v.minutes !== null) ul.appendChild(el('li', hours(Number(v.minutes)) + ' gagnées, selon ' + plural(Number(v.declared), 'agent', 'agents') + '.'));
      if (v.notDeclared) ul.appendChild(el('li', plural(Number(v.notDeclared), 'agent n’a pas déclaré', 'agents n’ont pas déclaré') + '.'));
      if (v.withoutGesture) ul.appendChild(el('li', plural(Number(v.withoutGesture), 'déclaration sans aucun geste', 'déclarations sans aucun geste') + ' au journal cette semaine-là.'));
      if (ul.children.length) body.appendChild(ul);
      return 'Semaine du ' + day(week) + '.' + (v.minutes === null ? ' Personne n’a déclaré.' : '');
    });
  }
  var TIME_REFUSALS = { week_before_entry: 'Cette semaine est d’avant votre entrée : rien n’est rangé.', week_not_finished: 'Cette semaine n’est pas finie : rien n’est rangé.', bad_minutes: 'Entre 0 et 80 heures : rien n’est rangé.', conflict: 'Une autre déclaration vient de passer : relisez avant de recommencer.', role: 'Ce n’est pas dans vos droits.' };
  var TIME_LOST = 'Réponse perdue : votre déclaration est peut-être rangée. Relisez avant de recommencer.';
  function timeRefusal(res) {
    var b = res.body;
    if (res.offline || !b || !b.code || res.status >= 500) return TIME_LOST;
    return b.rule === 'R16' ? TIME_REFUSALS.role : TIME_REFUSALS[b.code] || 'Refusé : rien n’est rangé. Relisez avant de recommencer.';
  }
  function myTime(message) {
    var week = lastWeek();
    return readBlock('temps-agent', '/v1/pilotage/temps-gagne?semaine=' + week, function (v, body) {
      body.appendChild(el('p', plural(Number(v.gestures), 'geste', 'gestes') + ' à votre nom au journal cette semaine-là.', 'doux'));
      var input = field(body, 'Heures gagnées cette semaine-là', 'text');
      input.setAttribute('inputmode', 'decimal');
      var state = el('p', '', 'etat');
      state.setAttribute('role', 'status');
      saveButton(body, 'Déclarer', state, function () {
        var mine = t.session();
        var text = input.value.trim();
        if (!/^\\d{1,2}(?:[.,]\\d{1,2})?$/.test(text) || Number(text.replace(',', '.')) > 80) { state.textContent = TIME_REFUSALS.bad_minutes; return null; }
        return send('/v1/pilotage/temps-gagne', 'POST', { week: week, minutes: Math.round(Number(text.replace(',', '.')) * 60) }).then(function (res) {
          if (res.gone || mine !== t.session()) return false;
          if (!res.ok) {
            /* Le formulaire a pu être remplacé pendant l'envoi : l'issue se dit quand même. */
            (Array.prototype.indexOf.call(body.children, state) < 0 ? $('temps-agent-etat') : state).textContent = timeRefusal(res);
            return false;
          }
          return myTime('Déclaration rangée.');
        });
      });
      body.appendChild(state);
      var said = 'Semaine du ' + day(week) + ' : ' + (v.minutes === null ? 'non déclarée.' : hours(Number(v.minutes)) + ' déclarées.');
      return (message ? message + ' ' : '') + said;
    }, message);
  }
  var SERVICE_NAMES = { site: 'Le site', api: 'L’API', application: 'L’application' };
  var UNMEASURED = { not_connected: 'aucune supervision branchée', supervision_failed: 'la supervision ne répond pas', bad_data: 'ses données ne tiennent pas', nothing_observed: 'rien d’observé ce mois-là' };
  function availabilityLine(v, s) {
    var name = SERVICE_NAMES[s.service] + ' : ';
    if (!s.measured) return name + 'non mesuré, ' + (UNMEASURED[s.reason] || 'donnée absente') + '.';
    var target = 'cible de ' + String(v.targetPercent).replace('.', ',') + ' %';
    var part = s.complete ? '' : 'mois connu en partie : ';
    var verdict = part + (s.targetMet === true ? target + ' tenue' : s.targetMet === false ? target + ' manquée' : target + ' impossible à dire tenue');
    var down = s.downMs ? ', ' + Math.ceil(s.downMs / 60000) + ' min de coupure' : '';
    return name + String(s.percent).replace('.', ',') + ' %' + down + ', ' + verdict + '.';
  }
  function availability() {
    var month = lastMonth();
    return readBlock('disponibilite', '/v1/pilotage/disponibilite?mois=' + month, function (v, body) {
      var ul = el('ul', null, 'liste');
      v.services.forEach(function (s) { ul.appendChild(el('li', availabilityLine(v, s))); });
      body.appendChild(ul);
      return monthName(month) + '.' + (v.connected ? '' : ' Non mesuré : aucune supervision n’est branchée.');
    });
  }
  var COPY_WHY = { cle_absente: 'la clé de chiffrement manque', cle_invalide: 'la clé de chiffrement est mauvaise', stockage_absent: 'le stockage n’est pas réglé', photo_absente: 'la photo de la base a manqué', photo_vide: 'la photo de la base était vide', stockage_en_panne: 'le stockage n’a pas répondu', copie_non_restaurable: 'la copie ne se restaurait pas à l’identique', copie_echouee: 'la copie a échoué' };
  function copyDay(iso) { return new Date(iso).toLocaleString('fr-FR', { timeZone: 'Europe/Paris', day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }); }
  function copies() {
    return readBlock('copies', '/v1/pilotage/copies', function (v, body) {
      var ul = el('ul', null, 'liste');
      if (v.lastFailure) ul.appendChild(el('li', 'Dernier essai, le ' + copyDay(v.lastFailure.at) + ' : ' + (COPY_WHY[v.lastFailure.reason] || 'il a échoué') + '.'));
      if (v.missedNights.length) ul.appendChild(el('li', 'Nuits sans copie : ' + v.missedNights.map(day).join(', ') + '.'));
      // AU109 · la preuve que la copie tourne : une copie à jour et un test de restauration réussi ce mois-ci.
      ul.appendChild(el('li', v.activation === 'prouvee' ? 'Copie prouvée : copie à jour et restauration réussie le ' + copyDay(v.exerciseAt) + '.' : 'Copie non prouvée : il faut une copie à jour et une restauration réussie ce mois-ci.'));
      if (ul.children.length) body.appendChild(ul);
      if (v.state === 'jamais') return 'Non sauvegardé : aucune copie réussie à ce jour.';
      var last = 'Dernière copie réussie : le ' + copyDay(v.lastSuccessAt) + '.';
      return v.state === 'a_jour' ? last : 'Non sauvegardé la nuit dernière. ' + last;
    });
  }
  var RESTORE_WHY = { aucune_copie: 'il n’y a aucune copie à restaurer', cle_absente: 'la clé de chiffrement manque', cle_invalide: 'la clé ne relit pas la copie', stockage_absent: 'le stockage n’est pas réglé', stockage_en_panne: 'le stockage n’a pas rendu la copie entière', copie_abimee: 'la copie est abîmée', copie_trop_ancienne: 'la dernière copie a plus de 48 heures', non_identique: 'la base restaurée n’est pas identique', trop_longue: 'elle a pris plus d’une heure', test_echoue: 'le test a échoué' };
  function lasted(ms) { var s = Math.ceil(Number(ms) / 1000); return s < 60 ? s + ' s' : Math.ceil(s / 60) + ' min'; }
  function restoration() {
    return readBlock('restauration', '/v1/pilotage/copies/restauration', function (v, body) {
      var r = v.receipt, ul = el('ul', null, 'liste');
      if (r && r.copyTakenAt) ul.appendChild(el('li', 'Copie du ' + copyDay(r.copyTakenAt) + (r.outcome === 'reussie' || r.reason === 'trop_longue' ? ', restaurée en ' + lasted(r.durationMs) : '') + '.'));
      if (r && r.outcome === 'reussie') {
        ul.appendChild(el('li', plural(Number(r.tables), 'table', 'tables') + ', ' + plural(Number(r.rows), 'ligne', 'lignes') + ', à l’identique.'));
        ul.appendChild(el('li', 'Empreinte de toute la base : ' + String(r.digest).slice(0, 16) + '.'));
      }
      if (ul.children.length) body.appendChild(ul);
      if (v.state === 'reussi') return 'Restauration de ' + monthName(r.month) + ' prouvée, le ' + copyDay(r.testedAt) + '.';
      if (v.state === 'echec') return 'Restauration de ' + monthName(r.month) + ' ratée : ' + (RESTORE_WHY[r.reason] || 'le test a échoué') + '.';
      return 'Aucune preuve de restauration pour ' + monthName(v.expectedMonth) + '.' + (r ? ' Dernier reçu : ' + monthName(r.month) + (r.outcome === 'reussie' ? ', réussi.' : ', raté.') : '');
    });
  }
  /* BR72 : le parcours complet fictif du mois. Les étapes du reçu, dans l'ordre et avec leurs mots. */
  var JOURNEY_STEP = { premier_message: 'le premier message du vendeur', qualification: 'le classement et l’attribution du contact', rendez_vous: 'le rendez-vous d’estimation', estimation: 'l’avis de valeur', mandat: 'le mandat et le registre', annonce: 'l’annonce', acquereur: 'le message de l’acquéreur', visite: 'la visite et son bon', offre: 'l’offre', compromis_acte: 'le compromis et l’acte', apres_vente: 'l’après-vente' };
  function journey() {
    return readBlock('parcours-mois', '/v1/pilotage/parcours-du-mois', function (v) {
      var r = v.receipt;
      if (v.state === 'reussi') return 'Parcours de ' + monthName(r.month) + ' réussi, le ' + copyDay(r.ranAt) + ' : toutes les étapes ont passé.';
      if (v.state === 'echec') return 'Parcours de ' + monthName(r.month) + ' raté, le ' + copyDay(r.ranAt) + ' : ' + (typeof r.step === 'string' && Object.prototype.hasOwnProperty.call(JOURNEY_STEP, r.step) ? 'il s’arrête à ' + JOURNEY_STEP[r.step] : 'l’étape cassée n’est pas connue') + '.';
      return 'Aucun parcours prouvé pour ' + monthName(v.expectedMonth) + '.' + (r ? ' Dernier reçu : ' + monthName(r.month) + (r.outcome === 'reussi' ? ', réussi.' : ', raté.') : '');
    });
  }
  /* Un seul geste en vol par session : refaire un geste déjà noté ne changerait rien, mais on ne l'envoie pas deux fois. */
  var MISSED_GESTURES = [['rappele', 'Rappelé', 'Rappel noté.'], ['injoignable', 'Injoignable', 'Noté : injoignable.'], ['sans_appel', 'Sans appel', 'Noté : sans appel.']];
  var MISSED_REREAD = { do_not_call: 'Cette personne ne doit plus être appelée : rien n’est noté. Seul « Sans appel » ferme ce rappel.', already_done: 'Ce rappel est déjà fermé autrement : rien n’est changé.' };
  var closing = null, gestures = [];
  function gesturesOff(off) { gestures.forEach(function (b) { b.disabled = off; }); }
  function closeMissed(task, gesture) {
    var mine = t.session(), state = $('engagements-manques-etat');
    if (closing === mine) return Promise.resolve(false);
    closing = mine;
    gesturesOff(true);
    state.textContent = 'Envoi…';
    return send('/v1/pilotage/engagements-manques/' + encodeURIComponent(task.id) + '/fait', 'POST', { outcome: gesture[0] }).then(function (res) {
      if (closing === mine) { closing = null; gesturesOff(false); }
      if (res.gone || mine !== t.session()) return false;
      if (res.ok) return missedPromises(gesture[2]);
      var b = res.body, known = !res.offline && b && b.code && res.status < 500;
      if (known && MISSED_REREAD[b.code]) return missedPromises(MISSED_REREAD[b.code]);
      /* Une relecture en vol n'efface pas ce qui vient d'être dit. */
      blockTurns['engagements-manques'] = (blockTurns['engagements-manques'] || 0) + 1;
      state.textContent = !known ? 'Réponse perdue : ce geste est peut-être noté. Relisez avant de recommencer.' : b.rule === 'R16' ? SEAL_REFUSALS.role : 'Refusé : rien n’est noté. Relisez avant de recommencer.';
      return false;
    });
  }
  function missedPromises(message) {
    return readBlock('engagements-manques', '/v1/pilotage/engagements-manques', function (v, body) {
      gestures = [];
      var ul = el('ul', null, 'liste');
      v.tasks.forEach(function (task) {
        var li = el('li');
        li.appendChild(el('strong', task.label));
        li.appendChild(el('p', 'Manqué le ' + day(task.day) + '.', 'doux'));
        var someone = task.personId || task.agentId;
        if (task.doNotCall) li.appendChild(el('p', 'Ne pas appeler : une exclusion est en cours sur cette fiche.', 'retard'));
        else if (!someone) li.appendChild(el('p', 'Ce cas ne désigne personne à rappeler.', 'doux'));
        else if (!task.personId) li.appendChild(el('p', 'À rappeler : ' + (task.agentName ? 'l’agent ' + task.agentName : 'un agent dont le nom manque') + '.'));
        if (task.personId) li.appendChild(t.ficheButton(task.personId));
        MISSED_GESTURES.forEach(function (gesture) {
          if (gesture[0] !== 'sans_appel' && (task.doNotCall || !someone)) return;
          var b = button(gesture[1], function () { closeMissed(task, gesture); });
          b.disabled = closing === t.session();
          if (gesture[0] !== 'rappele') b.className = 'secondaire';
          gestures.push(b);
          li.appendChild(b);
        });
        ul.appendChild(li);
      });
      if (v.tasks.length) body.appendChild(ul);
      var total = Number(v.total);
      var said = total ? plural(total, 'rappel à faire', 'rappels à faire') + '.' + (total > v.tasks.length ? ' Les ' + v.tasks.length + ' plus anciens sont ici.' : '') : 'Aucun rappel à faire.';
      return (message ? message + ' ' : '') + said;
    }, message);
  }
  function field(box, label, type) {
    uid += 1;
    var id = 'finances-champ-' + uid;
    var l = el('label', label);
    l.setAttribute('for', id);
    var i = el('input');
    i.setAttribute('id', id);
    i.setAttribute('type', type);
    box.appendChild(l);
    box.appendChild(i);
    return i;
  }
  /* Le geste : la date et la référence de la preuve, jamais un montant [R67] ; deux appuis espacés, sans suite la demande retombe. */
  function gesture(c, kind) {
    var isReceipt = kind === 'encaissement';
    var box = el('div');
    var when = field(box, isReceipt ? 'Jour et heure de l’encaissement' : 'Jour et heure du versement', 'datetime-local');
    var proof = field(box, 'Référence du relevé de compte, sans nom ni espace', 'text');
    var state = el('p', '', 'etat');
    state.setAttribute('role', 'status');
    var text = isReceipt ? 'Rapporter l’encaissement' : 'Rapporter le versement';
    var armedAt = null;
    var b = button(text, function () {
      if (b.disabled) return;
      var now = Date.now();
      if (armedAt !== null && now - armedAt < 1000) return;
      var at = when.value ? new Date(when.value) : null;
      if (!at || isNaN(at.getTime())) { state.textContent = 'Indiquez le jour et l’heure.'; return; }
      var ref = proof.value.trim();
      if (!PROOF.test(ref)) { state.textContent = PAY_REFUSALS.bad_proof; return; }
      if (armedAt === null || now - armedAt > 15000) {
        armedAt = now;
        b.textContent = 'Confirmer : ' + text.toLowerCase();
        state.textContent = (isReceipt ? 'Le délai de 24 h ouvrées partira de cette heure.' : 'La commission passera à « payée ».') + ' Ce geste ne se reprend pas. Appuyez de nouveau pour confirmer.';
        return;
      }
      armedAt = null;
      b.textContent = text;
      b.disabled = true;
      state.textContent = 'Envoi…';
      var mine = t.session();
      var payload = isReceipt ? { receivedAt: at.toISOString(), proofRef: ref } : { paidAt: at.toISOString(), proofRef: ref };
      send('/v1/pilotage/dossiers/' + encodeURIComponent(c.fileId) + '/' + kind, 'POST', payload).then(function (res) {
        if (res.gone || mine !== t.session()) return;
        if (!res.ok) {
          b.disabled = false;
          var code = res.body && res.body.code;
          /* Une réponse perdue ne dit pas que rien n'est rangé : le serveur a pu écrire avant de se taire. */
          var said = PAY_REFUSALS[code] || 'Réponse perdue : ce geste est peut-être rangé. Relisez la liste avant de recommencer.';
          /* La liste a changé sous l'écran : on la relit, et le refus reste dit. */
          if (code === 'already' || code === 'not_invoiced' || code === 'not_received' || code === 'unknown' || code === 'sale_cancelled') { commissions(said); return; }
          state.textContent = said;
          return;
        }
        var v = res.body.data || {};
        if (isReceipt) commissions('Encaissement rangé pour le dossier ' + c.fileId + (v.payoutDueAt ? ' : à verser avant le ' + date(v.payoutDueAt) + ' à ' + hour(v.payoutDueAt) + '.' : '.'));
        else commissions('Versement rangé pour le dossier ' + c.fileId + (v.late ? ', après l’échéance des 24 h ouvrées.' : ', dans les 24 h ouvrées.'));
      });
    });
    box.appendChild(b);
    box.appendChild(state);
    return box;
  }
  /* AU092 · le palier de la grille retenu pour la vente : le cumul de l'année déjà compté, le palier, son taux. */
  function tierText(c) {
    var p = c.tier;
    if (!p || typeof p.rateBp !== 'number') return null;
    return 'Grille à paliers : palier ' + p.tierSeq + ' (à partir de ' + euros(p.fromCents) + '), soit ' + String(p.rateBp / 100).replace('.', ',') + ' % ; chiffre d’affaires ' + p.year + ' déjà compté avant cette vente : ' + euros(p.cumulCents) + '.';
  }
  function line(c, group, task) {
    var li = el('li');
    li.appendChild(el('strong', 'Dossier ' + c.fileId));
    var charge = c.feeCharge === 'vendeur' ? ', à la charge du vendeur' : c.feeCharge === 'acquereur' ? ', à la charge de l’acquéreur' : '';
    li.appendChild(el('p', 'Agent ' + c.agentId + ' : honoraires ' + euros(c.feeCents) + charge + '.'));
    var parts = el('ul', null, 'liste');
    var sum = 0;
    (c.shares || []).forEach(function (s) {
      sum += Number(s.amountCents);
      var who = s.beneficiaryId ? ', agent ' + s.beneficiaryId : '';
      var why = s.reason && SPLIT_REASONS[s.reason] ? ' (' + SPLIT_REASONS[s.reason] + ')' : '';
      parts.appendChild(el('li', (SHARE_NAMES[s.kind] || 'Autre part') + who + why + ' : ' + euros(s.amountCents)));
    });
    li.appendChild(parts);
    var tierLine = tierText(c);
    if (tierLine) li.appendChild(el('p', tierLine, 'doux'));
    var gap = sum !== Number(c.feeCents);
    if (gap) li.appendChild(el('p', 'Écart de ' + euros(Math.abs(sum - Number(c.feeCents))) + ' entre les parts et les honoraires : ne versez rien, et vérifiez ce dossier.', 'retard'));
    li.appendChild(el('p', (c.steps || []).map(function (s) { return (STEP_NAMES[s.status] || s.status) + ' le ' + date(s.at); }).join(' · '), 'doux'));
    var pay = c.payment;
    if (group === 'annulee') li.appendChild(el('p', 'Plus rien ne s’encaisse ni ne se verse ici.' + (pay ? ' Déjà encaissée le ' + date(pay.receivedAt) + (pay.paidAt ? ', versée le ' + date(pay.paidAt) : '') + ' : à régler avec votre comptable.' : ''), 'retard'));
    if (group === 'facturer') li.appendChild(el('p', 'Sa facture se valide dans les brouillons plus haut. Sans brouillon, le payeur manque au dossier.', 'doux'));
    if (group === 'verser' && pay) {
      li.appendChild(el('p', 'Encaissé le ' + date(pay.receivedAt) + '. À verser avant le ' + date(pay.payoutDueAt) + ' à ' + hour(pay.payoutDueAt) + '.'));
      if (task && (task.alerts || []).indexOf('echeance_depassee') !== -1) li.appendChild(el('p', 'Échéance dépassée.', 'retard'));
    }
    if (group === 'payee' && pay && pay.paidAt) {
      li.appendChild(el('p', 'Versée le ' + date(pay.paidAt) + (pay.late ? ', après l’échéance des 24 h ouvrées.' : ', dans les 24 h ouvrées.')));
      if (c.status !== 'payee') li.appendChild(el('p', 'Le passage à « payée » se reprend au prochain passage.', 'doux'));
    }
    if (!gap && group === 'encaisser') li.appendChild(gesture(c, 'encaissement'));
    if (!gap && group === 'verser') li.appendChild(gesture(c, 'reversement'));
    return li;
  }
  function commissions(message) {
    var mine = t.session();
    /* Seule la dernière lecture demandée s'affiche : deux appuis ne font pas deux listes. */
    var turn = ++listing;
    var body = $('commissions-corps'), state = $('commissions-etat');
    clear(body);
    state.textContent = 'Chargement…';
    return Promise.all([send('/v1/pilotage/commissions', 'GET'), send('/v1/pilotage/reversements', 'GET'), send('/v1/pilotage/commissions/a-trancher', 'GET')]).then(function (all) {
      var a = all[0], b = all[1], k = all[2];
      if (a.gone || b.gone || k.gone || mine !== t.session() || turn !== listing) return false;
      /* Sans toutes les réponses, on ne sait pas ce qui attend : aucun geste n'est proposé. */
      if (!a.ok || !b.ok || !k.ok || !Array.isArray(a.body.data) || !Array.isArray(b.body.data) || !Array.isArray(k.body.data)) {
        var bad = !a.ok ? a : !b.ok ? b : k;
        var why = bad.offline ? 'Pas de réseau. Réessayez dans un moment.' : bad.body && bad.body.rule === 'R16' ? PAY_REFUSALS.role : 'Indisponible pour le moment. Réessayez plus tard.';
        /* Un geste réussi reste dit, même si la relecture échoue. */
        state.textContent = (message ? message + ' ' : '') + why;
        return false;
      }
      var tasks = {};
      b.body.data.forEach(function (x) { tasks[x.fileId] = x; });
      var blocked = {};
      k.body.data.forEach(function (x) { blocked[x.fileId] = x; });
      var groupOf = function (c) {
        if (Object.prototype.hasOwnProperty.call(blocked, c.fileId)) return 'trancher';
        if (c.cancelled) return 'annulee';
        if (c.status === 'payee' || (c.payment && c.payment.paidAt)) return 'payee';
        if (c.status === 'facturee') return c.payment ? 'verser' : 'encaisser';
        return c.status === 'due' ? 'facturer' : 'prevue';
      };
      /* Ce qui attend que la direction tranche passe avant tout : le passage n'y touchera plus de lui-même. */
      if (k.body.data.length) {
        body.appendChild(el('h4', 'À trancher (' + k.body.data.length + ')'));
        var open = el('ul', null, 'liste');
        k.body.data.forEach(function (x) { open.appendChild(el('li', 'Dossier ' + x.fileId + ' : ' + (BLOCKED[x.code] || 'la commission n’avance plus.'))); });
        body.appendChild(open);
      }
      GROUPS.forEach(function (g) {
        var items = a.body.data.filter(function (c) { return groupOf(c) === g[0]; });
        if (!items.length) return;
        body.appendChild(el('h4', g[1] + ' (' + items.length + ')'));
        var ul = el('ul', null, 'liste');
        items.forEach(function (c) { ul.appendChild(line(c, g[0], tasks[c.fileId])); });
        body.appendChild(ul);
      });
      state.textContent = message || (a.body.data.length || k.body.data.length ? '' : 'Aucune commission pour le moment : elles naissent au compromis signé.');
      return true;
    });
  }
  /* ---------- Le chemin de chaque euro (K13) : les étapes viennent du serveur, jamais d'un calcul de l'écran. ---------- */
  function stepAt(c, status) {
    var s = (c.steps || []).filter(function (x) { return x.status === status; })[0];
    return s ? s.at : null;
  }
  function pathLine(c, mine) {
    var li = el('li');
    li.appendChild(el('strong', 'Dossier ' + c.fileId + ' : ma part ' + euros(mine)));
    var myTier = tierText(c);
    if (myTier) li.appendChild(el('p', myTier, 'doux'));
    if (c.shares.length > 1) {
      var parts = el('ul', null, 'liste');
      c.shares.forEach(function (s) { parts.appendChild(el('li', (SHARE_NAMES[s.kind] || 'Autre part') + ' : ' + euros(s.amountCents))); });
      li.appendChild(parts);
    }
    var pay = c.payment;
    var way = [
      /* Les jours signés, et non l'heure où le passage les a vus. */
      ['Compromis signé', c.compromisOn ? c.compromisOn + 'T12:00:00Z' : null],
      ['Acte signé', c.signedOn ? c.signedOn + 'T12:00:00Z' : null],
      ['Facture émise', stepAt(c, 'facturee')],
      ['Honoraires encaissés par le réseau', pay ? pay.receivedAt : null],
      ['Versée sur mon compte', pay && pay.paidAt ? pay.paidAt : stepAt(c, 'payee')],
    ];
    var ol = el('ol');
    way.forEach(function (w) { ol.appendChild(el('li', w[0] + (w[1] ? ' : le ' + date(w[1]) : ' : pas encore'), w[1] ? undefined : 'doux')); });
    li.appendChild(ol);
    if (c.cancelled) li.appendChild(el('p', 'Vente annulée par un avoir : cette part n’est pas due. La direction règle ce qui a déjà été versé.', 'retard'));
    else if (pay && pay.paidAt) li.appendChild(el('p', pay.late ? 'Versée après l’heure limite du ' + date(pay.payoutDueAt) + ' à ' + hour(pay.payoutDueAt) + ' : la promesse n’a pas été tenue.' : 'Versée dans les 24 h ouvrées promises.', pay.late ? 'retard' : undefined));
    else if (pay) {
      var over = Date.now() > Date.parse(pay.payoutDueAt);
      li.appendChild(el('p', (over ? 'Heure limite dépassée : ' : 'Promesse : versée au plus tard ') + 'le ' + date(pay.payoutDueAt) + ' à ' + hour(pay.payoutDueAt) + '.', over ? 'retard' : undefined));
    }
    return li;
  }
  var pathing = 0;
  function path() {
    var mine = t.session();
    var turn = ++pathing;
    var body = $('euros-corps'), state = $('euros-etat');
    clear(body);
    state.textContent = 'Chargement…';
    return send('/v1/pilotage/commissions', 'GET').then(function (res) {
      if (res.gone || mine !== t.session() || turn !== pathing) return false;
      if (!res.ok || !Array.isArray(res.body.data)) {
        if (res.offline) state.textContent = 'Pas de réseau. Réessayez dans un moment.';
        else if (res.body && res.body.rule === 'R16') state.textContent = PAY_REFUSALS.role;
        else state.textContent = 'Indisponible pour le moment. Réessayez plus tard.';
        return false;
      }
      var items = res.body.data;
      if (!items.length) { state.textContent = 'Aucune commission pour le moment : elles naissent au compromis signé.'; return true; }
      var paid = 0, coming = 0, cut = 0, ul = el('ul', null, 'liste');
      items.forEach(function (c) {
        c.shares = c.shares || [];
        var own = c.shares.reduce(function (a, s) { return a + Number(s.amountCents); }, 0);
        if (c.cancelled) cut += own;
        else if ((c.payment && c.payment.paidAt) || c.status === 'payee') paid += own;
        else coming += own;
        ul.appendChild(pathLine(c, own));
      });
      /* Les totaux refont la somme des lignes ci-dessous, au centime [R69]. */
      body.appendChild(el('p', 'Versé : ' + euros(paid) + '. À venir : ' + euros(coming) + (cut ? '. Annulé : ' + euros(cut) : '') + '.'));
      body.appendChild(ul);
      state.textContent = '';
      return true;
    });
  }
  /* ---------- La grille, les seuils, les factures et l'export (K12). ---------- */
  function percent(bp) { return bp === null || bp === undefined ? '' : String(Number(bp) / 100).replace('.', ','); }
  /* Un pourcentage en points de base ; vide ou illisible : null. */
  function toBp(text) {
    var s = String(text).trim().replace(',', '.');
    if (!/^\\d{1,3}(\\.\\d{1,2})?$/.test(s)) return null;
    var bp = Math.round(Number(s) * 100);
    return bp <= 10000 ? bp : null;
  }
  function refusalOf(res, fallback) {
    /* Une réponse perdue ne dit pas que rien n'est rangé : le serveur a pu écrire avant de se taire. */
    return (res.body && SETTING_REFUSALS[res.body.code]) || fallback;
  }
  function saveButton(box, text, state, act) {
    var b = button(text, function () {
      if (b.disabled) return;
      var mine = t.session();
      var work = act();
      if (!work) return;
      b.disabled = true;
      state.textContent = 'Envoi…';
      work.then(function (done) {
        if (mine === t.session()) b.disabled = false;
        return done;
      });
    });
    box.appendChild(b);
    return b;
  }
  function gridForm(g) {
    var box = el('div');
    box.appendChild(el('h4', 'Nouvelle version de la grille'));
    var line = function (x) { return 'Version ' + x.version + ', ' + percent(x.defaultRateBp) + ' % pour l’agent'; };
    var force = g.inForce;
    box.appendChild(el('p', force ? 'En vigueur : ' + line(force) + ', depuis le ' + date(force.validFrom + 'T12:00:00Z') + '.' : 'Aucune grille en vigueur aujourd’hui : aucune commission ne peut naître sur un compromis signé ce jour.', force ? 'doux' : 'retard'));
    (g.upcoming || []).forEach(function (x) { box.appendChild(el('p', 'Déjà programmée : ' + line(x) + ', à partir du ' + date(x.validFrom + 'T12:00:00Z') + '.')); });
    var from = field(box, 'À partir du', 'date');
    var rate = field(box, 'Part de l’agent, en %', 'text');
    rate.value = force ? percent(force.defaultRateBp) : '';
    var rows = (g.agents || []).map(function (a) {
      var i = field(box, 'Taux propre à ' + (a.name || 'un agent dont le nom manque') + ', en % (vide : le taux commun)', 'text');
      i.value = percent(a.rateBp);
      return { agentId: a.agentId, input: i };
    });
    var state = el('p', '', 'etat');
    state.setAttribute('role', 'status');
    saveButton(box, 'Ranger cette version', state, function () {
      var mine = t.session();
      if (!/^\\d{4}-\\d{2}-\\d{2}$/.test(from.value)) { state.textContent = SETTING_REFUSALS.bad_day; return null; }
      var bp = toBp(rate.value);
      if (bp === null) { state.textContent = SETTING_REFUSALS.bad_rate; return null; }
      var agents = [], wrong = false;
      rows.forEach(function (r) {
        if (!r.input.value.trim()) return;
        var v = toBp(r.input.value);
        if (v === null) wrong = true;
        else agents.push({ agentId: r.agentId, rateBp: v });
      });
      if (wrong) { state.textContent = SETTING_REFUSALS.bad_rate; return null; }
      return send('/v1/pilotage/grille', 'POST', { validFrom: from.value, defaultRateBp: bp, agents: agents, expectedVersion: g.version === undefined ? null : g.version }).then(function (res) {
        if (res.gone || mine !== t.session()) return false;
        if (!res.ok) { state.textContent = refusalOf(res, 'Réponse perdue : cette version est peut-être rangée. Relisez la grille avant de recommencer.'); return false; }
        return settings('Nouvelle version de la grille rangée. Les ventes passées gardent la leur.');
      });
    });
    box.appendChild(state);
    return box;
  }
  function settingsForm(s) {
    var box = el('div');
    box.appendChild(el('h4', 'Alertes'));
    var budget = field(box, 'Budget mensuel de l’IA, en euros (vide : sans plafond)', 'text');
    budget.value = s.aiMonthlyBudgetCents === null || s.aiMonthlyBudgetCents === undefined ? '' : String(s.aiMonthlyBudgetCents / 100).replace('.', ',');
    var ai = field(box, 'Alerte à ce pourcentage du budget', 'text');
    ai.value = percent(s.aiAlertBp);
    var drop = field(box, 'Alerte quand un indicateur baisse de ce pourcentage', 'text');
    drop.value = percent(s.dropAlertBp);
    var notice = field(box, 'Préavis avant l’échéance d’un document d’agent, en jours', 'number');
    notice.value = String(s.documentNoticeDays);
    var state = el('p', '', 'etat');
    state.setAttribute('role', 'status');
    saveButton(box, 'Ranger ces alertes', state, function () {
      var mine = t.session();
      var cents = null;
      var raw = budget.value.trim().replace(',', '.');
      if (raw) {
        if (!/^\\d{1,9}(\\.\\d{1,2})?$/.test(raw) || Number(raw) <= 0) { state.textContent = SETTING_REFUSALS.bad_budget; return null; }
        cents = Math.round(Number(raw) * 100);
      }
      var a = toBp(ai.value), d = toBp(drop.value);
      if (a === null || d === null || a < 1 || d < 1) { state.textContent = SETTING_REFUSALS.bad_threshold; return null; }
      var days = Number(notice.value);
      if (!Number.isInteger(days) || days < 1 || days > 365) { state.textContent = SETTING_REFUSALS.bad_notice; return null; }
      return send('/v1/pilotage/reglages', 'POST', { aiMonthlyBudgetCents: cents, aiAlertBp: a, dropAlertBp: d, documentNoticeDays: days }).then(function (res) {
        if (res.gone || mine !== t.session()) return false;
        if (!res.ok) { state.textContent = refusalOf(res, 'Réponse perdue : ces alertes sont peut-être rangées. Relisez-les avant de recommencer.'); return false; }
        state.textContent = 'Alertes rangées.';
        return true;
      });
    });
    box.appendChild(state);
    return box;
  }
  var setting = 0;
  function settings(message) {
    var mine = t.session();
    var turn = ++setting;
    var body = $('grille-corps'), state = $('grille-etat');
    clear(body);
    state.textContent = 'Chargement…';
    return Promise.all([send('/v1/pilotage/grille', 'GET'), send('/v1/pilotage/reglages', 'GET')]).then(function (all) {
      var g = all[0], s = all[1];
      if (g.gone || s.gone || mine !== t.session() || turn !== setting) return false;
      /* Sans la dernière version, ranger une grille pourrait perdre des taux : aucun formulaire. */
      if (!g.ok || !s.ok || !g.body.data || !s.body.data) {
        var bad = !g.ok ? g : s;
        state.textContent = (message ? message + ' ' : '') + (bad.offline ? 'Pas de réseau. Réessayez dans un moment.' : bad.body && bad.body.rule === 'R16' ? SETTING_REFUSALS.role : 'Indisponible pour le moment. Réessayez plus tard.');
        return false;
      }
      body.appendChild(gridForm(g.body.data));
      body.appendChild(settingsForm(s.body.data));
      state.textContent = message || '';
      return true;
    });
  }
  function creditForm(inv) {
    var box = el('div');
    uid += 1;
    var id = 'finances-champ-' + uid;
    var l = el('label', 'Raison de l’avoir');
    l.setAttribute('for', id);
    var pick = el('select');
    pick.setAttribute('id', id);
    Object.keys(CREDIT_REASONS).forEach(function (k) {
      var o = el('option', CREDIT_REASONS[k]);
      o.setAttribute('value', k);
      pick.appendChild(o);
    });
    pick.value = 'erreur_montant';
    box.appendChild(l);
    box.appendChild(pick);
    var state = el('p', '', 'etat');
    state.setAttribute('role', 'status');
    var text = 'Corriger par un avoir', armedAt = null;
    var b = button(text, function () {
      if (b.disabled) return;
      var now = Date.now();
      if (armedAt !== null && now - armedAt < 1000) return;
      if (armedAt === null || now - armedAt > 15000) {
        armedAt = now;
        b.textContent = 'Confirmer : émettre l’avoir';
        state.textContent = (pick.value === 'vente_annulee' ? 'La vente sera dite annulée : plus aucune facture, aucun encaissement, aucun versement. ' : '') + 'Un avoir ne se reprend pas. Appuyez de nouveau pour confirmer.';
        return;
      }
      armedAt = null;
      b.textContent = text;
      b.disabled = true;
      state.textContent = 'Envoi…';
      var mine = t.session();
      send('/v1/pilotage/factures/' + encodeURIComponent(inv.id) + '/avoir', 'POST', { reason: pick.value }).then(function (res) {
        if (res.gone || mine !== t.session()) return;
        if (!res.ok) {
          b.disabled = false;
          var code = res.body && res.body.code;
          if (code === 'already' || code === 'unknown') { invoices(SETTING_REFUSALS[code]); return; }
          state.textContent = code && SETTING_REFUSALS[code] ? SETTING_REFUSALS[code] : 'Réponse perdue : l’avoir est peut-être émis. Relisez la liste avant de recommencer.';
          return;
        }
        var v = res.body.data;
        invoices('Avoir émis en mode essai' + (v && v.content && typeof v.content.label === 'string' ? ' : ' + v.content.label : '') + '.');
      });
    });
    box.appendChild(b);
    box.appendChild(state);
    return box;
  }
  var invoicing = 0;
  function invoices(message) {
    var mine = t.session();
    var turn = ++invoicing;
    var body = $('factures-corps'), state = $('factures-etat');
    clear(body);
    state.textContent = 'Chargement…';
    return send('/v1/pilotage/factures', 'GET').then(function (res) {
      if (res.gone || mine !== t.session() || turn !== invoicing) return false;
      if (!res.ok || !Array.isArray(res.body.data)) {
        state.textContent = (message ? message + ' ' : '') + (res.offline ? 'Pas de réseau. Réessayez dans un moment.' : res.body && res.body.rule === 'R16' ? SETTING_REFUSALS.role : 'Indisponible pour le moment. Réessayez plus tard.');
        return false;
      }
      var items = res.body.data;
      var corrected = {};
      items.forEach(function (i) { if (i.content && i.content.corrects) corrected[i.content.corrects] = true; });
      var ul = el('ul', null, 'liste');
      items.forEach(function (i) {
        var c = i.content || {};
        var li = el('li');
        li.appendChild(el('strong', (KIND_NAMES[c.kind] || 'Facture') + ' ' + c.label));
        li.appendChild(el('p', 'De ' + c.issuer + ' à ' + c.recipient + ', le ' + date(c.issuedOn + 'T12:00:00Z') + ' : ' + euros(c.ttcCents) + ' TTC.'));
        li.appendChild(el('p', 'Dossier ' + i.fileId + (i.transmitted ? (i.transmitted.mode === 'reel' ? ', déposée à la plateforme agréée' + (i.status ? ' : ' + i.status.name.toLowerCase() : '') + '.' : ', en mode essai.') : ', pas encore transmise.'), 'doux'));
        if (c.corrects) li.appendChild(el('p', 'Corrige la facture ' + c.corrects + '.', 'doux'));
        if (corrected[c.label]) li.appendChild(el('p', 'Corrigée par un avoir.', 'doux'));
        else if (c.kind !== 'avoir') li.appendChild(creditForm(i));
        ul.appendChild(li);
      });
      if (items.length) body.appendChild(ul);
      state.textContent = message || (items.length ? '' : 'Aucune facture émise pour le moment.');
      return true;
    });
  }
  function exportInvoices() {
    var from = $('factures-du').value, to = $('factures-au').value, state = $('factures-export-etat');
    var day = /^\\d{4}-\\d{2}-\\d{2}$/;
    if (!day.test(from) || !day.test(to) || from > to) { state.textContent = 'Choisissez une période : le premier jour, puis le dernier.'; return Promise.resolve(false); }
    return t.saveCsv('/v1/pilotage/factures/export?du=' + from + '&au=' + to, 'factures-' + from + '-' + to + '.csv', state, 'Export indisponible. Réessayez plus tard.', 'Export téléchargé.');
  }
  return { report: report, commissions: commissions, path: path, settings: settings, invoices: invoices, exportInvoices: exportInvoices };
};
`
  // Les retraits et les commentaires ne partent pas chez le client : ce script a son budget [R201]. Une chaîne ne tient que sur une ligne.
  .replace(/^[ \t]+/gm, '')
  .replace(/^\/\*.*\*\/\n/gm, '');
