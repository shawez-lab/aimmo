// AU082 · Chaque condition suspensive a son responsable, sa date limite, son état, son justificatif et ses alertes.
import { expect, it } from 'vitest';
import { ConditionsDossier, Echeancier, conditionLines } from '../src/dossiers/index.ts';
import { PROOF, setupDossier } from './dossiers-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

const PARIS_9H = (day: string) => new Date(`${day}T08:00:00.000Z`);
const OFFER = { conditions: [{ kind: 'pret', amountEur: 150000, durationMonths: 240 }, { kind: 'vente_autre_bien' }, { kind: 'permis_construire' }] };

it('[R61] [R10] les lignes : à saisir tant que le compromis ne les date pas, échue en attente après sa date, ajoutée par le compromis dite', () => {
  expect(conditionLines(['pret', 'vente_autre_bien'], [], '2027-03-10')).toEqual([
    { kind: 'vente_autre_bien', source: 'offre', status: 'a_saisir', responsible: null, day: null, proofRef: null, version: null },
  ]);
  const rec = (kind: 'vente_autre_bien' | 'autre', state: 'en_attente' | 'realisee', due_day: string) => ({ kind, version: 1, responsible: 'acquereur' as const, due_day, state, proof_ref: PROOF });
  const lines = conditionLines(['vente_autre_bien'], [rec('vente_autre_bien', 'en_attente', '2027-03-09'), rec('autre', 'realisee', '2027-03-09')], '2027-03-10');
  expect(lines.map((l) => [l.kind, l.source, l.status])).toEqual([['vente_autre_bien', 'offre', 'echue'], ['autre', 'compromis', 'realisee']]);
  // Le jour même de la date limite, la condition est encore en attente.
  expect(conditionLines([], [rec('autre', 'en_attente', '2027-03-10')], '2027-03-10')[0]!.status).toBe('en_attente');
});

describeWithSqlite('AU082 · conditions suspensives du dossier', () => {
  async function ready() {
    const t = await setupDossier('appartement', OFFER);
    await t.startCompromis();
    t.setClock(PARIS_9H('2027-03-10'));
    const e = new Echeancier(t.db, t.acces, t.journal, { now: t.now });
    const c = new ConditionsDossier(t.db, t.acces, t.journal, { now: t.now });
    return { t, e, c };
  }

  it('[R61] constat : la vente d’un autre bien et le permis ont chacun leur échéance, leur responsable, leur état et leur preuve', async () => {
    const { t, e, c } = await ready();
    // Avant : l'échéancier n'avait aucune ligne pour ces conditions ; elles sont maintenant suivies à part.
    expect(await c.record(t.agent, t.fileId, { kind: 'vente_autre_bien', responsible: 'acquereur', day: '2027-05-15', state: 'en_attente', proofRef: PROOF })).toEqual({ ok: false, rule: null, code: 'compromis_first' });
    await e.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF });
    let r: Awaited<ReturnType<typeof c.record>> = await c.conditions(t.agent, t.fileId);
    expect(r.ok && r.value.lines.map((l) => [l.kind, l.status])).toEqual([['vente_autre_bien', 'a_saisir'], ['permis_construire', 'a_saisir']]);
    expect(await c.record(t.agent, t.fileId, { kind: 'vente_autre_bien', responsible: 'acquereur', day: '2027-05-15', state: 'en_attente', proofRef: PROOF })).toMatchObject({ ok: true });
    expect(await c.record(t.agent, t.fileId, { kind: 'permis_construire', responsible: 'acquereur', day: '2027-06-30', state: 'en_attente', proofRef: PROOF })).toMatchObject({ ok: true });
    r = await c.conditions(t.agent, t.fileId);
    expect(r.ok && r.value.lines).toEqual([
      { kind: 'vente_autre_bien', source: 'offre', status: 'en_attente', responsible: 'acquereur', day: '2027-05-15', proofRef: PROOF, version: 1 },
      { kind: 'permis_construire', source: 'offre', status: 'en_attente', responsible: 'acquereur', day: '2027-06-30', proofRef: PROOF, version: 1 },
    ]);
    // La réalisation s'ajoute en nouvelle version, avec son justificatif ; l'ancienne reste [R17].
    const done = 'preuves/0b6f1d2e-9999-4a2b-8c3d-000000000002.pdf';
    r = await c.record(t.agent, t.fileId, { kind: 'vente_autre_bien', responsible: 'notaire', day: '2027-05-15', state: 'realisee', proofRef: done });
    expect(r.ok && r.value.lines[0]).toMatchObject({ status: 'realisee', responsible: 'notaire', proofRef: done, version: 2 });
    expect((await t.db.all("SELECT state FROM sale_file_conditions WHERE kind = 'vente_autre_bien' ORDER BY version")).map((x) => (x as { state: string }).state)).toEqual(['en_attente', 'realisee']);
    await expect(t.db.run('DELETE FROM sale_file_conditions')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE sale_file_conditions SET state = 'renoncee'")).rejects.toThrow(/rien ne change/);
    expect((await t.journal.bySubject(`sale_file:${t.fileId}`)).filter((x) => x.type === 'dossier.condition').at(-1)?.data).toEqual({ rule: 'R61', kind: 'vente_autre_bien', state: 'realisee', version: 2 });
  });

  it('[R61] des alertes indépendantes : à saisir, avant la date, échue ; une condition levée n’éteint pas les autres', async () => {
    const { t, e, c } = await ready();
    await e.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF });
    expect(await c.run(t.network.id)).toBe(2);
    expect(await c.run(t.network.id)).toBe(0);
    let k = await c.tasksOf(t.agent);
    expect(k.ok && k.tasks.map((x) => `${x.condition}:${x.reason}`)).toEqual(['vente_autre_bien:a_saisir', 'permis_construire:a_saisir']);
    await c.record(t.agent, t.fileId, { kind: 'vente_autre_bien', responsible: 'acquereur', day: '2027-04-15', state: 'en_attente', proofRef: PROOF });
    await c.record(t.agent, t.fileId, { kind: 'permis_construire', responsible: 'acquereur', day: '2027-04-20', state: 'en_attente', proofRef: PROOF });
    k = await c.tasksOf(t.agent);
    expect(k.ok && k.tasks).toEqual([]);
    // Dix jours avant chacune : son alerte, le bon jour, une seule.
    t.setClock(PARIS_9H('2027-04-05'));
    expect(await c.run(t.network.id)).toBe(1);
    t.setClock(PARIS_9H('2027-04-10'));
    expect(await c.run(t.network.id)).toBe(1);
    k = await c.tasksOf(t.agent);
    expect(k.ok && k.tasks.map((x) => [x.condition, x.reason, x.day])).toEqual([['vente_autre_bien', 'avant_echeance', '2027-04-15'], ['permis_construire', 'avant_echeance', '2027-04-20']]);
    // La vente de l'autre bien est réalisée : son alerte s'éteint, celle du permis reste.
    await c.record(t.agent, t.fileId, { kind: 'vente_autre_bien', responsible: 'acquereur', day: '2027-04-15', state: 'realisee', proofRef: PROOF });
    k = await c.tasksOf(t.agent);
    expect(k.ok && k.tasks.map((x) => [x.condition, x.reason])).toEqual([['permis_construire', 'avant_echeance']]);
    // Le permis passe sa date sans être levé : alerte « échue », une seule ; elle cesse quand il est levé.
    t.setClock(PARIS_9H('2027-04-21'));
    expect(await c.run(t.network.id)).toBe(1);
    expect(await c.run(t.network.id)).toBe(0);
    k = await c.tasksOf(t.agent);
    expect(k.ok && k.tasks.map((x) => [x.condition, x.reason, x.day])).toEqual([['permis_construire', 'echue', '2027-04-20']]);
    await c.record(t.agent, t.fileId, { kind: 'permis_construire', responsible: 'acquereur', day: '2027-04-20', state: 'defaillie', proofRef: PROOF });
    k = await c.tasksOf(t.agent);
    expect(k.ok && k.tasks).toEqual([]);
    // L'échéancier garde ses propres tâches, sans mélange.
    expect((await t.db.all('SELECT * FROM sale_file_tasks')).length).toBe(0);
    await expect(t.db.run('DELETE FROM sale_file_condition_tasks')).rejects.toThrow(/rien ne s'efface/);
  });

  it('[R10] [R61] des saisies réelles et prouvées ; la condition que seul le compromis porte est dite', async () => {
    const { t, e } = await ready();
    const stored = new Set<string>([PROOF]);
    const c = new ConditionsDossier(t.db, t.acces, t.journal, { now: t.now, proofs: { has: async (ref) => stored.has(ref) } });
    await e.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF });
    const base = { kind: 'permis_construire', responsible: 'acquereur', day: '2027-06-30', state: 'en_attente', proofRef: PROOF };
    expect(await c.record(t.agent, t.fileId, { ...base, kind: 'pret' })).toEqual({ ok: false, rule: null, code: 'unknown_condition' });
    expect(await c.record(t.agent, t.fileId, { ...base, responsible: 'banque' })).toEqual({ ok: false, rule: null, code: 'bad_responsible' });
    expect(await c.record(t.agent, t.fileId, { ...base, state: 'levee' })).toEqual({ ok: false, rule: null, code: 'bad_state' });
    for (const day of ['2027-02-30', '30/06/2027', null]) expect(await c.record(t.agent, t.fileId, { ...base, day })).toEqual({ ok: false, rule: null, code: 'bad_day' });
    expect(await c.record(t.agent, t.fileId, { ...base, day: '2027-03-09' })).toEqual({ ok: false, rule: null, code: 'before_compromis' });
    for (const proofRef of ['permis.pdf', '', null]) expect(await c.record(t.agent, t.fileId, { ...base, proofRef })).toEqual({ ok: false, rule: null, code: 'bad_proof' });
    expect(await c.record(t.agent, t.fileId, { ...base, proofRef: 'preuves/0b6f1d2e-9999-4a2b-8c3d-000000000777.pdf' })).toEqual({ ok: false, rule: null, code: 'not_stored' });
    // Le certificat d'urbanisme n'était pas dans l'offre : accepté, et dit « compromis ».
    const r = await c.record(t.agent, t.fileId, { ...base, kind: 'certificat_urbanisme', responsible: 'notaire' });
    expect(r.ok && r.value.lines.map((l) => [l.kind, l.source, l.status])).toEqual([['vente_autre_bien', 'offre', 'a_saisir'], ['permis_construire', 'offre', 'a_saisir'], ['certificat_urbanisme', 'compromis', 'en_attente']]);
    expect((await t.db.all('SELECT * FROM sale_file_conditions')).length).toBe(1);
  });

  it('[R16] seul l’agent du dossier saisit ; direction et conformité lisent ; les alertes sont à l’agent seul', async () => {
    const { t, e, c } = await ready();
    await e.record(t.agent, t.fileId, { kind: 'compromis_signe', day: '2027-03-10', proofRef: PROOF });
    const compliance = { role: 'compliance' as const, networkId: t.network.id, userId: 'c-1' };
    const input = { kind: 'permis_construire', responsible: 'acquereur', day: '2027-06-30', state: 'en_attente', proofRef: PROOF };
    for (const v of [t.direction, compliance]) {
      expect(await c.record(v, t.fileId, input)).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await c.conditions(v, t.fileId)).toMatchObject({ ok: true });
    }
    expect(await c.conditions(t.sam, t.fileId)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await c.record(t.sam, t.fileId, input)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await c.conditions(t.agent, 'dossier-inconnu')).toEqual({ ok: false, rule: null, code: 'unknown_file' });
    await c.run(t.network.id);
    expect(await c.tasksOf(t.direction)).toEqual({ ok: false, rule: 'R16', code: 'not_agent' });
    expect(await c.tasksOf(t.sam)).toEqual({ ok: true, tasks: [] });
  });
});
