/**
 * Les deux étiquettes du DPE sur la page du bien et la fiche imprimable (AU006, M07) [R43].
 *
 * L'audit du 2026-11-18 (A006) relevait que la page et la fiche ne disaient les classes qu'en texte. Les deux supports
 * montrent désormais les deux échelles, énergie et climat, de A à G, en couleur, la classe du bien mise en avant et dite
 * en mots (« ce bien »). Les classes sont lues dans les mentions de la version publiée (`energyClassesOf`), jamais
 * dans la fiche : la page ne peut pas montrer une autre classe que le texte publié. Le dessin et ses couleurs sont
 * dans le système de design (`ETIQUETTES_CSS`) [R201].
 *
 * Décidé, lecture prudente : les seuils écrits sur les barres sont ceux de l'arrêté du 31 mars 2021 (modèle du DPE
 * en vigueur) ; un diagnostic valable aujourd'hui date au plus tôt du 1er juillet 2021 [R45], c'est donc toujours ce
 * modèle. Sans classes dans les mentions (terrain), aucune étiquette.
 */
import type { EnergyClass } from './fiche-bien.ts';
import { ENERGY_CLASSES } from './fiche-bien.ts';
import { energyClassesOf } from './mentions.ts';

const NNBSP = ' ';
const SEUILS = {
  energie: ['≤ 70', '71 à 110', '111 à 180', '181 à 250', '251 à 330', '331 à 420', '> 420'],
  climat: ['≤ 6', '7 à 11', '12 à 30', '31 à 50', '51 à 70', '71 à 100', '> 100'],
} as const;

function scale(kind: 'energie' | 'climat', current: EnergyClass): string {
  const caption =
    kind === 'energie'
      ? `Performance énergétique : classe ${current}<span>consommation en kWh/m²/an</span>`
      : `Émissions de gaz à effet de serre : classe ${current}<span>en kg CO₂/m²/an</span>`;
  const bars = ENERGY_CLASSES.map((c, i) => {
    const here = c === current;
    const bar = `<b>${SEUILS[kind][i]!.replace(/ /g, NNBSP)}<i>${c}</i></b>`;
    return here ? `<li class="ce-bien" aria-current="true">${bar}<strong>◂ ce bien</strong></li>` : `<li>${bar}</li>`;
  });
  return `<figure class="etiquette ${kind}"><figcaption>${caption}</figcaption><ol class="echelle">${bars.join('')}</ol></figure>`;
}

/** Les deux étiquettes tirées des mentions publiées, ou une chaîne vide sans classes. */
export function energyLabels(mentions: string | null): string {
  const classes = energyClassesOf(mentions);
  if (!classes) return '';
  return `<section class="etiquettes" aria-label="Étiquettes énergie et climat">${scale('energie', classes.energy)}${scale('climat', classes.climate)}</section>`;
}
