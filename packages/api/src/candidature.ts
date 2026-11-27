/**
 * La page publique de candidature au réseau (M14, J12), à `/rejoindre`.
 *
 * Une page servie par le Worker, sans script, sans rien d'extérieur. Elle dit ce que l'agent trouve, ce qu'il paie, ce
 * qui l'engage, comment sa candidature est lue, et ce que le réseau ne promet pas : aucun revenu, aucun gain, aucun
 * montant [R80]. Chaque texte de la page passe le contrôle des promesses de revenus au moment où elle est servie : un
 * texte qui échoue ferme la page plutôt que de la publier.
 *
 * Le formulaire range la candidature par la couche métier (J01) : mêmes champs pour tous, aucune note, aucun tri [R81] ;
 * la réponse est la même, que la candidature soit nouvelle ou déjà rangée [R18] ; l'accord d'être recontacté est une
 * case libre, rangée avec sa preuve, et sans elle personne ne recontacte le candidat [R03]. Aucune coordonnée ne va au
 * journal [R13]. Rien n'est envoyé d'ici.
 *
 * Les communes ouvertes au recrutement par la direction (HX68, BR37) sont dites par leur nom seul, triées, sans aucun
 * chiffre ni promesse [R628] ; aucune ouverte, ou une lecture qui échoue : la section n'est pas là, la page sert quand même.
 */
import { appendEvent, DESIGN_CSS, SqlJournalStore, THEME_COLOR, type SqlDatabase } from '@aimmo/core';
import { CANDIDATE_EXPERIENCES, CANDIDATE_SOURCES, CANDIDATE_STATUSES, Candidatures, CommunesAPourvoir, checkRecruitingText } from '../../core/src/reseau/index.ts';

export const CANDIDATURE_PATH = '/rejoindre';
/** La version des textes de la page : elle entre dans la preuve de l'accord, pour savoir ce que le candidat a lu. */
export const CANDIDATURE_PAGE_VERSION = '2026-10-28';
const MAX_FORM_BYTES = 8_000;
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Le code d'un contenu de recrutement (HX64), porté par le lien marqué `?c=` : lettres et chiffres seuls. */
const CONTENT_CODE = /^[A-Za-z0-9]{1,40}$/;

const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";

export const STATUS_LABELS: Readonly<Record<(typeof CANDIDATE_STATUSES)[number], string>> = Object.freeze({
  agent_commercial: 'Agent commercial en immobilier',
  salarie_immobilier: 'Salarié d’une agence immobilière',
  autre_metier: 'Dans un autre métier',
  sans_emploi: 'En recherche d’emploi',
  etudiant: 'Étudiant',
  autre: 'Autre situation',
});
export const EXPERIENCE_LABELS: Readonly<Record<(typeof CANDIDATE_EXPERIENCES)[number], string>> = Object.freeze({
  aucune: 'Aucune pour l’instant',
  moins_de_2_ans: 'Moins de 2 ans',
  de_2_a_5_ans: 'De 2 à 5 ans',
  plus_de_5_ans: 'Plus de 5 ans',
});
export const SOURCE_LABELS: Readonly<Record<(typeof CANDIDATE_SOURCES)[number], string>> = Object.freeze({
  video: 'Une vidéo',
  podcast: 'Un épisode du podcast',
  page: 'Cette page, directement',
  parrain: 'Un agent du réseau',
  autre: 'Autrement',
});

const escape = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const deepFreeze = <T>(value: T): T => {
  if (value && typeof value === 'object') for (const v of Object.values(value)) deepFreeze(v);
  return Object.freeze(value);
};

/** Les textes de la page, en clair : ce qui est contrôlé [R80] est exactement ce qui est publié. */
export const PAGE_TEXT = deepFreeze({
  kicker: 'Réseau d’agents immobiliers · né à Dijon',
  title: 'Rejoindre AIMMO',
  lede: 'Vous signez des mandats et vous accompagnez vos clients. Le réseau prend le reste : les contacts qualifiés, les documents, la diffusion, le suivi jusqu’à l’acte.',
  finds: [
    ['Des clients', 'Vendeurs et acquéreurs déjà qualifiés, transmis avec leur fiche et leur historique, selon votre zone.'],
    ['Un plan du jour', 'Les personnes à rappeler, les rendez-vous, les biens à mettre en vente, dans l’ordre où ils comptent.'],
    ['Les estimations', 'Un avis de valeur préparé à partir des ventes réelles du quartier, que vous vérifiez et présentez.'],
    ['Les documents', 'Mandats, avenants, bons de visite et offres préparés depuis le dossier, signés en ligne, inscrits au registre.'],
    ['La commercialisation', 'Annonce avec ses mentions, page et fiche du bien, photos et vidéo, diffusion.'],
    ['Votre trésorerie', 'Votre commission versée sous 24 h ouvrées après l’encaissement par le réseau.'],
    ['Un référent', 'Une personne à appeler, surtout pendant vos 90 premiers jours, et un binôme pour vos absences.'],
    ['La formation', 'L’académie, des mises en situation, et vos heures de formation obligatoire suivies pour vous.'],
  ] as const,
  pays: [
    ['Pack d’outils', 'Aucun'],
    ['Frais d’entrée', 'Aucun'],
    ['Frais par dossier', 'Aucun'],
    ['Logiciel, signature, studio, estimation', 'Inclus'],
    ['Diffusion sur les portails', 'Incluse'],
  ] as const,
  paysRest: 'Restent à votre charge : vos cotisations, votre assurance si vous ne prenez pas celle proposée par le réseau, vos déplacements et les options que vous choisissez.',
  noPromise: [
    'Aucun chiffre de revenu, ni ici, ni en entretien, ni dans nos vidéos. Personne ne peut vous dire ce que vous vendrez.',
    'La grille des commissions est écrite. Vous la recevez avant de signer, et chaque commission se recompte ligne par ligne dans votre application.',
    'Le réseau vit de la part des commissions sur les ventes conclues, jamais de l’arrivée de nouveaux agents.',
  ] as const,
  engages: [
    'Exercer comme agent commercial immatriculé, avec l’attestation délivrée par le titulaire de la carte et votre propre assurance.',
    'Suivre l’académie au départ, puis la formation continue obligatoire.',
    'Respecter les règles du réseau : mandats, mentions, lutte contre le blanchiment, accords des clients, confidentialité.',
    'Recontacter un client transmis par le réseau dans le délai de la charte de service.',
  ] as const,
  engagesFree: 'Vous restez libre de votre organisation et de vos horaires : la charte porte sur la qualité du service, pas sur votre emploi du temps.',
  trial: [
    ['Aucun frais', 'ni pendant l’essai, ni après : ni pack, ni frais d’entrée, ni frais par dossier.'],
    ['Tout est ouvert', 'l’application, l’académie, les clients transmis selon votre zone.'],
    ['Libre de partir', 'avec un mois de préavis, aux conditions écrites dans votre contrat.'],
  ] as const,
  referral: 'Un agent qui fait venir un autre agent reçoit une prime calculée seulement sur les commissions réellement encaissées par celui qu’il a fait venir. Rien pour une simple arrivée, aucuns frais d’entrée pour la financer.',
  steps: [
    ['Votre candidature', 'Elle est lue dans l’ordre d’arrivée, par une personne. Aucune note, aucun classement automatique.'],
    ['Un entretien', 'Les mêmes questions pour tous, à partir de ce que vous avez déclaré. La décision est prise par une personne nommée, avec sa raison écrite.'],
    ['Votre dossier d’agent', 'Contrat, attestation, immatriculation, assurance : l’application vous dit la pièce suivante. Aucun client avant un dossier complet.'],
    ['Votre premier parcours', 'Un premier contact, un rendez-vous, un avis de valeur, d’abord sur un terrain d’entraînement, sans aucun vrai client.'],
  ] as const,
  consent: 'J’accepte d’être recontacté par l’équipe AIMMO au sujet de ma candidature, par les coordonnées données ici.',
  consentNote: 'Sans cette case, votre candidature est rangée mais personne ne pourra vous répondre. Vous pouvez retirer votre accord à tout moment.',
  privacy: 'Vos réponses servent seulement à étudier votre candidature. Elles ne sont ni vendues ni partagées hors de l’équipe qui recrute.',
  wherePrefix: 'Où nous recrutons',
  whereTitle: 'Les communes ouvertes aujourd’hui',
  whereNote: 'Votre commune n’y est pas ? Candidatez quand même : chaque candidature est lue.',
  thanks: 'Votre candidature est bien arrivée. Une personne de l’équipe la lit, dans l’ordre d’arrivée. Si vous avez accepté d’être recontacté, elle vous répond par les coordonnées données.',
});

/** Tout le texte visible de la page, sans balise : celui que le contrôle des promesses de revenus lit [R80]. */
export function pageTexts(): string[] {
  const t = PAGE_TEXT;
  return [
    t.kicker,
    t.title,
    t.lede,
    ...t.finds.flat(),
    ...t.pays.flat(),
    t.paysRest,
    ...t.noPromise,
    ...t.engages,
    t.engagesFree,
    ...t.trial.flat(),
    t.referral,
    ...t.steps.flat(),
    t.consent,
    t.consentNote,
    t.privacy,
    t.wherePrefix,
    t.whereTitle,
    t.whereNote,
    t.thanks,
    ...Object.values(STATUS_LABELS),
    ...Object.values(EXPERIENCE_LABELS),
    ...Object.values(SOURCE_LABELS),
  ];
}

/** Les textes de la page qui échouent au contrôle [R80]. Vide : la page peut être servie. */
export function pageProblems(): string[] {
  const texts = pageTexts();
  const failing = texts.filter((s) => !checkRecruitingText(s).ok);
  // Le texte entier aussi : une promesse coupée entre deux morceaux ne passe pas.
  if (failing.length === 0 && !checkRecruitingText(texts.join('\n')).ok) return ['page entière'];
  return failing;
}

/** La page suit le système de design d'AIMMO (Z03) : sa base, puis sa mise en page, en jetons seulement [R201]. */
const STYLE = DESIGN_CSS + `
main{max-width:var(--colonne);margin:0 auto;padding:var(--e-5) var(--e-4) var(--e-8)}
main>.marque{margin:0 0 var(--e-4);line-height:1.4;letter-spacing:.12em;font-size:var(--t-xs);align-items:flex-start}
main>.frise{margin:0 0 var(--e-7);border-radius:var(--r-rond)}
h1{margin:0 0 var(--e-4)}
.chapeau{font-size:var(--t-l);line-height:1.5;margin:0 0 var(--e-6)}
h2{margin:var(--e-7) 0 var(--e-4);padding-top:var(--e-4);border-top:2px solid var(--encre)}
h2 small{display:block;font:600 var(--t-xs)/1.4 var(--police-texte);letter-spacing:.12em;text-transform:uppercase;color:var(--accent);margin-bottom:var(--e-1)}
dl.offre{margin:0}
dl.offre div{display:grid;grid-template-columns:1fr;gap:var(--e-1);padding:var(--e-3) 0;border-bottom:1px solid var(--trait)}
dl.offre dt{font-weight:600}
dl.offre dd{margin:0;color:var(--doux)}
@media (min-width:36rem){dl.offre div{grid-template-columns:11rem 1fr;gap:var(--e-4)}}
table{width:100%;border-collapse:collapse;margin:0 0 var(--e-4)}
th,td{text-align:left;padding:var(--e-3) 0;border-bottom:1px solid var(--trait);vertical-align:top}
caption{caption-side:bottom;text-align:left;padding-top:var(--e-2)}
td{text-align:right;font:600 var(--t-l)/1.2 var(--police-titre);color:var(--accent);white-space:nowrap;padding-left:var(--e-4);font-variant-numeric:tabular-nums lining-nums}
.sans{margin:0;padding:var(--e-4) var(--e-4);background:var(--accent-doux);border-radius:var(--r-m);box-shadow:inset 4px 0 0 var(--accent);list-style:none}
.sans li+li{margin-top:var(--e-3)}
ul.liste{margin:0 0 var(--e-4);padding-left:var(--e-5)}
ul.liste li+li{margin-top:var(--e-2)}
ul.communes{list-style:none;margin:0 0 var(--e-3);padding:0;display:flex;flex-wrap:wrap;gap:var(--e-2)}
ul.communes li{padding:var(--e-1) var(--e-3);border:1px solid var(--trait);border-radius:var(--r-rond)}
ol.etapes{counter-reset:e;list-style:none;margin:0;padding:0}
ol.etapes li{counter-increment:e;position:relative;padding:0 0 var(--e-5) var(--e-7)}
ol.etapes li::before{content:counter(e);position:absolute;left:0;top:0;width:32px;height:32px;background:var(--moutarde);color:var(--sur-moutarde);transform:rotate(45deg);border-radius:var(--r-s);display:flex;align-items:center;justify-content:center;font-weight:700}
ol.etapes strong{display:block}
form{margin-top:var(--e-4)}
fieldset{margin:0 0 var(--e-5)}
legend{font:600 var(--t-l)/1.2 var(--police-titre);margin-bottom:var(--e-2)}
label{margin:var(--e-3) 0 var(--e-2)}
.aide{display:block;font-weight:400;color:var(--doux);font-size:var(--t-s)}
.case{align-items:flex-start}
.case input{margin-top:2px}
.piege{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
form button[type=submit]{width:100%;min-height:56px;margin-top:var(--e-4)}
.erreur{padding:var(--e-4);border-radius:var(--r-m);background:var(--danger-doux);box-shadow:inset 4px 0 0 var(--danger);margin:0 0 var(--e-5)}
.erreur p{margin:0}
[aria-invalid=true]{border-color:var(--danger);border-width:2px}
`;

function html(status: number, title: string, body: string): Response {
  const doc = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="description" content="${escape(PAGE_TEXT.lede)}">
<meta name="theme-color" content="${THEME_COLOR}">
<title>${escape(title)}</title>
<style>${STYLE}</style>
</head>
<body><main>${body}</main></body>
</html>`;
  return new Response(doc, {
    status,
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': CSP,
      'cache-control': 'no-store',
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    },
  });
}

type FormValues = { [K in 'firstName' | 'lastName' | 'email' | 'phone' | 'town' | 'currentStatus' | 'experience' | 'source' | 'question' | 'parrain' | 'contenu']?: string | undefined } & { consent?: boolean };

/** Le message d'un refus de la couche métier, et le champ qu'il vise. */
const ERRORS: Readonly<Record<string, [string, keyof FormValues | null]>> = Object.freeze({
  bad_first_name: ['Indiquez votre prénom (60 caractères au plus).', 'firstName'],
  bad_last_name: ['Votre nom tient en 60 caractères.', 'lastName'],
  bad_town: ['Votre ville tient en 80 caractères.', 'town'],
  bad_question: ['Votre question tient en 1 000 caractères.', 'question'],
  bad_status: ['Choisissez votre situation actuelle.', 'currentStatus'],
  bad_experience: ['Choisissez votre expérience de l’immobilier.', 'experience'],
  bad_source: ['Dites-nous comment vous nous avez connus.', 'source'],
  bad_email: ['Cette adresse mail n’est pas lisible.', 'email'],
  bad_phone: ['Ce numéro de téléphone n’est pas lisible.', 'phone'],
  no_contact: ['Laissez au moins une adresse mail ou un numéro de téléphone.', 'email'],
});

function options<K extends string>(labels: Readonly<Record<K, string>>, keys: readonly K[], selected: string | undefined, placeholder: string): string {
  const head = `<option value=""${selected ? '' : ' selected'}>${escape(placeholder)}</option>`;
  return head + keys.map((k) => `<option value="${k}"${selected === k ? ' selected' : ''}>${escape(labels[k])}</option>`).join('');
}

function field(name: keyof FormValues, label: string, type: 'text' | 'email' | 'tel', values: FormValues, invalid: keyof FormValues | null, extra = ''): string {
  const v = values[name];
  const bad = invalid === name;
  return `<label for="${name}">${escape(label)}</label><input id="${name}" name="${name}" type="${type}"${extra}${typeof v === 'string' && v !== '' ? ` value="${escape(v)}"` : ''}${bad ? ' aria-invalid="true" aria-describedby="erreur"' : ''}>`;
}

/** La page entière : l'offre, puis le formulaire, avec les valeurs saisies et l'erreur à corriger s'il y en a une. */
export function candidaturePage(values: FormValues = {}, error: { message: string; field: keyof FormValues | null } | null = null, communes: readonly string[] = []): string {
  const t = PAGE_TEXT;
  const inv = error?.field ?? null;
  const sponsor = values.parrain && AGENT_ID.test(values.parrain) ? values.parrain : null;
  const content = values.contenu && CONTENT_CODE.test(values.contenu) ? values.contenu : null;
  const select = (name: 'currentStatus' | 'experience' | 'source', label: string, body: string): string =>
    `<label for="${name}">${escape(label)}</label><select id="${name}" name="${name}" required${inv === name ? ' aria-invalid="true" aria-describedby="erreur"' : ''}>${body}</select>`;
  return `<p class="marque">${escape(t.kicker)}</p><div class="frise" aria-hidden="true"></div>
<h1>${escape(t.title)}</h1>
<p class="chapeau">${escape(t.lede)}</p>
<p><a class="lien" href="#candidater">Déposer ma candidature</a></p>
<h2><small>Ce que vous trouvez</small>Le métier, sans l’administratif</h2>
<dl class="offre">${t.finds.map(([k, v]) => `<div><dt>${escape(k)}</dt><dd>${escape(v)}</dd></div>`).join('')}</dl>
<h2><small>Ce que vous payez</small>Rien pour travailler avec le système</h2>
<table><caption class="doux">${escape(t.paysRest)}</caption><tbody>${t.pays.map(([k, v]) => `<tr><th scope="row">${escape(k)}</th><td>${escape(v)}</td></tr>`).join('')}</tbody></table>
<h2><small>Ce que nous ne promettons pas</small>Aucun chiffre de revenu</h2>
<ul class="sans">${t.noPromise.map((p) => `<li>${escape(p)}</li>`).join('')}</ul>
<h2><small>Ce qui vous engage</small>Un métier réglementé, exercé proprement</h2>
<ul class="liste">${t.engages.map((p) => `<li>${escape(p)}</li>`).join('')}</ul>
<p class="doux">${escape(t.engagesFree)}</p>
<h2><small>L’essai de 30 jours</small>Voir avant de s’engager</h2>
<dl class="offre">${t.trial.map(([k, v]) => `<div><dt>${escape(k)}</dt><dd>${escape(v)}</dd></div>`).join('')}</dl>
<h2><small>Le parrainage</small>Dans les règles</h2>
<p>${escape(t.referral)}</p>
${communes.length > 0 ? `<h2><small>${escape(t.wherePrefix)}</small>${escape(t.whereTitle)}</h2>
<ul class="communes">${communes.map((c) => `<li>${escape(c)}</li>`).join('')}</ul>
<p class="doux">${escape(t.whereNote)}</p>
` : ''}<h2><small>Après votre candidature</small>Quatre étapes, les mêmes pour tous</h2>
<ol class="etapes">${t.steps.map(([k, v]) => `<li><strong>${escape(k)}</strong>${escape(v)}</li>`).join('')}</ol>
<h2 id="candidater"><small>Candidater</small>Quelques réponses, deux minutes</h2>
${error ? `<div class="erreur" id="erreur" role="alert"><p>${escape(error.message)}</p></div>` : ''}
<form method="post" action="${CANDIDATURE_PATH}" novalidate>
<fieldset><legend>Vous</legend>
${field('firstName', 'Prénom', 'text', values, inv, ' required maxlength="60" autocomplete="given-name"')}
${field('lastName', 'Nom (si vous le souhaitez)', 'text', values, inv, ' maxlength="60" autocomplete="family-name"')}
${field('town', 'Ville où vous aimeriez exercer', 'text', values, inv, ' maxlength="80" autocomplete="address-level2"')}
</fieldset>
<fieldset><legend>Pour vous répondre</legend>
<p class="doux">Une adresse mail ou un numéro de téléphone, au moins.</p>
${field('email', 'Adresse mail', 'email', values, inv, ' maxlength="254" autocomplete="email" inputmode="email"')}
${field('phone', 'Téléphone', 'tel', values, inv, ' maxlength="30" autocomplete="tel" inputmode="tel"')}
</fieldset>
<fieldset><legend>Votre parcours</legend>
${select('currentStatus', 'Votre situation aujourd’hui', options(STATUS_LABELS, CANDIDATE_STATUSES, values.currentStatus, 'Choisir'))}
${select('experience', 'Votre expérience de l’immobilier', options(EXPERIENCE_LABELS, CANDIDATE_EXPERIENCES, values.experience, 'Choisir'))}
${select('source', 'Comment nous avez-vous connus ?', options(SOURCE_LABELS, CANDIDATE_SOURCES, values.source, 'Choisir'))}
<label for="question">Une question ? <span class="aide">Facultatif. Une personne de l’équipe vous répond.</span></label>
<textarea id="question" name="question" maxlength="1000"${inv === 'question' ? ' aria-invalid="true" aria-describedby="erreur"' : ''}>${escape(values.question ?? '')}</textarea>
</fieldset>
<fieldset><legend>Votre accord</legend>
<label class="case" for="consent"><input id="consent" name="consent" type="checkbox" value="oui"${values.consent ? ' checked' : ''}><span>${escape(t.consent)}</span></label>
<p class="doux">${escape(t.consentNote)}</p>
</fieldset>
<div class="piege" aria-hidden="true"><label for="site">Ne pas remplir</label><input id="site" name="site" type="text" tabindex="-1" autocomplete="off"></div>
${sponsor ? `<input type="hidden" name="parrain" value="${escape(sponsor)}">` : ''}
${content ? `<input type="hidden" name="contenu" value="${escape(content)}">` : ''}
<button type="submit">Envoyer ma candidature</button>
<p class="doux">${escape(t.privacy)}</p>
</form>`;
}

const thanks = (): Response => html(200, 'Candidature reçue · AIMMO', `<p class="marque">${escape(PAGE_TEXT.kicker)}</p><div class="frise" aria-hidden="true"></div><h1>Merci</h1><p class="chapeau">${escape(PAGE_TEXT.thanks)}</p>`);

export interface CandidatureConfig {
  db: SqlDatabase;
  /** Le réseau qui reçoit les candidatures. Absent : le seul réseau de la base s'il n'y en a qu'un (AU022), sinon la page dit que les candidatures ne sont pas encore ouvertes. */
  networkId: string | null;
  now?: () => Date;
  /** Le contrôle des textes avant de servir la page [R80] ; remplacé seulement par les tests. */
  problems?: () => string[];
}

/**
 * Les communes ouvertes au recrutement du réseau, par leur nom seul [R628]. Une lecture qui échoue est écrite au journal
 * et rend une liste vide : la page de candidature ne tombe jamais pour elle.
 */
async function openCommunes(db: SqlDatabase, networkId: string, now: () => Date): Promise<string[]> {
  const journal = new SqlJournalStore(db);
  try {
    return await new CommunesAPourvoir(db, journal, { now }).openCommunes(networkId);
  } catch (error) {
    // La panne est dite, sans rien de personnel, au journal ; si le journal échoue aussi, à la console. Jamais elle
    // n'empêche la page de servir.
    const name = error instanceof Error ? error.name : 'Error';
    try {
      await appendEvent(journal, { type: 'candidature.communes_illisibles', actor: 'system:candidature', subject: `network:${networkId}`, data: { rule: 'R628', error: name } }, now);
    } catch {
      console.error('candidature : communes ouvertes illisibles, journal indisponible', name);
    }
    return [];
  }
}

/** La page de candidature, ou `null` si l'adresse n'est pas à elle. */
export async function handleCandidature(request: Request, config: CandidatureConfig): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== CANDIDATURE_PATH && url.pathname !== `${CANDIDATURE_PATH}/`) return null;
  const now = config.now ?? (() => new Date());
  const journal = new SqlJournalStore(config.db);
  // Un texte qui promettrait un revenu ferme la page : rien n'est publié sans passer le contrôle [R80].
  const problems = (config.problems ?? pageProblems)();
  if (problems.length > 0) {
    await appendEvent(journal, { type: 'candidature.page_fermee', actor: 'system:candidature', subject: 'page:rejoindre', data: { rule: 'R80', count: problems.length } }, now);
    return html(503, 'Page fermée · AIMMO', '<h1>Page fermée</h1><p>Cette page est en cours de relecture. Revenez bientôt.</p>');
  }
  // Sans variable réglée, la page ne devine que s'il n'y a qu'un réseau : c'est lui qui reçoit (AU022). Aucun ou
  // plusieurs réseaux : rien n'est rangé, la page le dit.
  let networkId = config.networkId;
  if (!networkId) {
    // Une base illisible laisse la page fermée : elle ne range rien, et ne tombe pas.
    let rows: { id: string }[] = [];
    try {
      rows = await config.db.all<{ id: string }>('SELECT id FROM networks ORDER BY id LIMIT 2');
    } catch {
      rows = [];
    }
    if (rows.length === 1) {
      networkId = rows[0]!.id;
      if (request.method === 'POST') await appendEvent(journal, { type: 'candidature.reseau_unique', actor: 'system:candidature', subject: `network:${networkId}`, data: {} }, now);
    }
  }
  if (!networkId) return html(503, 'Bientôt · AIMMO', `<p class="marque">${escape(PAGE_TEXT.kicker)}</p><div class="frise" aria-hidden="true"></div><h1>Bientôt</h1><p class="chapeau">Les candidatures au réseau ne sont pas encore ouvertes. Revenez bientôt.</p>`);

  if (request.method === 'GET' || request.method === 'HEAD') {
    const parrain = url.searchParams.get('parrain') ?? undefined;
    // Le lien marqué d'une vidéo ou d'un épisode (HX64) : le code suit le formulaire, sans rien changer pour le candidat.
    const contenu = url.searchParams.get('c') ?? undefined;
    const values: FormValues = {};
    if (parrain !== undefined) values.parrain = parrain;
    if (contenu !== undefined) values.contenu = contenu;
    const res = html(200, 'Rejoindre AIMMO · réseau d’agents immobiliers', candidaturePage(values, null, await openCommunes(config.db, networkId, now)));
    return request.method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res;
  }
  if (request.method !== 'POST') return html(405, 'Méthode non admise · AIMMO', '<h1>Méthode non admise</h1><p>Utilisez le formulaire de la page.</p>');
  if (!(request.headers.get('content-type') ?? '').toLowerCase().startsWith('application/x-www-form-urlencoded')) {
    return html(400, 'Formulaire illisible · AIMMO', `<h1>Formulaire illisible</h1><p><a href="${CANDIDATURE_PATH}">Revenez à la page</a> et utilisez son bouton.</p>`);
  }
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_FORM_BYTES) return html(413, 'Trop long · AIMMO', `<h1>Réponse trop longue</h1><p><a href="${CANDIDATURE_PATH}">Revenez à la page</a> : une question tient en 1 000 caractères.</p>`);
  const form = new URLSearchParams(text);
  const get = (k: string): string | undefined => {
    const v = form.get(k);
    return v === null ? undefined : v;
  };
  const values: FormValues = {
    firstName: get('firstName'),
    lastName: get('lastName'),
    email: get('email'),
    phone: get('phone'),
    town: get('town'),
    currentStatus: get('currentStatus'),
    experience: get('experience'),
    source: get('source'),
    question: get('question'),
    parrain: get('parrain'),
    contenu: get('contenu'),
    consent: form.get('consent') === 'oui',
  };
  // Le champ piège, invisible aux personnes : rempli, c'est un robot. Même réponse, rien n'est rangé.
  if ((form.get('site') ?? '') !== '') {
    await appendEvent(journal, { type: 'candidature.robot', actor: 'candidat', subject: `network:${networkId}`, data: {} }, now);
    return thanks();
  }
  const blank = (v: string | undefined): string | null => (v === undefined || v.trim() === '' ? null : v);
  const input: Record<string, unknown> = {
    firstName: values.firstName ?? '',
    lastName: blank(values.lastName),
    email: blank(values.email),
    phone: blank(values.phone),
    town: blank(values.town),
    currentStatus: values.currentStatus,
    experience: values.experience,
    source: values.source,
    question: blank(values.question),
    sponsorAgentId: values.parrain && AGENT_ID.test(values.parrain) ? values.parrain : null,
    // Un code inconnu, retiré ou abîmé est ignoré par la couche métier : la réponse au candidat reste la même [R621].
    contentCode: values.contenu && CONTENT_CODE.test(values.contenu) ? values.contenu : null,
    // La preuve dit ce que le candidat a coché et sur quelle version de la page : jamais son adresse ni son appareil.
    contactConsent: values.consent ? { given: true, proof: `Case cochée sur la page ${CANDIDATURE_PATH}, version ${CANDIDATURE_PAGE_VERSION}, le ${now().toISOString()}` } : { given: false },
  };
  const outcome = await new Candidatures(config.db, journal, { now }).apply(networkId, input);
  if (outcome.ok) return thanks();
  const [message, target] = ERRORS[outcome.code] ?? ['Votre candidature n’a pas pu être rangée. Vérifiez vos réponses et réessayez.', null];
  return html(400, 'À corriger · Rejoindre AIMMO', candidaturePage(values, { message, field: target }, await openCommunes(config.db, networkId, now)));
}
