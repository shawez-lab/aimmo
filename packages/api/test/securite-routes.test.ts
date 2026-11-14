import { expect, it } from 'vitest';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Réseau, agents, clients, médiateur, registre et clés inventés. Le mardi 9 mars 2027, à 10 h à Paris.
const NOW = new Date('2027-03-09T09:00:00.000Z');
const KEYS = {
  alex: 'test-cle-br01-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sam: 'test-cle-br01-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  direction: 'test-cle-br01-direction-cccccccccccccccccccccc',
  conformite: 'test-cle-br01-conformite-ddddddddddddddddddddd',
};
type Who = keyof typeof KEYS;
const MEDIATOR = { responseDays: 30, mediatorName: 'Médiation Exemple', mediatorSite: 'https://mediation.example.test' };
const REGISTRE = [
  { entryId: 'G-1001', nature: 'personne_physique', names: ['FICTIF Marcel Auguste'] },
  { entryId: 'G-1002', nature: 'personne_morale', names: ['SOCIETE IMAGINAIRE SARL'] },
];

async function setup() {
  const t = await setupAnnonce();
  t.setClock(NOW);
  const ids: Record<Who, { role: string; userId: string }> = {
    alex: { role: 'agent', userId: t.alexId },
    sam: { role: 'agent', userId: t.sam.userId },
    direction: { role: 'direction', userId: t.direction.userId },
    conformite: { role: 'compliance', userId: 'conformite-1' },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: t.network.id, ...ids[w] }))));
  const config: ApiConfig = { db: t.db, apiKeys, mode: 'essai', now: t.now };
  const http = async (who: Who, method: string, path: string, body?: unknown, raw?: string) => {
    const headers: Record<string, string> = { authorization: `Bearer ${KEYS[who]}` };
    if (body !== undefined || raw !== undefined) headers['content-type'] = 'application/json';
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const r = await handleRequest(new Request(`https://aimmo-api.example.test/v1${path}`, { method, headers, ...(payload === undefined ? {} : { body: payload }) }), config);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string; code?: string; status?: string } };
  };
  const refusals = async () => (await t.journal.all()).filter((e) => e.type === 'acces.refuse');
  return { ...t, http, refusals };
}

describeWithSqlite('BR01 · routes des réclamations et du gel des avoirs', () => {
  it('[R16] chaque route refuse le mauvais rôle, en 403, avec le refus au journal', async () => {
    const t = await setup();
    const cases: [Who, string, string, unknown?][] = [
      ['conformite', 'GET', '/securite/reclamations'],
      ['alex', 'POST', '/securite/reclamations/reglage', MEDIATOR],
      ['alex', 'GET', '/securite/reclamations/reglage'],
      ['conformite', 'GET', '/securite/reclamations/reglage'],
      ['conformite', 'POST', `/securite/fiches/${t.personId}/reclamations`, { receivedOn: '2027-03-09', receivedBy: 'oral', summary: 'Retard.' }],
      ['sam', 'POST', `/securite/fiches/${t.personId}/reclamations`, { receivedOn: '2027-03-09', receivedBy: 'oral', summary: 'Retard.' }],
      ['alex', 'POST', '/securite/gel/registre', { publishedAt: '2027-03-01T00:00:00Z', entries: REGISTRE }],
      ['direction', 'POST', '/securite/gel/controle', { caseRef: `mandate:${t.mandateId}` }],
      ['alex', 'GET', `/securite/gel/controles?dossier=mandate:${t.mandateId}`],
      ['direction', 'GET', '/securite/gel/sans-nom'],
      ['alex', 'GET', '/securite/gel/correspondances'],
      ['direction', 'GET', '/securite/gel/correspondances/m-1/fige'],
      ['alex', 'POST', '/securite/gel/correspondances/m-1/decision', { decision: 'fausse_correspondance', reason: 'x', validatorName: 'x' }],
    ];
    // Une réclamation existante : ni l'autre agent ni la conformité ne la règlent ni ne remettent son médiateur.
    expect((await t.http('direction', 'POST', '/securite/reclamations/reglage', MEDIATOR)).status).toBe(200);
    const late = await t.http('alex', 'POST', `/securite/fiches/${t.personId}/reclamations`, { receivedOn: '2027-01-15', receivedBy: 'oral', summary: 'Pas de nouvelles.' });
    const id = late.body.data.complaintId as string;
    for (const who of ['sam', 'conformite'] as Who[]) {
      cases.push([who, 'POST', `/securite/reclamations/${id}/reponse`, { outcome: 'reglee', note: 'Réglé.' }]);
      cases.push([who, 'POST', `/securite/reclamations/${id}/mediateur-remis`]);
    }
    for (const [who, method, path, body] of cases) {
      const before = (await t.refusals()).length;
      const r = await t.http(who, method, path, body);
      expect(r.status, `${who} ${method} ${path}`).toBe(403);
      expect(r.body).toMatchObject({ ok: false, rule: 'R16' });
      expect((await t.refusals()).length, `${who} ${method} ${path}`).toBeGreaterThan(before);
    }
    const after = (await t.http('direction', 'GET', '/securite/reclamations')).body.data.find((c: { complaintId: string }) => c.complaintId === id);
    expect(after).toMatchObject({ status: 'ouverte', mediator: { status: 'a_remettre' } });
  });

  it('[R607] BR70 · la direction relit le réglage en service par la route', async () => {
    const t = await setup();
    expect((await t.http('direction', 'GET', '/securite/reclamations/reglage')).body).toEqual({
      ok: true,
      mode: 'essai',
      data: { version: null, setAt: null, responseDays: 30, mediator: null, offerText: null, waitingForMediator: 0 },
    });
    await t.http('direction', 'POST', '/securite/reclamations/reglage', MEDIATOR);
    const r = await t.http('direction', 'GET', '/securite/reclamations/reglage');
    expect(r.status).toBe(200);
    expect(r.body.data).toMatchObject({ version: 1, responseDays: 30, mediator: { name: 'Médiation Exemple', site: 'https://mediation.example.test' } });
    expect(r.body.data.offerText).toContain('sans frais');
  });

  it('[R606] [R607] une réclamation rangée par la route a son échéance de la base ; le médiateur reste à remettre, rien ne part [R26]', async () => {
    const t = await setup();
    expect((await t.http('direction', 'POST', '/securite/reclamations/reglage', MEDIATOR)).body).toMatchObject({ ok: true, mode: 'essai', version: 1 });
    const fresh = await t.http('alex', 'POST', `/securite/fiches/${t.personId}/reclamations`, { receivedOn: '2027-03-09', receivedBy: 'courrier', summary: 'Visites trop rares.' });
    expect(fresh.status).toBe(200);
    expect(fresh.body.data).toMatchObject({ receivedOn: '2027-03-09', responseDays: 30, dueOn: '2027-04-08', status: 'ouverte', mediator: null });
    // La base garde l'échéance : elle ne change plus.
    await expect(t.db.run("UPDATE complaints SET due_on = '2027-05-01'")).rejects.toThrow('ne change plus');
    // Rangée en retard, déjà à l'échéance : le médiateur est proposé aussitôt, par le mode essai seulement.
    const late = await t.http('alex', 'POST', `/securite/fiches/${t.personId}/reclamations`, { receivedOn: '2027-01-15', receivedBy: 'oral', summary: 'Pas de nouvelles.' });
    expect(late.body.data.mediator).toMatchObject({ cause: expect.any(String), status: 'a_remettre' });
    expect(late.body.data.mediator.text).toContain('Médiation Exemple');
    const id = late.body.data.complaintId as string;
    expect((await t.http('alex', 'POST', `/securite/reclamations/${id}/mediateur-remis`)).body.data.mediator).toMatchObject({ status: 'remis' });
    expect(await t.http('alex', 'POST', `/securite/reclamations/${id}/mediateur-remis`)).toMatchObject({ status: 400, body: { code: 'nothing_to_hand' } });
    // La réponse, une fois.
    expect((await t.http('alex', 'POST', `/securite/reclamations/${fresh.body.data.complaintId}/reponse`, { outcome: 'reglee', note: 'Rappel fait, visites ajoutées.' })).body.data.status).toBe('reglee');
    // L'agent lit les réclamations des fiches qu'il suit, l'autre agent aucune, la direction toutes.
    expect((await t.http('alex', 'GET', '/securite/reclamations')).body.data).toHaveLength(2);
    expect((await t.http('sam', 'GET', '/securite/reclamations')).body.data).toHaveLength(0);
    expect((await t.http('direction', 'GET', '/securite/reclamations')).body.data).toHaveLength(2);
    // BR71 : le groupe d'une fiche, par le paramètre `fiche`, et lui seul.
    expect((await t.http('alex', 'GET', `/securite/reclamations?fiche=${t.personId}`)).body.data).toHaveLength(2);
    expect(await t.http('sam', 'GET', `/securite/reclamations?fiche=${t.personId}`)).toMatchObject({ status: 403, body: { ok: false, rule: 'R16' } });
    expect(await t.http('direction', 'GET', '/securite/reclamations?fiche=inconnue')).toMatchObject({ status: 404, body: { code: 'unknown_person' } });
    expect(await t.http('direction', 'GET', '/securite/reclamations?fiche=a%20b')).toMatchObject({ status: 400, body: { code: 'bad_fiche' } });
    expect(await t.http('direction', 'GET', `/securite/reclamations?fiche=${t.personId}&fiche=x`)).toMatchObject({ status: 400, body: { code: 'unexpected_field' } });
    expect(await t.http('direction', 'GET', '/securite/reclamations?autre=1')).toMatchObject({ status: 400, body: { code: 'unexpected_field' } });
    expect(await t.http('alex', 'GET', '/securite/reclamations/inconnue/reponse')).toMatchObject({ status: 405 });
    expect(await t.http('alex', 'POST', '/securite/reclamations/inconnue/reponse', { outcome: 'reglee', note: 'x' })).toMatchObject({ status: 404, body: { code: 'unknown_complaint' } });
  });

  it('[R605] le contrôle demandé par l’agent rend toujours le même mot ; le résultat ne se lit que par le responsable', async () => {
    const t = await setup();
    const imported = await t.http('conformite', 'POST', '/securite/gel/registre', { publishedAt: '2027-03-01T00:00:00Z', entries: REGISTRE });
    expect(imported.status).toBe(200);
    expect(imported.body.data).toMatchObject({ entries: 2, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const asked = await t.http('alex', 'POST', '/securite/gel/controle', { caseRef: `mandate:${t.mandateId}` });
    expect(asked).toMatchObject({ status: 200, body: { ok: true, status: 'controle_fait', data: null } });
    expect(JSON.stringify(asked.body)).not.toMatch(/aucune|correspondance|nom_manquant/);
    expect(await t.http('alex', 'POST', '/securite/gel/controle', { caseRef: 'mandat-de-quelquun' })).toMatchObject({ status: 400, body: { code: 'bad_case' } });
    const checks = await t.http('conformite', 'GET', `/securite/gel/controles?dossier=mandate:${t.mandateId}`);
    expect(checks.status).toBe(200);
    expect(checks.body.data.length).toBeGreaterThan(0);
    expect((await t.http('conformite', 'GET', '/securite/gel/correspondances')).body.data).toEqual([]);
    expect((await t.http('conformite', 'GET', '/securite/gel/sans-nom')).status).toBe(200);
    expect(await t.http('conformite', 'GET', '/securite/gel/correspondances/m-inconnue/fige')).toMatchObject({ status: 404, body: { code: 'unknown_match' } });
    expect(await t.http('conformite', 'GET', '/securite/gel/controles')).toMatchObject({ status: 400, body: { code: 'invalid_body' } });
  });

  it('un corps absent, invalide ou trop gros est refusé sans rien ranger', async () => {
    const t = await setup();
    const count = async () => (await t.db.first<{ n: number }>('SELECT count(*) AS n FROM complaints'))!.n;
    const path = `/securite/fiches/${t.personId}/reclamations`;
    expect(await t.http('alex', 'POST', path)).toMatchObject({ status: 400, body: { code: 'invalid_body' } });
    expect(await t.http('alex', 'POST', path, undefined, '{pas du json')).toMatchObject({ status: 400, body: { code: 'invalid_body' } });
    expect(await t.http('alex', 'POST', path, [1, 2])).toMatchObject({ status: 400, body: { code: 'invalid_body' } });
    expect(await t.http('alex', 'POST', path, { receivedOn: '2027-03-09', receivedBy: 'oral', summary: 'x'.repeat(9_000) })).toMatchObject({ status: 400, body: { code: 'invalid_body' } });
    expect(await t.http('alex', 'POST', path, { receivedOn: '2027-03-09', receivedBy: 'oral', summary: 'Retard.', reply: 'mail' })).toMatchObject({ status: 400, body: { code: 'invalid_body' } });
    expect(await t.http('alex', 'POST', path, { receivedOn: '2027-04-01', receivedBy: 'oral', summary: 'Retard.' })).toMatchObject({ status: 400, body: { code: 'future_date' } });
    expect(await count()).toBe(0);
    // Le registre seul a droit à un gros corps ; au-delà de sa limite, refusé lui aussi.
    const huge = { publishedAt: '2027-03-01T00:00:00Z', entries: [{ entryId: 'G-1', nature: 'personne_physique', names: ['X'.repeat(4_100_000)] }] };
    expect(await t.http('conformite', 'POST', '/securite/gel/registre', huge)).toMatchObject({ status: 400, body: { code: 'invalid_body' } });
  });
});
