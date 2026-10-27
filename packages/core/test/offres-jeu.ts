// Jeu de test commun aux tâches de M09 : le bien en vente de M07, un acquéreur et une offre inventés.
import { RegistreOffres } from '../src/offres/index.ts';
import { setupAnnonce } from './annonces-jeu.ts';

export const SIGNED_REF = 'offres/0b6f1d2e-1111-4a2b-8c3d-000000000001.pdf';

export async function setupOffre() {
  const t = await setupAnnonce();
  t.setClock(new Date('2027-03-01T10:00:00.000Z'));
  const offres = new RegistreOffres(t.db, t.acces, t.journal, { now: t.now });
  const buyer = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Acheteur', lastName: 'Exemple' });
  const input = (patch: Record<string, unknown> = {}) => ({
    buyerPersonId: buyer.id,
    amountEur: 205000,
    conditions: [{ kind: 'pret', amountEur: 150000, durationMonths: 240 }],
    validUntil: '2027-03-10',
    downPaymentEur: 70000,
    loanEur: 150000,
    signedRef: SIGNED_REF,
    receivedAt: '2027-03-01T09:00:00.000Z',
    ...patch,
  });
  const record = async (patch: Record<string, unknown> = {}) => {
    const r = await offres.record(t.agent, t.propertyId, input(patch));
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  return { ...t, offres, buyerId: buyer.id, input, record };
}
