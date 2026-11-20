import { expect, it } from 'vitest';
import type { Viewer } from '@aimmo/core';
import { offreRoutes, syncOffres, type OffreServices } from '../src/offres.ts';
import { setupOffre, SIGNED_REF } from '../../core/test/offres-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';
import { identiteAuCoffre } from '../../core/test/identite-coffre.ts';

// Une offre test inventée, suivie de bout en bout par les routes.
const PROOF = 'preuves/0b6f1d2e-9999-4a2b-8c3d-000000000001.pdf';

async function setup() {
  const t = await setupOffre();
  const s: OffreServices = { db: t.db, journal: t.journal, acces: t.acces, now: t.now };
  const routes = offreRoutes();
  const call = async (viewer: Viewer, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const route = routes.find((r) => r.method === method && r.pattern.test(path));
    if (!route) throw new Error(`route inconnue ${method} ${path}`);
    const params = (route.pattern.exec(path) ?? []).slice(1);
    const request = new Request(`https://api.exemple.test/v1${path}`, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const response = await route.handle(s, viewer, params, request);
    return { status: response.status, body: (await response.json()) as { ok: boolean; data?: any; code?: string; rule?: string; tasks?: unknown[] } };
  };
  return { ...t, s, call };
}

const offerBody = (buyerPersonId: string, patch: Record<string, unknown> = {}) => ({
  buyerPersonId, amountEur: 205000, conditions: [{ kind: 'pret', amountEur: 150000, durationMonths: 240 }], validUntil: '2027-03-10',
  downPaymentEur: 70000, loanEur: 150000, signedRef: SIGNED_REF, receivedAt: '2027-03-01T09:00:00.000Z', ...patch,
});

describeWithSqlite('O08 · routes de M09', () => {
  it('une offre test suivie de bout en bout par les routes, jusqu’au compromis en préparation', async () => {
    const t = await setup();
    const rec = await t.call(t.agent, 'POST', `/offres/biens/${t.propertyId}`, offerBody(t.buyerId, { requestKey: 'cle-envoi-0000000001' }));
    expect(rec.status).toBe(200);
    const offerId = rec.body.data.offer.id as string;
    expect(rec.body.data.lines.map((l: { check: string }) => l.check)).toEqual(['identite', 'financement', 'pret', 'validite']);
    expect((await t.call(t.agent, 'POST', `/offres/${offerId}/transmission`, { via: 'telephone' })).status).toBe(200);
    t.setClock(new Date('2027-03-01T12:00:00.000Z'));
    expect((await t.call(t.agent, 'POST', `/offres/${offerId}/reponse`, { outcome: 'acceptee', proofRef: PROOF, respondedAt: '2027-03-01T11:00:00.000Z' })).status).toBe(200);
    const file = await t.call(t.agent, 'POST', `/offres/${offerId}/dossier`);
    expect(file.body).toMatchObject({ ok: true, data: { amountEur: 205000 } });
    const blocked = await t.call(t.agent, 'POST', `/offres/dossiers/${file.body.data.id}/compromis`);
    expect(blocked.status).toBe(409);
    expect(blocked.body).toMatchObject({ rule: 'R58', code: 'identity_missing' });
    await identiteAuCoffre({ db: t.db, acces: t.acces, journal: t.journal, now: t.now }, t.agent, t.buyerId, { piece: 'passeport', seenAt: new Date('2027-03-01T11:30:00.000Z') });
    expect((await t.call(t.agent, 'POST', `/offres/dossiers/${file.body.data.id}/compromis`)).status).toBe(200);
    const history = await t.call(t.direction, 'GET', `/offres/${offerId}/historique`);
    expect(history.body.data.map((e: { event: string }) => e.event)).toEqual(['recue', 'enregistree', 'controlee', 'transmise:telephone', 'reponse:acceptee']);
    const table = await t.call(t.agent, 'GET', `/offres/biens/${t.propertyId}/comparatif`);
    expect(table.body.data).toMatchObject({ count: 1, registerIntact: true });
  });

  it('[R56] un double envoi de la même offre (même clé) ne crée qu’une ligne au registre', async () => {
    const t = await setup();
    const body = offerBody(t.buyerId, { requestKey: 'cle-envoi-0000000002' });
    const [a, b] = await Promise.all([t.call(t.agent, 'POST', `/offres/biens/${t.propertyId}`, body), t.call(t.agent, 'POST', `/offres/biens/${t.propertyId}`, body)]);
    expect(a.body.data.offer.id).toBe(b.body.data.offer.id);
    const again = await t.call(t.agent, 'POST', `/offres/biens/${t.propertyId}`, body);
    expect(again.body.data.offer.id).toBe(a.body.data.offer.id);
    expect((await t.call(t.agent, 'GET', `/offres/biens/${t.propertyId}`)).body.data).toHaveLength(1);
    expect((await t.call(t.agent, 'POST', `/offres/biens/${t.propertyId}`, offerBody(t.buyerId, { requestKey: 'court' }))).body).toMatchObject({ code: 'invalid', field: 'requestKey' });
    // La même clé avec une autre offre : refusée, écrite au journal, le registre garde une seule ligne pour cette clé.
    const reused = await t.call(t.agent, 'POST', `/offres/biens/${t.propertyId}`, offerBody(t.buyerId, { requestKey: 'cle-envoi-0000000002', amountEur: 210000 }));
    expect(reused.status).toBe(409);
    expect(reused.body).toMatchObject({ rule: 'R56', code: 'request_key_reused' });
    expect((await t.journal.all()).filter((e) => e.type === 'offre.cle_reutilisee')).toHaveLength(1);
    expect((await t.call(t.agent, 'GET', `/offres/biens/${t.propertyId}`)).body.data).toHaveLength(1);
    // Rejouée bien plus tard, après la fin de validité, la même offre est rendue, pas refusée comme nouvelle.
    t.setClock(new Date('2027-03-20T10:00:00.000Z'));
    const late = await t.call(t.agent, 'POST', `/offres/biens/${t.propertyId}`, body);
    expect(late.status).toBe(200);
    expect(late.body.data.offer.id).toBe(a.body.data.offer.id);
    t.setClock(new Date('2027-03-01T10:00:00.000Z'));
    expect((await t.call(t.agent, 'POST', `/offres/biens/${t.propertyId}`, offerBody(t.buyerId))).body.data.offer.seq).toBe(2);
  });

  it('[R16] AU081 : le collègue partage son acquéreur pour ce bien, l’agent du bien inscrit et contrôle l’offre, sans la direction', async () => {
    const t = await setup();
    await t.db.run("UPDATE properties SET status = 'available' WHERE id = ?", [t.propertyId]);
    const colleague = await t.store.createPerson({ networkId: t.network.id, agentId: t.sam.userId, firstName: 'Colin', lastName: 'Fictif' });
    expect((await t.call(t.agent, 'POST', `/offres/biens/${t.propertyId}`, offerBody(colleague.id))).status).toBe(403);
    const share = await t.call(t.sam, 'POST', `/offres/biens/${t.propertyId}/partages`, { buyerPersonId: colleague.id });
    expect(share).toMatchObject({ status: 200, body: { ok: true, data: { buyerPersonId: colleague.id, revokedAt: null } } });
    const rec = await t.call(t.agent, 'POST', `/offres/biens/${t.propertyId}`, offerBody(colleague.id));
    expect(rec.status).toBe(200);
    expect(rec.body.data.lines.map((l: { check: string }) => l.check)).toEqual(['identite', 'financement', 'pret', 'validite']);
    expect(JSON.stringify(rec.body)).not.toMatch(/Colin|Fictif/);
    expect((await t.call(t.agent, 'POST', `/offres/partages/${share.body.data.id}/retrait`)).status).toBe(403);
    expect((await t.call(t.sam, 'POST', `/offres/partages/${share.body.data.id}/retrait`)).status).toBe(200);
    expect((await t.call(t.agent, 'POST', `/offres/biens/${t.propertyId}`, offerBody(colleague.id, { amountEur: 206000 }))).status).toBe(403);
  });

  it('[R16] chaque route passe par les droits ; chaque refus rend 403 et écrit une ligne au journal', async () => {
    const t = await setup();
    const rec = await t.call(t.agent, 'POST', `/offres/biens/${t.propertyId}`, offerBody(t.buyerId));
    const offerId = rec.body.data.offer.id as string;
    // Une contre-offre et un dossier, pour éprouver aussi leurs routes.
    await t.call(t.agent, 'POST', `/offres/${offerId}/transmission`, { via: 'telephone' });
    t.setClock(new Date('2027-03-01T12:00:00.000Z'));
    await t.call(t.agent, 'POST', `/offres/${offerId}/reponse`, { outcome: 'contre_offre', proofRef: PROOF, respondedAt: '2027-03-01T11:00:00.000Z' });
    const proposal = await t.call(t.agent, 'POST', `/offres/${offerId}/propositions`, { amountEur: 210000, validUntil: '2027-03-05', proofRef: PROOF });
    const proposalId = proposal.body.data.id as string;
    await t.call(t.agent, 'POST', `/offres/propositions/${proposalId}/transmission`, { via: 'telephone' });
    t.setClock(new Date('2027-03-01T13:00:00.000Z'));
    await t.call(t.agent, 'POST', `/offres/propositions/${proposalId}/reponse`, { outcome: 'acceptee', proofRef: PROOF, respondedAt: '2027-03-01T12:30:00.000Z' });
    const file = await t.call(t.agent, 'POST', `/offres/${offerId}/dossier`);
    const fileId = file.body.data.id as string;
    const refusals = async () => (await t.journal.all()).filter((e) => e.type === 'acces.refuse').length;
    const cases: [string, 'GET' | 'POST', string, unknown?][] = [
      ['enregistrer', 'POST', `/offres/biens/${t.propertyId}`, offerBody(t.buyerId)],
      ['liste', 'GET', `/offres/biens/${t.propertyId}`],
      ['comparatif', 'GET', `/offres/biens/${t.propertyId}/comparatif`],
      ['historique', 'GET', `/offres/${offerId}/historique`],
      ['controle', 'POST', `/offres/${offerId}/controle`],
      ['transmission', 'POST', `/offres/${offerId}/transmission`, { via: 'telephone' }],
      ['reponse', 'POST', `/offres/${offerId}/reponse`, { outcome: 'refusee', proofRef: PROOF, respondedAt: '2027-03-01T11:30:00.000Z' }],
      ['proposition', 'POST', `/offres/${offerId}/propositions`, { amountEur: 210000, validUntil: '2027-03-05', proofRef: PROOF }],
      ['dossier', 'POST', `/offres/${offerId}/dossier`],
      ['proposition.transmission', 'POST', `/offres/propositions/${proposalId}/transmission`, { via: 'telephone' }],
      ['proposition.reponse', 'POST', `/offres/propositions/${proposalId}/reponse`, { outcome: 'refusee', proofRef: PROOF, respondedAt: '2027-03-01T12:40:00.000Z' }],
      ['compromis', 'POST', `/offres/dossiers/${fileId}/compromis`],
      ['taches (direction)', 'GET', '/offres/taches'],
    ];
    for (const [name, method, path, body] of cases) {
      const before = await refusals();
      const r = await t.call(name === 'taches (direction)' ? t.direction : t.sam, method, path, body);
      expect(r.status, name).toBe(403);
      expect((await refusals()) - before, name).toBe(1);
    }
    expect((await t.call(t.agent, 'GET', '/offres/taches')).body).toMatchObject({ ok: true, tasks: [] });
    expect((await t.call(t.agent, 'POST', '/offres/offre-inconnue/controle')).status).toBe(404);
    const route = offreRoutes().find((r) => r.name === 'offres.transmission')!;
    const bad = await route.handle(t.s, t.agent, [offerId], new Request('https://api.exemple.test/v1/x', { method: 'POST', body: 'pas du json' }));
    expect(bad.status).toBe(400);
  });

  it('[R505] une offre d’un acquéreur qui a visité à distance sans signer son bon : 409 en mots, rien au registre', async () => {
    const t = await setup();
    const start = '2027-02-26T09:00:00.000Z';
    const end = '2027-02-26T09:45:00.000Z';
    const project = await t.store.createProject({ networkId: t.network.id, agentId: t.alexId, personId: t.buyerId, kind: 'buy', note: '' });
    await t.db.run(
      "INSERT INTO appointments (id, network_id, agent_id, person_id, property_id, kind, start_at, end_at, status, token_hash, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'visite', ?, ?, 'honored', ?, 'agent', ?, ?)",
      ['rdv-distance-br60', t.network.id, t.alexId, t.buyerId, t.propertyId, start, end, 'jeton-br60', start, start],
    );
    await t.db.run('INSERT INTO visits (appointment_id, network_id, property_id, project_id, person_id, agent_id, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
      'rdv-distance-br60', t.network.id, t.propertyId, project.id, t.buyerId, t.alexId, 'test', start,
    ]);
    await t.db.run('INSERT INTO remote_visits (appointment_id, network_id, property_id, person_id, started_by, started_at, ended_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
      'rdv-distance-br60', t.network.id, t.propertyId, t.buyerId, `agent:${t.alexId}`, start, end,
    ]);
    const res = await t.call(t.agent, 'POST', `/offres/biens/${t.propertyId}`, offerBody(t.buyerId, { requestKey: 'cle-envoi-br60-0001' }));
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ ok: false, rule: 'R505', code: 'remote_slip_unsigned' });
    expect((await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM offer_register WHERE property_id = ?', [t.propertyId]))!.n).toBe(0);
  });

  it('le passage quotidien signale les offres non transmises et range les échéances', async () => {
    const t = await setup();
    await t.call(t.agent, 'POST', `/offres/biens/${t.propertyId}`, offerBody(t.buyerId, { validUntil: '2027-03-03' }));
    t.setClock(new Date('2027-03-02T10:00:00.000Z'));
    expect(await syncOffres(t.s, t.network.id)).toEqual({ untransmitted: 1, deadlines: 1 });
    expect(await syncOffres(t.s, t.network.id)).toEqual({ untransmitted: 0, deadlines: 0 });
  });
});

it('O08 · chaque route a un nom stable et une adresse unique par méthode', () => {
  const routes = offreRoutes();
  const keys = routes.map((r) => `${r.method} ${r.pattern.source}`);
  expect(new Set(keys).size).toBe(keys.length);
  expect(routes.every((r) => /^offres\.[a-z_.]+$/.test(r.name))).toBe(true);
});
