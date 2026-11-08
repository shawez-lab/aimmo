/**
 * L'employeur d'un candidat ou de son garant, vérifié (HX47) [R532].
 *
 * Deux contrôles, dans cet ordre : la clé du numéro SIRET (algorithme de Luhn, avec l'exception publiée de La Poste),
 * vérifiable sans réseau ; puis l'existence de l'établissement au répertoire Sirene de l'INSEE (port `CompanyRegistry`),
 * ouvert ou fermé, et depuis quand.
 *
 * Décidé, lecture prudente : un registre injoignable rend « non vérifiable » ; un établissement inconnu ou fermé avant la
 * date de la pièce est un écart, à voir avec le candidat, jamais une conclusion sur la personne.
 */

/** SIREN de La Poste : ses SIRET suivent une autre clé (somme des chiffres multiple de 5). */
const LA_POSTE = '356000000';

export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** Un numéro SIRET de 14 chiffres dont la clé est juste ; les espaces sont permis. */
export function siretKeyValid(raw: unknown): boolean {
  if (typeof raw !== 'string') return false;
  const siret = raw.replace(/\s+/g, '');
  if (!/^\d{14}$/.test(siret)) return false;
  if (!luhnValid(siret.slice(0, 9))) return false;
  if (siret.startsWith(LA_POSTE)) return [...siret].reduce((s, c) => s + Number(c), 0) % 5 === 0;
  return luhnValid(siret);
}

export type RegistryAnswer =
  | { status: 'open' }
  | { status: 'closed'; closedOn: string }
  | { status: 'unknown' }
  | { status: 'unavailable' };

/** Le répertoire Sirene de l'INSEE. Le vrai branchement attend une clé d'accès (H62) ; les tests en ont un faux. */
export interface CompanyRegistry {
  establishment(siret: string): Promise<RegistryAnswer>;
}

export type EmployerOutcome = 'open' | 'closed_before' | 'unknown' | 'unavailable' | 'bad_key';

/**
 * L'établissement à la date de la pièce : ouvert, ou fermé ce jour-là ou après, c'est conforme ; fermé avant, inconnu ou
 * clé fausse, c'est un écart ; registre injoignable, ou fermé sans date de pièce connue, non vérifiable. Ne lève jamais.
 */
export async function checkEmployer(registry: CompanyRegistry, rawSiret: unknown, onDate: string | null): Promise<EmployerOutcome> {
  if (!siretKeyValid(rawSiret)) return 'bad_key';
  const siret = (rawSiret as string).replace(/\s+/g, '');
  let answer: RegistryAnswer;
  try {
    answer = await registry.establishment(siret);
  } catch {
    return 'unavailable';
  }
  if (answer.status === 'open') return 'open';
  if (answer.status === 'closed') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(answer.closedOn)) return 'unavailable';
    if (onDate === null) return 'unavailable';
    return answer.closedOn < onDate ? 'closed_before' : 'open';
  }
  return answer.status === 'unknown' ? 'unknown' : 'unavailable';
}
