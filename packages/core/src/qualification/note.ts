/**
 * La note d'un contact, de 0 à 100, et sa température (M03, Q02), par un barème fixe écrit ici, sans IA : chaque note
 * a sa raison en une ligne, et le même contact a toujours la même note [R24].
 *
 * Le barème ne lit que la demande : catégorie, bien cité, délai, précision (commune, critères). Il ne lit aucun
 * montant : un montant peut dire le financement, que la note ne doit jamais suivre, ni rien sur la personne [R14, R24].
 */
import type { Category, Deadline, Qualified } from './regles.ts';

export type Temperature = 'cold' | 'warm' | 'hot';

export interface ScoreInput extends Pick<Qualified, 'category' | 'deadline' | 'city' | 'criteria'> {
  propertyRecognized: boolean;
}

export interface Score {
  score: number;
  temperature: Temperature;
  /** La raison, en une ligne, sans donnée personnelle. */
  reason: string;
}

/** Les nombres du barème sont des réglages, pas du code. */
export interface ScoreSettings {
  base: Readonly<Record<Category, number>>;
  property: number;
  deadline: Readonly<Record<Deadline, number>>;
  city: number;
  /** À partir de deux critères. */
  criteria: number;
  /** Seuils : chaud à partir de `hot`, tiède à partir de `warm`. */
  hot: number;
  warm: number;
}

export const DEFAULT_SCORE_SETTINGS: ScoreSettings = Object.freeze({
  base: Object.freeze({ seller: 40, valuation: 35, rent_out: 30, buyer: 25, professional: 25, curious: 5, partner: 0, spam: 0 }),
  property: 20,
  deadline: Object.freeze({ now: 25, within_3_months: 15, within_6_months: 8, within_1_year: 3, later: -10 }),
  city: 5,
  criteria: 5,
  hot: 60,
  warm: 35,
});

const CATEGORY_FR: Record<Category, string> = {
  seller: 'Vendeur',
  valuation: 'Demande d’estimation',
  rent_out: 'Mise en location',
  buyer: 'Acquéreur',
  professional: 'Professionnel',
  curious: 'Simple curiosité',
  partner: 'Partenaire',
  spam: 'Message indésirable',
};

const DEADLINE_FR: Record<Deadline, string> = {
  now: 'délai immédiat',
  within_3_months: 'délai de 3 mois',
  within_6_months: 'délai de 6 mois',
  within_1_year: 'délai d’un an',
  later: 'pas pressé',
};

const TEMPERATURE_FR: Record<Temperature, string> = { hot: 'chaud', warm: 'tiède', cold: 'froid' };

export function scoreContact(input: ScoreInput, settings: ScoreSettings = DEFAULT_SCORE_SETTINGS): Score {
  // Un partenaire ou un message indésirable n'est pas un contact à rappeler : zéro, froid, quoi qu'il dise.
  if (input.category === 'partner' || input.category === 'spam') {
    return { score: 0, temperature: 'cold', reason: `${CATEGORY_FR[input.category]} : 0, froid.` };
  }
  const parts: string[] = [CATEGORY_FR[input.category]];
  let score = settings.base[input.category];
  if (input.propertyRecognized) {
    score += settings.property;
    parts.push('bien cité');
  }
  if (input.deadline) {
    score += settings.deadline[input.deadline];
    parts.push(DEADLINE_FR[input.deadline]);
  }
  if (input.city) {
    score += settings.city;
    parts.push('commune donnée');
  }
  if (input.criteria.length >= 2) {
    score += settings.criteria;
    parts.push('critères précis');
  }
  score = Math.max(0, Math.min(100, score));
  const temperature: Temperature = score >= settings.hot ? 'hot' : score >= settings.warm ? 'warm' : 'cold';
  return { score, temperature, reason: `${parts.join(', ')} : ${score}, ${TEMPERATURE_FR[temperature]}.` };
}
