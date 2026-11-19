/**
 * Les deux étiquettes du DPE sur la page du bien et la fiche imprimable (AU006, M07) [R43].
 *
 * L'audit du 2026-11-18 (A006) relevait que la page et la fiche ne disaient les classes qu'en texte. Les deux supports
 * montrent désormais les deux échelles, énergie et climat, de A à G, en couleur, la classe du bien mise en avant et dite
 * en mots (« ce bien »). Les classes sont lues dans les mentions de la version publiée (`energyClassesOf`), jamais
 * dans la fiche : la page ne peut pas montrer une autre classe que le texte publié. Le dessin et ses couleurs sont
 * dans le système de design (`ETIQUETTES_CSS`) [R201].
 *
 * Décidé, lecture prudente (relecture forte) : aucun seuil chiffré sur les barres. Depuis le 1er juillet 2024, les
 * logements de moins de 40 m² ont d'autres seuils, et la classe énergie est la plus mauvaise de la consommation et des
 * émissions : un chiffre écrit pourrait contredire le diagnostic. La lettre, la couleur et la classe du bien, elles,
 * sont toujours justes. Sans classes dans les mentions (terrain), aucune étiquette.
 */
import type { EnergyClass } from './fiche-bien.ts';
import { ENERGY_CLASSES } from './fiche-bien.ts';
import { energyClassesOf } from './mentions.ts';

function scale(kind: 'energie' | 'climat', current: EnergyClass): string {
  const caption = kind === 'energie' ? `Performance énergétique : classe ${current}` : `Émissions de gaz à effet de serre : classe ${current}`;
  const bars = ENERGY_CLASSES.map((c) => {
    const here = c === current;
    const bar = `<b><i>${c}</i></b>`;
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
