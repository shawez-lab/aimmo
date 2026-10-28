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
 */
import { appendEvent, SqlJournalStore, type SqlDatabase } from '@aimmo/core';
import { CANDIDATE_EXPERIENCES, CANDIDATE_SOURCES, CANDIDATE_STATUSES, Candidatures, checkRecruitingText } from '../../core/src/reseau/index.ts';

export const CANDIDATURE_PATH = '/rejoindre';
/** La version des textes de la page : elle entre dans la preuve de l'accord, pour savoir ce que le candidat a lu. */
export const CANDIDATURE_PAGE_VERSION = '2026-10-28';
const MAX_FORM_BYTES = 8_000;
const AGENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

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

/** Les textes de la page, en clair : ce qui est contrôlé [R80] est exactement ce qui est publié. */
export const PAGE_TEXT = Object.freeze({
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

const STYLE = `
:root{color-scheme:light dark;--papier:#f4f1ea;--encre:#16202b;--doux:#5a6270;--trait:#d9d3c7;--accent:#1f3a5f;--accent-doux:#e3e8ef;--alerte:#9b1c1c}
@media (prefers-color-scheme:dark){:root{--papier:#12161b;--encre:#ece8e0;--doux:#a7aeb8;--trait:#2b323b;--accent:#9dbbe0;--accent-doux:#1b2533;--alerte:#f2a3a3}}
*{box-sizing:border-box}
html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--papier);color:var(--encre);font:17px/1.6 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:40rem;margin:0 auto;padding:2rem 1rem 4rem}
.marque{font-size:.8rem;letter-spacing:.08em;text-transform:uppercase;color:var(--doux);margin:0 0 2.5rem}
h1,h2{font-family:"Iowan Old Style","Charter","Georgia",serif;font-weight:600;letter-spacing:-.01em}
h1{font-size:2.4rem;line-height:1.1;margin:0 0 1rem}
.chapeau{font-size:1.2rem;line-height:1.5;margin:0 0 2.5rem}
h2{font-size:1.45rem;line-height:1.2;margin:3rem 0 1rem;padding-top:1.2rem;border-top:2px solid var(--encre)}
h2 small{display:block;font:600 .75rem/1.4 system-ui,sans-serif;letter-spacing:.08em;text-transform:uppercase;color:var(--doux);margin-bottom:.3rem}
p{margin:0 0 1rem}
.doux{color:var(--doux);font-size:.95rem}
dl.offre{margin:0}
dl.offre div{display:grid;grid-template-columns:1fr;gap:.15rem;padding:.8rem 0;border-bottom:1px solid var(--trait)}
dl.offre dt{font-weight:600}
dl.offre dd{margin:0;color:var(--doux)}
@media (min-width:36rem){dl.offre div{grid-template-columns:11rem 1fr;gap:1rem}}
table{width:100%;border-collapse:collapse;margin:0 0 1rem}
th,td{text-align:left;padding:.7rem 0;border-bottom:1px solid var(--trait);vertical-align:top}
caption{caption-side:bottom;text-align:left;padding-top:.6rem}
td{text-align:right;font-weight:700;color:var(--accent);white-space:nowrap;padding-left:1rem}
.sans{margin:0;padding:1rem 1.1rem;background:var(--accent-doux);border-left:4px solid var(--accent);list-style:none}
.sans li+li{margin-top:.7rem}
ul.liste{margin:0 0 1rem;padding-left:1.1rem}
ul.liste li+li{margin-top:.4rem}
ol.etapes{counter-reset:e;list-style:none;margin:0;padding:0}
ol.etapes li{counter-increment:e;position:relative;padding:0 0 1.2rem 3rem}
ol.etapes li::before{content:counter(e);position:absolute;left:0;top:0;width:2rem;height:2rem;border:2px solid var(--encre);border-radius:50%;display:flex;align-items:center;justify-content:center;font-weight:700}
ol.etapes strong{display:block}
form{margin-top:1rem}
fieldset{border:0;margin:0 0 1.5rem;padding:0}
legend{font-family:"Iowan Old Style","Charter","Georgia",serif;font-size:1.15rem;font-weight:600;margin-bottom:.6rem;padding:0}
label{display:block;font-weight:600;margin:0 0 .35rem}
.aide{display:block;font-weight:400;color:var(--doux);font-size:.9rem}
input[type=text],input[type=email],input[type=tel],select,textarea{display:block;width:100%;min-height:48px;padding:.7rem .8rem;margin:0 0 1rem;font:inherit;color:inherit;background:transparent;border:1px solid var(--doux);border-radius:.5rem}
textarea{min-height:7rem;resize:vertical}
.case{display:flex;gap:.8rem;align-items:flex-start;font-weight:400;margin:.5rem 0}
.case input{flex:none;width:24px;height:24px;margin:.15rem 0 0}
.piege{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}
button{font:inherit;font-weight:600;min-height:52px;width:100%;padding:.8rem 1.2rem;border:0;border-radius:.5rem;background:var(--accent);color:var(--papier);cursor:pointer}
.erreur{padding:1rem 1.1rem;border:2px solid var(--alerte);border-radius:.5rem;margin:0 0 1.5rem}
.erreur p{margin:0}
[aria-invalid=true]{border-color:var(--alerte);border-width:2px}
a{color:var(--accent)}
:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
`;

function html(status: number, title: string, body: string): Response {
  const doc = `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<meta name="description" content="${escape(PAGE_TEXT.lede)}">
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

type FormValues = Partial<Record<'firstName' | 'lastName' | 'email' | 'phone' | 'town' | 'currentStatus' | 'experience' | 'source' | 'question' | 'parrain', string>> & { consent?: boolean };

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
export function candidaturePage(values: FormValues = {}, error: { message: string; field: keyof FormValues | null } | null = null): string {
  const t = PAGE_TEXT;
  const inv = error?.field ?? null;
  const sponsor = values.parrain && AGENT_ID.test(values.parrain) ? values.parrain : null;
  const select = (name: 'currentStatus' | 'experience' | 'source', label: string, body: string): string =>
    `<label for="${name}">${escape(label)}</label><select id="${name}" name="${name}" required${inv === name ? ' aria-invalid="true" aria-describedby="erreur"' : ''}>${body}</select>`;
  return `<p class="marque">${escape(t.kicker)}</p>
<h1>${escape(t.title)}</h1>
<p class="chapeau">${escape(t.lede)}</p>
<p><a href="#candidater">Déposer ma candidature</a></p>
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
<h2><small>Après votre candidature</small>Quatre étapes, les mêmes pour tous</h2>
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
<button type="submit">Envoyer ma candidature</button>
<p class="doux">${escape(t.privacy)}</p>
</form>`;
}

const thanks = (): Response => html(200, 'Candidature reçue · AIMMO', `<p class="marque">${escape(PAGE_TEXT.kicker)}</p><h1>Merci</h1><p class="chapeau">${escape(PAGE_TEXT.thanks)}</p>`);

export interface CandidatureConfig {
  db: SqlDatabase;
  /** Le réseau qui reçoit les candidatures. Absent : la page dit que les candidatures ne sont pas encore ouvertes. */
  networkId: string | null;
  now?: () => Date;
}

/** La page de candidature, ou `null` si l'adresse n'est pas à elle. */
export async function handleCandidature(request: Request, config: CandidatureConfig): Promise<Response | null> {
  const url = new URL(request.url);
  if (url.pathname !== CANDIDATURE_PATH && url.pathname !== `${CANDIDATURE_PATH}/`) return null;
  const now = config.now ?? (() => new Date());
  const journal = new SqlJournalStore(config.db);
  // Un texte qui promettrait un revenu ferme la page : rien n'est publié sans passer le contrôle [R80].
  const problems = pageProblems();
  if (problems.length > 0) {
    await appendEvent(journal, { type: 'candidature.page_fermee', actor: 'system:candidature', subject: 'page:rejoindre', data: { rule: 'R80', count: problems.length } }, now);
    return html(503, 'Page fermée · AIMMO', '<h1>Page fermée</h1><p>Cette page est en cours de relecture. Revenez bientôt.</p>');
  }
  if (!config.networkId) return html(503, 'Bientôt · AIMMO', `<p class="marque">${escape(PAGE_TEXT.kicker)}</p><h1>Bientôt</h1><p class="chapeau">Les candidatures au réseau ne sont pas encore ouvertes. Revenez bientôt.</p>`);

  if (request.method === 'GET' || request.method === 'HEAD') {
    const parrain = url.searchParams.get('parrain') ?? undefined;
    const res = html(200, 'Rejoindre AIMMO · réseau d’agents immobiliers', candidaturePage(parrain === undefined ? {} : { parrain }));
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
    consent: form.get('consent') === 'oui',
  };
  // Le champ piège, invisible aux personnes : rempli, c'est un robot. Même réponse, rien n'est rangé.
  if ((form.get('site') ?? '') !== '') {
    await appendEvent(journal, { type: 'candidature.robot', actor: 'candidat', subject: `network:${config.networkId}`, data: {} }, now);
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
    // La preuve dit ce que le candidat a coché et sur quelle version de la page : jamais son adresse ni son appareil.
    contactConsent: values.consent ? { given: true, proof: `Case cochée sur la page ${CANDIDATURE_PATH}, version ${CANDIDATURE_PAGE_VERSION}, le ${now().toISOString()}` } : { given: false },
  };
  const outcome = await new Candidatures(config.db, journal, { now }).apply(config.networkId, input);
  if (outcome.ok) return thanks();
  const [message, target] = ERRORS[outcome.code] ?? ['Votre candidature n’a pas pu être rangée. Vérifiez vos réponses et réessayez.', null];
  return html(400, 'À corriger · Rejoindre AIMMO', candidaturePage(values, { message, field: target }));
}
