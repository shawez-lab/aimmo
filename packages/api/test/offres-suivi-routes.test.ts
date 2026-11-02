import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import type { Viewer } from '@aimmo/core';
import { offreRoutes, type OffreServices, type OfferUploadStore } from '../src/offres.ts';
import { setupOffre, SIGNED_REF } from '../../core/test/offres-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Tout est inventé.
const PROOF = 'preuves/0b6f1d2e-9999-4a2b-8c3d-000000000001.pdf';
const PDF = new TextEncoder().encode('%PDF-1.7 essai');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function setup(store: (OfferUploadStore & { kept: Map<string, Uint8Array> }) | null = null) {
  const t = await setupOffre();
  const s: OffreServices = { db: t.db, journal: t.journal, acces: t.acces, now: t.now };
  const routes = offreRoutes(store);
  const run = async (viewer: Viewer, method: 'GET' | 'POST', path: string, init: RequestInit = {}) => {
    const route = routes.find((r) => r.method === method && r.pattern.test(path));
    if (!route) throw new Error(`route inconnue ${method} ${path}`);
    const response = await route.handle(s, viewer, (route.pattern.exec(path) ?? []).slice(1), new Request(`https://api.exemple.test/v1${path}`, { method, ...init }));
    return { status: response.status, body: (await response.json()) as { ok: boolean; data?: any; code?: string; rule?: string } };
  };
  const call = (viewer: Viewer, method: 'GET' | 'POST', path: string, body?: unknown) =>
    run(viewer, method, path, body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { ...t, call, run };
}

const memory = () => {
  const kept = new Map<string, Uint8Array>();
  return { kept, has: async (r: string) => kept.has(r), upload: async (k: string, b: Uint8Array) => void kept.set(k, b) };
};

describeWithSqlite('O10 · suivi des offres pour l’écran', () => {
  it('[R14] [R56] [R57] les offres restent dans l’ordre d’arrivée, chacune avec son seul prochain pas, jusqu’au compromis', async () => {
    const t = await setup();
    const first = await t.record({ amountEur: 190000, downPaymentEur: 40000 });
    const second = await t.record({ amountEur: 205000 });
    const read = async () => (await t.call(t.agent, 'GET', `/offres/biens/${t.propertyId}/suivi`)).body.data;
    let board = await read();
    expect(board).toMatchObject({ count: 2, registerIntact: true });
    // L'offre la plus haute reste seconde : aucun tri, aucune note.
    expect(board.offers.map((o: { id: string }) => o.id)).toEqual([first.id, second.id]);
    expect(board.offers[0]).toMatchObject({ seq: 1, amountEur: 190000, next: 'transmettre', buyer: { firstName: 'Acheteur', lastName: 'Exemple' }, proposalId: null, file: null });
    expect(JSON.stringify(board)).not.toMatch(/score|note|rang_|recommand/i);

    await t.call(t.agent, 'POST', `/offres/${second.id}/transmission`, { via: 'telephone' });
    board = await read();
    expect(board.offers[1].next).toBe('reponse_vendeur');
    t.setClock(new Date('2027-03-01T12:00:00.000Z'));
    await t.call(t.agent, 'POST', `/offres/${second.id}/reponse`, { outcome: 'contre_offre', proofRef: PROOF, respondedAt: '2027-03-01T11:00:00.000Z' });
    expect((await read()).offers[1].next).toBe('ranger_proposition');
    const p = await t.call(t.agent, 'POST', `/offres/${second.id}/propositions`, { amountEur: 210000, validUntil: '2027-03-05', proofRef: PROOF });
    board = await read();
    expect(board.offers[1]).toMatchObject({ next: 'transmettre_proposition', proposalId: p.body.data.id, amountEur: 210000, offeredEur: 205000, validUntil: '2027-03-05' });
    await t.call(t.agent, 'POST', `/offres/propositions/${p.body.data.id}/transmission`, { via: 'ecrit' });
    expect((await read()).offers[1].next).toBe('reponse_proposition');
    t.setClock(new Date('2027-03-01T13:00:00.000Z'));
    await t.call(t.agent, 'POST', `/offres/propositions/${p.body.data.id}/reponse`, { outcome: 'acceptee', proofRef: PROOF, respondedAt: '2027-03-01T12:30:00.000Z' });
    expect((await read()).offers[1].next).toBe('ouvrir_dossier');
    const file = await t.call(t.agent, 'POST', `/offres/${second.id}/dossier`);
    board = await read();
    expect(board.offers[1]).toMatchObject({ next: 'preparer_compromis', file: { id: file.body.data.id, compromisStarted: false } });
    // L'autre offre reste à transmettre : toute offre reçue l'est, même quand une autre est acceptée [R56].
    expect(board.offers[0].next).toBe('transmettre');
    expect(board.offers[1].history.map((e: { event: string }) => e.event)).toContain('proposition:1:acceptee');
  });

  it('[R56] un registre modifié se voit à l’écran', async () => {
    const t = await setup();
    await t.record();
    const triggers = await t.db.all<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'offer_register'");
    for (const x of triggers) await t.db.run(`DROP TRIGGER ${x.name}`);
    await t.db.run('UPDATE offer_register SET amount_eur = 1');
    expect((await t.call(t.agent, 'GET', `/offres/biens/${t.propertyId}/suivi`)).body.data.registerIntact).toBe(false);
  });

  it('[R16] le suivi, les contacts et le dépôt sont refusés hors de l’agent du bien et de la direction, avec une ligne au journal', async () => {
    const t = await setup(memory());
    await t.record();
    const refusals = async () => (await t.journal.all()).filter((e) => e.type === 'acces.refuse').length;
    for (const [method, path, init] of [
      ['GET', `/offres/biens/${t.propertyId}/suivi`, {}],
      ['GET', `/offres/biens/${t.propertyId}/contacts`, {}],
      ['POST', `/offres/biens/${t.propertyId}/fichiers/signee`, { headers: { 'content-type': 'application/pdf', 'x-aimmo-sha256': sha(PDF) }, body: PDF }],
    ] as const) {
      const before = await refusals();
      const refused = await t.run(t.sam, method, path, init);
      expect(refused.status).toBe(403);
      expect(await refusals()).toBe(before + 1);
    }
  });

  it('[R16] un acquéreur que l’agent ne voit pas reste sans nom ; les contacts sont les siens, sans le mandant du bien', async () => {
    const t = await setup();
    const own = (await t.call(t.agent, 'GET', `/offres/biens/${t.propertyId}/contacts`)).body.data;
    expect(own.contacts).toContainEqual({ personId: t.buyerId, firstName: 'Acheteur', lastName: 'Exemple' });
    const owner = await t.db.first<{ person_id: string }>('SELECT person_id FROM mandates WHERE property_id = ?', [t.propertyId]);
    expect(owner).not.toBeNull();
    expect(own.contacts.map((c: { personId: string }) => c.personId)).not.toContain(owner!.person_id);
    const foreign = await t.store.createPerson({ networkId: t.network.id, agentId: t.sam.userId, firstName: 'Autre', lastName: 'Contact' });
    expect(own.contacts.map((c: { personId: string }) => c.personId)).not.toContain(foreign.id);
    const recorded = await t.call(t.direction, 'POST', `/offres/biens/${t.propertyId}`, {
      buyerPersonId: foreign.id, amountEur: 200000, conditions: [], validUntil: '2027-03-10', downPaymentEur: 200000, loanEur: 0, signedRef: SIGNED_REF, receivedAt: '2027-03-01T09:00:00.000Z',
    });
    expect(recorded.status).toBe(200);
    const board = (await t.call(t.agent, 'GET', `/offres/biens/${t.propertyId}/suivi`)).body.data;
    expect(board.offers[0]).toMatchObject({ buyer: null, amountEur: 200000 });
  });

  it('[R13] le dépôt range le fichier sous la référence attendue par le registre et les réponses, sans contenu au journal', async () => {
    const store = memory();
    const t = await setup(store);
    const post = (kind: string, type: string, body: Uint8Array, hash = sha(body)) =>
      t.run(t.agent, 'POST', `/offres/biens/${t.propertyId}/fichiers/${kind}`, { headers: { 'content-type': type, 'x-aimmo-sha256': hash }, body });
    const signed = await post('signee', 'application/pdf', PDF);
    expect(signed.status).toBe(200);
    expect(signed.body.data.ref).toMatch(/^offres\/[0-9a-f-]{36}\.pdf$/);
    expect(store.kept.has(signed.body.data.ref)).toBe(true);
    const offer = await t.call(t.agent, 'POST', `/offres/biens/${t.propertyId}`, t.input({ signedRef: signed.body.data.ref }));
    expect(offer.status).toBe(200);
    const note = new TextEncoder().encode('Réponse dite au téléphone.');
    const proof = await post('preuve', 'text/plain', note);
    expect(proof.body.data.ref).toMatch(/^preuves\/[0-9a-f-]{36}\.txt$/);
    await t.call(t.agent, 'POST', `/offres/${offer.body.data.offer.id}/transmission`, { via: 'telephone' });
    t.setClock(new Date('2027-03-01T12:00:00.000Z'));
    expect((await t.call(t.agent, 'POST', `/offres/${offer.body.data.offer.id}/reponse`, { outcome: 'refusee', proofRef: proof.body.data.ref, respondedAt: '2027-03-01T11:00:00.000Z' })).status).toBe(200);
    // Une note n'est jamais une offre signée ; un fichier déguisé, vide ou abîmé ne passe pas.
    expect((await post('signee', 'text/plain', note)).status).toBe(415);
    expect((await post('signee', 'application/pdf', new TextEncoder().encode('<html>'))).status).toBe(415);
    expect((await post('signee', 'application/pdf', PDF, 'a'.repeat(64))).body.code).toBe('empreinte_differente');
    expect((await post('signee', 'application/pdf', new Uint8Array())).body.code).toBe('fichier_vide');
    const log = JSON.stringify((await t.journal.all()).filter((e) => e.type.startsWith('offre.depot')));
    expect(log).not.toContain('Réponse dite');
    expect(log).not.toContain('Exemple');
  });

  it('sans stockage, le dépôt est fermé et le dit', async () => {
    const t = await setup();
    const closed = await t.run(t.agent, 'POST', `/offres/biens/${t.propertyId}/fichiers/signee`, { headers: { 'content-type': 'application/pdf', 'x-aimmo-sha256': sha(PDF) }, body: PDF });
    expect(closed.status).toBe(503);
    expect(closed.body.code).toBe('depot_ferme');
  });
});
