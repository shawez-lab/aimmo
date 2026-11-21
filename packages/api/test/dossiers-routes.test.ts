import { expect, it } from 'vitest';
import type { Viewer } from '@aimmo/core';
import { DOSSIERS_JOB, R2PieceStore, dossierRoutes, dossiersJob, syncDossiers, type DossierServices } from '../src/dossiers.ts';
import { offreRoutes, type OffreServices } from '../src/offres.ts';
import { PROOF, setupDossier, type DossierKind } from '../../core/test/dossiers-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

const ACT_PROOF = 'preuves/0b6f1d2e-7777-4a2b-8c3d-000000000001.pdf';
const at9 = (day: string) => new Date(`${day}T08:00:00.000Z`);

async function setup(kind: DossierKind = 'appartement') {
  const t = await setupDossier(kind);
  // Les preuves citées sont rangées : les routes refusent une référence qui ne l'est pas (N13).
  t.storage.refs.add(PROOF);
  t.storage.refs.add(ACT_PROOF);
  const s: DossierServices = { db: t.db, journal: t.journal, acces: t.acces, now: t.now, pieces: t.storage };
  const routes = [...dossierRoutes(), ...offreRoutes()];
  const call = async (viewer: Viewer, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const route = routes.find((r) => r.method === method && r.pattern.test(path));
    if (!route) throw new Error(`route inconnue ${method} ${path}`);
    const params = (route.pattern.exec(path) ?? []).slice(1);
    const request = new Request(`https://api.exemple.test/v1${path}`, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const response = await (route.handle as (s: DossierServices & OffreServices, v: Viewer, p: string[], r: Request) => Promise<Response>)(s, viewer, params, request);
    return { status: response.status, body: (await response.json()) as { ok: boolean; mode?: string; data?: any; code?: string; rule?: string; tasks?: unknown[] } };
  };
  return { ...t, s, call };
}

it('le stockage R2 dit seulement si une référence existe', async () => {
  const store = new R2PieceStore({ head: async (key: string) => (key === 'dossiers/a/b.pdf' ? { size: 1 } : null) });
  expect(await store.has('dossiers/a/b.pdf')).toBe(true);
  expect(await store.has('dossiers/a/c.pdf')).toBe(false);
});

describeWithSqlite('N08 · routes de M10', () => {
  it('[R16] [R62] W26 : l’accueil lit ce qu’il y a à tenir, pour l’agent seul, même sans le stockage des pièces', async () => {
    const t = await setup();
    const route = offreRoutes().find((r) => r.name === 'offres.a_tenir')!;
    expect(route.pattern.test('/offres/a-tenir')).toBe(true);
    const noPieces = { db: t.db, journal: t.journal, acces: t.acces, now: t.now } as unknown as OffreServices;
    const read = async (v: Viewer) => {
      const r = await route.handle(noPieces, v, [], new Request('https://api.exemple.test/v1/offres/a-tenir'));
      return { status: r.status, body: (await r.json()) as { ok: boolean; code?: string; data?: unknown } };
    };
    expect(await read(t.agent)).toEqual({ status: 200, body: { ok: true, mode: 'essai', data: { fonds: [], financement: [], echeances: [] } } });
    expect(await read(t.direction)).toMatchObject({ status: 403, body: { ok: false, code: 'not_agent' } });
  });

  it('[R16] [R233] la route d’arrêt : l’agent arrête, la direction lit, un refus est un refus', async () => {
    const t = await setup();
    expect((await t.call(t.agent, 'GET', `/dossiers/${t.fileId}/arret`)).body.data).toBeNull();
    expect(await t.call(t.direction, 'POST', `/dossiers/${t.fileId}/arret`, { reason: 'autre', proofRef: ACT_PROOF })).toMatchObject({ status: 403, body: { ok: false, rule: 'R16' } });
    expect((await t.call(t.agent, 'POST', `/dossiers/${t.fileId}/arret`, { reason: 'caprice', proofRef: ACT_PROOF })).body).toMatchObject({ ok: false, code: 'bad_reason' });
    expect(await t.call(t.agent, 'POST', `/dossiers/${t.fileId}/arret`, { reason: 'autre', proofRef: ACT_PROOF })).toMatchObject({ status: 200, body: { ok: true, data: { reason: 'autre' } } });
    expect((await t.call(t.direction, 'GET', `/dossiers/${t.fileId}/arret`)).body.data).toMatchObject({ reason: 'autre' });
    const again = await t.call(t.agent, 'POST', `/dossiers/${t.fileId}/dates`, { kind: 'compromis_signe', day: '2027-03-01', proofRef: PROOF });
    expect(again.body).toMatchObject({ ok: false, code: 'file_stopped' });
    expect(again.status).toBe(400);
  });

  for (const kind of ['appartement', 'maison', 'terrain'] as DossierKind[]) {
    it(`dossier test « ${kind} » complet, sans pièce manquante, suivi par les routes de l’offre acceptée à l’acte`, async () => {
      const t = await setup(kind);
      await t.verifyBuyer();
      expect((await t.call(t.agent, 'POST', `/offres/dossiers/${t.fileId}/compromis`)).status).toBe(200);
      t.setClock(at9('2027-03-11'));
      for (const [k, day] of [['compromis_signe', '2027-03-10'], ['notification_acquereur', '2027-03-11'], ['dia_recue', '2027-03-11'], ['date_limite_pret', '2027-05-10'], ['etat_date_attendu', '2027-05-20'], ['acte_prevu', '2027-06-10']]) {
        expect((await t.call(t.agent, 'POST', `/dossiers/${t.fileId}/dates`, { kind: k, day, proofRef: PROOF })).status).toBe(200);
      }
      const pieces = await t.call(t.agent, 'GET', `/dossiers/${t.fileId}/pieces`);
      expect(pieces.body).toMatchObject({ ok: true, mode: 'essai', data: { complete: false } });
      for (const piece of pieces.body.data.missing as string[]) {
        expect((await t.call(t.agent, 'POST', `/dossiers/${t.fileId}/pieces`, { piece, ref: t.upload(), issuedOn: '2027-03-11' })).status).toBe(200);
      }
      // 3 dossiers complets, sans pièce manquante.
      expect((await t.call(t.agent, 'GET', `/dossiers/${t.fileId}/pieces`)).body.data).toMatchObject({ missing: [], complete: true });
      t.setClock(at9('2027-05-16'));
      expect((await t.call(t.agent, 'POST', `/dossiers/${t.fileId}/financement`, { step: 'offre_pret_emise', day: '2027-05-15', declaredBy: 'acquereur' })).status).toBe(200);
      t.setClock(at9('2027-05-27'));
      expect((await t.call(t.agent, 'POST', `/dossiers/${t.fileId}/financement`, { step: 'offre_pret_acceptee', day: '2027-05-26', declaredBy: 'acquereur' })).status).toBe(200);
      const path = await t.call(t.direction, 'GET', `/dossiers/${t.fileId}/chemin`);
      expect(path.body.data.path).toMatchObject({ holder: null, conditional: false, late: false });
      t.setClock(at9('2027-06-11'));
      const act = await t.call(t.agent, 'POST', `/dossiers/${t.fileId}/acte`, { signedOn: '2027-06-10', proofRef: ACT_PROOF });
      expect(act.body).toMatchObject({ ok: true, data: { commission: { feeEur: 10000 }, aftersale: 'a_demarrer' } });
      expect((await t.call(t.direction, 'GET', `/dossiers/${t.fileId}/acte`)).body.data).toMatchObject({ signedOn: '2027-06-10' });
    });
  }

  it('[R16] chaque route sous les droits : un autre agent est refusé, le refus au journal ; corps faux refusé', async () => {
    const t = await setup();
    for (const [method, path, body] of [
      ['GET', `/dossiers/${t.fileId}/pieces`, undefined], ['POST', `/dossiers/${t.fileId}/pieces`, { piece: 'dpe', ref: 'x', issuedOn: '2027-03-01' }],
      ['GET', `/dossiers/${t.fileId}/echeancier`, undefined], ['POST', `/dossiers/${t.fileId}/dates`, { kind: 'compromis_signe', day: '2027-03-01', proofRef: PROOF }],
      ['GET', `/dossiers/${t.fileId}/financement`, undefined], ['POST', `/dossiers/${t.fileId}/financement`, { step: 'demande_deposee', day: '2027-03-01', declaredBy: 'acquereur' }],
      ['GET', `/dossiers/${t.fileId}/acte`, undefined], ['POST', `/dossiers/${t.fileId}/acte`, { signedOn: '2027-03-01', proofRef: ACT_PROOF }],
      ['GET', `/dossiers/${t.fileId}/chemin`, undefined], ['GET', `/dossiers/${t.fileId}/relances`, undefined],
      ['GET', `/dossiers/${t.fileId}/conditions`, undefined], ['POST', `/dossiers/${t.fileId}/conditions`, { kind: 'autre', responsible: 'acquereur', day: '2027-06-01', state: 'en_attente', proofRef: PROOF }],
    ] as const) {
      const count = async () => (await t.journal.bySubject(`sale_file:${t.fileId}`)).filter((e) => e.type === 'acces.refuse').length;
      const before = await count();
      const r = await t.call(t.sam, method, path, body);
      expect([method, path, r.status, r.body.rule]).toEqual([method, path, 403, 'R16']);
      // Chaque refus : exactement une ligne de plus au journal du dossier.
      expect([method, path, (await count()) - before]).toEqual([method, path, 1]);
    }
    const all = async () => (await t.journal.all()).filter((e) => e.type === 'acces.refuse' && e.actor === 'direction:direction-1');
    expect((await t.call(t.direction, 'GET', '/dossiers/taches')).status).toBe(403);
    expect((await all()).filter((e) => e.data.kind === 'sale_file_tasks')).toHaveLength(1);
    expect((await t.call(t.direction, 'GET', '/dossiers/alertes')).status).toBe(403);
    expect((await all()).filter((e) => e.data.kind === 'sale_file_financing_alerts')).toHaveLength(1);
    expect((await t.call(t.agent, 'GET', '/dossiers/alertes')).body).toMatchObject({ ok: true, data: { financement: [], fonds: [], conditions: [] } });
    expect((await t.call(t.agent, 'GET', '/dossiers/inconnu/pieces')).status).toBe(404);
    const route = dossierRoutes().find((r) => r.name === 'dossiers.date')!;
    const res = await route.handle(t.s, t.agent, [t.fileId], new Request('https://api.exemple.test/v1/x', { method: 'POST', body: 'pas du json' }));
    expect(res.status).toBe(400);
  });

  it('chaque panne du passage est écrite au journal sous son étape, et la première est relancée', async () => {
    const t = await setup();
    const broken: DossierServices = { ...t.s, db: { ...t.db, exec: (q: string) => t.db.exec(q), run: (q: string, p?: never) => t.db.run(q, p), first: (q: string, p?: never) => t.db.first(q, p), all: async (q: string, p?: never) => { if (/FROM sale_files f JOIN properties/.test(q)) throw new Error('panne'); return t.db.all(q, p); } } as never };
    t.setClock(at9('2027-03-15'));
    await expect(syncDossiers(broken, t.network.id)).rejects.toThrow('panne');
    const errors = (await t.journal.all()).filter((e) => /dossiers\.passage\./.test(JSON.stringify(e.data)));
    expect(errors.length).toBeGreaterThanOrEqual(3);
  });

  it('le passage des dossiers, rejoué, n’ajoute rien ; il ne prépare aucune relance le dimanche', async () => {
    const t = await setup();
    await t.startCompromis();
    t.setClock(at9('2027-03-10'));
    await t.call(t.agent, 'POST', `/dossiers/${t.fileId}/dates`, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF });
    // AU082 : une condition saisie par la route, lue par la route.
    expect((await t.call(t.agent, 'POST', `/dossiers/${t.fileId}/conditions`, { kind: 'autre', responsible: 'notaire', day: '2027-06-01', state: 'en_attente', proofRef: PROOF })).status).toBe(200);
    expect((await t.call(t.agent, 'GET', `/dossiers/${t.fileId}/conditions`)).body).toMatchObject({ ok: true, data: { lines: [{ kind: 'autre', source: 'compromis', status: 'en_attente', responsible: 'notaire', day: '2027-06-01' }] } });
    // Dimanche 14 mars : échéances oui, relances non.
    t.setClock(at9('2027-03-14'));
    const sunday = await syncDossiers(t.s, t.network.id);
    expect(sunday.deadlines).toBeGreaterThan(0);
    expect(sunday.reminders).toBe(0);
    expect((await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM sale_file_reminders'))?.n).toBe(0);
    expect(await syncDossiers(t.s, t.network.id)).toEqual({ deadlines: 0, financing: 0, funds: 0, reminders: 0, conditions: 0 });
    // La tâche planifiée : tous les jours de 9 h à 19 h.
    const job = dossiersJob(t.db, t.journal, t.storage, { now: t.now });
    expect(job).toMatchObject({ name: DOSSIERS_JOB, hours: [9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19] });
    expect((job as { weekdays?: unknown }).weekdays).toBeUndefined();
    await job.run({} as never);
    expect(await syncDossiers(t.s, t.network.id)).toEqual({ deadlines: 0, financing: 0, funds: 0, reminders: 0, conditions: 0 });
  });
});

describeWithSqlite('AU011 · routes des obligations locales', () => {
  it('[R16] [R60] la direction range un arrêté, l’agent déclare le raccordement : le dossier demande alors ses pièces', async () => {
    const t = await setup('maison');
    const zone = { postalCode: '21000', city: 'Dijon', hazard: 'termites', inZone: true, title: 'Arrêté préfectoral inventé', url: 'https://prefecture.example.fr/arretes/t', datedOn: '2026-01-01', readOn: '2027-03-01' };
    expect(await t.call(t.agent, 'POST', '/dossiers/obligations-locales', zone)).toMatchObject({ status: 403, body: { ok: false, rule: 'R16' } });
    expect(await t.call(t.direction, 'POST', '/dossiers/obligations-locales', { ...zone, url: 'http://x.fr/a' })).toMatchObject({ status: 400, body: { code: 'bad_source' } });
    expect(await t.call(t.direction, 'POST', '/dossiers/obligations-locales', zone)).toMatchObject({ status: 200, body: { ok: true, data: { inZone: true } } });
    expect(await t.call(t.agent, 'POST', `/dossiers/${t.fileId}/assainissement`, { mode: 'fosse' })).toMatchObject({ status: 400, body: { code: 'bad_mode' } });
    expect(await t.call(t.sam, 'POST', `/dossiers/${t.fileId}/assainissement`, { mode: 'non_collectif' })).toMatchObject({ status: 403, body: { rule: 'R16' } });
    expect(await t.call(t.agent, 'POST', '/dossiers/inconnu/assainissement', { mode: 'non_collectif' })).toMatchObject({ status: 404, body: { code: 'unknown_file' } });
    expect(await t.call(t.agent, 'POST', `/dossiers/${t.fileId}/assainissement`, { mode: 'non_collectif' })).toMatchObject({ status: 200, body: { ok: true, data: 'non_collectif' } });
    const pieces = await t.call(t.agent, 'GET', `/dossiers/${t.fileId}/pieces`);
    expect(pieces.body.data.missing).toEqual(expect.arrayContaining(['etat_termites', 'controle_assainissement']));
  });
});

describeWithSqlite('AU084 · route des installations du bien', () => {
  it('[R16] [R60] l’agent déclare l’électricité rénovée et l’absence de gaz : les deux diagnostics ne sont plus demandés', async () => {
    const t = await setup('maison');
    const first = await t.call(t.agent, 'GET', `/dossiers/${t.fileId}/pieces`);
    expect(first.body.data.missing).toEqual(expect.arrayContaining(['electricite', 'gaz']));
    expect(await t.call(t.sam, 'POST', `/dossiers/${t.fileId}/installations`, { installation: 'gaz', present: false, proof: 'declaration_vendeur', proofRef: PROOF })).toMatchObject({ status: 403, body: { rule: 'R16' } });
    expect(await t.call(t.agent, 'POST', '/dossiers/inconnu/installations', { installation: 'gaz', present: false, proof: 'declaration_vendeur', proofRef: PROOF })).toMatchObject({ status: 404, body: { code: 'unknown_file' } });
    expect(await t.call(t.agent, 'POST', `/dossiers/${t.fileId}/installations`, { installation: 'electricite', present: true, since: 2016, proof: 'declaration_vendeur', proofRef: 'x.pdf' })).toMatchObject({ status: 400, body: { code: 'bad_proof' } });
    expect(await t.call(t.agent, 'POST', `/dossiers/${t.fileId}/installations`, { installation: 'electricite', present: true, since: 2016, proof: 'certificat_conformite', proofRef: PROOF })).toMatchObject({ status: 200, body: { ok: true, data: { installation: 'electricite', version: 1 } } });
    expect(await t.call(t.agent, 'POST', `/dossiers/${t.fileId}/installations`, { installation: 'gaz', present: false, proof: 'declaration_vendeur', proofRef: PROOF })).toMatchObject({ status: 200 });
    const after = await t.call(t.agent, 'GET', `/dossiers/${t.fileId}/pieces`);
    expect(after.body.data.missing).not.toEqual(expect.arrayContaining(['electricite']));
    expect(after.body.data.missing).not.toEqual(expect.arrayContaining(['gaz']));
    expect(after.body.data.installations.map((r: { verdict: string }) => r.verdict)).toEqual(['recente', 'absente']);
  });
});
