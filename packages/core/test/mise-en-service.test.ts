import { expect, it } from 'vitest';
import { MentionsSite, SITE_MENTION_FIELDS, renderLegalNotice, siteReady } from '../src/attirer/mentions-site.ts';
import { MiseEnService, LAUNCH_SOON_DAYS, type LaunchLine } from '../src/conformite/mise-en-service.ts';
import { SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { launchProofInputs } from './mise-en-service-jeu.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, numéros, émetteurs et références inventés.
const direction = { role: 'direction' as const, userId: 'dir-1', networkId: 'net-1' };
const agent = { role: 'agent' as const, userId: 'ag-1', networkId: 'net-1' };
const CARD = 'CPI 9999 0000 000 000 001';

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const journal = new SqlJournalStore(db);
  let clock = Date.parse('2026-11-21T09:00:00.000Z');
  const now = (): Date => new Date((clock += 1000));
  const setDay = (day: string): void => void (clock = Date.parse(`${day}T09:00:00.000Z`));
  let n = 0;
  const newId = (): string => `id-${++n}`;
  await db.run("INSERT INTO networks (id, name, created_at) VALUES ('net-1', 'Réseau test', '2026-01-01T00:00:00.000Z')");
  await db.run("INSERT INTO networks (id, name, created_at) VALUES ('net-2', 'Autre réseau', '2026-01-01T00:00:00.000Z')");
  const launch = new MiseEnService(db, journal, { now, newId });
  const mentions = new MentionsSite(db, journal, { now, newId });
  return { db, journal, launch, mentions, now, setDay };
}

type T = Awaited<ReturnType<typeof setup>>;
const lineOf = async (t: T, p: string, net = 'net-1'): Promise<LaunchLine> => (await t.launch.board(net)).lines.find((l) => l.prerequisite === p)!;

/** Les mentions du site, la carte affichée et son titulaire, tous remplis : avant AU088, le site passait alors en réel. */
async function siteFilled(t: T) {
  expect(await t.mentions.set(direction, Object.fromEntries(Object.keys(SITE_MENTION_FIELDS).map((f) => [f, `Texte inventé ${f}`])))).toEqual({ ok: true });
  await t.db.exec('PRAGMA foreign_keys = OFF');
  await t.db.run("INSERT INTO listing_settings (id, network_id, card_number, set_by, set_at) VALUES ('s1', 'net-1', ?, 'direction:dir-1', '2026-11-21T08:00:00.000Z')", [CARD]);
  await t.db.run("INSERT INTO card_holders (id, network_id, holder_name, set_by, set_at) VALUES ('h1', 'net-1', 'Société Exemple', 'direction:dir-1', '2026-11-21T08:00:00.000Z')");
  await t.db.exec('PRAGMA foreign_keys = ON');
}

async function declareAll(t: T, day = '2026-11-21') {
  for (const input of launchProofInputs(day, CARD)) expect((await t.launch.declare(direction, input)).ok).toBe(true);
}

describeWithSqlite('AU088 · le tableau de mise en service du réseau', () => {
  it('[R675] [R221] constat : toutes les mentions remplies, sans aucune preuve, le site ne passe plus en réel', async () => {
    const t = await setup();
    await siteFilled(t);
    const m = await t.mentions.read('net-1');
    // Avant AU088, `missing` vide suffisait : le site s'ouvrait sur de simples textes, sans preuve ni validité.
    expect(m.missing).toEqual([]);
    expect(siteReady(m)).toBe(false);
    expect(m.launchClosedBy).toEqual([
      'Carte professionnelle « transaction » du réseau',
      'Garantie financière',
      'Assurance de responsabilité civile professionnelle',
      'Adhésion au médiateur de la consommation',
      'Relecture des mentions légales par l’avocat',
    ]);
    expect(renderLegalNotice(m)).toContain('sa mise en service n’est pas terminée');
    // Aucun numéro, aucun émetteur sur la page publique : les preuves restent à l'écran de la direction.
    expect(renderLegalNotice(m)).not.toContain('Garant inventé');
    await declareAll(t);
    const after = await t.mentions.read('net-1');
    expect(after.launchClosedBy).toEqual([]);
    expect(siteReady(after)).toBe(true);
    expect(renderLegalNotice(after)).not.toContain('mise en service');
  });

  it('[R675] chaque preuve dit son état ; le tableau dit ce qui est déclaré, jamais vérifié', async () => {
    const t = await setup();
    const empty = await t.launch.board('net-1');
    expect(empty.verified).toBe(false);
    expect(empty.day).toBe('2026-11-21');
    expect(empty.lines.map((l) => [l.prerequisite, l.state])).toEqual([['carte', 'manquante'], ['garantie', 'manquante'], ['assurance', 'manquante'], ['mediateur', 'manquante'], ['mentions', 'manquante']]);
    expect(empty.features).toEqual([{ feature: 'site_reel', label: 'Site en réel : indexé et signalé aux moteurs', open: false, closedBy: ['carte', 'garantie', 'assurance', 'mediateur', 'mentions'] }]);
    await declareAll(t);
    const full = await t.launch.board('net-1');
    expect(full.lines.every((l) => l.state === 'valide')).toBe(true);
    expect(full.features[0]).toMatchObject({ open: true, closedBy: [] });
    expect(full.lines[1]).toMatchObject({ proof: { version: 1, documentNumber: 'GAR-0000', issuer: 'Garant inventé', proofRef: 'preuve-garantie-inventee', validFrom: '2026-01-01', validUntil: '2027-12-31' }, daysLeft: 405, soon: false, gap: null });
    // Un autre réseau ne voit rien de ces preuves.
    expect((await t.launch.board('net-2')).lines.every((l) => l.state === 'manquante')).toBe(true);
  });

  it('[R675] une preuve expirée ferme le site dès le lendemain de sa fin ; un renouvellement annoncé le rouvre le jour venu', async () => {
    const t = await setup();
    await siteFilled(t);
    await declareAll(t);
    t.setDay('2027-12-31');
    expect(await lineOf(t, 'assurance')).toMatchObject({ state: 'valide', daysLeft: 0, soon: true });
    t.setDay('2028-01-01');
    expect(await lineOf(t, 'assurance')).toMatchObject({ state: 'expiree', daysLeft: -1 });
    expect(await t.launch.gate('net-1', 'site_reel')).toEqual({ open: false, closedBy: ['garantie', 'assurance', 'mediateur'] });
    expect(siteReady(await t.mentions.read('net-1'))).toBe(false);
    // L'attestation de l'année suivante, déclarée en avance : à venir tant qu'elle ne vaut pas, puis valide.
    t.setDay('2027-12-01');
    expect(await lineOf(t, 'assurance')).toMatchObject({ state: 'valide', soon: true });
    expect((await t.launch.declare(direction, { prerequisite: 'assurance', documentNumber: 'RCP-0001', issuer: 'Assureur inventé', proofRef: 'preuve-assurance-2028', validFrom: '2028-01-01', validUntil: '2028-12-31' })).ok).toBe(true);
    const announced = await lineOf(t, 'assurance');
    expect(announced).toMatchObject({ state: 'valide', proof: { documentNumber: 'RCP-0000' }, next: { documentNumber: 'RCP-0001', version: 2 }, soon: false });
    t.setDay('2028-01-01');
    expect(await lineOf(t, 'assurance')).toMatchObject({ state: 'valide', proof: { documentNumber: 'RCP-0001' }, next: null });
  });

  it('[R675] une preuve qui ne vaut pas encore laisse la fonction fermée', async () => {
    const t = await setup();
    expect((await t.launch.declare(direction, { prerequisite: 'garantie', documentNumber: 'GAR-1', issuer: 'Garant inventé', proofRef: 'p', validFrom: '2026-12-01', validUntil: '2027-11-30' })).ok).toBe(true);
    expect(await lineOf(t, 'garantie')).toMatchObject({ state: 'a_venir', proof: null, next: { documentNumber: 'GAR-1' } });
    t.setDay('2026-12-01');
    expect(await lineOf(t, 'garantie')).toMatchObject({ state: 'valide' });
  });

  it('[R675] [R17] un retrait ferme aussitôt ; chaque déclaration s’ajoute, rien ne change ni ne s’efface', async () => {
    const t = await setup();
    await siteFilled(t);
    await declareAll(t);
    expect(await t.launch.declare(direction, { prerequisite: 'assurance', withdrawn: true })).toEqual({ ok: true, version: 2 });
    expect(await lineOf(t, 'assurance')).toMatchObject({ state: 'retiree', proof: null });
    expect((await t.mentions.read('net-1')).launchClosedBy).toEqual(['Assurance de responsabilité civile professionnelle']);
    // Une nouvelle attestation rouvre ; les trois versions restent.
    expect(await t.launch.declare(direction, { prerequisite: 'assurance', documentNumber: 'RCP-0002', issuer: 'Autre assureur inventé', proofRef: 'preuve-2', validFrom: '2026-11-21', validUntil: '2027-11-20' })).toEqual({ ok: true, version: 3 });
    expect(await lineOf(t, 'assurance')).toMatchObject({ state: 'valide', proof: { version: 3, issuer: 'Autre assureur inventé' } });
    expect(await t.db.all("SELECT version, withdrawn FROM launch_proofs WHERE prerequisite = 'assurance' ORDER BY version")).toEqual([{ version: 1, withdrawn: 0 }, { version: 2, withdrawn: 1 }, { version: 3, withdrawn: 0 }]);
    await expect(t.db.run("UPDATE launch_proofs SET issuer = 'x' WHERE prerequisite = 'assurance'")).rejects.toThrow(/ne change plus/);
    await expect(t.db.run("DELETE FROM launch_proofs WHERE prerequisite = 'assurance'")).rejects.toThrow(/rien ne s'efface/);
  });

  it('[R675] Jamais vu : la preuve doit dire ce que le réseau montre (numéro de carte affiché, médiateur proposé aux clients)', async () => {
    const t = await setup();
    await siteFilled(t);
    await declareAll(t);
    // Le même numéro, écrit autrement : pas d'écart.
    expect((await t.launch.declare(direction, { prerequisite: 'carte', documentNumber: 'cpi9999-0000-000-000-001', issuer: 'Chambre inventée', proofRef: 'p', validFrom: '2026-01-01', validUntil: '2028-12-31' })).ok).toBe(true);
    expect(await lineOf(t, 'carte')).toMatchObject({ state: 'valide' });
    // La carte affichée sur les annonces change sans nouvelle preuve : écart, le site se ferme.
    await t.db.exec('PRAGMA foreign_keys = OFF');
    await t.db.run("INSERT INTO listing_settings (id, network_id, card_number, set_by, set_at) VALUES ('s2', 'net-1', 'CPI 9999 0000 000 000 002', 'direction:dir-1', '2026-11-21T10:00:00.000Z')");
    await t.db.exec('PRAGMA foreign_keys = ON');
    expect(await lineOf(t, 'carte')).toMatchObject({ state: 'ecart', gap: 'numero_affiche' });
    expect(siteReady(await t.mentions.read('net-1'))).toBe(false);
    // Le médiateur proposé aux clients qui se plaignent n'est pas celui de l'adhésion prouvée : écart.
    await t.db.run("INSERT INTO complaint_settings (network_id, version, response_days, mediator_name, mediator_site, set_by, set_at) VALUES ('net-1', 1, 10, 'Médiateur Inventé', 'https://mediateur.exemple.test', 'direction:dir-1', 'x')");
    expect(await lineOf(t, 'mediateur')).toMatchObject({ state: 'valide' });
    await t.db.run("INSERT INTO complaint_settings (network_id, version, response_days, mediator_name, mediator_site, set_by, set_at) VALUES ('net-1', 2, 10, 'Un autre médiateur', 'https://autre.exemple.test', 'direction:dir-1', 'x')");
    expect(await lineOf(t, 'mediateur')).toMatchObject({ state: 'ecart', gap: 'mediateur_propose' });
  });

  it('[R675] Jamais vu : une mention changée après la relecture de l’avocat la rend « à relire »', async () => {
    const t = await setup();
    await siteFilled(t);
    await declareAll(t);
    expect(await lineOf(t, 'mentions')).toMatchObject({ state: 'valide', daysLeft: null });
    expect(await t.mentions.set(direction, { assureur: 'Autre assureur inventé' })).toEqual({ ok: true });
    expect(await lineOf(t, 'mentions')).toMatchObject({ state: 'a_relire' });
    expect(siteReady(await t.mentions.read('net-1'))).toBe(false);
    // Relue de nouveau, après ce changement : valide.
    expect((await t.launch.declare(direction, { prerequisite: 'mentions', documentNumber: 'RELECTURE-0001', issuer: 'Cabinet inventé', proofRef: 'p2', validFrom: '2026-11-21' })).ok).toBe(true);
    expect(await lineOf(t, 'mentions')).toMatchObject({ state: 'valide', proof: { version: 2 } });
    // Le titulaire de la carte, écrit sur la page des mentions mais réglé ailleurs, change : à relire aussi.
    await t.db.exec('PRAGMA foreign_keys = OFF');
    await t.db.run("INSERT INTO card_holders (id, network_id, holder_name, set_by, set_at) VALUES ('h2', 'net-1', 'Autre société', 'direction:dir-1', ?)", [t.now().toISOString()]);
    await t.db.exec('PRAGMA foreign_keys = ON');
    expect(await lineOf(t, 'mentions')).toMatchObject({ state: 'a_relire' });
    expect((await t.launch.declare(direction, { prerequisite: 'mentions', documentNumber: 'RELECTURE-0001b', issuer: 'Cabinet inventé', proofRef: 'p2b', validFrom: '2026-11-21' })).ok).toBe(true);
    expect(await lineOf(t, 'mentions')).toMatchObject({ state: 'valide', proof: { version: 3 } });
    // Une relecture datée d'avant le dernier changement ne vaut pas, même déclarée après.
    t.setDay('2026-11-23');
    expect(await t.mentions.set(direction, { garant: 'Autre garant inventé' })).toEqual({ ok: true });
    expect((await t.launch.declare(direction, { prerequisite: 'mentions', documentNumber: 'RELECTURE-0002', issuer: 'Cabinet inventé', proofRef: 'p3', validFrom: '2026-11-22' })).ok).toBe(true);
    expect(await lineOf(t, 'mentions')).toMatchObject({ state: 'a_relire' });
  });

  it('[R675] [R16] seule la direction déclare ; une preuve incomplète ou mal datée est refusée', async () => {
    const t = await setup();
    expect(await t.launch.declare(agent, launchProofInputs('2026-11-21', CARD)[0])).toEqual({ ok: false, rule: 'R16', code: 'role' });
    const refused = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'acces.refuse'");
    expect(refused.map((r) => JSON.parse(r.data))).toEqual([{ rule: 'R16', role: 'agent', kind: 'mise_en_service', code: 'role' }]);
    const ok = { prerequisite: 'garantie', documentNumber: 'GAR-1', issuer: 'Garant inventé', proofRef: 'p', validFrom: '2026-01-01', validUntil: '2026-12-31' };
    for (const [bad, code] of [
      [null, 'preuve_invalide'],
      [[], 'preuve_invalide'],
      [{ ...ok, prerequisite: 'kbis' }, 'prerequis_inconnu'],
      [{ ...ok, documentNumber: ' ' }, 'preuve_invalide'],
      [{ ...ok, issuer: undefined }, 'preuve_invalide'],
      [{ ...ok, proofRef: 'x'.repeat(201) }, 'preuve_invalide'],
      [{ ...ok, issuer: '<b>Garant</b>' }, 'preuve_invalide'],
      [{ ...ok, validFrom: '2026-02-30' }, 'date_invalide'],
      [{ ...ok, validUntil: undefined }, 'date_invalide'],
      [{ ...ok, validUntil: '2025-12-31' }, 'date_invalide'],
      [{ ...ok, withdrawn: 'oui' }, 'preuve_invalide'],
      [{ prerequisite: 'garantie', withdrawn: true, issuer: 'x' }, 'preuve_invalide'],
      [{ prerequisite: 'mentions', documentNumber: 'R', issuer: 'Cabinet', proofRef: 'p', validFrom: '2026-11-21', validUntil: '2027-01-01' }, 'date_invalide'],
      [{ prerequisite: 'mentions', documentNumber: 'R', issuer: 'Cabinet', proofRef: 'p', validFrom: '2026-11-22' }, 'date_invalide'],
    ] as const) {
      expect(await t.launch.declare(direction, bad), JSON.stringify(bad)).toEqual({ ok: false, rule: null, code });
    }
    expect(await t.db.all('SELECT id FROM launch_proofs')).toEqual([]);
    expect(await t.launch.declare(direction, ok)).toEqual({ ok: true, version: 1 });
    // Au journal : le prérequis et la version, jamais le numéro, l'émetteur ni la référence [R13].
    const events = await t.db.all<{ data: string }>("SELECT data FROM journal WHERE type = 'conformite.mise_en_service'");
    expect(events.map((e) => JSON.parse(e.data))).toEqual([{ rule: 'R675', prerequisite: 'garantie', version: 1, withdrawn: false }]);
  });

  it(`[R675] une preuve qui finit dans ${LAUNCH_SOON_DAYS} jours ou moins se signale, pas avant`, async () => {
    const t = await setup();
    expect((await t.launch.declare(direction, { prerequisite: 'carte', documentNumber: CARD, issuer: 'Chambre inventée', proofRef: 'p', validFrom: '2026-01-01', validUntil: '2026-12-22' })).ok).toBe(true);
    expect(await lineOf(t, 'carte')).toMatchObject({ state: 'valide', daysLeft: 31, soon: false });
    t.setDay('2026-11-22');
    expect(await lineOf(t, 'carte')).toMatchObject({ state: 'valide', daysLeft: 30, soon: true });
  });
});
