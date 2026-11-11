import { expect, it } from 'vitest';
import { verifyChain } from '@aimmo/core';
import { handleRequest } from '../src/app.ts';
import { sha256Hex } from '../src/index.ts';
import { setupAnnonce } from '../../core/test/annonces-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Tout est inventé : réseau, biens, vendeur, acquéreurs et clés de test. Le bien du jeu (REF-T-1, maison de 62 m²,
// 3 pièces, Dijon, 200 000 €) est diffusable après le délai de rétractation de son mandat.
const BASE = 'https://aimmo-api.example.test';
const KEYS = {
  alex: 'test-cle-br39-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  sam: 'test-cle-br39-sam-bbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  direction: 'test-cle-br39-direction-cccccccccccccccccccccc',
  compliance: 'test-cle-br39-conformite-dddddddddddddddddddd',
  ailleurs: 'test-cle-br39-ailleurs-eeeeeeeeeeeeeeeeeeeeeee',
};
type Who = keyof typeof KEYS;
const TUESDAY_10H = new Date('2027-03-02T09:00:00.000Z');
const PHRASE = 'Maison 3 pièces à Dijon, budget 250 000 €, 60 m² minimum';

async function setup() {
  const t = await setupAnnonce();
  t.setClock(TUESDAY_10H);
  // Le bien publié est disponible (SV08).
  await t.db.run("UPDATE properties SET status = 'available' WHERE id = ?", [t.propertyId]);
  const ids: Record<Who, { role: string; userId: string; networkId: string }> = {
    alex: { role: 'agent', userId: t.alexId, networkId: t.network.id },
    sam: { role: 'agent', userId: t.sam.userId, networkId: t.network.id },
    direction: { role: 'direction', userId: 'direction-1', networkId: t.network.id },
    compliance: { role: 'compliance', userId: 'c-1', networkId: t.network.id },
    ailleurs: { role: 'agent', userId: 'agent-ailleurs', networkId: 'autre-reseau' },
  };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), ...ids[w] }))));
  const call = async (who: Who, path: string, body?: unknown, raw?: string, query = '') => {
    const payload = raw ?? (body === undefined ? undefined : JSON.stringify(body));
    const init: RequestInit = { method: 'POST', headers: { authorization: `Bearer ${KEYS[who]}`, ...(payload === undefined ? {} : { 'content-type': 'application/json' }) } };
    if (payload !== undefined) init.body = payload;
    const r = await handleRequest(new Request(`${BASE}/v1${path}${query}`, init), { db: t.db, apiKeys, mode: 'essai', now: t.now });
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; code?: string; rule?: string | null; field?: string; mode?: string; sent?: boolean } };
  };
  const buyer = async (agentId: string) => {
    const person = await t.store.createPerson({ networkId: t.network.id, agentId, firstName: 'Inès', lastName: 'Durand' });
    const project = await t.store.createProject({ networkId: t.network.id, agentId, personId: person.id, kind: 'buy' });
    return { person, project };
  };
  const consent = (personId: string) =>
    t.store.addConsent({ networkId: t.network.id, personId, purpose: 'buyer_search', channel: 'email', proof: 'demande écrite inventée', givenAt: new Date('2027-02-01T09:00:00.000Z') });
  const refusals = async () => (await t.journal.all()).filter((e) => e.type === 'acces.refuse' || e.type === 'recherche.refuse');
  return { ...t, call, buyer, consent, refusals };
}

describeWithSqlite('BR39 · routes de la recherche en langage courant', () => {
  it('la phrase rend les seuls biens diffusables du réseau, chacun avec les mots qui le justifient [R420] [R421]', async () => {
    const t = await setup();
    // Un bien du réseau sans mandat : jamais montré, même s'il répond à la phrase.
    await t.store.createProperty({ networkId: t.network.id, agentId: t.alexId, reference: 'REF-T-2', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 70, rooms: 3, priceEur: 210000, status: 'available' });
    for (const who of ['alex', 'direction'] as const) {
      const r = await t.call(who, '/recherche/phrase', { phrase: PHRASE });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ ok: true, mode: 'essai', sent: false });
      expect(r.body.data.results.map((x: { reference: string }) => x.reference)).toEqual(['REF-T-1']);
      const [found] = r.body.data.results;
      expect(found.propertyId).toBe(t.propertyId);
      expect(found.reasons.length).toBeGreaterThan(0);
      for (const reason of found.reasons) expect(reason.from).toMatch(/^« .+ »$/);
      // Chaque critère porte les mots exacts de la phrase [R420].
      for (const c of r.body.data.search.criteria) expect(PHRASE.slice(c.source.start, c.source.end)).toBe(c.source.words);
      // Ni adresse ni personne dans un résultat.
      expect(Object.keys(found).sort()).toEqual(['city', 'kind', 'neighbourOf', 'preferencesMet', 'priceEur', 'propertyId', 'reasons', 'reference', 'rooms', 'status', 'surfaceM2']);
    }
    // Un agent d'un autre réseau ne voit rien du nôtre.
    const ailleurs = await t.call('ailleurs', '/recherche/phrase', { phrase: PHRASE });
    expect(JSON.stringify(ailleurs.body)).not.toContain('REF-T-1');
    // Pendant le délai de rétractation, le bien n'est pas diffusable : rien n'est montré [R421].
    t.setClock(new Date('2027-02-20T09:00:00.000Z'));
    expect((await t.call('alex', '/recherche/phrase', { phrase: PHRASE })).body.data.results).toEqual([]);
  });

  it('les gestes de la personne ajustent la recherche sur le serveur : refus d\'un bien, commune voisine [R423] [R424]', async () => {
    const t = await setup();
    const talant = 'Maison 3 pièces à Talant, budget 250 000 €';
    const first = await t.call('alex', '/recherche/phrase', { phrase: talant });
    expect(first.body.data.results).toEqual([]);
    // Dijon est proposée comme voisine, à part et marquée ; jamais ajoutée sans un geste.
    expect(first.body.data.proposedNeighbours).toContainEqual({ commune: 'Dijon', of: 'Talant' });
    expect(first.body.data.neighbours.map((x: { reference: string; neighbourOf: string }) => [x.reference, x.neighbourOf])).toEqual([['REF-T-1', 'Talant']]);
    expect(first.body.data.search.criteria.filter((c: { field: string }) => c.field === 'communes').map((c: { value: string }) => c.value)).toEqual(['Talant']);
    const accepted = await t.call('alex', '/recherche/phrase', { phrase: talant, steps: [{ acceptNeighbour: 'Dijon' }] });
    expect(accepted.body.data.results.map((x: { reference: string }) => x.reference)).toEqual(['REF-T-1']);
    // Une commune qui n'a pas été proposée ne s'ajoute pas.
    const stranger = await t.call('alex', '/recherche/phrase', { phrase: talant, steps: [{ acceptNeighbour: 'Beaune' }] });
    expect(stranger.body.data.search.criteria.filter((c: { field: string }) => c.field === 'communes').map((c: { value: string }) => c.value)).toEqual(['Talant']);
    // Le bien refusé « trop cher » ne revient plus, et le budget se resserre sous son prix.
    const refused = await t.call('alex', '/recherche/phrase', { phrase: PHRASE, steps: [{ refuse: t.propertyId, reason: 'trop_cher' }] });
    expect(refused.body.data.results).toEqual([]);
    expect(refused.body.data.search.refusedPropertyIds).toEqual([t.propertyId]);
    const budget = refused.body.data.search.criteria.filter((c: { field: string }) => c.field === 'budgetMaxEur');
    expect(budget.at(-1).value).toBeLessThan(200_000);
  });

  it('ranger : seulement avec l\'accord en cours de la personne, par l\'agent de la fiche ou la direction ; la phrase n\'est pas gardée [R422] [R16]', async () => {
    const t = await setup();
    const { person, project } = await t.buyer(t.alexId);
    const path = `/recherche/projets/${project.id}/phrase`;
    const secret = 'Maison 3 pièces à Dijon, budget 250 000 €, pour mon fils Théo';
    // Sans accord : refus R422, au journal, rien de rangé.
    expect((await t.call('alex', path, { phrase: secret })).body).toMatchObject({ ok: false, rule: 'R422', code: 'sans_accord' });
    expect((await t.call('alex', path, { phrase: secret })).status).toBe(409);
    expect(Number((await t.db.first<{ n: number }>('SELECT count(*) AS n FROM phrase_searches'))!.n)).toBe(0);
    await t.consent(person.id);
    // Un autre agent ne range rien dans la fiche d'Alex [R16].
    const sam = await t.call('sam', path, { phrase: secret });
    expect(sam.status).toBe(403);
    expect(sam.body.rule).toBe('R16');
    // Un projet inconnu : 404, rien n'est dit de son existence ; un agent d'un autre réseau est refusé.
    expect((await t.call('alex', '/recherche/projets/inconnu/phrase', { phrase: secret })).status).toBe(404);
    expect([403, 404]).toContain((await t.call('ailleurs', path, { phrase: secret })).status);
    // L'agent de la fiche range ; la fiche acquéreur a ses critères, et la phrase n'est gardée nulle part.
    const saved = await t.call('alex', path, { phrase: secret, steps: [{ refuse: t.propertyId, reason: 'trop_petit' }] });
    expect(saved.status).toBe(200);
    expect(saved.body.data.buyerSearchId).toEqual(expect.any(String));
    expect(saved.body.data.criteria).toBeGreaterThan(0);
    const row = await t.db.first<{ criteria: string }>('SELECT criteria FROM phrase_searches WHERE project_id = ?', [project.id]);
    expect(row!.criteria).not.toContain('Théo');
    expect(JSON.stringify(await t.journal.all())).not.toContain('Théo');
    const fiche = await t.call('alex', `/acquereurs/projets/${project.id}/recherche`);
    expect(fiche.body).toMatchObject({ ok: true, data: { value: { version: 1, search: { propertyKinds: ['house'], communes: ['Dijon'], budgetMaxEur: 250000, roomsMin: 3 } } } });
    // Le bien de 62 m² refusé « trop petit » : la surface demandée passe au-dessus [R424].
    expect(fiche.body.data.value.search.surfaceMinM2).toBeGreaterThan(62);
    // La direction range aussi.
    expect((await t.call('direction', path, { phrase: 'Maison à Dijon, budget 260 000 €' })).status).toBe(200);
    // Chaque refus est au journal, et la chaîne tient.
    expect((await t.refusals()).length).toBeGreaterThanOrEqual(4);
    expect((await verifyChain(await t.journal.all())).ok).toBe(true);
  });

  it('un autre rôle est refusé avant que le corps soit lu, et le refus va au journal [R16]', async () => {
    const t = await setup();
    const { project } = await t.buyer(t.alexId);
    for (const path of ['/recherche/phrase', `/recherche/projets/${project.id}/phrase`]) {
      const before = (await t.refusals()).length;
      const r = await t.call('compliance', path, undefined, '{pas du json');
      expect(r.status).toBe(403);
      expect(r.body).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
      const after = await t.refusals();
      expect(after.length).toBe(before + 1);
      expect(after.at(-1)!.data).toMatchObject({ rule: 'R16', kind: 'recherche_phrase' });
    }
  });

  it('une saisie mal formée est refusée, jamais tronquée ni devinée', async () => {
    const t = await setup();
    const bad = async (body: unknown, raw?: string, query?: string) => (await t.call('alex', '/recherche/phrase', body, raw, query)).body;
    expect(await bad(undefined, '{pas du json')).toMatchObject({ ok: false, code: 'invalid_body' });
    expect(await bad({ phrase: PHRASE, criteria: [] })).toMatchObject({ code: 'unknown_field', field: 'criteria' });
    expect(await bad({ phrase: PHRASE }, undefined, '?commune=Dijon')).toMatchObject({ code: 'unknown_field', field: 'commune' });
    expect(await bad({})).toMatchObject({ code: 'bad_phrase' });
    expect(await bad({ phrase: '   ' })).toMatchObject({ code: 'bad_phrase' });
    expect(await bad({ phrase: 42 })).toMatchObject({ code: 'bad_phrase' });
    expect(await bad({ phrase: 'm'.repeat(501) })).toMatchObject({ code: 'bad_phrase', max: 500 });
    for (const steps of [
      'refus',
      [{ refuse: t.propertyId }],
      [{ refuse: t.propertyId, reason: 'moche' }],
      [{ refuse: t.propertyId, reason: 'manque' }],
      [{ refuse: t.propertyId, reason: 'trop_cher', feature: 'garden' }],
      [{ refuse: t.propertyId, reason: 'manque', feature: 'licorne' }],
      [{ refuse: '../x', reason: 'trop_cher' }],
      [{ acceptNeighbour: 'Dijon', refuse: t.propertyId }],
      [{ acceptNeighbour: '' }],
      [null],
      Array.from({ length: 51 }, () => ({ acceptNeighbour: 'Dijon' })),
    ]) {
      expect(await bad({ phrase: PHRASE, steps }), JSON.stringify(steps).slice(0, 80)).toMatchObject({ code: 'bad_steps' });
    }
    // Un manque nommé est accepté.
    expect((await t.call('alex', '/recherche/phrase', { phrase: PHRASE, steps: [{ refuse: t.propertyId, reason: 'manque', feature: 'garden' }] })).status).toBe(200);
  });
});
