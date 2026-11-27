/**
 * La page d'estimation en ligne d'un site (RS04), à `/estimation`, sans script : un formulaire servi par le Worker.
 *
 * La fourchette est celle de E05, jamais une autre [R10] : cette page ne calcule rien, elle montre ce que rend
 * `EstimationEnLigne`. Sans visite, seule la fourchette de la commune, jamais le prix d'un bien : aucun champ de surface ni
 * d'adresse n'existe [R31]. Rien n'est gardé de la demande et personne n'est recontacté : le visiteur choisit lui-même
 * de prendre rendez-vous, aucune coordonnée n'est demandée, donc aucun accord n'a à l'être [R03].
 */
import { euros } from '../annonces/mentions.ts';
import { THEME_COLOR } from '../design/systeme.ts';
import { escapeHtml } from '../documents/modeles.ts';
import type { CommuneResult } from '../estimation/en-ligne.ts';
import { SITE_CSS } from './liste-biens.ts';

export type EstimationFormError = 'invalid_postal_code' | 'invalid_town' | 'invalid_kind' | 'invalid_form' | 'too_many_requests' | 'unavailable';
const ERRORS: Record<EstimationFormError, string> = {
  invalid_postal_code: 'Indiquez le code postal, en 5 chiffres.',
  invalid_town: 'Indiquez le nom de la commune, sans chiffre.',
  invalid_kind: 'Choisissez appartement ou maison.',
  invalid_form: 'Votre demande n’a pas pu être lue. Merci de recommencer.',
  too_many_requests: 'Trop de demandes pour le moment. Réessayez dans une heure.',
  unavailable: 'L’estimation ne répond pas en ce moment. Réessayez un peu plus tard, ou prenez rendez-vous ci-dessous.',
};

const REASONS: Record<Extract<CommuneResult, { ok: false }>['reason'], string> = {
  commune_introuvable: 'Nous ne trouvons pas cette commune avec ce code postal. Vérifiez les deux.',
  hors_zone: 'Nos données de ventes ne couvrent pas encore ce département.',
  dvf_non_couvert: 'Les ventes publiées par l’État ne couvrent pas ce département.',
  donnees_absentes: 'Les données de ventes sont incomplètes en ce moment. Nous préférons ne rien dire plutôt que dire faux.',
  peu_de_ventes: 'Trop peu de ventes dans cette commune pour donner une fourchette sûre.',
};

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
const month = (m: string): string => `${MONTHS[Number(m.slice(5, 7)) - 1] ?? ''} ${m.slice(0, 4)}`.trim();
const day = (d: string): string => `${Number(d.slice(8, 10))} ${month(d)}`;
const perM2 = (n: number): string => `${euros(n)}/m²`;

const CSS =
  SITE_CSS +
  'main>*{max-width:38rem}.types{border:0;margin:var(--e-4) 0 0;padding:0}.types legend{font-weight:600;padding:0}.types label{display:flex;align-items:center;gap:var(--e-2);margin:var(--e-2) 0;font-weight:400}' +
  '.reponse{background:var(--surface);border-radius:var(--r-m);padding:var(--e-4);margin:var(--e-5) 0}.reponse strong{display:block;font-size:var(--t-l)}';

export interface EstimationPageInput {
  /** L'identifiant opaque de cette visite, seule base de la limite par visiteur ; il ne dit rien du visiteur. */
  visitorId: string;
  /** Les données de ventes ne sont pas branchées : la page le dit, sans formulaire. */
  open: boolean;
  /** Le chemin où prendre rendez-vous avec un agent immobilier. */
  appointmentHref: string;
  values?: { postalCode: string; town: string; kind: string };
  error?: EstimationFormError;
  result?: CommuneResult;
}

function answer(result: CommuneResult): string {
  if (!result.ok) return `<section class="reponse" aria-live="polite"><p>${escapeHtml(REASONS[result.reason])}</p></section>`;
  const v = result.value;
  const what = v.kind === 'house' ? 'les maisons' : 'les appartements';
  return (
    `<section class="reponse" aria-live="polite"><h2>${escapeHtml(v.town)}, ${what}</h2>` +
    `<strong>De ${perM2(v.perM2.low)} à ${perM2(v.perM2.high)}</strong><p>La moitié des ventes se situe dans cette fourchette. Prix médian : ${perM2(v.perM2.median)}.</p>` +
    `<p class="doux">Sur ${v.sales} ventes de la commune, de ${month(v.period.from)} à ${month(v.period.to)}. Source : ${escapeHtml(v.data.source)}, dernière vente connue le ${escapeHtml(day(v.data.lastSale))}.${v.data.recentMissing ? ' Les ventes des derniers mois ne sont pas encore publiées.' : ''}</p>` +
    `<p>Ce n’est pas le prix de votre logement : sans visite, personne ne peut le dire.</p></section>`
  );
}

export function renderEstimationPage(input: EstimationPageInput): string {
  const { values } = input;
  const checked = (kind: string): string => (values?.kind === kind ? ' checked' : '');
  const form =
    `<form method="post" action="/estimation"><input type="hidden" name="visitorId" value="${escapeHtml(input.visitorId)}">` +
    `<label for="cp">Code postal</label><input id="cp" name="postalCode" inputmode="numeric" autocomplete="postal-code" maxlength="5" required value="${escapeHtml(values?.postalCode ?? '')}">` +
    `<label for="commune">Commune</label><input id="commune" name="town" autocomplete="address-level2" maxlength="80" required value="${escapeHtml(values?.town ?? '')}">` +
    `<fieldset class="types"><legend>Type de logement</legend><label><input type="radio" name="kind" value="appartement" required${checked('appartement')}> Appartement</label><label><input type="radio" name="kind" value="maison"${checked('maison')}> Maison</label></fieldset>` +
    `<button type="submit">Voir la fourchette</button></form><p class="doux">Rien de ce que vous indiquez ici n’est gardé, et personne ne vous recontactera : aucune coordonnée n’est demandée.</p>`;
  const closed = '<p>L’estimation en ligne n’est pas encore ouverte.</p>';
  return (
    `<!doctype html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="referrer" content="no-referrer"><meta name="robots" content="index"><meta name="theme-color" content="${THEME_COLOR}"><title>Estimer mon logement</title><style>${CSS}</style></head>` +
    `<body><header class="tete"><p class="marque">AIMMO</p><a class="lien" href="/">Accueil</a></header><div class="frise" aria-hidden="true"></div><main><h1>Estimer mon logement</h1>` +
    `<p>La fourchette des prix au mètre carré dans votre commune, d’après les ventes réelles.</p>` +
    (input.error ? `<p class="reponse" role="alert">${escapeHtml(ERRORS[input.error])}</p>` : '') +
    (input.result ? answer(input.result) : '') +
    (input.open ? form : closed) +
    `<h2>Le prix de votre logement</h2><p>Chaque bien est différent : étage, état, vue, extérieur. Un agent immobilier peut venir voir le vôtre. C’est offert.</p><a class="appel" href="${escapeHtml(input.appointmentHref)}">Prendre rendez-vous avec un agent immobilier</a></main></body></html>`
  );
}
