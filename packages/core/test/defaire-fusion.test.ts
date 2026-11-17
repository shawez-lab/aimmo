import { expect, it } from 'vitest';
import { Acces, DefaireFusion, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, fromSyncSqlite, type Viewer } from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// RC76 · La direction voit les fusions d'une fiche et défait celle faite à tort. Tout est inventé.
const START = Date.parse('2027-03-03T10:00:00.000Z');
const DAY = 86_400_000;

async function setup() {
  const db = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = START;
  const now = () => new Date(clock);
  const tick = (ms: number) => {
    clock += ms;
  };
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const unique = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, unique, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const as = (role: string, userId: string, networkId = network.id): Viewer => ({ role, userId, networkId }) as Viewer;
  const person = async (first: string, last: string, net = network.id, agentId: string | null = alex.id) => {
    const p = await store.createPerson({ networkId: net, agentId, firstName: first, lastName: last });
    await store.addConsent({ networkId: net, personId: p.id, purpose: 'prospecting', channel: 'email', proof: 'accord de test', givenAt: new Date(clock - 5 * DAY) });
    return p.id;
  };
  const lea = await person('Léa', 'Exemple');
  const max = await person('Max', 'Essai');
  tick(DAY);
  const merge = await unique.merge({ survivorId: lea, mergedId: max, reason: 'identifiant commun dans un message reçu' });
  tick(DAY);
  // Pendant la réunion : un accord, qu'on ne sait plus attribuer.
  await store.addConsent({ networkId: network.id, personId: max, purpose: 'suivi_vente', channel: 'sms', proof: 'accord de test', givenAt: new Date(clock) });
  tick(DAY);
  const fusions = new DefaireFusion(db, acces, unique, journal, { now });
  const openConsents = async (id: string) => (await db.first<{ n: number }>('SELECT COUNT(*) AS n FROM consents WHERE person_id = ? AND withdrawn_at IS NULL', [id]))?.n;
  const undone = async () => (await db.first<{ undone_at: string | null }>('SELECT undone_at FROM person_merges WHERE id = ?', [merge.id]))?.undone_at ?? null;
  return {
    db, journal, store, unique, acces, fusions, network, other, lea, max, merge, tick, person, openConsents, undone,
    alexId: alex.id,
    alex: as('agent', alex.id),
    direction: as('direction', 'd-1'),
    compliance: as('compliance', 'c-1'),
    outsider: as('direction', 'd-2', other.id),
  };
}

describeWithSqlite('RC76 · la direction défait une fusion faite à tort', () => {
  it('liste les fusions de la fiche, par l’une ou l’autre fiche, avec les deux côtés, le motif et l’automatique', async () => {
    const t = await setup();
    for (const id of [t.lea, t.max]) {
      const list = await t.fusions.list(t.direction, id);
      if (!list.ok) throw new Error(list.code);
      expect(list.value).toEqual([
        {
          id: t.merge.id,
          survivor: { personId: t.lea, firstName: 'Léa', lastName: 'Exemple' },
          merged: { personId: t.max, firstName: 'Max', lastName: 'Essai' },
          reason: 'identifiant commun dans un message reçu',
          automatic: true,
          mergedAt: t.merge.merged_at,
          undoneAt: null,
        },
      ]);
    }
  });

  it('[R03] [R17] défaite : deux fiches séparées, l’accord donné pendant la réunion fermé et gardé ; preview égal au geste', async () => {
    const t = await setup();
    const before = await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM consents');
    expect(await t.fusions.preview(t.direction, t.lea, t.merge.id)).toEqual({ ok: true, value: { merge: t.merge.id, consentsToClose: 1 } });
    const done = await t.fusions.undo(t.direction, t.lea, t.merge.id, { reason: 'personnes_differentes' });
    if (!done.ok) throw new Error(done.code);
    expect(done.value).toMatchObject({ merge: t.merge.id, changed: true, consentsClosed: 1, exclusionsCopied: 0, callsCopied: 0 });
    expect(done.value.undoneAt).toBe(await t.undone());
    expect(await t.unique.membersOf(t.lea)).toEqual([t.lea]);
    expect(await t.unique.membersOf(t.max)).toEqual([t.max]);
    expect(await t.openConsents(t.lea)).toBe(1);
    expect(await t.openConsents(t.max)).toBe(1);
    expect(await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM consents')).toEqual(before);
    expect(await t.fusions.preview(t.direction, t.lea, t.merge.id)).toEqual({ ok: true, value: { merge: t.merge.id, consentsToClose: 0 } });
    const list = await t.fusions.list(t.direction, t.max);
    expect(list.ok && list.value[0]?.undoneAt).toBe(done.value.undoneAt);
  });

  it('[R04] un arrêt noté pendant la réunion est recopié et compté', async () => {
    const t = await setup();
    await t.store.addExclusion({ networkId: t.network.id, personId: t.max, reason: 'stop', channel: null, notedAt: new Date(START + 2 * DAY) });
    const done = await t.fusions.undo(t.direction, t.max, t.merge.id, { reason: 'identifiant_partage' });
    expect(done).toMatchObject({ ok: true, value: { exclusionsCopied: 1 } });
    const n = await t.db.first<{ n: number }>("SELECT COUNT(*) AS n FROM exclusions WHERE person_id = ? AND reason = 'stop'", [t.lea]);
    expect(n?.n).toBe(1);
  });

  it('rejouée : rien de plus, changed faux, une seule ligne de motif', async () => {
    const t = await setup();
    const first = await t.fusions.undo(t.direction, t.lea, t.merge.id, { reason: 'erreur_de_saisie' });
    t.tick(60_000);
    const again = await t.fusions.undo(t.direction, t.lea, t.merge.id, { reason: 'personnes_differentes' });
    expect(again).toMatchObject({ ok: true, value: { changed: false, consentsClosed: 1 } });
    expect(first.ok && again.ok && again.value.undoneAt).toBe(first.ok && first.value.undoneAt);
    const motifs = (await t.journal.all()).filter((e) => e.type === 'fiche.fusion_defaite_motif');
    expect(motifs).toHaveLength(1);
    expect(motifs[0]!.data).toEqual({ rule: 'R16', merge: t.merge.id, reason: 'erreur_de_saisie' });
    expect((await t.journal.all()).filter((e) => e.type === 'fiche.fusion_defaite')).toHaveLength(1);
  });

  it('une autre direction qui arrive après le geste n’écrit pas son motif', async () => {
    const t = await setup();
    await t.fusions.undo(t.direction, t.lea, t.merge.id, { reason: 'erreur_de_saisie' });
    const other = { role: 'direction', userId: 'd-3', networkId: t.network.id } as Viewer;
    expect(await t.fusions.undo(other, t.lea, t.merge.id, { reason: 'personnes_differentes' })).toMatchObject({ ok: true, value: { changed: false } });
    const motifs = (await t.journal.all()).filter((e) => e.type === 'fiche.fusion_defaite_motif');
    expect(motifs.map((e) => [e.actor, e.data.reason])).toEqual([['direction:d-1', 'erreur_de_saisie']]);
  });

  it('[R16] seule la direction du réseau : agent de la fiche, conformité et autre réseau refusés, au journal, rien de défait', async () => {
    const t = await setup();
    for (const viewer of [t.alex, t.compliance, t.outsider]) {
      expect(await t.fusions.undo(viewer, t.lea, t.merge.id, { reason: 'personnes_differentes' })).toMatchObject({ ok: false, rule: 'R16' });
      expect(await t.fusions.list(viewer, t.lea)).toMatchObject({ ok: false, rule: 'R16' });
      expect(await t.fusions.preview(viewer, t.lea, t.merge.id)).toMatchObject({ ok: false, rule: 'R16' });
    }
    expect(await t.undone()).toBeNull();
    const refused = (await t.journal.all()).filter((e) => e.type === 'acces.refuse' && e.data.kind === 'merge_undo');
    expect(refused.map((e) => e.actor)).toEqual(expect.arrayContaining(['agent:' + t.alexId, 'compliance:c-1']));
    expect((await t.journal.all()).some((e) => e.type === 'acces.refuse' && e.actor === 'direction:d-2')).toBe(true);
  });

  it('une fusion d’une autre fiche, inconnue ou mal donnée est refusée, rien de défait', async () => {
    const t = await setup();
    const a = await t.person('Zoé', 'Autre');
    const b = await t.person('Noé', 'Autre');
    const elsewhere = await t.unique.merge({ survivorId: a, mergedId: b, reason: 'identifiant commun à la reprise du site' });
    for (const id of [elsewhere.id, '0b6f1d2e-5555-4a2b-8c3d-000000000099', 12, null]) {
      expect(await t.fusions.undo(t.direction, t.lea, id, { reason: 'personnes_differentes' })).toEqual({ ok: false, rule: null, code: 'unknown_merge' });
      expect(await t.fusions.preview(t.direction, t.lea, id)).toEqual({ ok: false, rule: null, code: 'unknown_merge' });
    }
    expect(await t.fusions.undo(t.direction, '0b6f1d2e-5555-4a2b-8c3d-000000000098', t.merge.id, { reason: 'personnes_differentes' })).toMatchObject({ ok: false, rule: null, code: 'unknown' });
    expect(await t.undone()).toBeNull();
    expect(await t.db.first('SELECT undone_at FROM person_merges WHERE id = ?', [elsewhere.id])).toEqual({ undone_at: null });
  });

  it('motif hors liste, champ inconnu, corps illisible : refusés, rien de défait', async () => {
    const t = await setup();
    const cases: [Record<string, unknown> | null, string][] = [
      [null, 'invalid_body'],
      [{}, 'bad_reason'],
      [{ reason: 'caprice' }, 'bad_reason'],
      [{ reason: 'personnes_differentes', force: true }, 'unexpected_field'],
    ];
    for (const [input, code] of cases) expect(await t.fusions.undo(t.direction, t.lea, t.merge.id, input)).toEqual({ ok: false, rule: null, code });
    expect(await t.undone()).toBeNull();
  });

  it('[R13] au journal : motif et identifiants, aucun nom', async () => {
    const t = await setup();
    await t.fusions.list(t.direction, t.lea);
    await t.fusions.undo(t.direction, t.lea, t.merge.id, { reason: 'personnes_differentes' });
    const text = JSON.stringify(await t.journal.all());
    for (const name of ['Léa', 'Exemple', 'Max', 'Essai']) expect(text).not.toContain(name);
    const line = (await t.journal.all()).find((e) => e.type === 'fiche.fusion_defaite');
    expect(line?.actor).toBe('direction:d-1');
  });
});
