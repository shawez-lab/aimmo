import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import type { Viewer } from '@aimmo/core';
import { dossierRoutes, type DossierServices } from '../src/dossiers.ts';
import { setupDossier } from '../../core/test/dossiers-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Tout est inventé.
const PDF = new TextEncoder().encode('%PDF-1.7 essai');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

async function setup(writable = true) {
  const t = await setupDossier();
  const kept = new Map<string, Uint8Array>();
  const pieces = { has: async (r: string) => kept.has(r), ...(writable ? { upload: async (k: string, b: Uint8Array) => void kept.set(k, b) } : {}) };
  const s: DossierServices = { db: t.db, journal: t.journal, acces: t.acces, now: t.now, pieces };
  const run = async (viewer: Viewer, method: 'GET' | 'POST', path: string, init: RequestInit = {}) => {
    const route = dossierRoutes().find((r) => r.method === method && r.pattern.test(path))!;
    const response = await route.handle(s, viewer, (route.pattern.exec(path) ?? []).slice(1), new Request(`https://api.exemple.test/v1${path}`, { method, ...init }));
    return { status: response.status, body: (await response.json()) as { ok: boolean; data?: any; code?: string; rule?: string } };
  };
  const put = (viewer: Viewer, body: Uint8Array, type = 'application/pdf', hash = sha(body)) => run(viewer, 'POST', `/dossiers/${t.fileId}/fichiers`, { headers: { 'content-type': type, 'x-aimmo-sha256': hash }, body });
  return { ...t, kept, run, put };
}

describeWithSqlite('N12 · dépôt d’une pièce du dossier', () => {
  it('[R60] le fichier déposé se range comme pièce, avec la référence rendue ; déposer seul ne joint rien', async () => {
    const t = await setup();
    const up = await t.put(t.agent, PDF);
    expect(up.status).toBe(200);
    const ref = up.body.data.ref as string;
    expect(ref.startsWith(`dossiers/${t.fileId}/`)).toBe(true);
    expect(t.kept.has(ref)).toBe(true);
    const before = (await t.run(t.agent, 'GET', `/dossiers/${t.fileId}/pieces`)).body.data;
    expect(before.lines.every((l: { received: unknown }) => l.received === null)).toBe(true);
    const add = await t.run(t.agent, 'POST', `/dossiers/${t.fileId}/pieces`, { headers: { 'content-type': 'application/json' }, body: JSON.stringify({ piece: before.missing[0], ref, issuedOn: '2027-03-01' }) });
    expect(add.status).toBe(200);
    expect(add.body.data.missing).not.toContain(before.missing[0]);
  });

  it('[R16] seul l’agent du bien dépose : refus avant de lire le fichier, écrit au journal', async () => {
    const t = await setup();
    const refusals = async () => (await t.journal.all()).filter((e) => e.type === 'acces.refuse').length;
    for (const viewer of [t.sam, t.direction]) {
      const before = await refusals();
      expect((await t.put(viewer, PDF)).status).toBe(403);
      expect(await refusals()).toBeGreaterThan(before);
    }
    expect(t.kept.size).toBe(0);
  });

  it('[R13] un fichier déguisé, vide ou abîmé ne passe pas, et le journal ne porte aucun contenu', async () => {
    const t = await setup();
    expect((await t.put(t.agent, new TextEncoder().encode('une note'), 'text/plain')).status).toBe(415);
    expect((await t.put(t.agent, new TextEncoder().encode('<html>'))).status).toBe(415);
    expect((await t.put(t.agent, new Uint8Array())).body.code).toBe('fichier_vide');
    expect((await t.put(t.agent, PDF, 'application/pdf', 'a'.repeat(64))).body.code).toBe('empreinte_differente');
    expect(t.kept.size).toBe(0);
    expect(JSON.stringify((await t.journal.all()).filter((e) => e.type.startsWith('dossier.depot')))).not.toContain('une note');
  });

  it('un dossier clos par l’acte refuse le dépôt, sans ranger de fichier', async () => {
    const t = await setup();
    await t.db.run('INSERT INTO sale_file_closings (file_id, network_id, signed_on, proof_ref, aftersale, at, by) VALUES (?, ?, ?, ?, \'a_demarrer\', ?, ?)', [t.fileId, t.network.id, '2027-03-01', 'preuves/0b6f1d2e-7777-4a2b-8c3d-000000000001.pdf', '2027-03-01T12:00:00.000Z', 'test']);
    expect((await t.put(t.agent, PDF)).body.code).toBe('closed');
    expect(t.kept.size).toBe(0);
  });

  it('sans stockage en écriture, le dépôt est fermé et le dit', async () => {
    const t = await setup(false);
    const closed = await t.put(t.agent, PDF);
    expect(closed.status).toBe(503);
    expect(closed.body.code).toBe('depot_ferme');
  });

  it('[R10] N13 : la preuve déposée vaut pour une date et pour l’acte ; une référence qui n’est pas rangée est refusée', async () => {
    const t = await setup();
    const json = (body: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await t.verifyBuyer();
    await t.startCompromis();
    const up = await t.run(t.agent, 'POST', `/dossiers/${t.fileId}/preuves`, { headers: { 'content-type': 'application/pdf', 'x-aimmo-sha256': sha(PDF) }, body: PDF });
    expect(up.status).toBe(200);
    const proofRef = up.body.data.ref as string;
    expect(proofRef).toMatch(/^preuves\/[0-9a-f-]{36}\.pdf$/);
    const lost = 'preuves/0b6f1d2e-7777-4a2b-8c3d-00000000dead.pdf';
    const date = (ref: string) => t.run(t.agent, 'POST', `/dossiers/${t.fileId}/dates`, json({ kind: 'compromis_signe', day: '2027-03-01', proofRef: ref }));
    expect((await date(lost)).body.code).toBe('not_stored');
    expect((await date('preuves/inventee.pdf')).body.code).toBe('bad_proof');
    expect((await date(proofRef)).status).toBe(200);
    expect((await t.run(t.agent, 'POST', `/dossiers/${t.fileId}/acte`, json({ signedOn: '2027-03-01', proofRef: lost }))).body.code).toBe('not_stored');
  });

  it('[R16] N13 : seul l’agent du bien dépose une preuve ; un fichier texte n’en est pas une ici', async () => {
    const t = await setup();
    const proof = (viewer: Viewer, type = 'application/pdf') => t.run(viewer, 'POST', `/dossiers/${t.fileId}/preuves`, { headers: { 'content-type': type, 'x-aimmo-sha256': sha(PDF) }, body: PDF });
    for (const viewer of [t.sam, t.direction]) expect((await proof(viewer)).status).toBe(403);
    expect((await proof(t.agent, 'text/plain')).status).toBe(415);
    expect(t.kept.size).toBe(0);
  });

  it('N13 : un dossier clos par l’acte ne reçoit plus ni date ni étape du prêt', async () => {
    const t = await setup();
    const json = (body: unknown) => ({ headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await t.db.run('INSERT INTO sale_file_closings (file_id, network_id, signed_on, proof_ref, aftersale, at, by) VALUES (?, ?, ?, ?, \'a_demarrer\', ?, ?)', [t.fileId, t.network.id, '2027-03-01', 'preuves/0b6f1d2e-7777-4a2b-8c3d-000000000001.pdf', '2027-03-01T12:00:00.000Z', 'test']);
    expect((await t.run(t.agent, 'POST', `/dossiers/${t.fileId}/dates`, json({ kind: 'acte_prevu', day: '2027-04-01', proofRef: 'preuves/0b6f1d2e-7777-4a2b-8c3d-000000000001.pdf' }))).body.code).toBe('closed');
    expect((await t.run(t.agent, 'POST', `/dossiers/${t.fileId}/financement`, json({ step: 'refus', day: '2027-03-01', declaredBy: 'acquereur' }))).body.code).toBe('closed');
  });

  it('[R63] N13 : une clôture coupée d’autrefois, sans commission, reçoit encore la preuve qui permet de la reprendre', async () => {
    const t = await setup();
    const closing = 'INSERT INTO sale_file_closings (file_id, network_id, signed_on, proof_ref, aftersale, at, by) VALUES (?, ?, ?, ?, \'a_demarrer\', ?, ?)';
    await t.db.run(closing, [t.fileId, t.network.id, '2027-03-01', 'preuves/0b6f1d2e-7777-4a2b-8c3d-000000000001.pdf', '2027-03-01T12:00:00.000Z', 'test']);
    expect((await t.run(t.agent, 'GET', `/dossiers/${t.fileId}/acte`)).body.data).toBeNull();
    const up = await t.run(t.agent, 'POST', `/dossiers/${t.fileId}/preuves`, { headers: { 'content-type': 'application/pdf', 'x-aimmo-sha256': sha(PDF) }, body: PDF });
    expect(up.status).toBe(200);
    expect((await t.put(t.agent, PDF)).body.code).toBe('closed');
  });
});
