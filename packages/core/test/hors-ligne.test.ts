import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryOutboxStorage, Outbox, type OpResult, type PendingOp, type Transport } from '../src/hors-ligne/boite.ts';
import { departureCheck, shotPlan } from '../src/hors-ligne/cadrage.ts';
import { decodeLuma, encodeLuma, fuseExposures, hdrPhoto, judgePhoto, type Luma } from '../src/hors-ligne/photo.ts';
import { checkKeptImage, IMAGE_MIN_LONG_SIDE, jpegSize, matchesKept } from '../src/hors-ligne/image.ts';
import { HorsLigne, type VisitImageStore } from '../src/hors-ligne/reception.ts';
import { Acces, FicheClient, FicheUnique, RendezVous, SqlJournalStore, Visites, applyMigrations, fromSyncSqlite, type SqlDatabase } from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';

// Images, réseau, agents, vendeur, acquéreurs et biens inventés.
const W = 64;
const H = 64;
const scene = (f: (v: number) => number = (v) => v): Luma => {
  const luma = new Uint8Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const v = 128 + 70 * Math.sign(Math.sin(x * 0.7) * Math.sin(y * 0.7)) + (x - 32) * 1.5;
      luma[y * W + x] = Math.max(0, Math.min(255, Math.round(f(v))));
    }
  return { width: W, height: H, luma };
};
const blur = (img: Luma, r = 3): Luma => {
  let a = img.luma;
  for (let k = 0; k < 2; k++) {
    const b = new Uint8Array(W * H);
    for (let y = 0; y < H; y++)
      for (let x = 0; x < W; x++) {
        let s = 0;
        let n = 0;
        for (let dy = -r; dy <= r; dy++)
          for (let dx = -r; dx <= r; dx++) {
            const xx = x + dx;
            const yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
            s += a[yy * W + xx] as number;
            n++;
          }
        b[y * W + x] = Math.round(s / n);
      }
    a = b;
  }
  return { width: W, height: H, luma: a };
};
const dark = scene((v) => v * 0.25);
const bright = scene((v) => v * 2.2);

describe('HX12 · la photo de l’appli', () => {
  it('[R277] une photo trop sombre, brûlée ou floue est refusée avec ce qu’il faut faire ; une photo nette et claire passe', () => {
    expect(judgePhoto(scene())).toMatchObject({ ok: true, problems: [], advice: null });
    expect(judgePhoto(dark)).toMatchObject({ ok: false, problems: ['trop_sombre'] });
    expect(judgePhoto(dark).advice).toMatch(/Trop sombre/);
    expect(judgePhoto(bright)).toMatchObject({ ok: false, problems: ['brulee'] });
    const flou = judgePhoto(blur(scene()));
    expect(flou).toMatchObject({ ok: false, problems: ['floue'] });
    expect(flou.advice).toMatch(/Floue/);
    // Mêmes entrées, même verdict.
    expect(judgePhoto(blur(scene()))).toEqual(flou);
  });

  it('[R277] la photo HDR fond au moins deux prises de lumières différentes ; une seule lumière n’est pas une photo HDR', () => {
    const r = hdrPhoto([dark, bright]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.exposures).toBe(2);
    // La fusion rattrape ce que chaque prise seule rate : ni trop sombre ni brûlée.
    expect(r.verdict.figures.brightness).toBeGreaterThan(60);
    expect(r.verdict.figures.clipped).toBeLessThan(0.2);
    expect(r.image).toEqual(fuseExposures([dark, bright]));
    expect(hdrPhoto([scene()])).toMatchObject({ ok: false, code: 'pas_hdr' });
    expect(hdrPhoto([scene(), scene()])).toMatchObject({ ok: false, code: 'pas_hdr' });
    // Deux prises floues : fondues, toujours floues.
    expect(hdrPhoto([blur(dark), blur(bright)])).toMatchObject({ ok: false, code: 'photo_refusee', verdict: { problems: ['floue'] } });
    // Prises abîmées ou de tailles différentes : refusées.
    expect(hdrPhoto([dark, { width: 32, height: 32, luma: new Uint8Array(32 * 32) }])).toMatchObject({ ok: false, code: 'prises_invalides' });
    expect(hdrPhoto([{ width: 10, height: 10, luma: new Uint8Array(100) }, dark])).toMatchObject({ ok: false, code: 'prises_invalides' });
    expect(hdrPhoto('photo')).toMatchObject({ ok: false, code: 'prises_invalides' });
  });

  it('[R277] l’image réduite voyage en texte sans rien perdre ; un texte abîmé ne fait pas une image', () => {
    const e = encodeLuma(dark);
    expect(decodeLuma(e)).toEqual(dark);
    expect(decodeLuma({ ...e, width: 65 })).toBeNull();
    expect(decodeLuma({ width: 64, height: 64, data: '!!!' })).toBeNull();
    expect(decodeLuma(null)).toBeNull();
  });

  it('[R277] la liste de cadrage vient de la fiche du bien, pièce par pièce, et dit ce qui manque avant de repartir', () => {
    const plan = shotPlan('home', 4);
    expect(plan.map((s) => s.key)).toEqual(['facade', 'sejour', 'cuisine', 'chambre-1', 'chambre-2', 'chambre-3', 'salle-d-eau', 'exterieur']);
    for (const s of plan) expect(s.advice.length).toBeGreaterThan(10);
    expect(shotPlan('home', 1).filter((s) => s.key.startsWith('chambre'))).toHaveLength(1);
    expect(shotPlan('home', 40).filter((s) => s.key.startsWith('chambre'))).toHaveLength(12);
    expect(shotPlan('land', null).map((s) => s.key)).toEqual(['vue-ensemble', 'acces', 'limites']);
    expect(shotPlan('commercial', null).map((s) => s.key)).toEqual(['facade', 'espace-principal', 'reserve']);
    const small = shotPlan('land', null);
    expect(departureCheck(small, ['vue-ensemble'], [])).toMatchObject({ canLeave: false, missing: ['acces', 'limites'] });
    expect(departureCheck(small, ['vue-ensemble', 'acces'], ['limites'])).toMatchObject({ canLeave: true, missing: [] });
  });
});

/** Un transport qui passe par un serveur de test et peut perdre le réseau à volonté. */
function wire(receive: (b: { deviceId: string; ops: PendingOp[] }) => Promise<{ results: OpResult[] }>) {
  const state = { network: true, loseAnswer: false, calls: 0 };
  const transport: Transport = async (batch) => {
    state.calls++;
    if (!state.network) throw new Error('hors ligne');
    // Les saisies voyagent en texte, comme sur le réseau.
    const r = await receive(JSON.parse(JSON.stringify(batch)));
    if (state.loseAnswer) throw new Error('réponse perdue');
    return r;
  };
  return { state, transport };
}

describe('HX12 · la boîte d’envoi du téléphone', () => {
  it('[R276] sans réseau, tout reste rangé ; au retour, tout part dans l’ordre et ne quitte la boîte que sur une réponse qui le nomme', async () => {
    const storage = new MemoryOutboxStorage();
    let n = 0;
    const box = new Outbox(storage, { newId: () => `id-test-${++n}` });
    const seen: string[][] = [];
    const answered = new Set<string>();
    const { state, transport } = wire(async (b) => {
      seen.push(b.ops.map((o) => o.opId));
      return { results: b.ops.filter((o) => !answered.has(o.opId)).slice(0, 2).map((o) => ({ opId: o.opId, outcome: 'applique' as const, again: false })) };
    });
    state.network = false;
    await box.add('visite.note', 'rdv-test-1', { text: 'Parquet à revoir' });
    await box.add('visite.note', 'rdv-test-1', { text: 'Belle lumière' });
    await box.add('visite.sans_objet', 'rdv-test-1', { shot: 'exterieur', reason: 'piece_absente' });
    expect(await box.flush(transport)).toMatchObject({ offline: true, sent: 0, left: 3 });
    // Rangé sur le téléphone : une autre boîte sur le même rangement (appli relancée) retrouve tout, dans l'ordre.
    const reopened = new Outbox(storage, { newId: () => `id-test-${++n}` });
    expect((await reopened.pending()).map((o) => o.seq)).toEqual([1, 2, 3]);
    state.network = true;
    // Le serveur ne répond qu'à deux saisies par envoi : la troisième reste, puis part au tour suivant.
    expect(await reopened.flush(transport)).toMatchObject({ offline: false, sent: 3, left: 0 });
    expect(seen.flat()).toEqual(['id-test-2', 'id-test-3', 'id-test-4', 'id-test-4']);
    expect(await reopened.pending()).toEqual([]);
  });

  it('[R276] une saisie refusée sort de la file mais reste visible de l’agent ; deux envois lancés ensemble n’en font qu’un', async () => {
    const box = new Outbox(new MemoryOutboxStorage());
    await box.add('visite.note', 'rdv-test-1', { text: '' });
    await box.add('visite.note', 'rdv-test-1', { text: 'Cave saine' });
    const { state, transport } = wire(async (b) => ({
      results: b.ops.map((o) => (o.payload.text === '' ? { opId: o.opId, outcome: 'refuse' as const, again: false, code: 'bad_note', rule: null } : { opId: o.opId, outcome: 'applique' as const, again: false })),
    }));
    const [a, b] = await Promise.all([box.flush(transport), box.flush(transport)]);
    expect(a).toEqual(b);
    expect(state.calls).toBe(1);
    expect(a).toMatchObject({ sent: 1, refused: 1, left: 0 });
    expect(await box.refused()).toMatchObject([{ code: 'bad_note', payload: { text: '' } }]);
  });

  it('[R276] deux saisies faites en même temps sont toutes deux gardées, chacune avec son numéro', async () => {
    const storage = new MemoryOutboxStorage();
    const box = new Outbox(storage);
    const ops = await Promise.all([box.add('visite.note', 'rdv-test-1', { text: 'Un' }), box.add('visite.note', 'rdv-test-1', { text: 'Deux' }), box.add('visite.note', 'rdv-test-1', { text: 'Trois' })]);
    expect(ops.map((o) => o.seq)).toEqual([1, 2, 3]);
    expect(storage.saved?.pending.map((o) => o.payload.text)).toEqual(['Un', 'Deux', 'Trois']);
    // Une saisie ajoutée pendant un envoi reste dans la boîte.
    let late: Promise<PendingOp> | null = null;
    const { transport } = wire(async (b) => {
      if (!late) {
        late = box.add('visite.note', 'rdv-test-1', { text: 'Quatre' });
        await late;
      }
      return { results: b.ops.map((o) => ({ opId: o.opId, outcome: 'applique' as const, again: false })) };
    });
    const report = await box.flush(transport);
    expect(report).toMatchObject({ sent: 4, left: 0 });
  });

  it('[R276] une réponse qui ne nomme aucune saisie ne retire rien', async () => {
    const box = new Outbox(new MemoryOutboxStorage());
    await box.add('visite.note', 'rdv-test-1', { text: 'Note' });
    const { transport } = wire(async () => ({ results: [{ opId: 'autre-saisie', outcome: 'applique', again: false }] }));
    expect(await box.flush(transport)).toMatchObject({ sent: 0, left: 1 });
    expect(await box.pending()).toHaveLength(1);
  });
});

// Lundi 7 décembre 2026, 9 h à Paris.
const MONDAY_9H = Date.parse('2026-12-07T08:00:00.000Z');
const HOUR = 3_600_000;
const MIN = 60_000;
const WEEK = { weekly: [1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, from: '09:00', to: '19:00' })) };

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = MONDAY_9H;
  const now = (): Date => new Date(clock);
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const rdv = new RendezVous(db, journal, { now });
  const visites = new Visites(db, journal, acces, { diffusion: { canDiffuse: async () => ({ allowed: true, reason: 'allowed' }) }, rendezVous: rdv, now });
  const server = new HorsLigne(db, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Bienveillant' });
  const as = (role: 'agent' | 'direction', userId: string) => ({ role, userId, networkId: network.id });
  const agentAlex = as('agent', alex.id);
  const agentSam = as('agent', sam.id);
  const direction = as('direction', 'd1');
  await rdv.setAvailability(agentAlex, WEEK);
  await rdv.setAvailability(agentSam, WEEK);
  await visites.createSlipTemplate(direction, 'Bon de visite : {{visiteur.nom}} visite {{bien.reference}} le {{visite.date}}.');
  const seller = await store.createPerson({ networkId: network.id, agentId: sam.id, firstName: 'Victorine', lastName: 'Vendeuse' });
  await store.addIdentifier({ networkId: network.id, personId: seller.id, kind: 'email', value: 'victorine.vendeuse@example.test' });
  const property = await store.createProperty({ networkId: network.id, agentId: sam.id, reference: 'B1', kind: 'home', city: 'Talant', priceEur: 250_000, surfaceM2: 90, rooms: 4, status: 'available' });
  const land = await store.createProperty({ networkId: network.id, agentId: sam.id, reference: 'T1', kind: 'land', city: 'Talant', priceEur: 90_000, surfaceM2: 800, rooms: 0, status: 'available' });
  let n = 0;
  /** Une visite d'une acquéreuse inventée, tenue par `agent`, le lendemain. */
  const visit = async (agent = alex, propertyId = property.id) => {
    n += 1;
    const buyer = await store.createPerson({ networkId: network.id, agentId: agent.id, firstName: 'Inès', lastName: 'Durandal' });
    await store.addIdentifier({ networkId: network.id, personId: buyer.id, kind: 'phone', value: '06 12 34 56 78' });
    const project = await store.createProject({ networkId: network.id, agentId: agent.id, personId: buyer.id, kind: 'buy' });
    const r = await visites.schedule(as('agent', agent.id), { propertyId, projectId: project.id, start: new Date(MONDAY_9H + 24 * HOUR + n * 90 * MIN) });
    if (!r.ok) throw new Error(r.code);
    return { id: r.visit.appointment.id, start: Date.parse(r.visit.appointment.start_at) };
  };
  return { db, journal, server, store, network, alex, sam, agentAlex, agentSam, direction, property, land, visit, setClock: (t: number) => (clock = t) };
}

/**
 * Un JPEG inventé, bien formé de bout en bout : début, table de quantification, trame à la taille dite, table de
 * Huffman, balayage des trois composantes, données (chaque 0xFF bourré d'un 0x00), fin.
 */
const fakeJpeg = (width: number, height: number, body: Uint8Array = new Uint8Array([1, 2, 3, 4])): Uint8Array => {
  const dqt = [0xff, 0xdb, 0x00, 0x43, 0x00, ...new Array<number>(64).fill(1)];
  const sof = [0xff, 0xc0, 0x00, 0x11, 0x08, height >> 8, height & 255, width >> 8, width & 255, 0x03, 1, 0x11, 0, 2, 0x11, 0, 3, 0x11, 0];
  const dht = [0xff, 0xc4, 0x00, 0x14, 0x00, 1, ...new Array<number>(15).fill(0), 0];
  const sos = [0xff, 0xda, 0x00, 0x0c, 0x03, 1, 0x00, 2, 0x00, 3, 0x00, 0x00, 0x3f, 0x00];
  const data: number[] = [];
  for (const b of body) b === 0xff ? data.push(0xff, 0x00) : data.push(b);
  return new Uint8Array([0xff, 0xd8, ...dqt, ...sof, ...dht, ...sos, ...data, 0xff, 0xd9]);
};
/** L'image entière qui accompagne la photo [R677] : le fichier, et ce que la saisie en dit. */
const wholeImage = (exposures: Luma[], o: { width?: number; height?: number; kept?: Luma; body?: Uint8Array } = {}) => {
  const width = o.width ?? 1280;
  const height = o.height ?? 1280;
  const bytes = fakeJpeg(width, height, o.body);
  return { bytes, meta: { sha256: createHash('sha256').update(bytes).digest('hex'), width, height, bytes: bytes.length, kept: encodeLuma(o.kept ?? fuseExposures(exposures)) } };
};
const photoPayload = (shot: string, exposures: Luma[] = [dark, bright]) => ({ shot, exposures: exposures.map(encodeLuma), image: wholeImage(exposures).meta });

describeWithSqlite('HX12 · l’appli sans réseau, côté serveur', () => {
  it('[R276] la même saisie rejouée après une réponse perdue ne fait aucun doublon ; rien n’est perdu', async () => {
    const t = await setup();
    const v = await t.visit();
    t.setClock(v.start + 10 * MIN);
    let k = 0;
    const box = new Outbox(new MemoryOutboxStorage(), { newId: () => `dev-or-op-${++k}`, now: () => new Date(v.start + 5 * MIN) });
    const { state, transport } = wire(async (b) => {
      const r = await t.server.receive(t.agentAlex, b);
      if (!r.ok) throw new Error(r.code);
      return { results: r.results };
    });
    await box.add('visite.note', v.id, { text: 'Les acquéreurs reviennent avec un artisan.' });
    await box.add('visite.photo', v.id, photoPayload('sejour'));
    // Le serveur range tout, puis la réponse se perd : le téléphone garde tout.
    state.loseAnswer = true;
    expect(await box.flush(transport)).toMatchObject({ offline: true, left: 2 });
    state.loseAnswer = false;
    expect(await box.flush(transport)).toMatchObject({ offline: false, sent: 2, left: 0 });
    expect(await t.db.all('SELECT body FROM visit_field_notes')).toEqual([{ body: 'Les acquéreurs reviennent avec un artisan.' }]);
    expect(await t.db.all('SELECT shot, exposures FROM visit_photos')).toEqual([{ shot: 'sejour', exposures: 2 }]);
    expect(await t.db.first('SELECT count(*) AS n FROM offline_ops')).toEqual({ n: 2 });
  });

  it('[R276] une panne de la base pendant la réception laisse la saisie au téléphone, qui la renvoie ensuite', async () => {
    const t = await setup();
    const v = await t.visit();
    t.setClock(v.start + 10 * MIN);
    let broken = true;
    const flaky: SqlDatabase = {
      ...t.db,
      exec: (sql) => t.db.exec(sql),
      run: (sql, params) => t.db.run(sql, params),
      all: (sql, params) => t.db.all(sql, params),
      first: (sql, params) => t.db.first(sql, params),
      batch: async (statements) => {
        if (broken) throw new Error('base indisponible');
        return t.db.batch ? t.db.batch(statements) : Promise.all(statements.map((st) => t.db.run(st.sql, st.params)));
      },
    };
    const server = new HorsLigne(flaky, t.journal, { now: () => new Date(v.start + 10 * MIN) });
    const box = new Outbox(new MemoryOutboxStorage(), { now: () => new Date(v.start + 5 * MIN) });
    await box.add('visite.note', v.id, { text: 'Note gardée' });
    const { transport } = wire(async (b) => {
      const r = await server.receive(t.agentAlex, b);
      if (!r.ok) throw new Error(r.code);
      return { results: r.results };
    });
    expect(await box.flush(transport)).toMatchObject({ offline: true, refused: 0, left: 1 });
    broken = false;
    expect(await box.flush(transport)).toMatchObject({ offline: false, sent: 1, left: 0 });
    expect(await t.db.all('SELECT body FROM visit_field_notes')).toEqual([{ body: 'Note gardée' }]);
  });

  it('[R276] rejouée, une saisie rend la même réponse ; un autre contenu sous le même identifiant est refusé, jamais écrit par-dessus', async () => {
    const t = await setup();
    const v = await t.visit();
    t.setClock(v.start + 10 * MIN);
    const op = { opId: 'op-test-0001', seq: 1, kind: 'visite.note', appointmentId: v.id, writtenAt: new Date(v.start).toISOString(), payload: { text: 'Première note' } };
    expect(await t.server.receive(t.agentAlex, { deviceId: 'device-test-1', ops: [op] })).toEqual({ ok: true, results: [{ opId: 'op-test-0001', outcome: 'applique', again: false, code: null, rule: 'R276' }] });
    expect(await t.server.receive(t.agentAlex, { deviceId: 'device-test-1', ops: [op] })).toEqual({ ok: true, results: [{ opId: 'op-test-0001', outcome: 'applique', again: true, code: null, rule: 'R276' }] });
    const changed = { ...op, payload: { text: 'Autre note' } };
    expect(await t.server.receive(t.agentAlex, { deviceId: 'device-test-1', ops: [changed] })).toMatchObject({ ok: true, results: [{ outcome: 'refuse', code: 'conflit', rule: 'R276' }] });
    expect(await t.db.all('SELECT body FROM visit_field_notes')).toEqual([{ body: 'Première note' }]);
    // Un refus rejoué rend le même refus.
    const empty = { ...op, opId: 'op-test-0002', seq: 2, payload: { text: '   ' } };
    const first = await t.server.receive(t.agentAlex, { deviceId: 'device-test-1', ops: [empty] });
    expect(first).toMatchObject({ ok: true, results: [{ outcome: 'refuse', code: 'bad_note', again: false }] });
    expect(await t.server.receive(t.agentAlex, { deviceId: 'device-test-1', ops: [empty] })).toMatchObject({ ok: true, results: [{ outcome: 'refuse', code: 'bad_note', again: true }] });
    // Les saisies d'un envoi passent dans leur ordre, même arrivées mélangées.
    const later = { ...op, opId: 'op-test-0004', seq: 4, payload: { text: 'Quatre' } };
    const earlier = { ...op, opId: 'op-test-0003', seq: 3, payload: { text: 'Trois' } };
    const r = await t.server.receive(t.agentAlex, { deviceId: 'device-test-1', ops: [later, earlier] });
    expect(r.ok && r.results.map((x) => x.opId)).toEqual(['op-test-0003', 'op-test-0004']);
    // Rien ne change ni ne s'efface.
    await expect(t.db.run("UPDATE visit_field_notes SET body = 'x'")).rejects.toThrow();
    await expect(t.db.run('DELETE FROM offline_ops')).rejects.toThrow();
  });

  it('[R276] deux envois concurrents d’un même identifiant, de contenus différents, n’écrivent qu’une seule chose', async () => {
    const t = await setup();
    const v = await t.visit(t.alex, t.land.id);
    t.setClock(v.start + 10 * MIN);
    const at = new Date(v.start).toISOString();
    const note = { opId: 'op-test-0001', seq: 1, kind: 'visite.note', appointmentId: v.id, writtenAt: at, payload: { text: 'Note' } };
    const skip = { ...note, kind: 'visite.sans_objet', payload: { shot: 'limites', reason: 'acces_refuse' } };
    const [a, b] = await Promise.all([t.server.receive(t.agentAlex, { deviceId: 'device-test-1', ops: [note] }), t.server.receive(t.agentAlex, { deviceId: 'device-test-1', ops: [skip] })]);
    const outcomes = [a, b].map((r) => (r.ok ? r.results[0]?.code ?? r.results[0]?.outcome : r.code)).sort();
    expect(outcomes).toEqual(['applique', 'conflit']);
    const notes = (await t.db.first<{ n: number }>('SELECT count(*) AS n FROM visit_field_notes'))?.n ?? 0;
    const skips = (await t.db.first<{ n: number }>('SELECT count(*) AS n FROM visit_shot_skips'))?.n ?? 0;
    expect(notes + skips).toBe(1);
  });

  it('[R277] le serveur refait le jugement de la photo : une photo sombre ou d’une seule lumière est refusée, quoi qu’en dise le téléphone', async () => {
    const t = await setup();
    const v = await t.visit();
    t.setClock(v.start + 10 * MIN);
    const at = new Date(v.start).toISOString();
    const ops = [
      { opId: 'op-photo-01', seq: 1, kind: 'visite.photo', appointmentId: v.id, writtenAt: at, payload: { ...photoPayload('cuisine', [scene((x) => x * 0.2), scene((x) => x * 0.42)]), verdict: { ok: true } } },
      { opId: 'op-photo-02', seq: 2, kind: 'visite.photo', appointmentId: v.id, writtenAt: at, payload: photoPayload('cuisine', [scene(), scene()]) },
      { opId: 'op-photo-03', seq: 3, kind: 'visite.photo', appointmentId: v.id, writtenAt: at, payload: photoPayload('cuisine', [blur(dark), blur(bright)]) },
      { opId: 'op-photo-04', seq: 4, kind: 'visite.photo', appointmentId: v.id, writtenAt: at, payload: photoPayload('grenier') },
      { opId: 'op-photo-05', seq: 5, kind: 'visite.photo', appointmentId: v.id, writtenAt: at, payload: { shot: 'cuisine', exposures: [{ width: 64, height: 64, data: 'abc' }] } },
    ];
    const r = await t.server.receive(t.agentAlex, { deviceId: 'device-test-1', ops });
    expect(r.ok && r.results.map((x) => [x.outcome, x.code, x.rule])).toEqual([
      ['refuse', 'trop_sombre', 'R277'],
      ['refuse', 'pas_hdr', 'R277'],
      ['refuse', 'floue', 'R277'],
      ['refuse', 'bad_shot', 'R277'],
      ['refuse', 'prises_invalides', 'R277'],
    ]);
    expect(await t.db.first('SELECT count(*) AS n FROM visit_photos')).toEqual({ n: 0 });
  });

  it('[R277] l’agent ne repart pas tant que chaque photo de la liste n’est ni acceptée ni dite sans objet', async () => {
    const t = await setup();
    const v = await t.visit(t.alex, t.land.id);
    t.setClock(v.start + 10 * MIN);
    const at = new Date(v.start).toISOString();
    const send = (opId: string, seq: number, kind: string, payload: Record<string, unknown>) => t.server.receive(t.agentAlex, { deviceId: 'device-test-1', ops: [{ opId, seq, kind, appointmentId: v.id, writtenAt: at, payload }] });
    expect(await t.server.departure(t.agentAlex, v.id)).toMatchObject({ ok: true, check: { canLeave: false, missing: ['vue-ensemble', 'acces', 'limites'] } });
    await send('op-test-0001', 1, 'visite.photo', photoPayload('vue-ensemble'));
    await send('op-test-0002', 2, 'visite.photo', photoPayload('acces'));
    expect(await send('op-test-0003', 3, 'visite.sans_objet', { shot: 'limites', reason: 'parce_que' })).toMatchObject({ ok: true, results: [{ outcome: 'refuse', code: 'bad_reason' }] });
    expect(await t.server.departure(t.agentAlex, v.id)).toMatchObject({ ok: true, check: { canLeave: false, missing: ['limites'] } });
    expect(await send('op-test-0004', 4, 'visite.sans_objet', { shot: 'limites', reason: 'acces_refuse' })).toMatchObject({ ok: true, results: [{ outcome: 'applique' }] });
    expect(await t.server.departure(t.agentAlex, v.id)).toMatchObject({ ok: true, check: { canLeave: true, missing: [] } });
    // La direction le lit aussi ; un autre agent, non.
    expect(await t.server.departure(t.direction, v.id)).toMatchObject({ ok: true, check: { canLeave: true } });
    expect(await t.server.departure(t.agentSam, v.id)).toMatchObject({ ok: false, rule: 'R16' });
  });

  it('[R16] seul l’agent du rendez-vous y saisit ; la direction ne saisit rien ; une heure impossible ou un rendez-vous annulé refusent', async () => {
    const t = await setup();
    const v = await t.visit();
    t.setClock(v.start + 10 * MIN);
    const op = { opId: 'op-test-0001', seq: 1, kind: 'visite.note', appointmentId: v.id, writtenAt: new Date(v.start).toISOString(), payload: { text: 'Note' } };
    expect(await t.server.receive(t.agentSam, { deviceId: 'device-test-2', ops: [op] })).toMatchObject({ ok: true, results: [{ outcome: 'refuse', code: 'pas_son_rendez_vous', rule: 'R16' }] });
    expect(await t.server.receive(t.direction, { deviceId: 'device-test-3', ops: [op] })).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.server.receive(t.agentAlex, { deviceId: 'court', ops: [op] })).toMatchObject({ ok: false, code: 'bad_device' });
    expect(await t.server.receive(t.agentAlex, { deviceId: 'device-test-1', ops: Array.from({ length: 51 }, () => op) })).toMatchObject({ ok: false, code: 'bad_batch' });
    const future = { ...op, opId: 'op-test-0002', seq: 2, writtenAt: new Date(v.start + 2 * HOUR).toISOString() };
    expect(await t.server.receive(t.agentAlex, { deviceId: 'device-test-1', ops: [future] })).toMatchObject({ ok: true, results: [{ code: 'heure_invalide' }] });
    await t.db.run("UPDATE appointments SET status = 'cancelled' WHERE id = ?", [v.id]);
    expect(await t.server.receive(t.agentAlex, { deviceId: 'device-test-1', ops: [{ ...op, opId: 'op-test-0003' }] })).toMatchObject({ ok: true, results: [{ code: 'rendez_vous_annule' }] });
    expect(await t.db.first('SELECT count(*) AS n FROM visit_field_notes')).toEqual({ n: 0 });
  });

  it('[R13] le journal garde la sorte et la réponse de chaque saisie, jamais le texte de la note', async () => {
    const t = await setup();
    const v = await t.visit();
    t.setClock(v.start + 10 * MIN);
    await t.server.receive(t.agentAlex, { deviceId: 'device-test-1', ops: [{ opId: 'op-test-0001', seq: 1, kind: 'visite.note', appointmentId: v.id, writtenAt: new Date(v.start).toISOString(), payload: { text: 'Madame Durandal hésite' } }] });
    const rows = await t.db.all<{ type: string; data: string }>("SELECT type, data FROM journal WHERE type LIKE 'hors_ligne.%'");
    expect(rows.map((r) => r.type)).toEqual(['hors_ligne.recu']);
    expect(JSON.stringify(rows)).not.toMatch(/Durandal|hésite/);
  });

  it('[R278] le paquet du jour ne garde que les visites prévues de l’agent, la fiche du bien sans client, jusqu’à la fin du jour de Paris', async () => {
    const t = await setup();
    const a = await t.visit();
    const b = await t.visit(t.alex, t.land.id);
    await t.visit(t.sam);
    const cancelled = await t.visit();
    await t.db.run("UPDATE appointments SET status = 'cancelled' WHERE id = ?", [cancelled.id]);
    const r = await t.server.pack(t.agentAlex, '2026-12-08');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pack.validUntil).toBe('2026-12-08T23:00:00.000Z');
    expect(r.pack.appointments.map((x) => x.appointmentId)).toEqual([a.id, b.id]);
    expect(r.pack.appointments[0]).toMatchObject({ kind: 'visite', property: { reference: 'B1', kind: 'home', city: 'Talant', surfaceM2: 90, rooms: 4 } });
    expect(r.pack.appointments[0]?.shots.map((s) => s.key)).toContain('chambre-3');
    const text = JSON.stringify(r.pack);
    for (const secret of ['Inès', 'Durandal', '06 12', '0612', 'Victorine', 'Vendeuse', 'example.test', 'Sam', 'Bienveillant']) expect(text).not.toContain(secret);
    expect(Object.keys(r.pack.appointments[0] ?? {}).sort()).toEqual(['accepted', 'appointmentId', 'end', 'kind', 'property', 'shots', 'skipped', 'start']);
    // Seulement aujourd'hui ou demain ; seul un agent en activité.
    expect(await t.server.pack(t.agentAlex)).toMatchObject({ ok: true, pack: { day: '2026-12-07', appointments: [] } });
    expect(await t.server.pack(t.agentAlex, '2026-12-09')).toMatchObject({ ok: false, code: 'bad_day' });
    expect(await t.server.pack(t.direction)).toMatchObject({ ok: false, rule: 'R16' });
  });
});

describeWithSqlite('AU104 · le mode privé de la visite, côté serveur', () => {
  const designate = async (t: Awaited<ReturnType<typeof setup>>, propertyId: string, street: string, version = 1) =>
    t.db.run(
      'INSERT INTO property_designations (id, network_id, property_id, version, street, postal_code, city, parcels, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [`des-${propertyId}-${version}`, t.network.id, propertyId, version, street, '21240', 'Talant', '[{"prefix":null,"section":"AB","number":"12"}]', 'agent:test', new Date(MONDAY_9H).toISOString()],
    );
  const endOf = async (t: Awaited<ReturnType<typeof setup>>, id: string) => Date.parse((await t.db.first<{ end_at: string }>('SELECT end_at FROM appointments WHERE id = ?', [id]))!.end_at);

  it('[R278] constat : le paquet du jour ne donne ni l’adresse ni le numéro, rien pour trouver l’entrée en zone blanche', async () => {
    const t = await setup();
    await designate(t, t.property.id, '12 rue des Vignes');
    await t.visit();
    t.setClock(MONDAY_9H + 23 * HOUR);
    const r = await t.server.pack(t.agentAlex);
    expect(JSON.stringify(r)).not.toMatch(/rue des Vignes|06 12|\+336/);
  });

  it('[R676] le mode privé donne, pour les visites du jour à venir ou en cours, l’adresse du bien, le nom et le numéro de la personne, jamais son mail', async () => {
    const t = await setup();
    await designate(t, t.property.id, '3 rue Ancienne');
    await designate(t, t.property.id, '12 rue des Vignes', 2);
    const a = await t.visit();
    const b = await t.visit(t.alex, t.land.id);
    await t.visit(t.sam);
    const cancelled = await t.visit();
    await t.db.run("UPDATE appointments SET status = 'cancelled' WHERE id = ?", [cancelled.id]);
    // Une visite de mercredi : pas aujourd'hui, jamais dans le mode privé du mardi.
    t.setClock(MONDAY_9H + 23 * HOUR);
    const r = await t.server.privatePack(t.agentAlex);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pack.day).toBe('2026-12-08');
    expect(r.pack.visits.map((v) => v.appointmentId)).toEqual([a.id, b.id]);
    expect(r.pack.visits[0]).toEqual({
      appointmentId: a.id,
      address: { street: '12 rue des Vignes', postalCode: '21240', city: 'Talant' },
      contact: { name: 'Inès Durandal', phone: '+33612345678' },
      wipeAt: new Date((await endOf(t, a.id)) + 2 * HOUR).toISOString(),
    });
    // Le terrain sans désignation : aucune adresse devinée.
    expect(r.pack.visits[1]?.address).toBeNull();
    expect(r.pack.validUntil).toBe(r.pack.visits[1]?.wipeAt);
    const text = JSON.stringify(r.pack);
    for (const secret of ['example.test', 'Victorine', 'Vendeuse', 'Sam', 'Bienveillant', 'rue Ancienne']) expect(text).not.toContain(secret);
    // Lundi, la veille : la visite de mardi n'entre pas.
    t.setClock(MONDAY_9H);
    expect(await t.server.privatePack(t.agentAlex)).toMatchObject({ ok: true, pack: { day: '2026-12-07', visits: [] } });
  });

  it('[R676] une visite finie depuis deux heures n’est plus rendue ; l’effacement ne passe jamais minuit', async () => {
    const t = await setup();
    const a = await t.visit();
    const b = await t.visit();
    const endA = await endOf(t, a.id);
    t.setClock(endA + 2 * HOUR);
    const r = await t.server.privatePack(t.agentAlex);
    expect(r.ok && r.pack.visits.map((v) => v.appointmentId)).toEqual([b.id]);
    // Une visite qui finit à 23 h 30 : effacée à minuit, pas à 1 h 30.
    await t.db.run('UPDATE appointments SET start_at = ?, end_at = ? WHERE id = ?', ['2026-12-08T21:45:00.000Z', '2026-12-08T22:30:00.000Z', b.id]);
    const late = await t.server.privatePack(t.agentAlex);
    expect(late.ok && late.pack.visits[0]?.wipeAt).toBe('2026-12-08T23:00:00.000Z');
  });

  it('[R676] [S04] la personne réunie en une autre fiche garde son nom ; son numéro vient de la fiche gardée', async () => {
    const t = await setup();
    const a = await t.visit();
    const person = (await t.db.first<{ person_id: string }>('SELECT person_id FROM appointments WHERE id = ?', [a.id]))!.person_id;
    await t.db.run("DELETE FROM person_identifiers WHERE person_id = ?", [person]).catch(() => undefined);
    const kept = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Inès', lastName: 'Durandal-Roy' });
    await t.store.addIdentifier({ networkId: t.network.id, personId: kept.id, kind: 'phone', value: '07 98 76 54 32' });
    await t.store.addIdentifier({ networkId: t.network.id, personId: kept.id, kind: 'email', value: 'ines@example.test' });
    const at = new Date(MONDAY_9H).toISOString();
    await t.db.run('INSERT INTO person_merges (id, network_id, agent_id, survivor_id, merged_id, reason, merged_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', ['merge-test-1', t.network.id, t.alex.id, kept.id, person, 'doublon', at, at]);
    t.setClock(MONDAY_9H + 23 * HOUR);
    const r = await t.server.privatePack(t.agentAlex);
    expect(r.ok && r.pack.visits[0]?.contact).toEqual({ name: 'Inès Durandal', phone: '+33798765432' });
    expect(JSON.stringify(r)).not.toContain('example.test');
  });

  it('[R676] [R16] [R13] seul l’agent en activité l’obtient ; la lecture est au journal, sans nom, adresse ni numéro', async () => {
    const t = await setup();
    await designate(t, t.property.id, '12 rue des Vignes');
    const a = await t.visit();
    t.setClock(MONDAY_9H + 23 * HOUR);
    expect(await t.server.privatePack(t.direction)).toMatchObject({ ok: false, rule: 'R16' });
    await t.server.privatePack(t.agentAlex);
    const rows = await t.db.all<{ type: string; data: string }>("SELECT type, data FROM journal WHERE type IN ('hors_ligne.prive', 'acces.refuse')");
    expect(rows.map((r) => r.type)).toEqual(['acces.refuse', 'hors_ligne.prive']);
    expect(JSON.parse(rows[1]!.data)).toEqual({ rule: 'R676', day: '2026-12-08', appointments: [a.id], addresses: 1, phones: 1 });
    expect(JSON.stringify(rows)).not.toMatch(/Durandal|Vignes|06 12|\+336/);
  });
});

describe('AU103 · l’image entière de la photo HDR, contrôlée', () => {
  const fused = fuseExposures([dark, bright]);
  it('[R677] l’image gardée est jugée sur elle-même : trop petite, sombre, brûlée, floue ou étrangère aux prises, elle est refusée', () => {
    expect(checkKeptImage(wholeImage([dark, bright]).meta, [dark, bright])).toMatchObject({ ok: true, image: { width: 1280, height: 1280 } });
    expect(checkKeptImage(undefined, [dark, bright])).toEqual({ ok: false, rule: 'R677', code: 'image_manquante' });
    expect(checkKeptImage(wholeImage([dark, bright], { width: 1000, height: 1000 }).meta, [dark, bright])).toMatchObject({ code: 'image_trop_petite' });
    expect(IMAGE_MIN_LONG_SIDE).toBe(1280);
    // De bonnes prises, mais l'image gardée (le JPEG relu) est sombre, brûlée ou floue : refusée quand même.
    expect(checkKeptImage(wholeImage([dark, bright], { kept: dark }).meta, [dark, bright])).toMatchObject({ code: 'trop_sombre' });
    expect(checkKeptImage(wholeImage([dark, bright], { kept: scene((v) => v * 4) }).meta, [dark, bright])).toMatchObject({ code: 'brulee' });
    expect(checkKeptImage(wholeImage([dark, bright], { kept: blur(fused) }).meta, [dark, bright])).toMatchObject({ code: 'floue' });
    // Une belle image, mais pas le résultat de ces prises.
    const other = scene((v) => 255 - v);
    expect(judgePhoto(other).ok).toBe(true);
    expect(checkKeptImage(wholeImage([dark, bright], { kept: other }).meta, [dark, bright])).toMatchObject({ code: 'image_differente' });
    // Une annonce mal formée ou d'autres proportions que sa version réduite.
    const meta = wholeImage([dark, bright]).meta;
    for (const bad of [{ ...meta, sha256: 'abc' }, { ...meta, width: 4096 }, { ...meta, bytes: 0 }, { ...meta, kept: { width: 64, height: 64, data: 'abc' } }, { ...meta, width: 1920, height: 1080 }])
      expect(checkKeptImage(bad, [dark, bright])).toMatchObject({ ok: false, code: 'image_invalide' });
  });

  it('[R677] la taille d’un JPEG se lit dans son en-tête ; un fichier coupé ou qui n’est pas un JPEG n’a pas de taille', async () => {
    const jpg = fakeJpeg(1600, 1200);
    expect(jpegSize(jpg)).toEqual({ width: 1600, height: 1200 });
    expect(jpegSize(jpg.slice(0, jpg.length - 1))).toBeNull();
    expect(jpegSize(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0xff, 0xd9]))).toBeNull();
    expect(jpegSize(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0, 2, 0xff, 0xd9]))).toBeNull();
    // Un en-tête de trame seul, coupé, entre début et fin : pas un JPEG.
    expect(jpegSize(new Uint8Array([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x05, 0x00, 0x05, 0x00, 0xff, 0xd9]))).toBeNull();
    // Sans table de quantification, ou un 0xFF non bourré dans les données : pas un JPEG.
    const noDqt = jpg.slice(0, 2).toString() + ',' + [...jpg.slice(71)].join(',');
    expect(jpegSize(new Uint8Array(noDqt.split(',').map(Number)))).toBeNull();
    expect(jpegSize(fakeJpeg(1600, 1200).map((b, i, a) => (i === a.length - 4 ? 0xff : b)))).toBeNull();
    expect(jpegSize(fakeJpeg(1600, 1200, new Uint8Array([0xff, 0xff, 7])))).toEqual({ width: 1600, height: 1200 });
    const { bytes, meta } = wholeImage([dark, bright]);
    expect(await matchesKept(bytes, meta)).toBe(true);
    const touched = bytes.slice();
    touched[touched.length - 3] = 9;
    expect(await matchesKept(touched, meta)).toBe(false);
    expect(await matchesKept(fakeJpeg(1280, 1000), meta)).toBe(false);
  });
});

describeWithSqlite('AU103 · l’image entière de la photo, côté serveur', () => {
  const memory = () => {
    const put: { key: string; bytes: Uint8Array; type: string }[] = [];
    const store: VisitImageStore = { put: async (key, bytes, type) => void put.push({ key, bytes: bytes.slice(), type }) };
    return { put, store };
  };
  async function photoSent() {
    const t = await setup();
    const v = await t.visit(t.alex, t.land.id);
    t.setClock(v.start + 10 * MIN);
    const at = new Date(v.start).toISOString();
    const whole = wholeImage([dark, bright]);
    const r = await t.server.receive(t.agentAlex, {
      deviceId: 'device-test-1',
      ops: [{ opId: 'op-photo-01', seq: 1, kind: 'visite.photo', appointmentId: v.id, writtenAt: at, payload: { shot: 'vue-ensemble', exposures: [dark, bright].map(encodeLuma), image: whole.meta } }],
    });
    return { t, v, at, whole, r };
  }

  it('[R677] constat : une photo faite des seules prises réduites, sans image entière, n’est plus reçue', async () => {
    const t = await setup();
    const v = await t.visit(t.alex, t.land.id);
    t.setClock(v.start + 10 * MIN);
    const r = await t.server.receive(t.agentAlex, {
      deviceId: 'device-test-1',
      ops: [{ opId: 'op-photo-01', seq: 1, kind: 'visite.photo', appointmentId: v.id, writtenAt: new Date(v.start).toISOString(), payload: { shot: 'vue-ensemble', exposures: [dark, bright].map(encodeLuma) } }],
    });
    expect(r).toMatchObject({ ok: true, results: [{ outcome: 'refuse', code: 'image_manquante', rule: 'R677' }] });
    expect(await t.db.first('SELECT count(*) AS n FROM visit_photos')).toEqual({ n: 0 });
  });

  it('[R677] la photo reçue garde l’empreinte, la taille et le contrôle de l’image gardée ; le fichier annoncé est rangé une fois', async () => {
    const { t, v, whole, r } = await photoSent();
    expect(r).toMatchObject({ ok: true, results: [{ outcome: 'applique' }] });
    const row = await t.db.first<Record<string, unknown>>('SELECT image_sha256, image_width, image_height, image_bytes, kept_brightness, kept_sharpness FROM visit_photos');
    expect(row).toMatchObject({ image_sha256: whole.meta.sha256, image_width: 1280, image_height: 1280, image_bytes: whole.bytes.length });
    expect(row!.kept_brightness).toBe(judgePhoto(fuseExposures([dark, bright])).figures.brightness);
    const m = memory();
    // Sans rangement possible : rien n'est écrit, le téléphone garde le fichier.
    expect(await t.server.depositImage(t.agentAlex, 'device-test-1', 'op-photo-01', whole.bytes, null)).toEqual({ ok: false, rule: null, code: 'depot_indisponible' });
    // Un fichier abîmé en route : refusé, au journal, rien de rangé.
    const touched = whole.bytes.slice();
    touched[30] = 77;
    expect(await t.server.depositImage(t.agentAlex, 'device-test-1', 'op-photo-01', touched, m.store)).toEqual({ ok: false, rule: 'R677', code: 'image_differente' });
    expect(m.put).toEqual([]);
    expect(await t.db.first('SELECT count(*) AS n FROM visit_photo_files')).toEqual({ n: 0 });
    // Le bon fichier : rangé hors des médias publiés, sous le rendez-vous.
    expect(await t.server.depositImage(t.agentAlex, 'device-test-1', 'op-photo-01', whole.bytes, m.store)).toEqual({ ok: true, again: false });
    expect(m.put).toHaveLength(1);
    expect(m.put[0]!.key).toMatch(new RegExp(`^visites/${t.network.id}/${v.id}/[0-9a-f]{64}\\.jpg$`));
    expect(m.put[0]!.type).toBe('image/jpeg');
    expect(m.put[0]!.bytes).toEqual(whole.bytes);
    // Rejoué : la même réponse, rien de rangé deux fois.
    expect(await t.server.depositImage(t.agentAlex, 'device-test-1', 'op-photo-01', whole.bytes, m.store)).toEqual({ ok: true, again: true });
    expect(m.put).toHaveLength(1);
    expect(await t.db.first('SELECT media_key, sha256, bytes FROM visit_photo_files')).toEqual({ media_key: m.put[0]!.key, sha256: whole.meta.sha256, bytes: whole.bytes.length });
    // Rien ne change ni ne s'efface.
    await expect(t.db.run('DELETE FROM visit_photo_files')).rejects.toThrow(/rien ne s'efface/);
    const events = await t.db.all<{ type: string; data: string }>("SELECT type, data FROM journal WHERE type LIKE 'hors_ligne.image%' ORDER BY rowid");
    expect(events.map((e) => e.type)).toEqual(['hors_ligne.image_refusee', 'hors_ligne.image_rangee']);
    expect(JSON.stringify(events)).not.toContain(whole.meta.sha256);
  });

  it('[R677] [R16] le fichier ne se range que pour la photo reçue de cet agent et de cet appareil ; la direction ne dépose rien', async () => {
    const { t, whole } = await photoSent();
    const m = memory();
    expect(await t.server.depositImage(t.agentSam, 'device-test-1', 'op-photo-01', whole.bytes, m.store)).toMatchObject({ ok: false, code: 'photo_inconnue' });
    expect(await t.server.depositImage(t.agentAlex, 'device-test-2', 'op-photo-01', whole.bytes, m.store)).toMatchObject({ ok: false, code: 'photo_inconnue' });
    expect(await t.server.depositImage(t.agentAlex, 'device-test-1', 'op-photo-99', whole.bytes, m.store)).toMatchObject({ ok: false, code: 'photo_inconnue' });
    expect(await t.server.depositImage(t.agentAlex, 'court', 'op-photo-01', whole.bytes, m.store)).toMatchObject({ ok: false, code: 'bad_photo' });
    expect(await t.server.depositImage(t.direction, 'device-test-1', 'op-photo-01', whole.bytes, m.store)).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(m.put).toEqual([]);
  });

  it('[R677] une panne du rangement n’écrit rien : le même fichier renvoyé ensuite est rangé', async () => {
    const { t, whole } = await photoSent();
    const broken: VisitImageStore = { put: async () => { throw new Error('panne'); } };
    await expect(t.server.depositImage(t.agentAlex, 'device-test-1', 'op-photo-01', whole.bytes, broken)).rejects.toThrow('panne');
    expect(await t.db.first('SELECT count(*) AS n FROM visit_photo_files')).toEqual({ n: 0 });
    const m = memory();
    expect(await t.server.depositImage(t.agentAlex, 'device-test-1', 'op-photo-01', whole.bytes, m.store)).toEqual({ ok: true, again: false });
  });
});
