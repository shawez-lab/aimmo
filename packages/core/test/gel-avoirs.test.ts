import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ControleEnvois, DecisionEnvoi, FakeChannel, FicheUnique, SqlSendJournal, verifyChain, type Channel, type Viewer } from '../src/index.ts';
import { RegistreOffres } from '../src/offres/index.ts';
import { ControleGels, FREEZE_CHECK_STATUS, nameTokens, namesMatch, type FreezeRegistryEntry } from '../src/securite/index.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Clients, dossiers, agents, responsable et registre inventés. Un mardi de mars, à 10 h à Paris.
const NOW = new Date('2027-03-09T09:00:00.000Z');
const LONG_AGO = new Date('2026-01-01T00:00:00.000Z');

// Un registre inventé : aucune de ces personnes n'existe.
const SANS_LEA: FreezeRegistryEntry[] = [
  { entryId: 'G-1001', nature: 'personne_physique', names: ['FICTIF Marcel Auguste', 'Marcel l’Inventé'] },
  { entryId: 'G-1002', nature: 'personne_morale', names: ['SOCIETE IMAGINAIRE SARL'] },
];
const AVEC_LEA: FreezeRegistryEntry[] = [...SANS_LEA, { entryId: 'G-2001', nature: 'personne_physique', names: ['EXEMPLE Léa Marie', 'Léa Exemplaire'] }];

async function setup() {
  const t = await setupAnnonce();
  t.setClock(NOW);
  const gels = new ControleGels(t.db, t.acces, t.journal, { now: t.now });
  const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: t.network.id }) as Viewer;
  const fiche = new FicheUnique(t.db, t.store, { now: t.now });
  const decisions = new DecisionEnvoi(t.db, t.store, fiche, { now: t.now });
  const outbox = (['email', 'sms'] as Channel[]).map((c) => new FakeChannel(c));
  const controle = new ControleEnvois(t.db, fiche, decisions, { channels: outbox, journal: new SqlSendJournal(t.db), budget: { allows: async () => false }, now: t.now });
  await t.store.addIdentifier({ networkId: t.network.id, personId: t.personId, kind: 'email', value: 'lea.exemple@example.test' });
  await t.store.addConsent({ networkId: t.network.id, personId: t.personId, purpose: 'follow_up', channel: 'email', proof: 'formulaire test', givenAt: LONG_AGO });
  const mandateRef = `mandate:${t.mandateId}`;
  const conformite = as('compliance', 'conformite-1');
  const importAt = async (publishedAt: string, entries: FreezeRegistryEntry[]) => {
    const r = await gels.importRegistry(conformite, { publishedAt, entries });
    if (!r.ok) throw new Error(r.code);
    return r.value;
  };
  return { ...t, gels, controle, outbox, mandateRef, conformite, partner: as('partner', 'partenaire-1'), importAt };
}

describe('HX57 · comparer les noms', () => {
  it('[R603] sans accents, casse ni ordre ; un seul prénom ne suffit jamais', () => {
    expect(nameTokens('  Léa-Marie  EXEMPLE ')).toEqual(['EXEMPLE', 'LEA', 'MARIE']);
    expect(nameTokens(null)).toEqual([]);
    const entry = nameTokens('EXEMPLE Léa Marie');
    expect(namesMatch(entry, nameTokens('Lea Exemple'))).toBe(true);
    expect(namesMatch(entry, nameTokens('exemple léa marie'))).toBe(true);
    expect(namesMatch(entry, nameTokens('Léa'))).toBe(false);
    expect(namesMatch(entry, nameTokens('Léa Autre'))).toBe(false);
    expect(namesMatch(nameTokens('IMAGINAIRE'), nameTokens('Imaginaire'))).toBe(true);
    expect(namesMatch(nameTokens('IMAGINAIRE'), nameTokens('Imaginaire Conseil'))).toBe(false);
    expect(namesMatch([], [])).toBe(false);
    // Les lettres liées et barrées se lisent comme le registre les écrit.
    expect(nameTokens('Lætitia Œuvray-Łukasz Øster')).toEqual(['LAETITIA', 'LUKASZ', 'OEUVRAY', 'OSTER']);
    expect(namesMatch(nameTokens('EXEMPLE Laetitia'), nameTokens('Lætitia Exemple'))).toBe(true);
    expect(nameTokens('Иван Петров')).toEqual([]);
  });
});

describeWithSqlite('HX57 · contrôle du gel des avoirs', () => {
  it('[R603] [R605] Jamais vu : une nouvelle version du registre revérifie tout dossier ouvert ; une correspondance alerte le responsable et fige le dossier', async () => {
    const t = await setup();
    const first = await t.importAt('2027-03-01T10:00:00.000Z', SANS_LEA);
    expect(first.checked).toBe(1);
    expect(await t.gels.matches(t.conformite)).toEqual({ ok: true, value: [] });
    // Une semaine plus tard, une nouvelle version : le dossier est revérifié sans que personne ne le demande.
    t.setClock(new Date('2027-03-16T09:00:00.000Z'));
    const second = await t.importAt('2027-03-15T10:00:00.000Z', AVEC_LEA);
    expect(second).toMatchObject({ entries: 3, checked: 1 });
    const list = await t.gels.matches(t.conformite);
    if (!list.ok) throw new Error(list.code);
    expect(list.value).toHaveLength(1);
    const match = list.value[0]!;
    expect(match).toMatchObject({
      caseRef: t.mandateRef,
      decision: null,
      check: { result: 'correspondance', reason: 'mise_a_jour', matches: [{ personId: t.personId, entryId: 'G-2001' }], version: { versionId: second.versionId, sha256: second.sha256 } },
    });
    expect(match.lines).toBeGreaterThan(3);
    // Le dossier est figé : intact, puis tout changement forcé se voit.
    expect(await t.gels.checkFrozen(t.conformite, match.matchId)).toEqual({ ok: true, value: { intact: true, changed: [], missing: [], added: [] } });
    await t.db.exec('DROP TRIGGER IF EXISTS mandates_fige');
    await t.db.run("UPDATE mandates SET source_detail = 'modifié' WHERE id = ?", [t.mandateId]);
    expect(await t.gels.checkFrozen(t.conformite, match.matchId)).toMatchObject({ ok: true, value: { intact: false, changed: [{ table: 'mandates', key: t.mandateId }] } });
    // Personne d'autre ne voit rien, pas même qu'une correspondance existe.
    for (const viewer of [t.agent, t.sam, t.direction, t.partner]) {
      expect(await t.gels.matches(viewer)).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await t.gels.checkFrozen(viewer, match.matchId)).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await t.gels.checks(viewer, t.mandateRef)).toEqual({ ok: false, rule: 'R16', code: 'role' });
      expect(await t.gels.importRegistry(viewer, { publishedAt: '2027-03-16T00:00:00.000Z', entries: AVEC_LEA })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    }
  });

  it('[R603] une offre et un dossier de vente : l’acquéreur et le vendeur sont contrôlés ; un dossier fini ne l’est plus', async () => {
    const t = await setup();
    const buyer = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Marcel', lastName: 'Fictif' });
    const offer = await new RegistreOffres(t.db, t.acces, t.journal, { now: t.now }).record(t.agent, t.propertyId, {
      buyerPersonId: buyer.id, amountEur: 195000, conditions: [], validUntil: '2027-03-20', downPaymentEur: 195000, loanEur: 0,
      signedRef: 'offres/0b6f1d2e-1111-4a2b-8c3d-000000000001.pdf', receivedAt: '2027-03-09T08:00:00.000Z',
    });
    if (!offer.ok) throw new Error(offer.code);
    const fileId = '0b6f1d2e-9999-4a2b-8c3d-000000000009';
    await t.db.run(
      'INSERT INTO sale_files (id, network_id, property_id, offer_id, buyer_person_id, amount_eur, opened_at, opened_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [fileId, t.network.id, t.propertyId, offer.value.id, buyer.id, 195000, NOW.toISOString(), `agent:${t.alexId}`],
    );
    const v = await t.importAt('2027-03-01T10:00:00.000Z', SANS_LEA);
    // Le mandat (vendeur seul), l'offre et le dossier de vente (acquéreur et vendeur) : trois dossiers ouverts.
    expect(v.checked).toBe(3);
    const list = await t.gels.matches(t.conformite);
    if (!list.ok) throw new Error(list.code);
    expect(list.value.map((m) => m.caseRef).sort()).toEqual([`offer:${offer.value.id}`, `sale_file:${fileId}`].sort());
    for (const m of list.value) expect(m.check.matches).toEqual([{ personId: buyer.id, entryId: 'G-1001' }]);
    expect(await t.gels.checks(t.conformite, t.mandateRef)).toMatchObject({ ok: true, value: [{ result: 'aucune', persons: 1 }] });
    // Le dossier de vente arrêté : l'offre et le dossier ne sont plus revérifiés à la version suivante, le mandat si.
    await t.db.run("INSERT INTO sale_file_stops (file_id, network_id, reason, proof_ref, at, by) VALUES (?, ?, 'pret_refuse', 'arrets/preuve.pdf', ?, ?)", [fileId, t.network.id, NOW.toISOString(), `agent:${t.alexId}`]);
    t.setClock(new Date('2027-03-16T09:00:00.000Z'));
    const next = await t.importAt('2027-03-15T10:00:00.000Z', AVEC_LEA);
    expect(next.checked).toBe(1);
    expect(await t.gels.checks(t.conformite, t.mandateRef)).toMatchObject({ ok: true, value: [{ result: 'aucune' }, { result: 'correspondance', version: { versionId: next.versionId } }] });
  });

  it('[R604] Jamais vu : le client reçoit exactement les mêmes textes, et l’agent le même mot, avec ou sans correspondance', async () => {
    const run = async (entries: FreezeRegistryEntry[]) => {
      const t = await setup();
      await t.importAt('2027-03-01T10:00:00.000Z', entries);
      const asked = await t.gels.checkCase(t.agent, t.mandateRef);
      const sent = [];
      for (const [subject, text] of [
        ['relance:vente-1', 'Bonjour Léa, votre agent vous rappelle cette semaine pour faire le point.'],
        ['point:semaine-10', 'Bonjour Léa, voici le point de la semaine sur votre bien.'],
      ] as const) {
        const r = await t.controle.send({ networkId: t.network.id, agentId: t.alexId, personId: t.personId, channel: 'email', kind: 'follow_up', subject, fallbackTexts: [text] });
        sent.push([r.status, r.rule ?? null, r.body ?? null]);
      }
      await t.publication.sync(t.network.id, t.propertyId);
      const matches = await t.gels.matches(t.conformite);
      return {
        found: matches.ok ? matches.value.length : -1,
        view: {
          asked,
          sent,
          delivered: t.outbox.map((c) => c.sent.map((m) => [c.channel, m.to, m.body])),
          portals: t.channels.map((c) => c.received.map((p) => JSON.stringify({ ...p, version: undefined, id: undefined }))),
          fiche: await (async () => {
            const f = await t.acces.readFiche(t.agent, t.personId);
            return f.ok ? { ...f.value, messages: f.value.messages.map((m) => m.body).sort() } : f;
          })(),
        },
      };
    };
    const without = await run(SANS_LEA);
    const withIt = await run(AVEC_LEA);
    expect(without.found).toBe(0);
    expect(withIt.found).toBe(1);
    expect(without.view.asked).toEqual({ ok: true, status: FREEZE_CHECK_STATUS });
    expect(without.view.delivered.flat().length).toBeGreaterThan(0);
    expect(JSON.stringify(withIt.view).replace(/[0-9a-f-]{36}/g, '')).toEqual(JSON.stringify(without.view).replace(/[0-9a-f-]{36}/g, ''));
  });

  it('[R605] chaque contrôle est daté avec la version du registre, une fois par version ; une version plus ancienne est refusée', async () => {
    const t = await setup();
    expect(await t.gels.checkCase(t.agent, t.mandateRef)).toEqual({ ok: false, rule: 'R605', code: 'no_registry' });
    const v1 = await t.importAt('2027-03-01T10:00:00.000Z', SANS_LEA);
    t.setClock(new Date('2027-03-09T10:30:00.000Z'));
    // Demandé de nouveau sur la même version et le même périmètre : rien de plus n'est rangé.
    expect(await t.gels.checkCase(t.agent, t.mandateRef)).toEqual({ ok: true, status: FREEZE_CHECK_STATUS });
    expect(await t.gels.sweep(t.network.id)).toEqual({ checked: 0 });
    const checks = await t.gels.checks(t.conformite, t.mandateRef);
    expect(checks).toMatchObject({
      ok: true,
      value: [{ checkedAt: NOW.toISOString(), reason: 'mise_a_jour', result: 'aucune', version: { versionId: v1.versionId, publishedAt: '2027-03-01T10:00:00.000Z', sha256: v1.sha256 } }],
    });
    expect(v1.sha256).toMatch(/^[0-9a-f]{64}$/);
    // La même version, ou une plus ancienne, est refusée ; une date future aussi.
    expect(await t.gels.importRegistry(t.conformite, { publishedAt: '2027-03-01T10:00:00.000Z', entries: SANS_LEA })).toEqual({ ok: false, rule: null, code: 'already_imported' });
    expect(await t.gels.importRegistry(t.conformite, { publishedAt: '2027-02-01T10:00:00.000Z', entries: AVEC_LEA })).toEqual({ ok: false, rule: 'R605', code: 'older_version' });
    expect(await t.gels.importRegistry(t.conformite, { publishedAt: '2027-04-01T10:00:00.000Z', entries: AVEC_LEA })).toEqual({ ok: false, rule: null, code: 'future_date' });
    // Entrées mal formées.
    for (const entries of [[], [{ entryId: 'x', nature: 'navire', names: ['A B'] }], [{ entryId: 'x', nature: 'personne_physique', names: [] }], [{ entryId: 'x', nature: 'personne_physique', names: ['A B'], extra: 1 }], [...SANS_LEA, SANS_LEA[0]]]) {
      expect(await t.gels.importRegistry(t.conformite, { publishedAt: '2027-03-05T10:00:00.000Z', entries })).toMatchObject({ ok: false, rule: null });
    }
    // Un nouveau dossier, ouvert après l'import : le passage planifié le contrôle sur la dernière version.
    const buyer = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Acheteur', lastName: 'Exemple' });
    const offer = await new RegistreOffres(t.db, t.acces, t.journal, { now: t.now }).record(t.agent, t.propertyId, {
      buyerPersonId: buyer.id, amountEur: 195000, conditions: [], validUntil: '2027-03-20', downPaymentEur: 195000, loanEur: 0,
      signedRef: 'offres/0b6f1d2e-1111-4a2b-8c3d-000000000002.pdf', receivedAt: '2027-03-09T08:00:00.000Z',
    });
    if (!offer.ok) throw new Error(offer.code);
    expect(await t.gels.sweep(t.network.id)).toEqual({ checked: 1 });
    expect(await t.gels.checks(t.conformite, `offer:${offer.value.id}`)).toMatchObject({ ok: true, value: [{ reason: 'passage', persons: 2, version: { versionId: v1.versionId } }] });
    expect(await t.gels.sweep(t.network.id)).toEqual({ checked: 0 });
    // La base : un contrôle sur une version ouverte ou inconnue est refusé ; rien ne change ni ne s'efface.
    await expect(
      t.db.run(
        "INSERT INTO freeze_checks (id, network_id, case_ref, version_id, scope_sha256, persons, result, matches, unnamed, reason, requested_by, checked_at) VALUES ('c-x', ?, 'mandate:x', 'inconnue', ?, 1, 'aucune', '[]', '[]', 'demande', 'x', 'x')",
        [t.network.id, 'a'.repeat(64)],
      ),
    ).rejects.toThrow('version scellée');
    await expect(t.db.run("UPDATE freeze_checks SET result = 'aucune'")).rejects.toThrow('ne change plus');
    await expect(t.db.run('DELETE FROM freeze_checks')).rejects.toThrow('rien ne s');
    await expect(t.db.run("UPDATE freeze_registry_versions SET sha256 = ?", ['b'.repeat(64)])).rejects.toThrow('se scelle une fois');
    await expect(t.db.run("INSERT INTO freeze_registry_entries (version_id, entry_id, nature, names) VALUES (?, 'G-9', 'personne_physique', '[\"A B\"]')", [v1.versionId])).rejects.toThrow('scellée');
    await expect(t.db.run('DELETE FROM freeze_registry_entries')).rejects.toThrow('rien ne s');
    await expect(
      t.db.run("INSERT INTO freeze_registry_versions (id, network_id, published_at, sha256, entries, imported_by, imported_at) VALUES ('v-old', ?, '2027-02-01T10:00:00.000Z', ?, 1, 'x', 'x')", [t.network.id, 'c'.repeat(64)]),
    ).rejects.toThrow('plus récente');
    await expect(
      t.db.run("INSERT INTO freeze_matches (id, network_id, check_id, case_ref, snapshot, snapshot_sha256, created_at) SELECT 'm-x', network_id, id, case_ref, '{}', ?, 'x' FROM freeze_checks LIMIT 1", ['d'.repeat(64)]),
    ).rejects.toThrow('correspondance');
  });

  it('[R605] l’import est une seule écriture, en lots de 100 valeurs au plus (limite de D1) ; un alias illisible est laissé', async () => {
    const t = await setup();
    let max = 0;
    const strict = Object.create(t.db) as typeof t.db;
    const guard = (params: readonly unknown[] | undefined) => {
      max = Math.max(max, params?.length ?? 0);
      if ((params?.length ?? 0) > 100) throw new Error('too many SQL variables');
    };
    strict.run = async (sql, params) => (guard(params), t.db.run(sql, params));
    strict.batch = async (statements) => {
      statements.forEach((st) => guard(st.params));
      return t.db.batch ? t.db.batch(statements) : Promise.all(statements.map((st) => t.db.run(st.sql, st.params ?? [])));
    };
    const gels = new ControleGels(strict, t.acces, t.journal, { now: t.now });
    const many: FreezeRegistryEntry[] = Array.from({ length: 120 }, (_, i) => ({ entryId: `G-${3000 + i}`, nature: 'personne_physique', names: [`FICTIF Numero${i} Inventé`, 'Иван Петров'] }));
    const r = await gels.importRegistry(t.conformite, { publishedAt: '2027-03-01T10:00:00.000Z', entries: [...many, ...AVEC_LEA] });
    expect(r).toMatchObject({ ok: true, value: { entries: 123, checked: 1 } });
    expect(max).toBeLessThanOrEqual(100);
    // Une entrée dont aucun nom n'est lisible est refusée.
    expect(await gels.importRegistry(t.conformite, { publishedAt: '2027-03-05T10:00:00.000Z', entries: [{ entryId: 'G-1', nature: 'personne_physique', names: ['Иван Петров'] }] })).toEqual({ ok: false, rule: null, code: 'bad_entry' });
    // Un lot qui échoue ne laisse aucune version ouverte : le même import repasse ensuite.
    const failing = Object.create(t.db) as typeof t.db;
    failing.batch = async () => { throw new Error('D1 en panne'); };
    failing.run = async () => { throw new Error('D1 en panne'); };
    const broken = new ControleGels(failing, t.acces, t.journal, { now: t.now });
    await expect(broken.importRegistry(t.conformite, { publishedAt: '2027-03-06T10:00:00.000Z', entries: SANS_LEA })).rejects.toThrow('D1 en panne');
    expect(await t.db.first('SELECT id FROM freeze_registry_versions WHERE sealed_at IS NULL')).toBeNull();
    expect(await t.gels.importRegistry(t.conformite, { publishedAt: '2027-03-06T10:00:00.000Z', entries: SANS_LEA })).toMatchObject({ ok: true });
  });

  it('[R605] un bien revendu : le nouveau mandat est revérifié, malgré l’acte d’une vente d’avant', async () => {
    const t = await setup();
    const buyer = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Acheteur', lastName: 'Exemple' });
    const offer = await new RegistreOffres(t.db, t.acces, t.journal, { now: t.now }).record(t.agent, t.propertyId, {
      buyerPersonId: buyer.id, amountEur: 195000, conditions: [], validUntil: '2027-03-20', downPaymentEur: 195000, loanEur: 0,
      signedRef: 'offres/0b6f1d2e-1111-4a2b-8c3d-000000000003.pdf', receivedAt: '2027-03-09T08:00:00.000Z',
    });
    if (!offer.ok) throw new Error(offer.code);
    // Une vente d'avant, ouverte et close bien avant le mandat en cours.
    const fileId = '0b6f1d2e-9999-4a2b-8c3d-000000000010';
    await t.db.run(
      'INSERT INTO sale_files (id, network_id, property_id, offer_id, buyer_person_id, amount_eur, opened_at, opened_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [fileId, t.network.id, t.propertyId, offer.value.id, buyer.id, 195000, '2020-01-01T00:00:00.000Z', `agent:${t.alexId}`],
    );
    await t.db.exec('PRAGMA foreign_keys = OFF');
    await t.db.run("INSERT INTO sale_file_closings (file_id, network_id, signed_on, proof_ref, aftersale, at) VALUES (?, ?, '2020-03-01', 'actes/preuve.pdf', 'a_demarrer', '2020-03-01T10:00:00.000Z')", [fileId, t.network.id]).catch(async () => {
      const cols = await t.db.all<{ name: string }>('PRAGMA table_info(sale_file_closings)');
      const v: Record<string, string> = { file_id: fileId, network_id: t.network.id, signed_on: '2020-03-01', proof_ref: 'actes/preuve.pdf', aftersale: 'a_demarrer', at: '2020-03-01T10:00:00.000Z' };
      await t.db.run(`INSERT INTO sale_file_closings (${cols.map((c) => c.name).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`, cols.map((c) => v[c.name] ?? 'x'));
    });
    await t.importAt('2027-03-01T10:00:00.000Z', AVEC_LEA);
    expect(await t.gels.checks(t.conformite, t.mandateRef)).toMatchObject({ ok: true, value: [{ result: 'correspondance' }] });
  });

  it('[R603] [R605] un nom corrigé après un contrôle est recontrôlé, sur la même version', async () => {
    const t = await setup();
    await t.db.exec('DROP TRIGGER IF EXISTS persons_fige');
    await t.db.run("UPDATE persons SET last_name = 'Autre' WHERE id = ?", [t.personId]);
    await t.importAt('2027-03-01T10:00:00.000Z', AVEC_LEA);
    expect(await t.gels.matches(t.conformite)).toEqual({ ok: true, value: [] });
    await t.db.run("UPDATE persons SET last_name = 'Exemple' WHERE id = ?", [t.personId]);
    t.setClock(new Date('2027-03-09T10:00:00.000Z'));
    expect(await t.gels.sweepAll()).toEqual({ checked: 1 });
    expect(await t.gels.checks(t.conformite, t.mandateRef)).toMatchObject({ ok: true, value: [{ result: 'aucune' }, { result: 'correspondance', reason: 'passage' }] });
  });

  it('[R603] des fiches réunies se complètent : le prénom de l’une et le nom de l’autre', async () => {
    const t = await setup();
    await t.db.exec('DROP TRIGGER IF EXISTS persons_fige');
    await t.db.run('UPDATE persons SET first_name = ?, last_name = NULL WHERE id = ?', ['Marcel', t.personId]);
    const other = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, lastName: 'Fictif' });
    await new FicheUnique(t.db, t.store, { now: t.now }).merge({ survivorId: t.personId, mergedId: other.id, reason: 'même mail' });
    await t.importAt('2027-03-01T10:00:00.000Z', [{ entryId: 'G-5001', nature: 'personne_physique', names: ['FICTIF Marcel'] }]);
    const list = await t.gels.matches(t.conformite);
    expect(list.ok && list.value.map((m) => m.check.result)).toEqual(['correspondance']);
    expect(list.ok && list.value[0]!.check.unnamed).toEqual([]);
  });

  it('[R603] une fiche avec un prénom seul ne peut pas être jugée « aucune »', async () => {
    const t = await setup();
    await t.db.exec('DROP TRIGGER IF EXISTS persons_fige');
    await t.db.run('UPDATE persons SET last_name = NULL WHERE id = ?', [t.personId]);
    await t.importAt('2027-03-01T10:00:00.000Z', AVEC_LEA);
    expect(await t.gels.checks(t.conformite, t.mandateRef)).toMatchObject({ ok: true, value: [{ result: 'nom_manquant', unnamed: [t.personId] }] });
  });

  it('[R605] le passage de chaque heure contrôle les dossiers ouverts de chaque réseau', async () => {
    const t = await setup();
    expect(await t.gels.sweepAll()).toEqual({ checked: 0 });
    await t.importAt('2027-03-01T10:00:00.000Z', SANS_LEA);
    const buyer = await t.store.createPerson({ networkId: t.network.id, agentId: t.alexId, firstName: 'Marcel Auguste', lastName: 'Fictif' });
    const offer = await new RegistreOffres(t.db, t.acces, t.journal, { now: t.now }).record(t.agent, t.propertyId, {
      buyerPersonId: buyer.id, amountEur: 195000, conditions: [], validUntil: '2027-03-20', downPaymentEur: 195000, loanEur: 0,
      signedRef: 'offres/0b6f1d2e-1111-4a2b-8c3d-000000000004.pdf', receivedAt: '2027-03-09T08:00:00.000Z',
    });
    if (!offer.ok) throw new Error(offer.code);
    expect(await t.gels.sweepAll()).toEqual({ checked: 1 });
    expect(await t.gels.matches(t.conformite)).toMatchObject({ ok: true, value: [{ caseRef: `offer:${offer.value.id}`, check: { reason: 'passage' } }] });
  });

  it('[R603] une fiche sans nom ne peut pas être jugée : le responsable seul le sait', async () => {
    const t = await setup();
    await t.db.exec('DROP TRIGGER IF EXISTS persons_fige');
    await t.db.run('UPDATE persons SET first_name = NULL, last_name = NULL WHERE id = ?', [t.personId]);
    await t.importAt('2027-03-01T10:00:00.000Z', AVEC_LEA);
    expect(await t.gels.matches(t.conformite)).toEqual({ ok: true, value: [] });
    expect(await t.gels.unnamedCases(t.conformite)).toMatchObject({ ok: true, value: [{ caseRef: t.mandateRef, result: 'nom_manquant', unnamed: [t.personId] }] });
    expect(await t.gels.unnamedCases(t.agent)).toEqual({ ok: false, rule: 'R16', code: 'role' });
  });

  it('[R603] [R16] seul l’agent du client ou le responsable demandent un contrôle ; le responsable juge seul, une fois ; le journal sans nom', async () => {
    const t = await setup();
    await t.importAt('2027-03-01T10:00:00.000Z', SANS_LEA);
    for (const viewer of [t.sam, t.direction, t.partner]) {
      const r = await t.gels.checkCase(viewer, t.mandateRef);
      expect(r.ok).toBe(false);
      expect(JSON.stringify(r)).not.toContain(FREEZE_CHECK_STATUS);
    }
    expect(await t.gels.checkCase(t.agent, 'mandate:x')).toEqual({ ok: false, rule: null, code: 'bad_case' });
    expect(await t.gels.checkCase(t.agent, 'offer:00000000-0000-4000-8000-000000000000')).toEqual({ ok: false, rule: null, code: 'unknown_case' });
    t.setClock(new Date('2027-03-16T09:00:00.000Z'));
    await t.importAt('2027-03-15T10:00:00.000Z', AVEC_LEA);
    const list = await t.gels.matches(t.conformite);
    if (!list.ok) throw new Error(list.code);
    const id = list.value[0]!.matchId;
    for (const viewer of [t.agent, t.direction, t.partner]) {
      expect(await t.gels.decide(viewer, id, { decision: 'fausse_correspondance', reason: 'Date de naissance différente', validatorName: 'Camille Conforme' })).toEqual({ ok: false, rule: 'R16', code: 'role' });
    }
    expect(await t.gels.decide(t.conformite, id, { decision: 'autre', reason: 'x', validatorName: 'Camille Conforme' })).toEqual({ ok: false, rule: null, code: 'bad_decision' });
    expect(await t.gels.decide(t.conformite, id, { decision: 'fausse_correspondance', reason: 'x', validatorName: ' ' })).toEqual({ ok: false, rule: null, code: 'missing_name' });
    expect(await t.gels.decide(t.conformite, id, { decision: 'fausse_correspondance', reason: 'Date de naissance différente', validatorName: 'Camille Conforme' })).toMatchObject({
      ok: true,
      value: { decision: { decision: 'fausse_correspondance', validatorName: 'Camille Conforme', decidedOn: '2027-03-16' } },
    });
    expect(await t.gels.decide(t.conformite, id, { decision: 'correspondance_confirmee', reason: 'x', validatorName: 'Camille Conforme' })).toEqual({ ok: false, rule: null, code: 'already_decided' });
    await expect(t.db.run("UPDATE freeze_match_decisions SET decision = 'correspondance_confirmee'")).rejects.toThrow('ne change plus');
    const all = await t.journal.all();
    expect(all.filter((e) => e.type.startsWith('securite.gel_')).map((e) => [e.type, (e.subject ?? '').split(':')[0], e.data.rule])).toEqual([
      ['securite.gel_registre', 'freeze_registry', 'R605'],
      ['securite.gel_controle', 'freeze_check', 'R605'],
      ['securite.gel_registre', 'freeze_registry', 'R605'],
      ['securite.gel_controle', 'freeze_check', 'R605'],
      ['securite.gel_correspondance', 'freeze_match', 'R603'],
      ['securite.gel_decision', 'freeze_match', 'R603'],
    ]);
    expect(JSON.stringify(await t.journal.bySubject(`person:${t.personId}`))).not.toMatch(/gel|freeze/);
    const text = JSON.stringify(all);
    for (const word of ['Camille', 'EXEMPLE', 'FICTIF', 'naissance', 'G-2001']) expect(text).not.toContain(word);
    expect(await verifyChain(all)).toMatchObject({ ok: true });
  });
});

describe('HX57 · rien ne lit le contrôle du gel hors de son code', () => {
  it('[R604] ni le contrôle des envois, ni l’espace du client, ni aucun autre code ne lit les tables du gel', () => {
    const roots = ['../src', '../../api/src', '../../app/src'].map((r) => fileURLToPath(new URL(r, import.meta.url)));
    const files: string[] = [];
    const walk = (dir: string) => {
      let names: string[] = [];
      try {
        names = readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx|js|mjs)$/.test(p)) files.push(p);
      }
    };
    roots.forEach(walk);
    const readers = files.filter((f) => /freeze_(registry|checks|matches|match_decisions)|ControleGels|gel-avoirs\.ts/.test(readFileSync(f, 'utf8'))).map((f) => f.split(/[\\/]/).slice(-2).join('/'));
    // Le registre des traitements et la carte des accès nomment les tables sans les lire ; l'index de la sécurité exporte le module.
    // Le planificateur appelle le passage, sans lire aucune table du gel.
    expect(readers.sort()).toEqual(['conformite/carte-acces.ts', 'conformite/registre-traitements.ts', 'securite/gel-avoirs.ts', 'securite/index.ts', 'src/planificateur.ts']);
    const tables = files.filter((f) => /freeze_(registry_versions|registry_entries|checks|matches|match_decisions)\b/.test(readFileSync(f, 'utf8'))).map((f) => f.split(/[\\/]/).slice(-2).join('/'));
    expect(tables.sort()).toEqual(['conformite/registre-traitements.ts', 'securite/gel-avoirs.ts']);
  });
});
