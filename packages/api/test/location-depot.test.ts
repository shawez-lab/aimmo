import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { FicheClient, SqlJournalStore, applyMigrations, fromSyncSqlite, type SqlDatabase } from '@aimmo/core';
import { handleRequest, type ApiConfig } from '../src/app.ts';
import { R2PieceStore } from '../src/dossiers.ts';
import { sha256Hex } from '../src/index.ts';
import { assembleAccess, assembleAccessDetail, erasurePlan } from '../../core/src/conformite/index.ts';
import { RENTAL_DEPOSIT_MAX_BYTES } from '../../core/src/location/index.ts';
import { loadMigrations } from '../../core/test/migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from '../../core/test/sqlite.ts';

// Réseau, agents, propriétaire, logement, fichiers et clés inventés.
const BASE = 'https://aimmo-api.example.test';
const KEYS = { alex: 'test-cle-w14-alex-aaaaaaaaaaaaaaaaaaaaaaaaaaaa', bea: 'test-cle-w14-bea-bbbbbbbbbbbbbbbbbbbbbbbbbbbbb', conformite: 'test-cle-w14-conf-ccccccccccccccccccccccccccc' };
type Who = keyof typeof KEYS;
const PDF = new TextEncoder().encode('%PDF-1.7 diagnostic inventé');
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70, 73, 70, 0, 1, 1]);
const sha = (b: Uint8Array | string): string => createHash('sha256').update(b).digest('hex');
const REF = (id: string, folder: string, ext: string) => new RegExp(`^location/${id}/${folder}[0-9a-f-]{36}\\.${ext}$`);

async function setup(bucketWrites = true) {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = Date.parse('2027-01-11T09:00:00.000Z');
  const now = (): Date => new Date((clock += 1_000));
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const network = (await store.createNetwork('Réseau test')).id;
  const alex = (await store.createAgent({ networkId: network, firstName: 'Alex', lastName: 'Agent' })).id;
  const bea = (await store.createAgent({ networkId: network, firstName: 'Béa', lastName: 'Agent' })).id;
  const owner = (await store.createPerson({ networkId: network, agentId: alex, firstName: 'Léa', lastName: 'Exemple' })).id;
  const home = (await store.createProperty({ networkId: network, agentId: alex, reference: 'L-1', kind: 'home', postalCode: '21000' })).id;
  const stored = new Map<string, { bytes: Uint8Array; type: string | undefined }>();
  const state = { broken: false };
  const bucket = {
    head: async (k: string) => (stored.has(k) ? {} : null),
    ...(bucketWrites
      ? {
          put: async (k: string, v: Uint8Array, o?: { httpMetadata?: { contentType?: string } }) => {
            if (state.broken) throw new Error('panne');
            stored.set(k, { bytes: v, type: o?.httpMetadata?.contentType });
          },
        }
      : {}),
  };
  const pieces = new R2PieceStore(bucket);
  const ids: Record<Who, { role: string; userId: string }> = { alex: { role: 'agent', userId: alex }, bea: { role: 'agent', userId: bea }, conformite: { role: 'compliance', userId: 'conf-1' } };
  const apiKeys = JSON.stringify(await Promise.all((Object.keys(KEYS) as Who[]).map(async (w) => ({ sha256: await sha256Hex(KEYS[w]), networkId: network, ...ids[w] }))));
  const config: ApiConfig = { db, apiKeys, mode: 'essai', now, pieces };
  const json = async (who: Who, path: string, body: unknown) => {
    const r = await handleRequest(new Request(`${BASE}/v1${path}`, { method: 'POST', headers: { authorization: `Bearer ${KEYS[who]}`, 'content-type': 'application/json' }, body: JSON.stringify(body) }), config);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string | null; code?: string } };
  };
  const created = await json('alex', '/location', { propertyId: home, ownerPersonId: owner });
  const id = created.body.data.listingId as string;
  const deposit = async (who: Who, kind: string, bytes: Uint8Array, type: string, hash: string | null = sha(bytes), headers: Record<string, string> = {}) => {
    const r = await handleRequest(
      new Request(`${BASE}/v1/location/${id}/fichiers/${kind}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${KEYS[who]}`, 'content-type': type, ...(hash ? { 'x-aimmo-sha256': hash } : {}), ...headers },
        body: bytes,
      }),
      config,
    );
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string | null; code?: string } };
  };
  const depositPiece = async (who: Who, applicationId: string, bytes: Uint8Array, type: string, hash: string = sha(bytes), holder: string | null = 'candidat') => {
    const r = await handleRequest(new Request(`${BASE}/v1/location/candidatures/${applicationId}/fichiers/piece${holder === null ? '' : `?holder=${encodeURIComponent(holder)}`}`, { method: 'POST', headers: { authorization: `Bearer ${KEYS[who]}`, 'content-type': type, 'x-aimmo-sha256': hash }, body: bytes }), config);
    return { status: r.status, body: (await r.json()) as { ok: boolean; data?: any; rule?: string | null; code?: string } };
  };
  const candidate = async () => {
    const person = (await store.createPerson({ networkId: network, agentId: alex, firstName: 'Cand', lastName: 'Inventé' })).id;
    return person;
  };
  return { db, journal, id, stored, state, deposit, depositPiece, json, candidate };
}

describeWithSqlite('W14 · dépôt des pièces de la location, par le socle', () => {
  it('[R13] le fichier est rangé tel quel, sous la référence que le geste attend, et le geste l’accepte ; au journal, ni contenu ni nom', async () => {
    const t = await setup();
    const annex = await t.deposit('alex', 'annexe', PDF, 'application/pdf');
    expect(annex).toMatchObject({ status: 200, body: { ok: true, data: { kind: 'annexe', sha256: sha(PDF), size: PDF.length } } });
    const ref = annex.body.data.ref as string;
    expect(ref).toMatch(REF(t.id, '', 'pdf'));
    expect(t.stored.get(ref)).toEqual({ bytes: PDF, type: 'application/pdf' });
    // Déposer ne joint rien : le geste de M15 garde ses contrôles, et accepte cette référence.
    expect(await t.db.first('SELECT 1 FROM rental_annexes')).toBeNull();
    expect(await t.json('alex', `/location/${t.id}/annexes`, { kind: 'dpe', ref, diagnosedOn: '2027-01-02' })).toMatchObject({ status: 200, body: { ok: true } });
    const proof = await t.deposit('alex', 'preuve', JPG, 'image/jpeg');
    expect(proof.body.data.ref).toMatch(REF(t.id, 'choix/', 'jpg'));
    const note = new TextEncoder().encode('Le propriétaire a choisi par téléphone, note de l’agent.');
    expect((await t.deposit('alex', 'preuve', note, 'text/plain; charset=utf-8')).body.data.ref).toMatch(REF(t.id, 'choix/', 'txt'));
    const notice = await t.deposit('alex', 'notice', PDF, 'application/pdf');
    expect(notice.body.data.ref).toMatch(REF(t.id, 'bail/', 'pdf'));
    const events = (await t.journal.all()).filter((e) => e.type === 'location.depot');
    expect(events).toHaveLength(4);
    expect(events[0]!.data).toEqual({ kind: 'annexe', ref, size: PDF.length, sha256: sha(PDF) });
    expect(JSON.stringify(events)).not.toMatch(/diagnostic inventé|Léa|Exemple|note de l/);
  });

  it('[R104] [R16] W18 : une pièce de candidature se dépose dans son dossier, et le geste l’accepte ; les droits passent d’abord', async () => {
    const t = await setup();
    const person = await t.candidate();
    const applied = await t.json('alex', `/location/${t.id}/candidatures`, { personId: person });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    const app = applied.body.data.applicationId as string;
    const d = await t.depositPiece('alex', app, PDF, 'application/pdf');
    expect(d).toMatchObject({ status: 200, body: { ok: true, data: { kind: 'piece', sha256: sha(PDF) } } });
    const ref = d.body.data.ref as string;
    expect(ref).toMatch(new RegExp(`^location/${t.id}/candidatures/${app}/[0-9a-f-]{36}\\.pdf$`));
    // Déposer ne range rien ; le geste accepte la référence, puis contrôle la sorte.
    expect(await t.db.first('SELECT 1 FROM rental_application_pieces')).toBeNull();
    expect(await t.json('alex', `/location/candidatures/${app}/pieces`, { holder: 'candidat', sort: 'photo_identite_inventee', ref, sha256: sha(PDF) })).toMatchObject({ status: 409, body: { rule: 'R104', code: 'not_allowed' } });
    expect(await t.json('alex', `/location/candidatures/${app}/pieces`, { holder: 'candidat', sort: 'bulletins_salaire', ref, sha256: sha(PDF) })).toMatchObject({ status: 200, body: { ok: true } });
    // Un autre agent et la conformité sont refusés avant toute lecture, rien de plus n'est rangé.
    const before = t.stored.size;
    expect(await t.depositPiece('bea', app, PDF, 'application/pdf')).toMatchObject({ status: 403, body: { rule: 'R16' } });
    expect(await t.depositPiece('conformite', app, PDF, 'application/pdf')).toMatchObject({ status: 403, body: { rule: 'R16' } });
    // Une page, un autre type, une empreinte fausse : rien n'est rangé.
    expect((await t.depositPiece('alex', app, new TextEncoder().encode('<html>'), 'text/html')).body).toMatchObject({ ok: false, code: 'type_refuse' });
    expect((await t.depositPiece('alex', app, PDF, 'application/pdf', 'a'.repeat(64))).body).toMatchObject({ ok: false, code: 'empreinte_differente' });
    expect(t.stored.size).toBe(before);
    // Une candidature inconnue, et la sorte « pièce » par la route d'un logement : refusées.
    expect((await t.depositPiece('alex', 'inconnue', PDF, 'application/pdf')).body).toMatchObject({ ok: false });
    expect((await t.deposit('alex', 'piece', PDF, 'application/pdf')).status).toBe(404);
  });

  describe('W19 · chaque pièce déposée est vue par l’accès et l’effacement', () => {
    const section = async (t: Awaited<ReturnType<typeof setup>>, person: string, table: string) => (await assembleAccess(t.db, [person])).sections.find((s) => s.table === table)?.rows ?? [];
    const apply = async (t: Awaited<ReturnType<typeof setup>>) => {
      const person = await t.candidate();
      const applied = await t.json('alex', `/location/${t.id}/candidatures`, { personId: person });
      return { person, app: applied.body.data.applicationId as string };
    };

    it('[R95] un dépôt refusé ensuite par le geste, ou jamais suivi du geste, apparaît sur la carte de la personne', async () => {
      const t = await setup();
      const { person, app } = await apply(t);
      const refused = await t.depositPiece('alex', app, PDF, 'application/pdf');
      expect(await t.json('alex', `/location/candidatures/${app}/pieces`, { holder: 'candidat', sort: 'photo_inventee', ref: refused.body.data.ref, sha256: sha(PDF) })).toMatchObject({ body: { rule: 'R104', code: 'not_allowed' } });
      const lost = await t.depositPiece('alex', app, JPG, 'image/jpeg');
      expect(await t.db.first('SELECT 1 FROM rental_application_pieces')).toBeNull();
      const rows = await section(t, person, 'rental_piece_deposits');
      expect(rows.map((r) => r.ref).sort()).toEqual([refused.body.data.ref, lost.body.data.ref].sort());
      expect(rows.every((r) => r.application_id === app && r.holder === 'candidat')).toBe(true);
      // Le propriétaire et les autres contacts n’y voient rien, pas même au journal de leur logement.
      const owner = (await t.db.first<{ owner_person_id: string }>('SELECT owner_person_id FROM rental_listings WHERE id = ?', [t.id]))!.owner_person_id;
      const ownerCard = JSON.stringify(await assembleAccess(t.db, [owner]));
      expect(ownerCard).not.toContain('location.depot');
      expect(ownerCard).not.toContain(refused.body.data.ref);
    });

    it('[R97] le plan d’effacement compte chaque dépôt, joint ou non', async () => {
      const t = await setup();
      const { person, app } = await apply(t);
      await t.depositPiece('alex', app, PDF, 'application/pdf');
      const kept = await t.depositPiece('alex', app, JPG, 'image/jpeg');
      await t.json('alex', `/location/candidatures/${app}/pieces`, { holder: 'candidat', sort: 'bulletins_salaire', ref: kept.body.data.ref, sha256: sha(JPG) });
      const plan = erasurePlan(await assembleAccessDetail(t.db, [person]));
      expect(plan.lines.filter((l) => l.table === 'rental_piece_deposits').map((l) => [l.action, l.rows])).toEqual([['effacer', 2]]);
    });

    it('[R95] [R16] le fichier d’un garant est sur la carte du garant seul ; un visa Visale sur celle du candidat ; un titulaire inconnu ou absent ne dépose rien', async () => {
      const t = await setup();
      const { person, app } = await apply(t);
      const guarantorPerson = await t.candidate();
      const added = await t.json('alex', `/location/candidatures/${app}/garants`, { kind: 'personne', personId: guarantorPerson });
      const guarantor = added.body.data.guarantorId as string;
      const d = await t.depositPiece('alex', app, PDF, 'application/pdf', sha(PDF), guarantor);
      expect((await section(t, guarantorPerson, 'rental_piece_deposits')).map((r) => r.ref)).toEqual([d.body.data.ref]);
      expect(await section(t, person, 'rental_piece_deposits')).toEqual([]);
      expect(JSON.stringify(await assembleAccess(t.db, [person]))).not.toContain(d.body.data.ref);
      const visale = await t.json('alex', `/location/candidatures/${app}/garants`, { kind: 'visale' });
      const v = await t.depositPiece('alex', app, JPG, 'image/jpeg', sha(JPG), visale.body.data.guarantorId);
      expect((await section(t, person, 'rental_piece_deposits')).map((r) => r.ref)).toEqual([v.body.data.ref]);
      const before = t.stored.size;
      expect(await t.depositPiece('alex', app, PDF, 'application/pdf', sha(PDF), null)).toMatchObject({ status: 404, body: { code: 'unknown_holder' } });
      expect(await t.depositPiece('alex', app, PDF, 'application/pdf', sha(PDF), 'garant-inconnu')).toMatchObject({ status: 404, body: { code: 'unknown_holder' } });
      expect(t.stored.size).toBe(before);
      // Le garant d’une autre candidature n’est pas un titulaire ici.
      const other = await apply(t);
      expect(await t.depositPiece('alex', other.app, PDF, 'application/pdf', sha(PDF), guarantor)).toMatchObject({ status: 404, body: { code: 'unknown_holder' } });
    });

    it('[R95] un fichier déposé pour une personne ne se range pas au nom d’une autre, ni sous une autre empreinte', async () => {
      const t = await setup();
      const { app } = await apply(t);
      const added = await t.json('alex', `/location/candidatures/${app}/garants`, { kind: 'personne', personId: await t.candidate() });
      const d = await t.depositPiece('alex', app, PDF, 'application/pdf');
      const ref = d.body.data.ref;
      expect(await t.json('alex', `/location/candidatures/${app}/pieces`, { holder: added.body.data.guarantorId, sort: 'bulletins_salaire', ref, sha256: sha(PDF) })).toMatchObject({ status: 400, body: { code: 'holder_mismatch' } });
      expect(await t.json('alex', `/location/candidatures/${app}/pieces`, { holder: 'candidat', sort: 'bulletins_salaire', ref, sha256: 'b'.repeat(64) })).toMatchObject({ status: 400, body: { code: 'bad_sha256' } });
      expect(await t.db.first('SELECT 1 FROM rental_application_pieces')).toBeNull();
      expect(await t.json('alex', `/location/candidatures/${app}/pieces`, { holder: 'candidat', sort: 'bulletins_salaire', ref, sha256: sha(PDF) })).toMatchObject({ status: 200 });
    });

    it('[R13] ni contenu ni nom au journal ; la pièce d’un garant n’y laisse ni référence ni empreinte', async () => {
      const t = await setup();
      const { app } = await apply(t);
      const d = await t.depositPiece('alex', app, PDF, 'application/pdf');
      await t.depositPiece('alex', app, new TextEncoder().encode('<html>'), 'text/html');
      const events = (await t.journal.all()).filter((e) => e.type.startsWith('location.depot'));
      expect(events.map((e) => e.subject)).toEqual([`rental_application:${app}`, `rental_application:${app}`]);
      expect(events[0]!.data).toEqual({ kind: 'piece', size: PDF.length, deposit: expect.any(String) });
      const text = JSON.stringify(events);
      expect(text).not.toMatch(/diagnostic inventé|Cand|Inventé/);
      expect(text).not.toContain(d.body.data.ref);
      expect(text).not.toContain(sha(PDF));
    });

    it('[R17] le dépôt n’efface rien : la ligne reste, ne change plus, et une panne du stockage la laisse sans fichier, sans rendre de référence', async () => {
      const t = await setup();
      const { person, app } = await apply(t);
      const d = await t.depositPiece('alex', app, PDF, 'application/pdf');
      await t.depositPiece('alex', app, JPG, 'image/jpeg');
      expect(t.stored.size).toBe(2);
      await expect(t.db.run('DELETE FROM rental_piece_deposits WHERE ref = ?', [d.body.data.ref])).rejects.toThrow(/rien ne s'efface/);
      await expect(t.db.run("UPDATE rental_piece_deposits SET holder = 'x'")).rejects.toThrow(/ne change plus/);
      t.state.broken = true;
      expect(await t.depositPiece('alex', app, PDF, 'application/pdf')).toMatchObject({ status: 503, body: { code: 'stockage_indisponible' } });
      t.state.broken = false;
      const rows = await section(t, person, 'rental_piece_deposits');
      expect(rows).toHaveLength(3);
      expect(t.stored.size).toBe(2);
      // La ligne sans fichier ne se joint pas au dossier.
      const phantom = rows.map((r) => String(r.ref)).find((ref) => !t.stored.has(ref))!;
      expect(await t.json('alex', `/location/candidatures/${app}/pieces`, { holder: 'candidat', sort: 'bulletins_salaire', ref: phantom, sha256: sha(PDF) })).toMatchObject({ body: { code: 'not_stored' } });
    });
  });

  it('[R16] un autre agent et la conformité sont refusés avant toute lecture, au journal, et rien n’est rangé', async () => {
    const t = await setup();
    expect(await t.deposit('bea', 'annexe', PDF, 'application/pdf')).toMatchObject({ status: 403, body: { rule: 'R16' } });
    expect(await t.deposit('conformite', 'annexe', PDF, 'application/pdf')).toMatchObject({ status: 403, body: { rule: 'R16', code: 'role' } });
    expect(t.stored.size).toBe(0);
    expect((await t.journal.all()).filter((e) => e.type === 'acces.refuse').length).toBeGreaterThanOrEqual(2);
  });

  it('une page, un script, un fichier vide, un type mal dit, une mauvaise sorte : rien n’est rangé', async () => {
    const t = await setup();
    const html = new TextEncoder().encode('<script>alert(1)</script> une page piégée');
    expect(await t.deposit('alex', 'annexe', html, 'text/html')).toMatchObject({ status: 415, body: { code: 'type_refuse' } });
    expect(await t.deposit('alex', 'annexe', html, 'application/pdf')).toMatchObject({ status: 415, body: { code: 'type_refuse' } });
    expect(await t.deposit('alex', 'annexe', html, 'text/plain')).toMatchObject({ status: 415, body: { code: 'type_refuse' } });
    expect(await t.deposit('alex', 'notice', JPG, 'image/jpeg')).toMatchObject({ status: 415, body: { code: 'type_refuse' } });
    expect(await t.deposit('alex', 'preuve', new Uint8Array([0x41, 0, 0x42]), 'text/plain')).toMatchObject({ status: 415, body: { code: 'type_refuse' } });
    expect(await t.deposit('alex', 'preuve', new Uint8Array([0xc3, 0x28]), 'text/plain')).toMatchObject({ status: 415, body: { code: 'type_refuse' } });
    expect(await t.deposit('alex', 'annexe', new Uint8Array(0), 'application/pdf')).toMatchObject({ status: 400, body: { code: 'fichier_vide' } });
    expect((await t.deposit('alex', 'autre', PDF, 'application/pdf')).status).toBe(404);
    expect(t.stored.size).toBe(0);
    const refused = (await t.journal.all()).filter((e) => e.type === 'location.depot.refuse');
    expect(refused.length).toBe(7);
    expect(JSON.stringify(refused)).not.toContain('piégée');
  });

  it('une empreinte absente ou différente, un fichier trop lourd annoncé ou réel : rien n’est rangé', async () => {
    const t = await setup();
    expect(await t.deposit('alex', 'annexe', PDF, 'application/pdf', null)).toMatchObject({ status: 400, body: { code: 'empreinte_absente' } });
    expect(await t.deposit('alex', 'annexe', PDF, 'application/pdf', sha('autre chose'))).toMatchObject({ status: 400, body: { code: 'empreinte_differente' } });
    const big = new Uint8Array(RENTAL_DEPOSIT_MAX_BYTES + 1);
    big.set(PDF);
    expect(await t.deposit('alex', 'annexe', big, 'application/pdf')).toMatchObject({ status: 413, body: { code: 'trop_lourd' } });
    expect(t.stored.size).toBe(0);
  });

  it('une panne du stockage ne rend aucune référence ; un stockage sans écriture dit « indisponible » ; la même route reste fermée sans stockage', async () => {
    const t = await setup();
    t.state.broken = true;
    expect(await t.deposit('alex', 'annexe', PDF, 'application/pdf')).toMatchObject({ status: 503, body: { code: 'stockage_indisponible' } });
    expect((await t.journal.all()).some((e) => e.type === 'location.depot')).toBe(false);
    t.state.broken = false;
    expect((await t.deposit('alex', 'annexe', PDF, 'application/pdf')).status).toBe(200);
    const closed = await setup(false);
    expect(await closed.deposit('alex', 'annexe', PDF, 'application/pdf')).toMatchObject({ status: 503, body: { code: 'stockage_indisponible' } });
  });

  it('une référence d’un logement ne sert pas pour un autre : le geste la refuse', async () => {
    const t = await setup();
    const annex = await t.deposit('alex', 'preuve', PDF, 'application/pdf');
    expect(await t.json('alex', `/location/${t.id}/annexes`, { kind: 'dpe', ref: annex.body.data.ref, diagnosedOn: '2027-01-02' })).toMatchObject({ body: { code: 'bad_ref' } });
  });
});
