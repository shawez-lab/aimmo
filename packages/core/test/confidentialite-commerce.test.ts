import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { ONLINE_SIGNATURE_PURPOSE } from '../src/documents/signature-en-ligne.ts';
import { Acces, FicheClient, FicheUnique, SqlJournalStore, applyMigrations, createCaptation, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { ConfidentialiteCommerce, EstimationCommerce, FicheCommerce, PresentationCommerce, type IdentityState } from '../src/commerces/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

const TUESDAY_10H = Date.parse('2027-09-07T08:00:00.000Z');
const NDA_BODY =
  'Engagement de confidentialité (modèle inventé pour les tests). Le signataire garde secrets les chiffres et documents du commerce qui lui sont communiqués, et ne les utilise que pour étudier sa reprise.';

const SHEET = {
  activity: 'restaurant',
  signName: 'La Table Inventée',
  fiscalYears: [{ year: 2026, revenueCents: 61_234_500, resultCents: 2_345_600, ebitdaCents: 5_432_100 }],
  leaseAnnualRentCents: 2_400_000,
  employees: 6,
};

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = TUESDAY_10H;
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const { store, fiche } = createCaptation(db, journal, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const fiches = new FicheCommerce(db, journal, { now });
  const estimations = new EstimationCommerce(db, journal, fiches, { now });
  const presentations = new PresentationCommerce(db, journal, fiches, estimations, { now });
  const verified = new Map<string, string>();
  const identity: IdentityState = { state: async (_n, personId) => ({ identityVerifiedOn: verified.get(personId) ?? null }) };
  let nextCode = '123456';
  const conf = new ConfidentialiteCommerce(db, journal, fiches, presentations, identity, { now, newCode: () => nextCode });
  const network = await store.createNetwork('Réseau test');
  const alexAgent = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const samAgent = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: 'agent' | 'direction' | 'compliance' | 'partner', userId: string) => ({ role, userId, networkId: network.id });
  const alex = as('agent', alexAgent.id);
  const sam = as('agent', samAgent.id);
  const direction = as('direction', 'dir-1');
  let seq = 0;
  const shop = async () => {
    const p = await store.createProperty({ networkId: network.id, agentId: alexAgent.id, reference: `CE-${(seq += 1)}`, kind: 'business', status: 'available', city: 'Dijon', postalCode: '21000' });
    await fiches.update(acces, alex, p.id, SHEET);
    return p;
  };
  const buyer = async (i: number) => {
    const p = await store.createPerson({ networkId: network.id, agentId: alexAgent.id, firstName: `Repreneur${'ABCDEFGHIJK'[i]}`, lastName: 'Inventé' });
    await store.addIdentifier({ networkId: network.id, personId: p.id, kind: 'email', value: `repreneur.${i}.invente@example.test` });
    return p;
  };
  /** Signe l'engagement d'une personne : ouverture, puis le bon code. */
  const signNda = async (ndaId: string) => {
    nextCode = String(100_000 + Math.floor(Math.random() * 899_999));
    const s = await conf.startSignature(acces, alex, ndaId, { consentProof: 'accord donné au rendez-vous du 7 septembre' });
    if (!s.ok) throw new Error(`ouverture : ${JSON.stringify(s)}`);
    return conf.sign(acces, alex, s.value.sessionId, { code: nextCode });
  };
  return { db, journal, acces, fiches, conf, verified, alex, sam, direction, compliance: as('compliance', 'conf-1'), network, shop, buyer, signNda, setCode: (c: string) => (nextCode = c) };
}

const ndaOf = (r: { ok: boolean; value?: { ndaId: string | null } }): string => {
  if (!r.ok || !r.value?.ndaId) throw new Error('engagement');
  return r.value.ndaId;
};

describeWithSqlite('CE04 · engagement de confidentialité et pièce vérifiée avant tout chiffre', () => {
  it('[R113] [R110] sur 10 demandes tests, aucun dossier confidentiel n’est ouvert sans engagement signé et pièce vérifiée', async () => {
    const t = await setup();
    await t.conf.recordTemplate(t.direction, NDA_BODY);
    const a = await t.shop();
    const b = await t.shop();
    const net = t.network.id;
    const cases: { name: string; prepare: () => Promise<{ property: string; person: string }>; open: boolean; codes?: string[] }[] = [
      {
        name: '1. demande seule, rien de signé',
        prepare: async () => {
          const p = await t.buyer(1);
          await t.conf.requestAccess(t.acces, t.alex, a.id, p.id);
          return { property: a.id, person: p.id };
        },
        open: false,
        codes: ['engagement_non_signe', 'identite_non_verifiee'],
      },
      {
        name: '2. pièce vérifiée, engagement non signé',
        prepare: async () => {
          const p = await t.buyer(2);
          t.verified.set(p.id, '2027-09-01');
          await t.conf.requestAccess(t.acces, t.alex, a.id, p.id);
          return { property: a.id, person: p.id };
        },
        open: false,
        codes: ['engagement_non_signe'],
      },
      {
        name: '3. engagement signé, pièce non vérifiée',
        prepare: async () => {
          const p = await t.buyer(3);
          await t.signNda(ndaOf(await t.conf.requestAccess(t.acces, t.alex, a.id, p.id)));
          return { property: a.id, person: p.id };
        },
        open: false,
        codes: ['identite_non_verifiee'],
      },
      {
        name: '4. engagement signé et pièce vérifiée',
        prepare: async () => {
          const p = await t.buyer(4);
          t.verified.set(p.id, '2027-09-01');
          await t.signNda(ndaOf(await t.conf.requestAccess(t.acces, t.alex, a.id, p.id)));
          return { property: a.id, person: p.id };
        },
        open: true,
      },
      {
        name: '5. engagement signé pour un autre bien',
        prepare: async () => {
          const p = await t.buyer(5);
          t.verified.set(p.id, '2027-09-01');
          await t.signNda(ndaOf(await t.conf.requestAccess(t.acces, t.alex, b.id, p.id)));
          return { property: a.id, person: p.id };
        },
        open: false,
        codes: ['engagement_absent'],
      },
      {
        name: '6. document modifié après la signature',
        prepare: async () => {
          const p = await t.buyer(6);
          t.verified.set(p.id, '2027-09-01');
          const nda = ndaOf(await t.conf.requestAccess(t.acces, t.alex, a.id, p.id));
          await t.signNda(nda);
          // Une écriture directe dans la base, hors du code : la garde est levée le temps de l'essai.
          await t.db.run('DROP TRIGGER business_ndas_fige');
          await t.db.run('UPDATE business_ndas SET content = content || ? WHERE id = ?', [' Clause ajoutée après coup.', nda]);
          await t.db.run("CREATE TRIGGER business_ndas_fige BEFORE UPDATE ON business_ndas BEGIN SELECT RAISE(ABORT, 'business_ndas : un engagement ne se réécrit pas'); END");
          return { property: a.id, person: p.id };
        },
        open: false,
        codes: ['engagement_modifie'],
      },
      {
        name: '7. engagement révoqué',
        prepare: async () => {
          const p = await t.buyer(7);
          t.verified.set(p.id, '2027-09-01');
          const nda = ndaOf(await t.conf.requestAccess(t.acces, t.alex, a.id, p.id));
          await t.signNda(nda);
          await t.conf.revoke(t.acces, t.alex, nda, 'demande_repreneur');
          return { property: a.id, person: p.id };
        },
        open: false,
        codes: ['engagement_revoque'],
      },
      {
        name: '8. code faux cinq fois : session bloquée, rien de signé',
        prepare: async () => {
          const p = await t.buyer(8);
          t.verified.set(p.id, '2027-09-01');
          const nda = ndaOf(await t.conf.requestAccess(t.acces, t.alex, a.id, p.id));
          t.setCode('654321');
          const s = await t.conf.startSignature(t.acces, t.alex, nda, { consentProof: 'accord donné au rendez-vous' });
          if (!s.ok) throw new Error('ouverture');
          for (let i = 0; i < 5; i += 1) await t.conf.sign(t.acces, t.alex, s.value.sessionId, { code: '000000' });
          expect(await t.conf.sign(t.acces, t.alex, s.value.sessionId, { code: '654321' })).toMatchObject({ ok: false, code: 'blocked' });
          return { property: a.id, person: p.id };
        },
        open: false,
        codes: ['engagement_non_signe'],
      },
      {
        name: '9. aucune demande, aucun engagement',
        prepare: async () => {
          const p = await t.buyer(9);
          t.verified.set(p.id, '2027-09-01');
          return { property: a.id, person: p.id };
        },
        open: false,
        codes: ['engagement_absent'],
      },
      {
        name: '10. révoqué, puis nouvel engagement signé',
        prepare: async () => {
          const p = await t.buyer(10);
          t.verified.set(p.id, '2027-09-01');
          const first = ndaOf(await t.conf.requestAccess(t.acces, t.alex, a.id, p.id));
          await t.signNda(first);
          await t.conf.revoke(t.acces, t.alex, first, 'autre');
          const second = ndaOf(await t.conf.requestAccess(t.acces, t.alex, a.id, p.id));
          expect(second).not.toBe(first);
          await t.signNda(second);
          return { property: a.id, person: p.id };
        },
        open: true,
      },
    ];
    for (const c of cases) {
      const { property, person } = await c.prepare();
      const door = await t.conf.canSendConfidential(net, property, person);
      expect(door.ok, c.name).toBe(c.open);
      if (!door.ok) expect(door.codes, c.name).toEqual([...(c.codes ?? [])].sort());
      const sheet = await t.conf.confidentialSheet(t.acces, t.alex, property, person);
      expect(sheet.ok, c.name).toBe(c.open);
      if (sheet.ok) expect(sheet.value.sheet.signName).toBe('La Table Inventée');
    }
  });

  it('[R110] la réponse immédiate à une demande ne porte que la vue publique', async () => {
    const t = await setup();
    const a = await t.shop();
    const p = await t.buyer(1);
    const r = await t.conf.requestAccess(t.acces, t.alex, a.id, p.id);
    // Sans modèle : la demande est rangée, pas d'engagement à signer.
    expect(r).toMatchObject({ ok: true, value: { ndaId: null, presentation: null, publicView: { kind: 'business', activity: 'restaurant', city: 'Dijon', postalCode: '21000' } } });
    const text = JSON.stringify(r);
    for (const secret of ['Table', '61234500', '612345', '2400000', '24000', 'employees', 'signName', 'fiscalYears']) expect(text, secret).not.toContain(secret);
  });

  it('[R15] [R13] aucune pièce d’identité ni numéro n’est lu ni rangé hors du coffre ; les refus vont au journal sans donnée personnelle', async () => {
    const t = await setup();
    await t.conf.recordTemplate(t.direction, NDA_BODY);
    const a = await t.shop();
    const p = await t.buyer(1);
    await t.conf.requestAccess(t.acces, t.alex, a.id, p.id);
    expect(await t.conf.canSendConfidential(t.network.id, a.id, p.id)).toMatchObject({ ok: false, rule: 'R113' });
    const journal = JSON.stringify(await t.journal.all());
    expect(journal).toContain('commerces.confidentiel.refuse');
    for (const s of ['RepreneurB', 'Inventé', 'repreneur.1', 'example.test']) expect(journal, s).not.toContain(s);
    const source = readFileSync(new URL('../src/commerces/confidentialite.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/compliance_vault|pieces-identite|IDENTITY_PIECES|document_number|passport/);
    for (const table of ['business_nda_templates', 'business_access_requests', 'business_ndas', 'business_nda_signatures', 'business_nda_revocations']) {
      const cols = await t.db.all<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`);
      for (const c of cols) expect(c.name, `${table}.${c.name}`).not.toMatch(/piece|identity|passport|cni|number|numero/);
    }
  });

  it('[R16] seuls l’agent du bien et la direction rangent une demande et ouvrent une signature ; refus au journal', async () => {
    const t = await setup();
    await t.conf.recordTemplate(t.direction, NDA_BODY);
    expect(await t.conf.recordTemplate(t.alex, NDA_BODY)).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.conf.recordTemplate(t.direction, 'trop court')).toMatchObject({ ok: false, code: 'bad_body' });
    const a = await t.shop();
    const p = await t.buyer(1);
    expect(await t.conf.requestAccess(t.acces, t.sam, a.id, p.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.conf.requestAccess(t.acces, t.compliance, a.id, p.id)).toMatchObject({ ok: false, rule: 'R16' });
    const nda = ndaOf(await t.conf.requestAccess(t.acces, t.alex, a.id, p.id));
    expect(await t.conf.startSignature(t.acces, t.sam, nda, { consentProof: 'accord' })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.conf.confidentialSheet(t.acces, t.sam, a.id, p.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(JSON.stringify(await t.journal.all())).toContain('business_nda');
  });

  it('[R113] [R26] [R17] le code part par le contrôle central en essai ; la signature est d’essai ; rien ne s’efface', async () => {
    const t = await setup();
    await t.conf.recordTemplate(t.direction, NDA_BODY);
    const a = await t.shop();
    const p = await t.buyer(1);
    const nda = ndaOf(await t.conf.requestAccess(t.acces, t.alex, a.id, p.id));
    const content = await t.db.first<{ content: string }>('SELECT content FROM business_ndas WHERE id = ?', [nda]);
    expect(content!.content).toContain(NDA_BODY);
    expect(content!.content).toContain('Signataire : RepreneurB Inventé');
    t.setCode('424242');
    const s = await t.conf.startSignature(t.acces, t.alex, nda, { consentProof: 'accord donné au rendez-vous' });
    expect(s).toMatchObject({ ok: true, value: { mode: 'essai' } });
    if (!s.ok) return;
    // Le code n'est rangé qu'en empreinte.
    expect(JSON.stringify(await t.db.all('SELECT * FROM business_nda_signatures'))).not.toContain('424242');
    expect(await t.conf.sign(t.acces, t.alex, s.value.sessionId, { code: '111111' })).toMatchObject({ ok: false, code: 'wrong_code' });
    expect(await t.conf.sign(t.acces, t.alex, s.value.sessionId, { code: '424242' })).toMatchObject({ ok: true, value: { realSignature: false, mode: 'essai', method: 'code' } });
    expect(await t.conf.sign(t.acces, t.alex, s.value.sessionId, { code: '424242' })).toMatchObject({ ok: false, code: 'already_signed' });
    expect(await t.conf.startSignature(t.acces, t.alex, nda, { consentProof: 'accord' })).toMatchObject({ ok: false, code: 'already_signed' });
    await expect(t.db.run('DELETE FROM business_ndas')).rejects.toThrow(/rien ne s'efface/);
    await expect(t.db.run("UPDATE business_nda_signatures SET status = 'ouverte'")).rejects.toThrow(/ne change plus/);
    await expect(t.db.run('DELETE FROM business_nda_signatures')).rejects.toThrow(/rien ne s'efface/);
    // Une session expirée ne signe plus.
    const q = await t.buyer(2);
    const nda2 = ndaOf(await t.conf.requestAccess(t.acces, t.alex, a.id, q.id));
    const s2 = await t.conf.startSignature(t.acces, t.alex, nda2, { consentProof: 'accord' });
    if (!s2.ok) throw new Error('ouverture');
    await t.db.run('DROP TRIGGER business_nda_signatures_fige');
    await t.db.run("UPDATE business_nda_signatures SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [s2.value.sessionId]);
    expect(await t.conf.sign(t.acces, t.alex, s2.value.sessionId, { code: '424242' })).toMatchObject({ ok: false, code: 'expired' });
  });

  it('[R03] un accord redonné est rangé quand la ligne ouverte est plus ancienne qu’un retrait (AC07), et un accord qui compte n’est pas doublé', async () => {
    const t = await setup();
    await t.conf.recordTemplate(t.direction, NDA_BODY);
    const a = await t.shop();
    const p = await t.buyer(1);
    const nda = ndaOf(await t.conf.requestAccess(t.acces, t.alex, a.id, p.id));
    const store = new FicheClient(t.db);
    // Un retrait sur la fiche, un accord plus ancien resté ouvert sur son doublon, puis la fusion.
    const twin = await store.createPerson({ networkId: t.network.id, firstName: 'Doublon' });
    await store.addConsent({ networkId: t.network.id, personId: twin.id, purpose: ONLINE_SIGNATURE_PURPOSE, channel: 'email', proof: 'preuve inventée', givenAt: new Date('2020-01-02T00:00:00.000Z') });
    const old = await store.addConsent({ networkId: t.network.id, personId: p.id, purpose: ONLINE_SIGNATURE_PURPOSE, channel: 'email', proof: 'preuve inventée', givenAt: new Date('2020-01-01T00:00:00.000Z') });
    await store.withdrawConsent(old.id, new Date('2020-02-01T00:00:00.000Z'));
    const unique = new FicheUnique(t.db, new FicheClient(t.db));
    await unique.merge({ survivorId: p.id, mergedId: twin.id, reason: 'identifiant commun' });
    expect(await unique.hasConsentInForce(p.id, ONLINE_SIGNATURE_PURPOSE, 'email')).toBe(false);
    const lines = () => t.db.all<{ id: string }>('SELECT id FROM consents WHERE person_id = ? AND purpose = ?', [p.id, ONLINE_SIGNATURE_PURPOSE]);
    expect((await t.conf.startSignature(t.acces, t.alex, nda, { consentProof: 'accord donné au rendez-vous' })).ok).toBe(true);
    expect(await lines()).toHaveLength(2);
    await t.conf.startSignature(t.acces, t.alex, nda, { consentProof: 'accord donné au rendez-vous' });
    expect(await lines()).toHaveLength(2);
    expect(await unique.hasConsentInForce(p.id, ONLINE_SIGNATURE_PURPOSE, 'email')).toBe(true);
  });
});
