import type { GbpAction, GbpDraftState, GbpErrorCode, GbpLink, GbpProblem } from '../../core/src/attirer/fiche-google.ts';

/**
 * L'écran « Fiche Google » (AT14), en morceaux posés dans `fichiers.ts` : son entrée sur l'accueil de l'agent, sa section
 * de page, son chargeur, et son script servi à part (`/app/fiche-google.js`), chargé à la première ouverture pour tenir le
 * budget de l'application [R201]. La direction l'ouvre depuis l'écran « Attirer », agent par agent.
 *
 * L'agent voit ses avis, fait préparer une réponse, la corrige, la valide, puis la fait partir ; rien ne part sans lui, et
 * en essai rien ne part du tout [R154, R26]. Chaque texte montré est le texte exact qu'il valide : un texte corrigé est un
 * nouveau texte, à relire. L'écran ne lit et n'écrit que par `/v1/attirer/google` [R16] ; il ne décide rien : l'état de
 * chaque texte vient du serveur. Sans H07, il dit que Google n'est pas branché, sans erreur. Tout texte reçu est posé avec
 * `textContent`.
 */

/** Les raisons d'un refus, dites en français : jamais un code interne. */
const REFUSALS: Record<string, string> = {
  role: 'Ce n’est pas dans vos droits.',
  agent_inconnu: 'Cet agent n’est pas dans le réseau.',
  agent_parti: 'Cet agent n’est plus en activité.',
  inconnu: 'Introuvable : la liste a changé.',
  non_valide: 'Ce texte n’est pas encore validé : relisez-le, puis validez.',
  texte_change: 'Un texte plus récent existe : relisez celui-ci.',
  deja_valide: 'Ce texte est déjà validé.',
  deja_parti: 'Un envoi est déjà parti ou en cours pour ce texte.',
  bien_retire: 'Ce bien n’est plus en vente, ou son annonce a changé : ce texte ne peut plus partir.',
  deja_publie: 'Ce bien est déjà publié sur la fiche.',
  trop_tot: 'Une publication est déjà partie ces derniers jours : celle-ci attend la période suivante.',
  sans_fiche: 'Aucune fiche Google n’est réglée pour cet agent : la direction doit la régler.',
  invalide: 'Vérifiez les champs : un nom de 2 à 100 caractères, une référence accounts/…/locations/…, et une adresse en https.',
  occupe: 'Cet envoi a commencé il y a moins d’une heure : attendez avant de le clore.',
  echec: 'Google n’a pas répondu : rien n’est enregistré comme parti. Réessayez dans un moment.',
  a_verifier: 'La réponse de Google s’est perdue : la publication a pu partir. Rien ne repart tant que la direction n’a pas regardé la fiche Google.',
  sans_service: 'Google n’est pas encore branché : rien à lire ni à envoyer pour le moment.',
};

/** Pourquoi Google a refusé un envoi réel (AU037), en mots : jamais le texte de Google. */
const ERRORS: Record<GbpErrorCode, string> = {
  connexion: 'Google refuse la connexion du compte qui gère les fiches.',
  droits: 'Ce compte Google ne gère pas cette fiche.',
  fiche_introuvable: 'Google ne trouve pas cette fiche à cette référence.',
  refuse_google: 'Google a refusé ce texte ou son lien.',
  limite: 'La limite d’envois de Google est atteinte pour le moment.',
  panne: 'Google n’a pas répondu.',
  accuse_absent: 'Google a répondu sans confirmer l’envoi.',
};

/** Le geste qui règle chaque échec. */
const ACTIONS: Record<GbpAction, string> = {
  reconnecter: 'À faire : reconnecter le compte Google du réseau (la direction).',
  relier: 'À faire : vérifier la référence de la fiche et donner l’accès de la fiche au compte du réseau (la direction).',
  corriger: 'À faire : corriger le texte, puis le valider de nouveau.',
  reessayer: 'Rien n’est parti : réessayez dans un moment.',
  verifier: 'À faire : regarder la fiche Google avant de réessayer.',
};

/** La liaison avec Google, dite par le serveur. */
const LINKS: Record<GbpLink['state'], string> = {
  essai: 'En essai, rien ne part vers Google, même validé : l’envoi est seulement noté.',
  sans_service: 'Google n’est pas encore branché : aucun avis ne peut arriver, et rien ne peut partir. Vous pouvez déjà préparer et relire.',
  pret: 'Reliée à Google : ce qui part est confirmé par Google.',
  a_reconnecter: 'Google refuse la connexion : rien ne peut partir tant que le compte n’est pas reconnecté.',
  a_relier: 'Google refuse l’accès à cette fiche : rien ne peut partir tant qu’elle n’est pas reliée au compte du réseau.',
};

/** Ce qu'un texte refusé porte encore [R154, R46, R64, R07, R06]. */
const PROBLEMS: Record<GbpProblem, string> = {
  nom: 'un nom de personne',
  adresse: 'une adresse',
  montant: 'un montant ou un grand nombre',
  dossier: 'un détail du dossier',
  coordonnee: 'une coordonnée',
  contrepartie: 'une contrepartie',
  vocabulaire: 'un mot interdit',
  ia: 'une mention de l’outil',
  temoignage: 'un témoignage ou une note',
  longueur: 'trop de texte (1 500 caractères au plus)',
  vide: 'aucun texte',
};

const ORIGINS = { ia: 'Préparé par l’IA', secours: 'Préparé sans IA', code: 'Écrit depuis l’annonce', agent: 'Écrit à la main' };

/** Ce que dit chaque état décidé par le serveur. */
const STATES: Record<GbpDraftState, string> = {
  a_valider: 'À relire : rien ne part sans votre validation.',
  a_envoyer: 'Validé : prêt à partir.',
  envoi_en_cours: 'Envoi en cours : attendez un moment avant de rouvrir.',
  envoi_coupe: 'L’envoi a été coupé avant la réponse de Google. La direction regarde la fiche Google, puis le clôt.',
  echec: 'L’envoi a échoué : rien n’est parti.',
  note_essai: 'En essai, rien n’est parti : l’envoi est seulement noté.',
  envoye: 'Parti sur Google.',
  bien_retire: 'Ce bien n’est plus en vente, ou son annonce a changé : ce texte ne peut plus partir.',
  texte_a_revoir: 'Ce texte ne passe plus le contrôle et ne peut pas partir : changez le titre de l’annonce, puis préparez une nouvelle publication.',
};

export const FICHE_GOOGLE_HOME_HTML = `<section class="bloc" aria-labelledby="titre-fiche-google-accueil">
<h3 id="titre-fiche-google-accueil">Fiche Google</h3>
<p class="etat">Vos avis et vos publications : préparés pour vous, rien ne part sans vous.</p>
<button id="fiche-google-ouvrir" type="button" class="secondaire">Ouvrir</button>
</section>
`;

export const FICHE_GOOGLE_HTML = `<section id="fiche-google" hidden>
<button id="fiche-google-retour" type="button" class="retour">Retour</button>
<h2 id="fiche-google-titre">Fiche Google</h2>
<p id="fiche-google-etat" class="etat" role="status"></p>
<div id="fiche-google-corps"></div>
</section>
`;

/** Le chargeur posé dans le script de l'application : l'écran est servi à part, chargé une fois, jamais gardé. */
export const FICHE_GOOGLE_JS = `
  /* ---------- M01 : l'écran « Fiche Google » (AT14), chargé à la demande [R16, R201]. ---------- */
  var googleScreen = null, googleAgent = null;
  function wipeGoogle() {
    if (googleScreen) { googleScreen.wipe(); return; }
    clear($('fiche-google-corps'));
    $('fiche-google-etat').textContent = '';
  }
  function openGoogle(agentId) {
    if (!currentKey) return Promise.resolve(false);
    googleAgent = agentId || null;
    if (googleScreen) return googleScreen.open(googleAgent, '');
    session += 1;
    var mine = session;
    wipeGoogle();
    show('fiche-google');
    $('fiche-google-etat').textContent = 'Chargement…';
    return new Promise(function (resolve) {
      var s = document.createElement('script');
      s.setAttribute('src', '/app/fiche-google.js');
      s.addEventListener('load', function () {
        var make = globalThis.AIMMO_FICHE_GOOGLE;
        try { delete globalThis.AIMMO_FICHE_GOOGLE; } catch (e) { /* rien */ }
        if (mine !== session || typeof make !== 'function') { resolve(false); return; }
        googleScreen = make({ $: $, el: el, clear: clear, send: send, show: show, button: button, field: field, details: details, date: date, key: function () { return currentKey; }, session: function () { return session; }, next: function () { session += 1; return session; } });
        resolve(googleScreen.open(googleAgent, ''));
      });
      s.addEventListener('error', function () {
        if (mine === session) $('fiche-google-etat').textContent = 'Pas de réseau. Réessayez dans un moment.';
        resolve(false);
      });
      $('fiche-google').appendChild(s);
    });
  }
`;

/**
 * Le script de l'écran, servi à part (`/app/fiche-google.js`). Il reçoit les outils de l'application, ne lit et n'écrit que
 * par `/v1/attirer/google` [R16], et ne garde aucune donnée.
 */
export const FICHE_GOOGLE_SCRIPT = `'use strict';
globalThis.AIMMO_FICHE_GOOGLE = function (t) {
  var $ = t.$, el = t.el, clear = t.clear, send = t.send, show = t.show, button = t.button, field = t.field, details = t.details, date = t.date;
  var REFUSALS = ${JSON.stringify(REFUSALS)};
  var PROBLEMS = ${JSON.stringify(PROBLEMS)};
  var ORIGINS = ${JSON.stringify(ORIGINS)};
  var STATES = ${JSON.stringify(STATES)};
  var ERRORS = ${JSON.stringify(ERRORS)};
  var ACTIONS = ${JSON.stringify(ACTIONS)};
  var LINKS = ${JSON.stringify(LINKS)};
  /* Après ces refus, ce qui est à l'écran n'est plus vrai : il est relu. */
  var STALE = ['texte_change', 'deja_valide', 'deja_parti', 'bien_retire', 'inconnu', 'non_valide'];
  var P = '/v1/attirer/google/';
  var busy = false, target = null, n = 0;
  function state(text) { $('fiche-google-etat').textContent = text; }
  function refusal(res, fallback) {
    if (res.offline) return 'La réponse n’est pas arrivée : rien n’est sûr. Relisez avant de recommencer.';
    var b = res.body;
    if (b && b.code === 'texte_refuse') {
      var found = (Array.isArray(b.problems) ? b.problems : []).map(function (p) { return PROBLEMS[p] || 'un mot à retirer'; });
      return 'Ce texte ne passe pas le contrôle' + (found.length ? ' : il porte ' + found.join(', ') : '') + '. Rien n’est enregistré.';
    }
    if (b && b.code === 'echec' && ERRORS[b.error]) return ERRORS[b.error] + ' ' + (ACTIONS[b.action] || '');
    return (b && REFUSALS[b.code]) || fallback;
  }
  /* Un lien rendu par Google, seulement en https. */
  function googleLink(url) {
    if (typeof url !== 'string' || url.indexOf('https://') !== 0) return null;
    var a = el('a', 'Voir sur Google');
    a.setAttribute('href', url);
    a.setAttribute('rel', 'noopener noreferrer');
    a.setAttribute('target', '_blank');
    return a;
  }
  function wipe() {
    clear($('fiche-google-corps'));
    state('');
    $('fiche-google-titre').textContent = 'Fiche Google';
    target = null;
  }
  function part(title) {
    var box = el('section', null, 'bloc');
    box.appendChild(el('h3', title));
    return box;
  }
  /* Un geste à la fois, même si l'écran est rouvert entre-temps. */
  function once(work) {
    if (busy) return Promise.resolve(false);
    busy = true;
    return work().then(function (r) { busy = false; return r; }, function () { busy = false; return false; });
  }
  function write(path, body, okText, failText) {
    return once(function () {
      state('Envoi…');
      return send(path, 'POST', body).then(function (x) {
        if (x.gone) return false;
        if (!x.ok) {
          var text = refusal(x, failText);
          if (x.body && STALE.indexOf(x.body.code) >= 0) return open(target, text);
          state(text);
          return false;
        }
        return open(target, typeof okText === 'function' ? okText(x.body.data) : okText);
      });
    });
  }
  function open(agentId, message) {
    if (!t.key()) return Promise.resolve(false);
    var mine = t.next();
    var who = agentId || null;
    wipe();
    target = who;
    show('fiche-google');
    state('Chargement…');
    return send(who ? P + 'agents/' + encodeURIComponent(who) : P + 'moi', 'GET').then(function (res) {
      if (res.gone || mine !== t.session()) return false;
      if (res.offline) { state('Pas de réseau. Réessayez dans un moment.'); return false; }
      if (!res.ok) { state(refusal(res, 'Indisponible pour le moment. Réessayez plus tard.')); return false; }
      render(res.body.data);
      state(message || '');
      return true;
    });
  }
  function render(d) {
    n = 0;
    $('fiche-google-titre').textContent = d.canConfigure ? 'Fiche Google de ' + d.agentFirstName : 'Ma fiche Google';
    var body = $('fiche-google-corps');
    body.appendChild(renderLocation(d));
    body.appendChild(renderReviews(d));
    body.appendChild(renderPosts(d));
  }

  function renderLocation(d) {
    var box = part('La fiche');
    var link = d.link || { state: d.mode === 'reel' ? 'pret' : 'essai', action: null, info: null };
    if (!d.connected) box.appendChild(el('p', LINKS.sans_service, 'etat'));
    else box.appendChild(el('p', LINKS[link.state] || '', link.action ? 'etat' : 'doux'));
    if (link.action) box.appendChild(el('p', ACTIONS[link.action] || '', 'etat'));
    var loc = d.location;
    if (link.info) {
      var when = 'Informations envoyées le ' + date(link.info.at);
      box.appendChild(el('p', link.info.ackRef ? when + ' : confirmées par Google.' : when + ' : ' + (ERRORS[link.info.error] || 'échec.') + ' ' + (ACTIONS[link.info.action] || ''), 'doux'));
    }
    if (d.canConfigure && d.mode === 'reel' && d.connected && loc) box.appendChild(button('Mettre à jour la fiche sur Google', function () {
      write(P + 'agents/' + encodeURIComponent(d.agentId) + '/informations', undefined, function (r) { return r && r.changed ? 'Fiche mise à jour : Google l’a confirmé.' : 'Rien n’a changé depuis le dernier envoi.'; }, 'La fiche n’est pas mise à jour.');
    }));
    if (loc) {
      box.appendChild(el('strong', loc.title));
      box.appendChild(el('p', loc.websiteUri, 'doux'));
    } else box.appendChild(el('p', d.canConfigure ? 'Aucune fiche réglée pour cet agent.' : 'Aucune fiche réglée : la direction doit la régler.', 'doux'));
    if (d.canConfigure) {
      var form = details(box, loc ? 'Changer le réglage de la fiche' : 'Régler la fiche');
      var title = field(form, 'fg-nom', 'Nom affiché sur la fiche');
      title.value = loc ? loc.title : '';
      var ref = field(form, 'fg-ref', 'Référence de la fiche chez Google (accounts/…/locations/…)');
      ref.value = loc ? loc.locationRef : '';
      var site = field(form, 'fg-site', 'Adresse du site');
      site.setAttribute('type', 'url');
      site.setAttribute('inputmode', 'url');
      site.value = loc ? loc.websiteUri : '';
      form.appendChild(button('Enregistrer la fiche', function () {
        write(P + 'agents/' + encodeURIComponent(d.agentId) + '/fiche', { title: title.value, locationRef: ref.value, websiteUri: site.value }, 'Fiche enregistrée.', 'La fiche n’est pas enregistrée.');
      }));
    }
    return box;
  }

  function renderReviews(d) {
    var box = part('Avis');
    box.appendChild(el('p', d.reviewsTotal === 0 ? 'Aucun avis lu pour le moment.' : d.reviewsTotal + ' avis, dont ' + d.reviewsWaiting + ' sans réponse partie.', 'doux'));
    if (d.reviewsTotal > d.reviews.length) box.appendChild(el('p', 'Les ' + d.reviews.length + ' plus récents sont montrés ici.', 'doux'));
    box.appendChild(el('p', 'Le nom de l’auteur d’un avis n’est jamais gardé, et aucune réponse ne peut le citer.', 'doux'));
    if (d.connected && d.location) box.appendChild(button('Lire les nouveaux avis', function () {
      write(P + 'agents/' + encodeURIComponent(d.agentId) + '/lecture', undefined, function (r) { return r && r.added ? r.added + ' nouvel(s) avis lu(s).' : 'Aucun nouvel avis.'; }, 'Les avis ne sont pas lus.');
    }));
    var ul = el('ul', null, 'liste');
    d.reviews.forEach(function (r) { ul.appendChild(reviewLine(d, r)); });
    box.appendChild(ul);
    return box;
  }
  function replyForm(box, r, label, value) {
    var form = details(box, label);
    n += 1;
    var text = field(form, 'fg-reponse-' + n, 'Votre réponse', 'textarea');
    text.value = value;
    form.appendChild(button('Enregistrer ce texte', function () {
      write(P + 'avis/' + encodeURIComponent(r.reviewId) + '/reponse', { body: text.value }, 'Texte enregistré : relisez-le, puis validez.', 'Le texte n’est pas enregistré.');
    }));
  }
  function reviewLine(d, r) {
    var li = el('li');
    li.appendChild(el('strong', 'Note : ' + r.rating + ' sur 5'));
    li.appendChild(el('p', 'Avis du ' + date(r.reviewedAt), 'doux'));
    li.appendChild(el('p', r.comment === null ? 'Avis sans texte.' : r.comment));
    if (!r.draft) {
      li.appendChild(button('Préparer une réponse', function () {
        write(P + 'avis/' + encodeURIComponent(r.reviewId) + '/brouillon', undefined, 'Réponse préparée : relisez-la, puis validez.', 'La réponse n’est pas préparée.');
      }));
      replyForm(li, r, 'Écrire ma réponse', '');
      return li;
    }
    li.appendChild(draftBlock(d, r.draft));
    if (['a_valider', 'a_envoyer', 'echec'].indexOf(r.draft.state) >= 0) replyForm(li, r, 'Corriger ce texte', r.draft.body);
    return li;
  }

  function renderPosts(d) {
    var box = part('Publications');
    box.appendChild(el('p', 'Tirées de vos biens en vente : une par période au plus, jamais deux fois le même bien, jamais le prix.', 'doux'));
    if (d.location) box.appendChild(button('Préparer la prochaine publication', function () {
      write(P + 'agents/' + encodeURIComponent(d.agentId) + '/publication', undefined, function (r) { return r ? 'Publication préparée : relisez-la, puis validez.' : 'Rien à préparer : aucun bien à publier, ou une publication a déjà été préparée dans la période.'; }, 'La publication n’est pas préparée.');
    }));
    if (!d.publications.length) box.appendChild(el('p', 'Aucune publication préparée.', 'doux'));
    var ul = el('ul', null, 'liste');
    d.publications.forEach(function (p) {
      var li = el('li');
      li.appendChild(draftBlock(d, p));
      ul.appendChild(li);
    });
    box.appendChild(ul);
    return box;
  }

  /* Le texte exact, ligne par ligne, puis son état et les gestes que cet état permet. */
  function draftBlock(d, x) {
    var box = el('div');
    box.appendChild(el('p', ORIGINS[x.origin] || 'Texte', 'doux'));
    x.body.split('\\n').forEach(function (line) { box.appendChild(el('p', line)); });
    if (x.linkUri) box.appendChild(el('p', 'Lien : ' + x.linkUri, 'doux'));
    if (x.validatedAt) box.appendChild(el('p', 'Validé le ' + date(x.validatedAt) + '.', 'doux'));
    box.appendChild(el('p', STATES[x.state] || '', 'etat'));
    if (x.state === 'envoye' && x.ackRef) {
      box.appendChild(el('p', 'Confirmé par Google.', 'doux'));
      var seen = googleLink(x.url);
      if (seen) box.appendChild(seen);
    }
    if (x.state === 'echec' && x.error) box.appendChild(el('p', (ERRORS[x.error] || '') + ' ' + (ACTIONS[x.action] || ''), 'etat'));
    var path = P + 'textes/' + encodeURIComponent(x.draftId);
    if (x.state === 'a_valider') box.appendChild(button('Je l’ai relu : valider', function () {
      write(path + '/valider', undefined, 'Texte validé.', 'Le texte n’est pas validé.');
    }));
    if (x.state === 'a_envoyer' || x.state === 'echec') {
      var label = d.mode === 'reel' ? (x.state === 'echec' ? 'Réessayer l’envoi sur Google' : 'Envoyer sur Google') : 'Noter l’envoi, sans rien faire partir';
      box.appendChild(button(label, function () {
        write(path + '/publier', undefined, function (r) { return r && r.mode === 'reel' ? 'Parti sur Google.' : 'Envoi noté : en essai, rien n’est parti.'; }, 'L’envoi n’a pas abouti.');
      }));
    }
    if (x.state === 'envoi_coupe' && d.canConfigure) box.appendChild(closeButton(path));
    return box;
  }
  /* Clore un envoi coupé peut faire partir le texte deux fois si Google l'a reçu : deux appuis espacés, après avoir regardé. */
  function closeButton(path) {
    var text = 'Clore cet envoi coupé', armedAt = null;
    var b = button(text, function () {
      var now = Date.now();
      if (armedAt !== null && now - armedAt < 1000) return;
      if (armedAt === null || now - armedAt > 15000) {
        armedAt = now;
        b.textContent = 'Confirmer : clore cet envoi coupé';
        state('Regardez d’abord la fiche Google : si le texte y est, ne le renvoyez pas. Appuyez de nouveau pour confirmer.');
        return;
      }
      armedAt = null;
      b.textContent = text;
      write(path + '/liberer', undefined, 'Envoi clos : le texte peut repartir.', 'L’envoi n’est pas clos.');
    });
    return b;
  }
  return { open: open, wipe: wipe };
};
`;
