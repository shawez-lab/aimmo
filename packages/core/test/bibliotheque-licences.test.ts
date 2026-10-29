import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { Bibliotheque, parisDay } from '../src/studio/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const proof = (n: number) => `bibliotheque/preuves/0000000${n}-0000-4000-8000-000000000000.pdf`;

it('le jour d’une licence se compte à Paris', () => {
  expect(parisDay(new Date('2027-10-31T22:30:00Z'))).toBe('2027-10-31');
  expect(parisDay(new Date('2027-10-31T23:30:00Z'))).toBe('2027-11-01');
  expect(parisDay(new Date('2027-07-31T22:30:00Z'))).toBe('2027-08-01');
});

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse('2027-10-09T08:00:00.000Z');
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const stored = new Set([proof(1), proof(2), proof(3)]);
  const proofs = { down: false, has: async (r: string) => { if (proofs.down) throw new Error('panne'); return stored.has(r); } };
  const lib = new Bibliotheque(db, journal, proofs, { now });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const direction = { role: 'direction', userId: 'd1', networkId: network.id } as const;
  const agent = { role: 'agent', userId: 'a1', networkId: network.id } as const;
  const music = (over: Record<string, unknown> = {}) => ({
    kind: 'musique',
    title: 'Matin clair, piano',
    source: 'banque_sous_licence',
    licence: 'abonnement',
    validUntil: '2027-12-31',
    proofRef: proof(1),
    ...over,
  });
  return { db, lib, network, other, direction, agent, music, proofs, stored, setClock: (iso: string) => (clock = Date.parse(iso)) };
}

describeWithSqlite('X07 · bibliothèque sous licence', () => {
  it('[R133] une entrée sans licence ni preuve est refusée ; avec, elle entre dans les choix', async () => {
    const t = await setup();
    expect(await t.lib.add(t.direction, t.music({ licence: undefined }))).toEqual({ ok: false, rule: 'R133', code: 'sans_licence' });
    expect(await t.lib.add(t.direction, t.music({ licence: 'trouvee_sur_internet' }))).toEqual({ ok: false, rule: 'R133', code: 'sans_licence' });
    expect(await t.lib.add(t.direction, t.music({ source: 'inconnue' }))).toEqual({ ok: false, rule: 'R133', code: 'sans_source' });
    expect(await t.lib.add(t.direction, t.music({ proofRef: undefined }))).toEqual({ ok: false, rule: 'R133', code: 'sans_preuve' });
    expect(await t.lib.add(t.direction, t.music({ proofRef: 'https://exemple.test/licence.pdf' }))).toEqual({ ok: false, rule: 'R133', code: 'sans_preuve' });
    expect(await t.lib.add(t.direction, t.music({ proofRef: proof(9) }))).toEqual({ ok: false, rule: 'R133', code: 'preuve_absente' });
    expect(await t.lib.add(t.direction, t.music({ licence: 'cc_by' }))).toEqual({ ok: false, rule: 'R133', code: 'mention_auteur_absente' });
    expect(await t.lib.add(t.direction, t.music({ validUntil: '2027-02-30' }))).toEqual({ ok: false, rule: 'R133', code: 'date_de_fin_invalide' });
    expect(await t.lib.add(t.direction, t.music({ validUntil: '2027-10-08' }))).toEqual({ ok: false, rule: 'R133', code: 'licence_expiree' });
    t.proofs.down = true;
    expect(await t.lib.add(t.direction, t.music())).toEqual({ ok: false, rule: 'R133', code: 'stockage_indisponible' });
    t.proofs.down = false;
    expect(await t.db.all('SELECT id FROM licensed_assets')).toEqual([]);
    const ok = await t.lib.add(t.direction, t.music());
    expect(ok).toMatchObject({ ok: true, value: { kind: 'musique', licence: 'abonnement', validUntil: '2027-12-31', usable: true, withdrawn: null } });
    const cc = await t.lib.add(t.direction, t.music({ kind: 'image', title: 'Toits au soleil', licence: 'cc_by', attribution: 'Photographe Exemple, CC BY 4.0', validUntil: null, proofRef: proof(2) }));
    expect(cc).toMatchObject({ ok: true, value: { kind: 'image', attribution: 'Photographe Exemple, CC BY 4.0', validUntil: null } });
    expect(await t.lib.choices(t.agent, 'musique')).toMatchObject({ ok: true, value: [{ title: 'Matin clair, piano' }] });
    expect(await t.lib.choices(t.agent, 'image')).toMatchObject({ ok: true, value: [{ title: 'Toits au soleil' }] });
    if (!ok.ok || !cc.ok) throw new Error('ajout');
    expect(await t.lib.licensedMusic(t.network.id, ok.value.id, new Date('2027-10-09T10:00:00Z'))).toMatchObject({ id: ok.value.id });
    expect(await t.lib.licensedImage(t.network.id, cc.value.id, new Date('2027-10-09T10:00:00Z'))).toEqual({ id: cc.value.id, attribution: 'Photographe Exemple, CC BY 4.0' });
    // Une image n'est pas une musique ; un autre réseau ne la voit pas.
    expect(await t.lib.licensedMusic(t.network.id, cc.value.id, new Date('2027-10-09T10:00:00Z'))).toBeNull();
    expect(await t.lib.licensedMusic(t.other.id, ok.value.id, new Date('2027-10-09T10:00:00Z'))).toBeNull();
    expect(await t.lib.choices({ ...t.agent, networkId: t.other.id }, 'musique')).toEqual({ ok: true, value: [] });
  });

  it('[R133] [R17] une licence expirée ou retirée sort des choix, sans rien effacer', async () => {
    const t = await setup();
    const a = await t.lib.add(t.direction, t.music());
    const b = await t.lib.add(t.direction, t.music({ title: 'Soir doux, guitare', validUntil: null, licence: 'licence_achetee', source: 'achat_unitaire', proofRef: proof(3) }));
    if (!a.ok || !b.ok) throw new Error('ajout');
    // Le dernier jour, encore à 23 h 59 heure de Paris ; le lendemain, plus.
    expect(await t.lib.licensedMusic(t.network.id, a.value.id, new Date('2027-12-31T22:59:00Z'))).not.toBeNull();
    expect(await t.lib.licensedMusic(t.network.id, a.value.id, new Date('2027-12-31T23:01:00Z'))).toBeNull();
    t.setClock('2028-01-02T09:00:00Z');
    expect(await t.lib.choices(t.agent, 'musique')).toMatchObject({ ok: true, value: [{ title: 'Soir doux, guitare' }] });
    // Retrait par la direction : hors des choix, toujours dans la bibliothèque.
    expect(await t.lib.withdraw(t.direction, b.value.id, 'licence_retiree')).toMatchObject({ ok: true, value: { usable: false, withdrawn: { reason: 'licence_retiree' } } });
    expect(await t.lib.withdraw(t.direction, b.value.id, 'choix_de_la_direction')).toMatchObject({ ok: true, value: { withdrawn: { reason: 'licence_retiree' } } });
    expect(await t.lib.withdraw(t.direction, b.value.id, 'au_hasard')).toEqual({ ok: false, rule: 'R10', code: 'motif_inconnu' });
    expect(await t.lib.choices(t.agent, 'musique')).toEqual({ ok: true, value: [] });
    expect(await t.lib.licensedMusic(t.network.id, b.value.id, new Date())).toBeNull();
    const all = await t.lib.all(t.direction);
    expect(all.ok && all.value.map((x) => [x.title, x.usable])).toEqual([
      ['Matin clair, piano', false],
      ['Soir doux, guitare', false],
    ]);
    await expect(t.db.run('DELETE FROM licensed_assets')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run('DELETE FROM licensed_asset_withdrawals')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE licensed_assets SET valid_until = '2099-01-01'")).rejects.toThrow(/ne change plus/);
  });

  it('[R16] seule la direction range ou retire ; les agents voient les choix, les autres rien', async () => {
    const t = await setup();
    expect(await t.lib.add(t.agent, t.music())).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.lib.add({ role: 'compliance', userId: 'c', networkId: t.network.id }, t.music())).toEqual({ ok: false, rule: 'R16', code: 'role' });
    const a = await t.lib.add(t.direction, t.music());
    if (!a.ok) throw new Error(a.code);
    expect(await t.lib.withdraw(t.agent, a.value.id, 'licence_retiree')).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.lib.withdraw({ ...t.direction, networkId: t.other.id }, a.value.id, 'licence_retiree')).toEqual({ ok: false, rule: 'R10', code: 'entree_inconnue' });
    // Le retrait refusé est au journal, sans l'identifiant demandé, et l'entrée reste en service.
    const ev = await t.db.all<{ subject: string; data: string }>("SELECT subject, data FROM journal WHERE type = 'acces.refuse' AND subject = ?", [`network:${t.other.id}`]);
    expect(ev.map((e) => JSON.parse(e.data))).toEqual([{ rule: 'R16', role: 'direction', kind: 'licensed_assets', code: 'unknown' }]);
    expect(ev.map((e) => e.data).join('')).not.toContain(a.value.id);
    expect(await t.lib.choices(t.agent, 'musique')).toMatchObject({ ok: true, value: [{ id: a.value.id }] });
    expect(await t.lib.choices(t.agent, 'sons')).toEqual({ ok: false, rule: 'R10', code: 'sorte_inconnue' });
    expect(await t.lib.all(t.agent)).toEqual({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.lib.choices({ role: 'partner', userId: 'p', networkId: t.network.id }, 'musique')).toEqual({ ok: false, rule: 'R16', code: 'role' });
    const refused = await t.db.all("SELECT seq FROM journal WHERE type = 'acces.refuse'");
    expect(refused).toHaveLength(6);
  });
});
