/**
 * Recommander un proche depuis la fiche du client (X22) : la route de M11 existait sans geste. Script servi à part
 * (`/app/recommandation.js`), chargé au premier geste [R201]. Rien n'est envoyé ici, et aucun champ ne parle de récompense
 * [R66]. Le proche n'est appelé que si la case est cochée, avec la preuve de son accord [R03, R142]. La réponse dite à
 * l'écran ne dépend que de ce qui a été saisi : jamais de qui suit le proche, ni s'il est opposé [R16]. La clé d'idempotence
 * reste la même tant que la saisie ne change pas : une réponse perdue se renvoie sans rien doubler.
 */

/** Le bloc de la fiche n'est plus posé dans l'application : la fiche servie à part (`/app/fiche.js`) le demande au chargeur commun (DS010). */
/** Le script servi à part. Il ne lit et n'écrit que les recommandations de cette fiche [R16]. */
export const RECOMMANDATION_SCRIPT = `'use strict';
globalThis.AIMMO_RECOMMANDATION = function (t) {
  var el = t.el, clear = t.clear, send = t.send, button = t.button, field = t.field, checkbox = t.checkbox;
  var OFFLINE = 'Pas de réseau. Réessayez dans un moment.';
  var DENIED = 'Réservé à l’agent de cette fiche et à la direction.';
  var LOST = 'La réponse n’est pas arrivée : rien n’est sûr. Renvoyez cette saisie : une recommandation n’est jamais rangée deux fois.';
  var STUCK_MS = 120000;
  var REWARD = 'Une recommandation ne se récompense jamais : retirez ce qui en parle.';
  var REFUSALS = {
    bad_first_name: 'Ce prénom n’est pas lisible : 60 caractères au plus.',
    bad_project: 'Choisissez le projet du proche.',
    bad_proof: 'Écrivez la preuve de son accord, en 300 caractères au plus.',
    bad_email: 'Ce mail n’est pas lisible.',
    bad_phone: 'Ce téléphone n’est pas lisible.',
    no_contact: 'Donnez un mail ou un téléphone du proche.',
    reward: REWARD,
    unknown_field: REWARD,
    same_person: 'Ces coordonnées sont celles du client de cette fiche.',
    already_referred: 'Ce client a déjà recommandé cette personne : rien de plus n’est rangé.'
  };
  // Des WeakSet : un bloc fermé ou une déconnexion ne laissent en mémoire ni le formulaire ni ce qui y est écrit.
  var opened = new WeakSet();
  var busy = new WeakSet();
  var loading = new WeakSet();
  function newKey() {
    var bytes = crypto.getRandomValues(new Uint8Array(16));
    return Array.prototype.map.call(bytes, function (b) { return (b + 256).toString(16).slice(1); }).join('');
  }
  function form(personId, list, corps, said) {
    corps.appendChild(el('p', 'Rien ne part d’ici, et une recommandation ne se récompense jamais.', 'doux'));
    var first = field(corps, 'reco-prenom', 'Prénom du proche');
    var email = field(corps, 'reco-mail', 'Mail du proche');
    email.setAttribute('type', 'email');
    var phone = field(corps, 'reco-tel', 'Téléphone du proche');
    phone.setAttribute('type', 'tel');
    [first, email, phone].forEach(function (f) { f.setAttribute('autocomplete', 'off'); });
    var project = field(corps, 'reco-projet', 'Son projet', 'select');
    var none = el('option', 'Choisir');
    none.setAttribute('value', '');
    project.appendChild(none);
    Object.keys(t.projects).forEach(function (k) {
      var o = el('option', t.projects[k]);
      o.setAttribute('value', k);
      project.appendChild(o);
    });
    var callable = checkbox(corps, 'reco-accord', 'Selon le client, le proche accepte d’être appelé');
    var proof = field(corps, 'reco-preuve', 'Preuve de cet accord (quand, comment)', 'textarea');
    corps.appendChild(el('p', 'Sans cette case et sa preuve, cette recommandation ne demande aucun appel.', 'doux'));
    var key = null, sent = null, waitingSince = 0;
    corps.appendChild(button('Ranger la recommandation', function () {
      if (busy.has(corps)) return;
      var body = { projectKind: project.value, callable: !!callable.checked };
      if (first.value.trim()) body.firstName = first.value.trim();
      if (email.value.trim()) body.email = email.value.trim();
      if (phone.value.trim()) body.phone = phone.value.trim();
      if (body.callable) body.proof = proof.value.trim();
      var stop = !body.email && !body.phone ? 'no_contact' : !body.projectKind ? 'bad_project' : body.callable && !body.proof ? 'bad_proof' : null;
      if (stop) { said.textContent = REFUSALS[stop]; return; }
      // La clé ne change qu'avec la saisie : renvoyer la même saisie après une réponse perdue relit la première réponse.
      var text = JSON.stringify(body);
      if (!key || sent !== text) { key = newKey(); sent = text; waitingSince = 0; }
      busy.add(corps);
      said.textContent = 'Envoi…';
      send('/v1/apres-vente/fiches/' + encodeURIComponent(personId) + '/recommandations', 'POST', body, { 'idempotency-key': key }).then(function (x) {
        busy.delete(corps);
        if (x.gone) return;
        if (x.offline || !x.body) { said.textContent = LOST; return; }
        var code = x.body.code;
        if (x.ok) {
          key = null;
          [first, email, phone, project, proof].forEach(function (f) { f.value = ''; });
          callable.checked = false;
          // Le même texte quel que soit le proche : suivi par un autre agent, opposé ou inconnu [R16].
          var done = body.callable ? 'Recommandation rangée. Si cet appel est permis, il sera proposé à l’agent qui suit cette personne.' : 'Recommandation rangée. Elle ne demande aucun appel.';
          load(personId, list, corps, said, done);
          return;
        }
        if (code === 'retry_with_new_key' || code === 'idempotency_key_reused') { key = null; said.textContent = 'Cet envoi n’a pas abouti. Renvoyez la saisie.'; return; }
        if (code === 'in_progress') {
          // Une coupure peut laisser cette clé sans réponse pour toujours : passé ce délai, une autre clé repart, et le socle
          // refuse de ranger deux fois le même proche pour ce client.
          if (!waitingSince) waitingSince = Date.now();
          if (Date.now() - waitingSince > STUCK_MS) { key = null; said.textContent = 'Cet envoi n’a pas abouti. Renvoyez la saisie.'; return; }
          said.textContent = 'L’envoi précédent n’a pas encore de réponse. Réessayez dans un moment.';
          return;
        }
        if (x.status >= 500) { said.textContent = LOST; return; }
        key = null;
        said.textContent = x.status === 403 ? DENIED : REFUSALS[code] || 'Cette recommandation n’est pas rangée.';
      });
    }));
  }
  function load(personId, list, corps, said, message) {
    var mine = t.session();
    if (!message) said.textContent = 'Chargement…';
    return send('/v1/apres-vente/fiches/' + encodeURIComponent(personId) + '/recommandations', 'GET').then(function (res) {
      if (res.gone || mine !== t.session()) return false;
      var d = res.ok && res.body.data;
      if (!d || !Array.isArray(d.recommendedBy) || !Array.isArray(d.recommended)) {
        said.textContent = (message ? message + ' ' : '') + (res.offline ? OFFLINE : res.status === 403 ? DENIED : 'Indisponible pour le moment.');
        return false;
      }
      clear(list);
      d.recommendedBy.forEach(function (r) { list.appendChild(el('p', 'Recommandé par ' + (r.firstName || 'un client'))); });
      d.recommended.forEach(function (r) { list.appendChild(el('p', 'A recommandé ' + (r.firstName || 'un proche'))); });
      if (!opened.has(corps)) {
        opened.add(corps);
        form(personId, list, corps, said);
      }
      said.textContent = message || '';
      return true;
    });
  }
  function open(personId, corps, said) {
    // Le bloc déjà ouvert garde ce qui y est écrit : une saisie ne se perd pas sur un second appui.
    // Une lecture déjà partie suffit : une seconde poserait une autre liste, et le formulaire suivrait la première, détachée.
    if (opened.has(corps) || loading.has(corps)) return Promise.resolve(true);
    loading.add(corps);
    clear(corps);
    var list = el('div');
    corps.appendChild(list);
    return load(personId, list, corps, said).then(function (r) {
      loading.delete(corps);
      return r;
    });
  }
  return { open: open };
};
`;
