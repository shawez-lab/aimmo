/**
 * La grille publiée d'un programme neuf, en page publique du site du réseau (BR76) [R543, R544, R10].
 *
 * La page ne montre que ce que `ProgrammesNeufs.publishedGrid` rend : les lots disponibles confirmés depuis 14 jours au
 * plus, sans aucune donnée personnelle. Chaque frais porte sa source et sa date ; sans barème, aucun frais n'est écrit et
 * la page le dit. Aucun identifiant interne de barème n'est montré. Tout texte venu de la base est échappé.
 */
import type { LotTypology, PublishedGrid, PublishedLot } from './neuf.ts';

const esc = (t: string): string => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
const group = (n: number): string => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');

/** Un montant en euros, sans centimes quand il tombe juste : « 250 000 € ». */
export function eurosOf(cents: number): string {
  const sign = cents < 0 ? '−' : '';
  const a = Math.abs(cents);
  const whole = group(Math.floor(a / 100));
  return a % 100 === 0 ? `${sign}${whole} €` : `${sign}${whole},${String(a % 100).padStart(2, '0')} €`;
}

/** Une surface en centièmes de mètre carré : « 65 m² », « 65,5 m² ». */
export function areaOf(hundredths: number): string {
  const whole = group(Math.floor(hundredths / 100));
  const rest = hundredths % 100;
  if (rest === 0) return `${whole} m²`;
  return `${whole},${String(rest).padStart(2, '0').replace(/0$/, '')} m²`;
}

export function floorOf(floor: number): string {
  if (floor === 0) return 'Rez-de-chaussée';
  if (floor < 0) return `Sous-sol ${-floor}`;
  return floor === 1 ? '1er étage' : `${floor}e étage`;
}

const TYPOLOGY: Record<LotTypology, string> = { studio: 'Studio', t1: 'T1', t2: 'T2', t3: 'T3', t4: 'T4', t5: 'T5', t6: 'T6', maison: 'Maison', local: 'Local' };

const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];
/** Un jour `AAAA-MM-JJ` en toutes lettres : « 1er mars 2027 ». */
export function dayOf(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  return `${d === 1 ? '1er' : d} ${MONTHS[m - 1]} ${y}`;
}

/** La source d'un barème, sans son identifiant interne : `bareme:<id> · <source>` devient `<source>`. */
export function sourceText(source: string): string {
  return source.replace(/^bareme:[^ ]+ · /, '');
}

function feesLines(l: PublishedLot): string {
  if (!l.fees) return '<li>Frais d’acquisition : non calculés, barème absent</li>';
  return `<li>Frais d’acquisition : ${eurosOf(l.fees.newFees.value)}</li><li>Économie face à l’ancien, au même prix : ${eurosOf(l.fees.saving.value)}</li>`;
}

/** Les barèmes cités sous la grille : une seule fois chacun, avec leur date. */
function sources(lots: readonly PublishedLot[]): string {
  const withFees = lots.filter((l) => l.fees);
  if (withFees.length === 0) return '';
  const seen = new Map<string, string>();
  for (const l of withFees) {
    for (const [label, f] of [['du neuf', l.fees!.newFees], ['de l’ancien', l.fees!.oldFees]] as const) {
      const key = `${label}|${f.source}|${f.asOf}`;
      if (!seen.has(key)) seen.set(key, `<li>Barème ${label} : ${esc(sourceText(f.source))}, en vigueur depuis le ${esc(dayOf(f.asOf))}.</li>`);
    }
  }
  return `<h2>D’où viennent les frais</h2><p>Les frais d’acquisition sont calculés sur le prix du lot, avec le barème du neuf ; l’écart compare au barème de l’ancien, au même prix.</p><ul>${[...seen.values()].join('')}</ul>`;
}

export interface NewBuildPageInput {
  grid: PublishedGrid;
  /** Le lien de contact : la page de l'agent du programme si elle est publiable, sinon la liste des agents. */
  contactHref: string;
}

/** Le titre et le corps de la page publique de la grille. */
export function renderNewBuildGrid(input: NewBuildPageInput): { title: string; body: string } {
  const { grid } = input;
  const title = `${grid.name}, programme neuf à ${grid.city}`;
  const intro =
    `<p>${esc(grid.postalCode)} ${esc(grid.city)} · promoteur ${esc(grid.promoter)}.</p>` +
    `<p>Les lots ci-dessous sont disponibles et confirmés par le promoteur depuis 14 jours au plus. Grille lue le ${esc(dayOf(grid.day))}.</p>`;
  // Un lot par bloc, lisible sur un téléphone d'abord : aucune grille large à faire défiler.
  const lots = grid.lots
    .map(
      (l) =>
        `<section><h2>Lot ${esc(l.lotRef)} · ${TYPOLOGY[l.typology]}, ${areaOf(l.livingAreaHundredths)}, ${floorOf(l.floor).toLowerCase()}</h2>` +
        `<p><strong>${eurosOf(l.priceCents)}</strong></p><ul>${feesLines(l)}<li>Confirmé le ${esc(dayOf(l.confirmedOn))}</li></ul></section>`,
    )
    .join('');
  const table = lots || '<p>Aucun lot n’est disponible et confirmé en ce moment.</p>';
  const noScale = grid.lots.length > 0 && grid.lots.every((l) => !l.fees) ? '<p>Les frais ne sont pas calculés : le barème n’est pas encore rangé.</p>' : '';
  const contact = `<p><a href="${esc(input.contactHref)}">Parler de ce programme à un agent</a></p>`;
  const notice = '<p class="doux">Prix et disponibilités donnés par le promoteur, sous réserve de la vente des lots. Les frais sont une estimation, pas une offre.</p>';
  return { title, body: intro + table + noScale + sources(grid.lots) + contact + notice };
}
