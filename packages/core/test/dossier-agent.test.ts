import { expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, verifyChain, type SqlDatabase } from '../src/index.ts';
import { AGENT_FILE_PIECES, Candidatures, DossierAgent, Entretiens, vigilanceUntil, type AgentPieceStore } from '../src/reseau/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Réseau, direction, candidats et documents inventés.
let clock = Date.parse('2027-07-10T08:00:00.000Z');
const DAY = 86_400_000;
let n = 0;
const uuid = (): string => `00000000-0000-4000-8000-${String(++n).padStart(12, '0')}`;

class FakeStore implements AgentPieceStore {
  readonly refs = new Set<string>();
  readonly texts = new Map<string, string>();
  put(agentId: string, ext = 'pdf'): string {
    const ref = `agents/${agentId}/${uuid()}.${ext}`;
    this.refs.add(ref);
    return ref;
  }
  async has(ref: string): Promise<boolean> {
    return this.refs.has(ref);
  }
  async putDraft(agentId: string, text: string): Promise<string> {
    const ref = this.put(agentId, 'txt');
    this.texts.set(ref, text);
    return ref;
  }
}

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  const now = (): Date => new Date((clock += 1000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const candidatures = new Candidatures(db, journal, { now });
  const entretiens = new Entretiens(db, journal, { now });
  const files = new FakeStore();
  const dossier = new DossierAgent(db, store, entretiens, files, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const dir = { role: 'direction' as const, userId: 'dir-1', networkId: network.id };
  /** Un candidat retenu : entretien fixé, tenu, puis « oui ». */
  const accepted = async (email: string): Promise<string> => {
    await candidatures.apply(network.id, { firstName: 'Ana', lastName: 'Nouvelle', email, currentStatus: 'autre_metier', experience: 'aucune', source: 'page' });
    const id = (await db.first<{ id: string }>('SELECT id FROM candidates WHERE email = ?', [email]))!.id;
    const s = await entretiens.schedule(dir, id, { at: new Date(clock + 3_600_000).toISOString(), interviewer: 'Shawez' });
    clock += 2 * 3_600_000;
    if (!s.ok) throw new Error('entretien');
    await entretiens.markHeld(dir, s.interviewId, 'Shawez');
    await entretiens.decide(dir, id, { decision: 'oui', reason: 'Projet clair et secteur libre', deciderName: 'Shawez' });
    return id;
  };
  const today = (): string => new Date(clock).toISOString().slice(0, 10);
  const daysFrom = (d: number): string => new Date(clock + d * DAY).toISOString().slice(0, 10);
  /** Toutes les pièces, valables. */
  const fill = async (agentId: string, by = dir) => {
    const ag = { role: 'agent' as const, userId: agentId, networkId: network.id };
    void by;
    for (const p of AGENT_FILE_PIECES) {
      const r = await dossier.addPiece(ag, agentId, { kind: p.kind, ref: files.put(agentId), issuedOn: today(), validUntil: p.kind === 'contrat_agent_commercial' || p.kind === 'attestation_vigilance' ? undefined : daysFrom(365) });
      if (!r.ok) throw new Error(`${p.kind} : ${r.code}`);
    }
  };
  return { db, journal, store, entretiens, dossier, files, network, other, dir, accepted, today, daysFrom, fill };
}

describeWithSqlite('J04 · dossier d’agent', () => {
  it('[R82] un candidat retenu entre une fois ; son dossier n’est complet qu’avec toutes les pièces valables', async () => {
    const t = await setup();
    const cand = await t.accepted('ana@example.test');
    const a = await t.dossier.admit(t.dir, cand, { zone: 'Dijon' });
    expect(a).toMatchObject({ ok: true });
    if (!a.ok) return;
    expect(await t.dossier.admit(t.dir, cand)).toEqual({ ok: true, agentId: a.agentId });
    expect(await t.db.all('SELECT agent_id FROM agent_onboardings')).toHaveLength(1);
    const ag = { role: 'agent' as const, userId: a.agentId, networkId: t.network.id };
    const s0 = await t.dossier.status(ag, a.agentId);
    expect(s0.ok && s0.value).toMatchObject({ complete: false, missing: AGENT_FILE_PIECES.map((p) => p.kind), nextStep: 'Déposez votre contrat d’agent commercial signé.' });
    expect(await t.dossier.complete(t.network.id, a.agentId, new Date(clock))).toBe(false);
    // Une pièce de moins : jamais complet.
    for (const p of AGENT_FILE_PIECES.slice(0, 4)) {
      await t.dossier.addPiece(ag, a.agentId, { kind: p.kind, ref: t.files.put(a.agentId), issuedOn: t.today(), validUntil: p.kind === 'contrat_agent_commercial' ? undefined : t.daysFrom(365) });
    }
    const s1 = await t.dossier.status(t.dir, a.agentId);
    expect(s1.ok && s1.value).toMatchObject({ complete: false, missing: ['attestation_vigilance'], nextStep: 'Déposez votre attestation de vigilance de moins de 6 mois.' });
    await t.dossier.addPiece(ag, a.agentId, { kind: 'attestation_vigilance', ref: t.files.put(a.agentId), issuedOn: t.today() });
    expect(await t.dossier.complete(t.network.id, a.agentId, new Date(clock))).toBe(true);
    const s2 = await t.dossier.status(ag, a.agentId);
    expect(s2.ok && s2.value.nextStep).toBe('Votre dossier est complet : l’accès à vos clients est ouvert.');
    // Sans « oui », personne n'entre.
    const refusedCand = (await t.db.first<{ id: string }>("SELECT id FROM candidates WHERE email = 'ana@example.test'"))!.id;
    expect(refusedCand).toBe(cand);
  });

  it('[R82] une pièce échue, attestation de vigilance de plus de 6 mois comprise, rend le dossier incomplet ce jour-là', async () => {
    const t = await setup();
    const a = await t.dossier.admit(t.dir, await t.accepted('b@example.test'));
    if (!a.ok) throw new Error('admit');
    await t.fill(a.agentId);
    expect(await t.dossier.complete(t.network.id, a.agentId, new Date(clock))).toBe(true);
    // La vigilance est valable 6 mois, calculée par le code ; le lendemain de sa fin, le dossier n'est plus complet.
    const until = vigilanceUntil(t.today());
    expect(await t.dossier.complete(t.network.id, a.agentId, new Date(`${until}T20:00:00Z`))).toBe(true);
    expect(await t.dossier.complete(t.network.id, a.agentId, new Date(Date.parse(`${until}T12:00:00Z`) + DAY))).toBe(false);
    expect(vigilanceUntil('2027-01-15')).toBe('2027-07-14');
    expect(vigilanceUntil('2027-08-31')).toBe('2028-02-28');
    // Une assurance échue : incomplet, avec la date dans l'étape suivante.
    clock += 400 * DAY;
    const s = await t.dossier.status(t.dir, a.agentId);
    expect(s.ok && s.value.expired).toEqual(['attestation_habilitation', 'immatriculation_rsac', 'assurance_rcp', 'attestation_vigilance']);
    expect(s.ok && s.value.nextStep).toMatch(/^Votre attestation d’habilitation .* a expiré le \d{2}\/\d{2}\/\d{4} : déposez la nouvelle\.$/);
    // Une nouvelle version s'ajoute, l'ancienne reste [R17].
    const ag = { role: 'agent' as const, userId: a.agentId, networkId: t.network.id };
    await t.dossier.addPiece(ag, a.agentId, { kind: 'assurance_rcp', ref: t.files.put(a.agentId), issuedOn: t.today(), validUntil: t.daysFrom(365) });
    expect(await t.db.all("SELECT version FROM agent_file_pieces WHERE kind = 'assurance_rcp' ORDER BY version")).toEqual([{ version: 1 }, { version: 2 }]);
    await expect(t.db.run("UPDATE agent_file_pieces SET valid_until = '2099-01-01'")).rejects.toThrow(/ne change plus/);
    await expect(t.db.run('DELETE FROM agent_file_pieces')).rejects.toThrow(/rien ne s'efface/);
    // Une assurance sans fin de validité est refusée.
    expect(await t.dossier.addPiece(ag, a.agentId, { kind: 'assurance_rcp', ref: t.files.put(a.agentId), issuedOn: t.today() })).toEqual({ ok: false, rule: 'R82', code: 'valid_until_required' });
  });

  it('[R82] le contrat et l’attestation préparés par le réseau portent « PROJET » et ne comptent jamais', async () => {
    const t = await setup();
    const a = await t.dossier.admit(t.dir, await t.accepted('c@example.test'));
    if (!a.ok) throw new Error('admit');
    const d = await t.dossier.prepareDraft(t.dir, a.agentId, 'contrat_agent_commercial');
    expect(d.ok && d.value.drafts).toEqual(['contrat_agent_commercial']);
    expect(d.ok && d.value.nextStep).toBe('Votre contrat d’agent commercial signé est encore un projet : déposez-le une fois signé.');
    const [text] = [...t.files.texts.values()];
    expect(text).toMatch(/^PROJET — modèle en attente de validation juridique\. Ne pas signer\./);
    expect(await t.dossier.prepareDraft(t.dir, a.agentId, 'assurance_rcp')).toEqual({ ok: false, rule: null, code: 'not_draftable' });
    const ag = { role: 'agent' as const, userId: a.agentId, networkId: t.network.id };
    expect(await t.dossier.prepareDraft(ag, a.agentId, 'contrat_agent_commercial')).toMatchObject({ ok: false, rule: 'R16' });
    // Toutes les autres pièces valables : le projet seul suffit à dire « incomplet ».
    for (const p of AGENT_FILE_PIECES.slice(1)) {
      await t.dossier.addPiece(ag, a.agentId, { kind: p.kind, ref: t.files.put(a.agentId), issuedOn: t.today(), validUntil: p.kind === 'attestation_vigilance' ? undefined : t.daysFrom(365) });
    }
    expect(await t.dossier.complete(t.network.id, a.agentId, new Date(clock))).toBe(false);
    await t.dossier.addPiece(ag, a.agentId, { kind: 'contrat_agent_commercial', ref: t.files.put(a.agentId), issuedOn: t.today() });
    expect(await t.dossier.complete(t.network.id, a.agentId, new Date(clock))).toBe(true);
    // Un projet préparé ensuite ne remplace pas le contrat signé.
    await t.dossier.prepareDraft(t.dir, a.agentId, 'contrat_agent_commercial');
    expect(await t.dossier.complete(t.network.id, a.agentId, new Date(clock))).toBe(true);
  });

  it('[R15] une pièce d’identité, un document anti-blanchiment ou un RIB ne sont jamais une pièce du dossier', async () => {
    const t = await setup();
    const a = await t.dossier.admit(t.dir, await t.accepted('d@example.test'));
    if (!a.ok) throw new Error('admit');
    for (const kind of ['piece_identite', 'passeport', 'rib', 'anti_blanchiment', 'releve_bancaire']) {
      expect(await t.dossier.addPiece(t.dir, a.agentId, { kind, ref: t.files.put(a.agentId), issuedOn: t.today() }), kind).toEqual({ ok: false, rule: 'R15', code: 'forbidden_piece' });
    }
    expect(await t.dossier.addPiece(t.dir, a.agentId, { kind: 'assurance_rcp', ref: 'ailleurs/x.pdf', issuedOn: t.today(), validUntil: t.daysFrom(10) })).toMatchObject({ code: 'bad_ref' });
    expect(await t.dossier.addPiece(t.dir, a.agentId, { kind: 'assurance_rcp', ref: `agents/${a.agentId}/${uuid()}.pdf`, issuedOn: t.today(), validUntil: t.daysFrom(10) })).toMatchObject({ code: 'not_stored' });
    expect(await t.dossier.addPiece(t.dir, a.agentId, { kind: 'assurance_rcp', ref: t.files.put(a.agentId), issuedOn: t.daysFrom(3), validUntil: t.daysFrom(10) })).toMatchObject({ code: 'bad_date' });
    expect(await t.db.all('SELECT id FROM agent_file_pieces')).toEqual([]);
  });

  it('[R16] l’agent lui-même, la direction et la conformité lisent ; un autre agent ou un autre réseau, non ; rien d’un nom au journal [R13]', async () => {
    const t = await setup();
    const a = await t.dossier.admit(t.dir, await t.accepted('e@example.test'));
    const b = await t.dossier.admit(t.dir, await t.accepted('f@example.test'));
    if (!a.ok || !b.ok) throw new Error('admit');
    const other = { role: 'agent' as const, userId: b.agentId, networkId: t.network.id };
    expect(await t.dossier.status(other, a.agentId)).toMatchObject({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.dossier.addPiece(other, a.agentId, { kind: 'assurance_rcp', ref: t.files.put(a.agentId), issuedOn: t.today(), validUntil: t.daysFrom(10) })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.dossier.status({ role: 'compliance', userId: 'c', networkId: t.network.id }, a.agentId)).toMatchObject({ ok: true });
    expect(await t.dossier.addPiece({ role: 'compliance', userId: 'c', networkId: t.network.id }, a.agentId, { kind: 'assurance_rcp', ref: t.files.put(a.agentId), issuedOn: t.today(), validUntil: t.daysFrom(10) })).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.dossier.status({ role: 'direction', userId: 'x', networkId: t.other.id }, a.agentId)).toMatchObject({ ok: false, rule: 'R16', code: 'unknown' });
    expect(await t.dossier.complete(t.other.id, a.agentId, new Date(clock))).toBe(false);
    expect(await t.dossier.admit(other, 'x')).toMatchObject({ ok: false, rule: 'R16' });
    // Un agent parti ne lit plus son dossier, et n'est jamais complet.
    await t.fill(a.agentId);
    await t.db.run("UPDATE agents SET status = 'left' WHERE id = ?", [a.agentId]);
    expect(await t.dossier.status({ role: 'agent', userId: a.agentId, networkId: t.network.id }, a.agentId)).toMatchObject({ ok: false, code: 'agent_inactive' });
    expect(await t.dossier.complete(t.network.id, a.agentId, new Date(clock))).toBe(false);
    const entries = await t.journal.all();
    expect(JSON.stringify(entries)).not.toMatch(/Ana|Nouvelle|example\.test|agents\//);
    expect((await verifyChain(entries)).ok).toBe(true);
  });

  it('[R18] deux entrées du même candidat en même temps ne créent qu’un agent', async () => {
    const t = await setup();
    const cand = await t.accepted('h@example.test');
    const before = (await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM agents'))!.n;
    const [x, y] = await Promise.all([t.dossier.admit(t.dir, cand), t.dossier.admit(t.dir, cand)]);
    expect(x).toEqual(y);
    expect((await t.db.first<{ n: number }>('SELECT COUNT(*) AS n FROM agents'))!.n).toBe(before + 1);
    expect(await t.db.all('SELECT agent_id FROM agent_onboardings')).toHaveLength(1);
    expect(await t.db.all("SELECT id FROM agents WHERE status = 'left'")).toEqual([]);
  });

  it('[R82] sans « oui » d’un humain, personne n’entre', async () => {
    const t = await setup();
    const c = new Candidatures(t.db, t.journal, { now: () => new Date(clock) });
    await c.apply(t.network.id, { firstName: 'Ugo', email: 'u@example.test', currentStatus: 'autre', experience: 'aucune', source: 'page' });
    const id = (await t.db.first<{ id: string }>("SELECT id FROM candidates WHERE email = 'u@example.test'"))!.id;
    expect(await t.dossier.admit(t.dir, id)).toEqual({ ok: false, rule: null, code: 'not_accepted' });
    await t.entretiens.decide(t.dir, id, { decision: 'a_revoir', reason: 'À revoir dans trois mois', deciderName: 'Marion' });
    expect(await t.dossier.admit(t.dir, id)).toEqual({ ok: false, rule: null, code: 'not_accepted' });
    expect(await t.db.all('SELECT agent_id FROM agent_onboardings')).toEqual([]);
  });

  it('[R82] l’agent est prévenu une fois, 30 jours avant l’échéance d’une pièce', async () => {
    const t = await setup();
    const ids: string[] = [];
    for (let i = 0; i < 10; i++) {
      const a = await t.dossier.admit(t.dir, await t.accepted(`g${i}@example.test`));
      if (!a.ok) throw new Error('admit');
      ids.push(a.agentId);
      const ag = { role: 'agent' as const, userId: a.agentId, networkId: t.network.id };
      // Assurance qui finit dans 40 + i jours.
      await t.dossier.addPiece(ag, a.agentId, { kind: 'assurance_rcp', ref: t.files.put(a.agentId), issuedOn: t.today(), validUntil: t.daysFrom(40 + i) });
    }
    expect(await t.dossier.dueAlerts(t.network.id)).toEqual([]);
    const seen: string[] = [];
    for (let d = 0; d < 60; d++) {
      clock += DAY;
      for (const alert of await t.dossier.dueAlerts(t.network.id)) {
        seen.push(alert.agentId);
        // Prévenu à 30 jours de l'échéance, à un jour près selon l'heure.
        const left = (Date.parse(`${alert.validUntil}T12:00:00Z`) - clock) / DAY;
        expect(left).toBeGreaterThan(28.5);
        expect(left).toBeLessThanOrEqual(30.5);
      }
    }
    expect(seen.sort()).toEqual([...ids].sort());
    expect(await t.db.all('SELECT piece_id FROM agent_file_alerts')).toHaveLength(10);
  });
});
