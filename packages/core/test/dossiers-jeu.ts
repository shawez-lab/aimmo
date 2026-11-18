// Jeu de test commun aux tâches de M10 : l'offre acceptée de M09 et son dossier de vente, inventés.
import { FicheBien } from '../src/annonces/index.ts';
import { ObligationsLocales, PiecesDossier, type PieceStore } from '../src/dossiers/index.ts';
import { DossiersVente, TransmissionOffres } from '../src/offres/index.ts';
import { setupOffre } from './offres-jeu.ts';
import { identiteAuCoffre } from './identite-coffre.ts';

export const PROOF = 'preuves/0b6f1d2e-9999-4a2b-8c3d-000000000001.pdf';

/** Un faux stockage : il connaît les références qu'on y a déposées. */
export class FakePieceStore implements PieceStore {
  readonly refs = new Set<string>();
  async has(ref: string): Promise<boolean> {
    return this.refs.has(ref);
  }
}

let counter = 0;

/** Les trois biens types des dossiers tests : l'appartement en copropriété du jeu de M07, une maison, un terrain. */
export type DossierKind = 'appartement' | 'maison' | 'terrain';

export async function setupDossier(kind: DossierKind = 'appartement', offerPatch: Record<string, unknown> = {}, options: { coBuyers?: number; local?: boolean } = {}) {
  const t = await setupOffre();
  // Des coacquéreurs inventés, chacun sa fiche (AU009).
  const coBuyerIds: string[] = [];
  for (let i = 0; i < (options.coBuyers ?? 0); i++) {
    coBuyerIds.push((await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: `Coacheteur${i + 1}`, lastName: 'Exemple' })).id);
  }
  if (coBuyerIds.length) offerPatch = { coBuyerPersonIds: coBuyerIds, ...offerPatch };
  if (kind === 'maison') {
    const sheet = await new FicheBien(t.db, t.acces, t.journal, { now: t.now }).read(t.agent, t.propertyId);
    if (!sheet.ok) throw new Error(sheet.code);
    const s = sheet.value.sheet;
    const r = await new FicheBien(t.db, t.acces, t.journal, { now: t.now }).save(t.agent, t.propertyId, {
      ...s,
      characteristics: { ...s.characteristics, floor: null, floorsTotal: 2, buildYear: 2008, heating: 'individuel_gaz', outdoor: ['jardin'], landM2: 450, elevator: false },
      coownership: { isCoownership: false },
    });
    if (!r.ok) throw new Error(r.code);
  }
  if (kind === 'terrain') {
    // Le jeu de M07 ne crée qu'une maison : le terrain en est une copie au type changé, pour ce test seulement.
    await t.db.run("UPDATE properties SET kind = 'land' WHERE id = ?", [t.propertyId]);
  }
  const transmission = new TransmissionOffres(t.db, t.acces, t.journal, { now: t.now });
  const offer = await t.record(offerPatch);
  await transmission.transmit(t.agent, offer.id, { via: 'telephone' });
  t.setClock(new Date('2027-03-01T12:00:00.000Z'));
  const r = await transmission.respond(t.agent, offer.id, { outcome: 'acceptee', proofRef: PROOF, respondedAt: '2027-03-01T11:00:00.000Z' });
  if (!r.ok) throw new Error(r.code);
  const opened = await new DossiersVente(t.db, t.acces, t.journal, { now: t.now }).open(t.agent, offer.id);
  if (!opened.ok) throw new Error(opened.code);
  const fileId = opened.value.id;
  // Les obligations locales (AU011), connues par défaut : commune hors zone termites et mérule, selon un arrêté inventé
  // lu le jour de l'ouverture, logement raccordé au tout-à-l'égout. `local: false` les laisse inconnues.
  const obligations = new ObligationsLocales(t.db, t.acces, t.journal, { now: t.now });
  if (options.local !== false) {
    for (const hazard of ['termites', 'merule'] as const) {
      const z = await obligations.recordZone(t.direction, { postalCode: '21000', city: 'Dijon', hazard, inZone: false, title: `Arrêté préfectoral inventé, ${hazard}`, url: `https://prefecture.example.fr/arretes/${hazard}`, datedOn: '2020-01-15', readOn: '2027-03-01' });
      if (!z.ok) throw new Error(z.code);
    }
    const s = await obligations.recordSanitation(t.agent, t.propertyId, 'collectif');
    if (!s.ok) throw new Error(s.code);
  }
  const storage = new FakePieceStore();
  const pieces = new PiecesDossier(t.db, t.acces, t.journal, storage, { now: t.now });
  /** Dépose une pièce dans le faux stockage et rend sa référence. */
  const upload = (ext: 'pdf' | 'jpg' | 'png' = 'pdf', file = fileId) => {
    counter += 1;
    const ref = `dossiers/${file}/0b6f1d2e-4444-4a2b-8c3d-${String(counter).padStart(12, '0')}.${ext}`;
    storage.refs.add(ref);
    return ref;
  };
  const verifyBuyer = (seenAt = new Date('2027-03-01T11:30:00.000Z'), personId = t.buyerId) =>
    identiteAuCoffre({ db: t.db, acces: t.acces, journal: t.journal, now: t.now }, t.agent, personId, { piece: 'passeport', seenAt });
  /** Identité vérifiée, compromis en préparation [R58]. */
  const startCompromis = async () => {
    await verifyBuyer();
    for (const id of coBuyerIds) await verifyBuyer(undefined, id);
    const r = await new DossiersVente(t.db, t.acces, t.journal, { now: t.now }).startCompromis(t.agent, fileId);
    if (!r.ok) throw new Error(r.code);
  };
  return { ...t, offerId: offer.id, fileId, storage, pieces, obligations, upload, verifyBuyer, startCompromis, coBuyerIds };
}
