import { expect, it } from 'vitest';
import { dossiers, pilotage, type Viewer } from '@aimmo/core';
import { pilotageJobs, pilotageRoutes, type PilotageServices } from '../src/pilotage.ts';
import { PROOF, setupDossier } from '../../core/test/dossiers-jeu.ts';
import { describeWithSqlite } from '../../core/test/sqlite.ts';

// Tout est inventé : agents, dossiers, preuves, pièces d'agent.
const ACT_PROOF = 'preuves/0b6f1d2e-7777-4a2b-8c3d-000000000001.pdf';
const at9 = (day: string) => new Date(`${day}T08:00:00.000Z`);

async function setup() {
  const t = await setupDossier('appartement');
  const s: PilotageServices = { db: t.db, journal: t.journal, acces: t.acces, now: t.now };
  const routes = pilotageRoutes();
  const call = async (viewer: Viewer, method: 'GET' | 'POST', path: string, body?: unknown) => {
    const route = routes.find((r) => r.method === method && r.pattern.test(path.split('?')[0]!));
    if (!route) throw new Error(`route inconnue ${method} ${path}`);
    const params = (route.pattern.exec(path.split('?')[0]!) ?? []).slice(1);
    const request = new Request(`https://api.exemple.test/v1${path}`, body === undefined ? { method } : { method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const response = await route.handle(s, viewer, params, request);
    const type = response.headers.get('content-type') ?? '';
    return { status: response.status, type, text: type.startsWith('text/csv') ? await response.text() : '', body: type.startsWith('application/json') ? ((await response.json()) as { ok: boolean; data?: any; code?: string; rule?: string }) : null };
  };
  const runJobs = async () => {
    for (const j of pilotageJobs(t.db, t.journal, { now: t.now })) await j.run({ job: j.name, slot: t.now().toISOString().slice(0, 13), at: t.now() });
  };
  /** Le dossier mené jusqu'au compromis du 10 mars 2027, puis jusqu'à l'acte du 10 juin 2027. */
  const compromis = async () => {
    await t.startCompromis();
    t.setClock(at9('2027-03-11'));
    const e = new dossiers.Echeancier(t.db, t.acces, t.journal, { now: t.now });
    for (const [kind, day] of [['compromis_signe', '2027-03-10'], ['notification_acquereur', '2027-03-11'], ['dia_recue', '2027-03-11'], ['date_limite_pret', '2027-05-10'], ['etat_date_attendu', '2027-05-20'], ['acte_prevu', '2027-06-10']] as const) {
      const r = await e.record(t.agent, t.fileId, { kind, day, proofRef: PROOF });
      if (!r.ok) throw new Error(r.code);
    }
  };
  const acte = async () => {
    const status = await t.pieces.status(t.agent, t.fileId);
    if (!status.ok) throw new Error(status.code);
    for (const piece of status.value.missing) {
      const r = await t.pieces.add(t.agent, t.fileId, { piece, ref: t.upload(), issuedOn: '2027-03-11' });
      if (!r.ok) throw new Error(r.code);
    }
    t.setClock(at9('2027-06-11'));
    const r = await new dossiers.ActeVente(t.db, t.acces, t.journal, t.storage, { now: t.now }).record(t.agent, t.fileId, { signedOn: '2027-06-10', proofRef: ACT_PROOF });
    if (!r.ok) throw new Error(r.code);
  };
  const compliance: Viewer = { ...t.direction, role: 'compliance', userId: 'conformite-1' };
  return { ...t, s, call, runJobs, compromis, acte, compliance };
}

describeWithSqlite('K08 · routes et passages de M13', () => {
  it('[R16] chaque route refuse qui n’a pas le droit, et le refus est au journal', async () => {
    const t = await setup();
    const before = (await t.journal.all()).filter((e) => e.type === 'acces.refuse').length;
    const reads = ['/pilotage/reseau?du=2027-06-01&au=2027-06-30', '/pilotage/alertes', '/pilotage/factures/brouillons', '/pilotage/reversements', '/pilotage/export-quotidien?jour=2027-06-10', '/pilotage/factures/export?du=2027-06-01&au=2027-06-30'];
    for (const path of reads) {
      for (const v of [t.agent, t.compliance]) expect([path, v.role, (await t.call(v, 'GET', path)).status]).toEqual([path, v.role, 403]);
    }
    expect([403, 404]).toContain((await t.call(t.compliance, 'GET', '/pilotage/mes-chiffres?du=2027-06-01&au=2027-06-30')).status);
    // Un agent ne lit pas les chiffres d'un autre agent [R68].
    expect((await t.call(t.agent, 'GET', `/pilotage/mes-chiffres?du=2027-06-01&au=2027-06-30&agent=${t.sam.userId}`)).status).toBe(403);
    expect((await t.call(t.agent, 'POST', '/pilotage/grille', { validFrom: '2027-03-01', defaultRateBp: 9000 })).status).toBe(403);
    expect((await t.call(t.agent, 'POST', '/pilotage/reglages', { dropAlertBp: 2000 })).status).toBe(403);
    const after = (await t.journal.all()).filter((e) => e.type === 'acces.refuse').length;
    expect(after - before).toBeGreaterThanOrEqual(reads.length * 2 + 4);
  });

  it('[R16] [R210] le compteur de la preuve : la direction le lit, l’agent et la conformité non', async () => {
    const t = await setup();
    const read = await t.call(t.direction, 'GET', '/pilotage/preuve');
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ ok: true, data: { startMonth: '2027-01', target: 10, requiredMonths: 6 } });
    expect((await t.call(t.agent, 'GET', '/pilotage/preuve')).status).toBe(403);
    expect((await t.call(t.compliance, 'GET', '/pilotage/preuve')).status).toBe(403);
  });

  it('[R16] [R214] les indicateurs du parcours : la direction les lit, l’agent et la conformité non', async () => {
    const t = await setup();
    const read = await t.call(t.direction, 'GET', '/pilotage/parcours?du=2027-03-01&au=2027-03-31');
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ ok: true, data: { from: '2027-03-01', to: '2027-03-31' } });
    expect((await t.call(t.agent, 'GET', '/pilotage/parcours?du=2027-03-01&au=2027-03-31')).status).toBe(403);
    expect((await t.call(t.compliance, 'GET', '/pilotage/parcours?du=2027-03-01&au=2027-03-31')).status).toBe(403);
    expect((await t.call(t.direction, 'GET', '/pilotage/parcours?du=2027-03-31&au=2027-03-01')).status).toBe(400);
  });

  it('[R16] [R215] les indicateurs du réseau : agents actifs pour la direction, zones aussi pour l’agent, jamais pour la conformité', async () => {
    const t = await setup();
    const passe = 'mois=2020-01';
    expect((await t.call(t.direction, 'GET', `/pilotage/agents-actifs?${passe}`)).status).toBe(200);
    expect((await t.call(t.agent, 'GET', `/pilotage/agents-actifs?${passe}`)).status).toBe(403);
    expect((await t.call(t.compliance, 'GET', `/pilotage/agents-actifs?${passe}`)).status).toBe(403);
    expect((await t.call(t.agent, 'GET', `/pilotage/contacts-par-zone?${passe}`)).status).toBe(200);
    expect((await t.call(t.direction, 'GET', `/pilotage/contacts-par-zone?${passe}`)).status).toBe(200);
    expect((await t.call(t.compliance, 'GET', `/pilotage/contacts-par-zone?${passe}`)).status).toBe(403);
    expect((await t.call(t.direction, 'GET', '/pilotage/contacts-par-zone?mois=2020-13')).status).toBe(400);
    expect((await t.call(t.direction, 'GET', '/pilotage/contacts-par-zone?mois=2999-01')).status).toBe(409);
    expect((await t.call(t.direction, 'GET', `/pilotage/engagements-tenus?${passe}`)).status).toBe(200);
    expect((await t.call(t.agent, 'GET', `/pilotage/engagements-tenus?${passe}`)).status).toBe(403);
    expect((await t.call(t.compliance, 'GET', `/pilotage/engagements-tenus?${passe}`)).status).toBe(403);
    expect((await t.call(t.direction, 'GET', '/pilotage/engagements-tenus?mois=2999-01')).status).toBe(409);
    expect((await t.call(t.direction, 'GET', '/pilotage/temps-gagne/reseau?semaine=2020-01-06')).status).toBe(200);
    expect((await t.call(t.agent, 'GET', '/pilotage/temps-gagne/reseau?semaine=2020-01-06')).status).toBe(403);
    expect((await t.call(t.agent, 'GET', '/pilotage/temps-gagne?semaine=2020-01-06')).status).toBe(200);
    expect((await t.call(t.direction, 'GET', '/pilotage/temps-gagne?semaine=2020-01-06')).status).toBe(403);
    expect((await t.call(t.agent, 'POST', '/pilotage/temps-gagne', { week: '2020-01-06', minutes: 90 })).body).toMatchObject({ ok: false, rule: 'R217', code: 'week_before_entry' });
    await t.db.run('UPDATE agents SET created_at = ? WHERE id = ?', ['2019-01-01T00:00:00.000Z', t.agent.userId]);
    expect((await t.call(t.agent, 'POST', '/pilotage/temps-gagne', { week: '2020-01-06', minutes: 90 })).body).toMatchObject({ ok: true, data: { minutes: 90, version: 1 } });
    expect((await t.call(t.agent, 'POST', '/pilotage/temps-gagne', { week: '2020-01-07', minutes: 90 })).status).toBe(400);
    expect((await t.call(t.agent, 'POST', '/pilotage/temps-gagne', { week: '2999-01-07', minutes: 90 })).status).toBe(409);
    const disponibilite = await t.call(t.direction, 'GET', `/pilotage/disponibilite?${passe}`);
    expect(disponibilite.status).toBe(200);
    expect(disponibilite.body).toMatchObject({ ok: true, data: { connected: false, targetPercent: 99.9, services: [{ service: 'site', measured: false, reason: 'not_connected' }, { service: 'api', measured: false }, { service: 'application', measured: false }] } });
    expect((await t.call(t.agent, 'GET', `/pilotage/disponibilite?${passe}`)).status).toBe(403);
    expect((await t.call(t.compliance, 'GET', `/pilotage/disponibilite?${passe}`)).status).toBe(403);
    expect((await t.call(t.direction, 'GET', '/pilotage/disponibilite?mois=2020-13')).status).toBe(400);
    expect((await t.call(t.direction, 'GET', '/pilotage/disponibilite?mois=2999-01')).status).toBe(409);
    expect((await t.call(t.direction, 'GET', '/pilotage/engagements-manques')).body).toMatchObject({ ok: true, data: { total: 0, tasks: [] } });
    expect((await t.call(t.agent, 'GET', '/pilotage/engagements-manques')).status).toBe(403);
    expect((await t.call(t.compliance, 'GET', '/pilotage/engagements-manques')).status).toBe(403);
    expect((await t.call(t.direction, 'POST', '/pilotage/engagements-manques/inconnue/fait', { outcome: 'rappele' })).status).toBe(404);
    expect((await t.call(t.direction, 'POST', '/pilotage/engagements-manques/inconnue/fait', { outcome: 'x' })).status).toBe(400);
    expect((await t.call(t.agent, 'POST', '/pilotage/engagements-manques/inconnue/fait', { outcome: 'rappele' })).status).toBe(403);
    // SV02 : la copie de nuit, pour la direction seule ; aucune copie : « jamais », jamais à jour.
    const copies = await t.call(t.direction, 'GET', '/pilotage/copies');
    expect(copies.status).toBe(200);
    expect(copies.body).toMatchObject({ ok: true, data: { state: 'jamais', lastSuccessAt: null } });
    expect(JSON.stringify(copies.body)).not.toMatch(/keepDays|gardée/);
    expect((await t.call(t.agent, 'GET', '/pilotage/copies')).status).toBe(403);
    expect((await t.call(t.compliance, 'GET', '/pilotage/copies')).status).toBe(403);
    // SV03 : le reçu du mois, pour la direction seule ; aucun reçu : « manquant », jamais vert.
    expect((await t.call(t.direction, 'GET', '/pilotage/copies/restauration')).body).toMatchObject({ ok: true, data: { state: 'manquant', receipt: null } });
    expect((await t.call(t.agent, 'GET', '/pilotage/copies/restauration')).status).toBe(403);
    expect((await t.call(t.compliance, 'GET', '/pilotage/copies/restauration')).status).toBe(403);
    // BR72 : le parcours complet fictif du mois, la direction seule.
    expect((await t.call(t.direction, 'GET', '/pilotage/parcours-du-mois')).body).toMatchObject({ ok: true, data: { state: 'manquant', receipt: null } });
    expect((await t.call(t.agent, 'GET', '/pilotage/parcours-du-mois')).status).toBe(403);
    expect((await t.call(t.compliance, 'GET', '/pilotage/parcours-du-mois')).status).toBe(403);
  });

  it('[R230] le passage du planificateur porte bien la surveillance : une nuit sans copie se lit à l’écran', async () => {
    const t = await setup();
    const job = pilotageJobs(t.db, t.journal, { now: t.now }).find((j) => j.name === 'sauvegarde.surveillance')!;
    expect(job).toBeDefined();
    await job.run({ job: job.name, slot: t.now().toISOString().slice(0, 13), at: t.now() });
    const nights = await t.db.all<{ night: string }>('SELECT night FROM base_copy_alerts');
    expect(nights).toHaveLength(1);
    expect((await t.call(t.direction, 'GET', '/pilotage/copies')).body).toMatchObject({ data: { state: 'jamais', missedNights: [nights[0]!.night] } });
  });

  it('[R67] aucune route ne reçoit un montant : la commission vient du mandat, par le passage horaire', async () => {
    const t = await setup();
    expect((await t.call(t.direction, 'POST', '/pilotage/grille', { validFrom: '2027-03-01', defaultRateBp: 7000 })).status).toBe(200);
    const refused = await t.call(t.direction, 'POST', `/pilotage/dossiers/${t.fileId}/encaissement`, { receivedAt: '2027-06-12T10:00:00.000Z', proofRef: 'preuves/releve-1.pdf', amountCents: 100 });
    expect(refused).toMatchObject({ status: 400, body: { rule: 'R67', code: 'amount_refused' } });
    expect((await t.call(t.direction, 'POST', '/pilotage/grille', { validFrom: '2027-04-01', defaultRateBp: 7000, feeEur: 1 })).status).toBe(400);
    await t.compromis();
    await t.runJobs();
    expect((await t.call(t.direction, 'GET', '/pilotage/commissions/a-trancher')).body!.data).toEqual([]);
    expect((await t.call(t.direction, 'GET', '/pilotage/grille')).body!.data).toMatchObject({ version: 1 });
    expect(await t.call(t.agent, 'GET', '/pilotage/grille')).toMatchObject({ status: 403, body: { rule: 'R16' } });
    expect((await t.call(t.direction, 'GET', '/pilotage/reglages')).body!.data).toHaveProperty('documentNoticeDays');
    expect(await t.call(t.agent, 'GET', '/pilotage/reglages')).toMatchObject({ status: 403, body: { rule: 'R16' } });
    expect(await t.call(t.agent, 'GET', '/pilotage/commissions/a-trancher')).toMatchObject({ status: 403, body: { rule: 'R16' } });
    // AU091 · la régularisation : la direction seule, un motif, jamais un montant [R678].
    const path = `/pilotage/commissions/${t.fileId}/regularisation`;
    expect(await t.call(t.agent, 'POST', path, { reason: 'Avenant de baisse signé.' })).toMatchObject({ status: 403, body: { rule: 'R16' } });
    expect(await t.call(t.direction, 'POST', path, { reason: 'Avenant de baisse signé.', feeCents: 1 })).toMatchObject({ status: 400, body: { rule: 'R67', code: 'amount_refused' } });
    expect(await t.call(t.direction, 'POST', path, { motif: 'Avenant de baisse signé.' })).toMatchObject({ status: 400, body: { code: 'invalid_body' } });
    expect(await t.call(t.direction, 'POST', path, { reason: 'Avenant de baisse signé.' })).toMatchObject({ status: 409, body: { rule: 'R678', code: 'nothing_to_fix' } });
    const planned = await t.call(t.agent, 'GET', '/pilotage/commissions');
    expect(planned.status).toBe(200);
    expect(planned.body!.data.map((c: { fileId: string; status: string }) => [c.fileId, c.status])).toEqual([[t.fileId, 'prevue']]);
    // L'autre agent ne voit pas la commission d'Alex.
    expect((await t.call(t.sam, 'GET', '/pilotage/commissions')).body!.data).toEqual([]);
    await t.acte();
    await t.runJobs();
    await t.runJobs(); // rejoué : rien de plus [R18]
    // Le jour de l'acte, les factures partent seules au passage (HX04) : plus aucun brouillon à valider, chacune une fois.
    const drafts = await t.call(t.direction, 'GET', '/pilotage/factures/brouillons');
    expect(drafts).toMatchObject({ status: 200, body: { data: [] } });
    const invoices = await t.call(t.direction, 'GET', '/pilotage/factures');
    expect(invoices.status).toBe(200);
    expect(invoices.body!.data.map((i: { content: { kind: string } }) => i.content.kind)).toEqual(['honoraires', 'reversement']);
    expect((await t.call(t.agent, 'GET', '/pilotage/commissions')).body!.data[0].status).toBe('facturee');
    // Puis l'encaissement fixe l'échéance.
    const receipt = await t.call(t.direction, 'POST', `/pilotage/dossiers/${t.fileId}/encaissement`, { receivedAt: '2027-06-11T08:00:00.000Z', proofRef: 'preuves/releve-1.pdf' });
    expect(receipt).toMatchObject({ status: 200, body: { ok: true, data: { payoutDueAt: '2027-06-14T08:00:00.000Z' } } });
    const tasks = await t.call(t.direction, 'GET', '/pilotage/reversements');
    expect(tasks.body!.data.map((x: { fileId: string }) => x.fileId)).toEqual([t.fileId]);
    const csv = await t.call(t.direction, 'GET', '/pilotage/factures/export?du=2027-06-01&au=2027-06-30');
    expect(csv.status).toBe(200);
    expect(csv.type).toMatch(/^text\/csv/);
  });

  it('[R69] l’export du jour égale le tableau de bord du réseau, colonne par colonne, et son total', async () => {
    const t = await setup();
    await t.call(t.direction, 'POST', '/pilotage/grille', { validFrom: '2027-03-01', defaultRateBp: 7000 });
    await t.compromis();
    await t.runJobs();
    await t.acte();
    await t.runJobs();
    const board = await t.call(t.direction, 'GET', '/pilotage/reseau?du=2027-06-10&au=2027-06-10');
    expect(board.status).toBe(200);
    const d = board.body!.data as pilotage.NetworkDashboard;
    expect(d.totals.sales).toBe(1);
    const exported = await t.call(t.direction, 'GET', '/pilotage/export-quotidien?jour=2027-06-10');
    expect(exported.status).toBe(200);
    const [header, ...rows] = exported.text.trim().split('\r\n').map((l) => l.split(';'));
    expect(header).toEqual([...pilotage.DAILY_EXPORT_HEADER]);
    const total = rows.find((r) => r[1] === 'total')!;
    expect(total.slice(2, 6).map(Number)).toEqual([d.totals.contacts, d.totals.appointments, d.totals.mandates, d.totals.sales]);
    const agents = rows.filter((r) => r[1] !== 'total');
    expect(agents.map((r) => r[1])).toEqual(d.byAgent.map((a) => a.agentId ?? 'direction'));
    for (const [i, k] of (['contacts', 'appointments', 'mandates', 'sales'] as const).entries()) expect(agents.reduce((a, r) => a + Number(r[2 + i]), 0)).toBe(d.totals[k]);
    // Les honoraires du jour : ceux de l'acte rapporté, en euros, égaux à la somme des lignes.
    const fee = (await t.db.first<{ fee_eur: number }>('SELECT fee_eur FROM sale_commissions WHERE file_id = ?', [t.fileId]))!.fee_eur;
    expect(Number(total[6])).toBe(fee);
    expect(agents.reduce((a, r) => a + Number(r[6]), 0)).toBe(fee);
    expect((await t.call(t.direction, 'GET', '/pilotage/export-quotidien?jour=2027-02-30')).status).toBe(400);
  });

  it('l’agent lit ses chiffres, chacun avec ses lignes ; une période fausse est refusée', async () => {
    const t = await setup();
    const mine = await t.call(t.agent, 'GET', '/pilotage/mes-chiffres?du=2027-06-01&au=2027-06-30');
    expect(mine.status).toBe(200);
    for (const k of ['contacts', 'appointments', 'mandates', 'sales'] as const) expect(mine.body!.data[k].value).toBe(mine.body!.data[k].lines.length);
    expect((await t.call(t.agent, 'GET', '/pilotage/mes-chiffres?du=2027-06-30&au=2027-06-01')).status).toBe(400);
    expect((await t.call(t.agent, 'GET', '/pilotage/rapport-matin?jour=demain')).status).toBe(400);
    expect((await t.call(t.agent, 'GET', '/pilotage/rapport-matin')).status).toBe(200);
  });

  it('[R82] les alertes de pilotage lisent les pièces du dossier d’agent : une alerte par pièce, une seule fois', async () => {
    const t = await setup();
    t.setClock(at9('2027-06-01'));
    const add = (kind: string, version: number, validUntil: string, draft = 0) =>
      t.db.run('INSERT INTO agent_file_pieces (id, network_id, agent_id, kind, version, ref, issued_on, valid_until, is_draft, recorded_by, recorded_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        `piece-${kind}-${version}`,
        t.network.id,
        t.alexId,
        kind,
        version,
        `ref-${kind}-${version}`,
        '2026-06-01',
        validUntil,
        draft,
        'direction:direction-1',
        '2026-06-01T08:00:00.000Z',
      ]);
    await add('assurance_rcp', 1, '2027-06-20');
    await add('immatriculation_rsac', 1, '2027-06-15');
    await add('immatriculation_rsac', 2, '2028-06-15'); // remplacée : plus d'alerte
    await add('attestation_vigilance', 1, '2027-12-01'); // loin
    const due = await new pilotage.SqlEcheancesDocumentsAgent(t.db).dueBy(t.network.id, '2027-07-01');
    expect(due).toEqual([{ agentId: t.alexId, document: 'assurance_rcp', validUntil: '2027-06-20' }]);
    t.setClock(new Date('2027-06-01T04:10:00.000Z')); // 6 h 10 à Paris
    await t.runJobs();
    await t.runJobs();
    const alerts = await t.call(t.direction, 'GET', '/pilotage/alertes');
    expect(alerts.body!.data.filter((a: { kind: string }) => a.kind === 'document_agent').map((a: { data: unknown }) => a.data)).toEqual([{ agentId: t.alexId, document: 'assurance_rcp', validUntil: '2027-06-20' }]);
  });
});
