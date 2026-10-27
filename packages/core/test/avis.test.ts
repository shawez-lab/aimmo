import { expect, it } from 'vitest';
import {
  ADVICE_NOTICE,
  AvisDeValeur,
  FicheClient,
  Fourchette,
  SqlJournalStore,
  applyMigrations,
  checkText,
  euros,
  fromSyncSqlite,
  verifyChain,
  type PublicFacts,
  type RangeResult,
  type Sale,
  type ValuationBrief,
  type Viewer,
} from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Ventes inventées, toutes autour d'un point fictif.
const SALES: Sale[] = Array.from({ length: 14 }, (_, i) => ({
  id: `t:${i}`,
  kind: 'apartment' as const,
  lat: 47.3225 + i * 0.0002,
  lon: 5.0412,
  surface: 60 + i,
  pricePerM2: 2500 + i * 20,
  month: `2025-0${(i % 9) + 1}`,
}));
const NOW = () => new Date('2026-10-27T09:00:00.000Z');

async function range(): Promise<Extract<RangeResult, { ok: true }>> {
  const r = await new Fourchette(
    { coverage: async () => ({ department: '21', lastSale: '2025-12-30', years: [2023, 2024, 2025], source: 'DVF test' }), within: async () => SALES },
    undefined,
    NOW,
  ).estimate({ kind: 'apartment', surface: 65, lat: 47.3225, lon: 5.0412, postalCode: '21000', floor: 2, balcony: true, energyClass: 'E' });
  if (!r.ok) throw new Error(r.reason);
  return r;
}

const FACTS: PublicFacts = {
  address: { ok: true, source: 'BAN', collectedAt: NOW().toISOString(), value: { label: '1 Rue de l’Essai 21000 Dijon', lat: 47.3225, lon: 5.0412, postalCode: '21000', inseeCode: '21231', town: 'Dijon', banId: 'x', score: 0.9 } },
  parcel: { ok: false, source: 'Cadastre', collectedAt: NOW().toISOString(), reason: 'panne' },
  energy: { ok: true, source: 'ADEME', collectedAt: NOW().toISOString(), value: { energyClass: 'E', ghgClass: null, date: '2024-01-10', diagnosisNumber: null } },
  risks: { ok: true, source: 'Géorisques', collectedAt: NOW().toISOString(), value: [{ code: '11', label: 'Inondation' }] },
  missing: ['parcel'],
};

async function world(writer?: (b: ValuationBrief) => Promise<string>) {
  const db = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const store = new FicheClient(db);
  const net = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const paul = await store.createAgent({ networkId: net.id, firstName: 'Paul', lastName: 'Essai' });
  const lise = await store.createAgent({ networkId: net.id, firstName: 'Lise', lastName: 'Essai' });
  const property = await store.createProperty({ networkId: net.id, agentId: paul.id, reference: 'B-1', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 65 });
  const journal = new SqlJournalStore(db);
  const avis = new AvisDeValeur(db, journal, { now: NOW, ...(writer ? { writer: { write: writer } } : {}), aiTimeoutMs: 50 });
  const as = (role: Viewer['role'], userId: string, networkId = net.id): Viewer => ({ role, userId, networkId });
  const draft = async () => avis.draft({ networkId: net.id, propertyId: property.id, kind: 'apartment', surface: 65, range: await range(), facts: FACTS, details: new Map([['t:0', { street: 'Rue des Essais', town: 'Dijon' }]]) });
  return { db, store, net, other, paul, lise, property, journal, avis, as, draft };
}

describeWithSqlite('E04 · brouillon d’avis de valeur et validation par l’agent', () => {
  it('sans IA, le code écrit un brouillon complet, aux seuls chiffres du calcul [R10] [R28]', async () => {
    const w = await world();
    const r = await w.draft();
    const calc = await range();
    expect(r).toMatchObject({ status: 'draft', text_by: 'fallback', computed_low: calc.low, computed_high: calc.high, agent_id: w.paul.id });
    expect(r.text).toContain(`${String(calc.low).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')} €`);
    expect(r.text).toContain('décembre 2025');
    expect(r.text).toContain('ne sont pas encore publiées');
    expect(r.text).toContain('classe E');
    expect(r.text).toContain('plan de commercialisation');
    expect(r.text.endsWith(ADVICE_NOTICE)).toBe(true);
    expect(checkText(r.text, { audience: 'client', channel: 'email', figures: [] }).map((p) => p.rule)).toContain('R10');
    const computed = JSON.parse(r.computed) as { cited: { street?: string; month: string }[]; data: { lastSale: string } };
    expect(computed.data.lastSale).toBe('2025-12-30');
    expect(computed.cited[0]).toMatchObject({ street: 'Rue des Essais', month: expect.stringMatching(/^\d{4}-\d{2}$/) });
    for (const c of computed.cited) expect(c.street ?? '').not.toMatch(/\d/);
  });

  it('l’IA rédige à partir d’un brief sans nom ni adresse ; un texte qui invente un chiffre est remplacé', async () => {
    let seen: ValuationBrief | null = null;
    const good = await world(async (b) => {
      seen = b;
      return `Votre appartement vaut entre ${euros(b.low)} et ${euros(b.high)}, d’après ${b.comparables} ventes.`;
    });
    const r = await good.draft();
    expect(r.text_by).toBe('ai');
    expect(r.text.endsWith(ADVICE_NOTICE)).toBe(true);
    // [R28] La date des ventes utilisées et le manque des plus récentes sont dits par le code, quel que soit l'auteur.
    expect(r.text).toContain('Ventes utilisées jusqu’à septembre 2025, données publiées jusqu’à décembre 2025.');
    expect(r.text).toContain('ne sont pas encore publiées');
    const vague = await world(async () => 'Votre appartement a une belle valeur.');
    expect((await vague.draft()).text_by).toBe('fallback');
    expect(JSON.stringify(seen)).not.toMatch(/Essai|Rue|"lat"|"lon"/);

    const liar = await world(async () => 'Votre appartement vaut 999 999 €.');
    expect((await liar.draft()).text_by).toBe('fallback');
    const slow = await world(() => new Promise(() => {}));
    expect((await slow.draft()).text_by).toBe('fallback');
    const ai = await world(async () => 'Notre IA estime votre bien.');
    expect((await ai.draft()).text_by).toBe('fallback');
    const entries = await ai.journal.all();
    expect(entries.find((e) => e.type === 'avis.brouillon')?.data).toMatchObject({ textBy: 'fallback', aiRefused: 'R06' });
  });

  it('[R30] aucun avis ne part sans la validation de l’agent qui suit le bien', async () => {
    const w = await world();
    const r = await w.draft();
    expect(await w.avis.releasable(r.id)).toEqual({ ok: false, rule: 'R30', code: 'not_validated' });
    for (const viewer of [w.as('agent', w.lise.id), w.as('direction', 'dir-1'), w.as('compliance', 'conf-1'), w.as('partner', 'p-1'), w.as('agent', w.paul.id, w.other.id)]) {
      const v = await w.avis.validate(viewer, r.id);
      expect(v.ok, `${viewer.role}`).toBe(false);
    }
    expect(await w.avis.releasable(r.id)).toMatchObject({ ok: false, code: 'not_validated' });
    const ok = await w.avis.validate(w.as('agent', w.paul.id), r.id);
    expect(ok).toMatchObject({ ok: true, value: { status: 'validated', validated_by: w.paul.id } });
    expect(await w.avis.releasable(r.id)).toMatchObject({ ok: true, value: { low: r.computed_low, high: r.computed_high } });
  });

  it('[R30] un agent parti ne valide plus ; un avis validé ne change plus', async () => {
    const w = await world();
    const r = await w.draft();
    await w.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [w.paul.id]);
    expect(await w.avis.validate(w.as('agent', w.paul.id), r.id)).toMatchObject({ ok: false, code: 'not_following_agent' });
    await w.db.run("UPDATE agents SET status = 'active' WHERE id = ?", [w.paul.id]);
    await w.avis.validate(w.as('agent', w.paul.id), r.id);
    expect(await w.avis.adjust(w.as('agent', w.paul.id), r.id, { low: 100000 })).toMatchObject({ ok: false, code: 'already_validated' });
    await expect(w.db.run("UPDATE valuation_reports SET text = 'autre' WHERE id = ?", [r.id])).rejects.toThrow();
    await expect(w.db.run('DELETE FROM valuation_reports')).rejects.toThrow();
  });

  it('[R10] [R06] le texte de l’agent passe le contrôle du texte ; la fourchette dite est celle qui part', async () => {
    const w = await world();
    const r = await w.draft();
    const paul = w.as('agent', w.paul.id);
    expect(await w.avis.adjust(paul, r.id, { text: `Notre IA estime votre bien entre ${euros(r.computed_low)} et ${euros(r.computed_high)}.` })).toMatchObject({ ok: false, code: 'text_refused' });
    expect(await w.avis.adjust(paul, r.id, { text: `Votre bien vaut entre ${euros(r.computed_low)} et 999 999 €.` })).toMatchObject({ ok: false, code: 'text_refused' });
    expect(await w.avis.adjust(paul, r.id, { text: '   ' })).toMatchObject({ ok: false, code: 'text_refused' });
    // Un texte qui ne dit pas la fourchette retenue ne peut pas être validé.
    const silent = await w.avis.adjust(paul, r.id, { text: 'Votre bien est lumineux et bien tenu.' });
    expect(silent.ok).toBe(true);
    expect(await w.avis.validate(paul, r.id)).toMatchObject({ ok: false, code: 'range_not_in_text' });
    // Fourchette changée sans nouveau texte : la phrase de fourchette du code suit.
    const v = await world();
    const d = await v.draft();
    const changed = await v.avis.adjust(v.as('agent', v.paul.id), d.id, { low: 150000, high: 170000 });
    if (!changed.ok) throw new Error(changed.code);
    expect(changed.value.text).toContain('entre 150 000 € et 170 000 €');
    expect(changed.value.text).not.toContain(euros(d.computed_low));
    expect((await v.avis.validate(v.as('agent', v.paul.id), d.id)).ok).toBe(true);
    // La nouvelle borne basse vaut l'ancienne borne haute : chaque borne n'est remplacée qu'une fois.
    const u = await world();
    const e = await u.draft();
    const shifted = await u.avis.adjust(u.as('agent', u.paul.id), e.id, { low: e.computed_high, high: e.computed_high + 20000 });
    if (!shifted.ok) throw new Error(shifted.code);
    expect(shifted.value.text).toContain(`entre ${euros(e.computed_high)} et ${euros(e.computed_high + 20000)}`);
    expect((await u.avis.validate(u.as('agent', u.paul.id), e.id)).ok).toBe(true);
  });

  it('[R30] une modification faite pendant la validation demande une nouvelle validation', async () => {
    const w = await world();
    const r = await w.draft();
    const paul = w.as('agent', w.paul.id);
    expect(await w.avis.adjust(paul, r.id, { low: 160000, high: 160000 })).toMatchObject({ ok: false, code: 'invalid_range' });
    // Le texte change entre la lecture de la validation et son écriture.
    const original = w.avis.get.bind(w.avis);
    let first = true;
    w.avis.get = async (id: string) => {
      const seen = await original(id);
      if (first) {
        first = false;
        await w.db.run("UPDATE valuation_reports SET text = 'Votre bien est lumineux.', updated_at = ? WHERE id = ?", ['2026-10-27T09:00:01.000Z', id]);
      }
      return seen;
    };
    expect(await w.avis.validate(paul, r.id)).toMatchObject({ ok: false, code: 'changed_meanwhile' });
    w.avis.get = original;
    expect((await w.avis.get(r.id))?.status).toBe('draft');
  });

  it('une surface décimale s’écrit à la française et passe le contrôle', async () => {
    const w = await world();
    const r = await w.avis.draft({ networkId: w.net.id, propertyId: w.property.id, kind: 'apartment', surface: 65.5, range: await range() });
    expect(r.text).toContain('65,5 m²');
  });

  it('les ajustements de l’agent sont gardés à côté du calcul, et la mention d’avis reste', async () => {
    const w = await world();
    const r = await w.draft();
    const paul = w.as('agent', w.paul.id);
    expect(await w.avis.adjust(paul, r.id, { low: 10, high: 5 })).toMatchObject({ ok: false, code: 'invalid_range' });
    const a = await w.avis.adjust(paul, r.id, { low: 150000, high: 170000, text: 'Après visite, votre bien est lumineux et bien tenu. Je le situe entre 150 000 € et 170 000 €.' });
    if (!a.ok) throw new Error(a.code);
    expect(a.value).toMatchObject({ computed_low: r.computed_low, computed_high: r.computed_high, agent_low: 150000, agent_high: 170000, text_by: 'agent', computed: r.computed });
    expect(a.value.text.endsWith(ADVICE_NOTICE)).toBe(true);
    await w.avis.validate(paul, r.id);
    expect(await w.avis.releasable(r.id)).toMatchObject({ ok: true, value: { low: 150000, high: 170000 } });
  });

  it('[R13] le journal ne porte ni texte ni chiffre de l’avis, et sa chaîne tient', async () => {
    const w = await world();
    const r = await w.draft();
    await w.avis.validate(w.as('agent', w.lise.id), r.id);
    await w.avis.validate(w.as('agent', w.paul.id), r.id);
    const entries = await w.journal.all();
    expect(entries.map((e) => e.type)).toEqual(['avis.brouillon', 'avis.refuse', 'avis.valide']);
    const dump = JSON.stringify(entries);
    expect(dump).not.toContain(String(r.computed_low));
    expect(dump).not.toContain('Dijon');
    expect((await verifyChain(entries)).ok).toBe(true);
  });
});
