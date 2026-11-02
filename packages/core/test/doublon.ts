import { FicheClient, FicheUnique, type SqlDatabase } from '../src/index.ts';

/**
 * Réunit une fiche à un doublon inventé, de façon que le doublon sorte le premier d'une lecture sans ordre : la fiche gardée
 * est celle dont l'identifiant est le plus grand, quelle qu'elle soit. Rend le prénom que le message doit porter.
 */
export async function mergeWithDouble(db: SqlDatabase, store: FicheClient, personId: string, doubleName: string): Promise<string> {
  const person = await store.getPerson(personId);
  if (!person) throw new Error('Fiche inconnue.');
  const double = await store.createPerson({ networkId: person.network_id, agentId: person.agent_id, firstName: doubleName });
  const [survivor, merged] = person.id > double.id ? [person, double] : [double, person];
  await new FicheUnique(db, store).merge({ survivorId: survivor.id, mergedId: merged.id, reason: 'test' });
  return survivor.first_name as string;
}
