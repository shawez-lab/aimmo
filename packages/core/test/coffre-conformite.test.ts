import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { Acces, ControlesSignature, FicheClient, FicheUnique, Modeles, SqlJournalStore, applyMigrations, conformite, fromSyncSqlite, verifyChain, type SqlDatabase, type Viewer } from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';
import { designerTout } from './designation-jeu.ts';

// Personnes et pièces inventées pour les tests : le contenu d'une pièce est quelques octets sans signification.
const NOW = new Date('2027-03-10T10:00:00.000Z');
const PDF = new TextEncoder().encode('%PDF-test piece inventee');

class FakeVault implements conformite.VaultStorage {
  readonly blobs = new Map<string, Uint8Array>();
  private n = 0;
  async put(networkId: string, content: Uint8Array): Promise<string> {
    const ref = `coffre/${networkId}/${++this.n}`;
    this.blobs.set(ref, content);
    return ref;
  }
}

async function setup() {
  const db: SqlDatabase = fromSyncSqlite(openMemoryDatabase());
  await applyMigrations(db, loadMigrations());
  let clock = NOW;
  const now = () => clock;
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const vault = new FakeVault();
  const coffre = new conformite.CoffreConformite(db, acces, vault, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const other = await store.createNetwork('Autre réseau');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: string, userId: string, networkId = network.id): Viewer => ({ role, userId, networkId }) as Viewer;
  const person = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: 'Léa', lastName: 'Exemple' });
  return {
    db, journal, store, fiche, acces, vault, coffre, network, other, person,
    agent: as('agent', alex.id), sam: as('agent', sam.id), direction: as('direction', 'direction-1'),
    conformite: as('compliance', 'conformite-1'), partner: as('partner', 'partenaire-1'), foreign: as('compliance', 'conformite-2', other.id),
    setClock: (d: Date) => { clock = d; },
    now,
  };
}

const deposit = (overrides: Record<string, unknown> = {}) => ({ kind: 'carte_identite', content: PDF, contentType: 'application/pdf', verifiedOn: '2027-03-09', validUntil: '2031-01-01', ...overrides });

describeWithSqlite('L01 · coffre de la conformité', () => {
  it('[R90] l’agent dépose une pièce et reçoit une preuve de dépôt, sans la pièce ni sa référence', async () => {
    const t = await setup();
    const r = await t.coffre.deposit(t.agent, t.person.id, deposit());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.receipt).toEqual({ pieceId: expect.any(String), kind: 'carte_identite', label: 'Carte d’identité', sha256: expect.stringMatching(/^[0-9a-f]{64}$/), depositedAt: NOW.toISOString() });
    expect(Object.keys(r.receipt)).not.toContain('storageRef');
    // La pièce est au stockage du coffre, la base n'en garde que la référence et l'empreinte.
    expect([...t.vault.blobs.values()]).toEqual([PDF]);
    const row = await t.db.first<Record<string, unknown>>('SELECT * FROM compliance_vault_pieces');
    expect(Object.values(row!).some((v) => v instanceof Uint8Array)).toBe(false);
    // La preuve reste lisible de l'agent, sans référence.
    const proofs = await t.coffre.receipts(t.agent, t.person.id);
    expect(proofs).toEqual({ ok: true, value: [r.receipt] });
  });

  it('[R90] l’agent ne relit jamais une pièce, même la sienne ; seul le responsable liste et ouvre', async () => {
    const t = await setup();
    const r = await t.coffre.deposit(t.agent, t.person.id, deposit());
    if (!r.ok) throw new Error(r.code);
    for (const viewer of [t.agent, t.sam, t.direction, t.partner]) {
      expect(await t.coffre.list(viewer, t.person.id)).toEqual({ ok: false, rule: 'R90', code: 'role' });
      expect(await t.coffre.open(viewer, r.receipt.pieceId)).toEqual({ ok: false, rule: 'R90', code: 'role' });
    }
    expect(await t.coffre.open(t.foreign, r.receipt.pieceId)).toEqual({ ok: false, rule: 'R90', code: 'unknown' });
    const list = await t.coffre.list(t.conformite, t.person.id);
    expect(list).toMatchObject({ ok: true, value: [{ pieceId: r.receipt.pieceId, kind: 'carte_identite', verifiedOn: '2027-03-09', validUntil: '2031-01-01', depositedBy: `agent:${t.agent.userId}`, replacedBy: null }] });
    const opened = await t.coffre.open(t.conformite, r.receipt.pieceId);
    expect(opened.ok && t.vault.blobs.get(opened.storageRef)).toEqual(PDF);
  });

  it('[R90] [R16] la direction, un partenaire ou un autre agent ne déposent rien ; chaque lecture et chaque refus vont au journal', async () => {
    const t = await setup();
    expect(await t.coffre.deposit(t.direction, t.person.id, deposit())).toEqual({ ok: false, rule: 'R90', code: 'role' });
    expect(await t.coffre.deposit(t.partner, t.person.id, deposit())).toEqual({ ok: false, rule: 'R90', code: 'role' });
    expect(await t.coffre.deposit(t.sam, t.person.id, deposit())).toMatchObject({ ok: false, rule: 'R16' });
    expect(t.vault.blobs.size).toBe(0);
    const r = await t.coffre.deposit(t.agent, t.person.id, deposit());
    if (!r.ok) throw new Error(r.code);
    await t.coffre.list(t.conformite, t.person.id);
    await t.coffre.open(t.conformite, r.receipt.pieceId);
    await t.coffre.open(t.agent, r.receipt.pieceId);
    const types = (await t.journal.all()).map((e) => e.type);
    expect(types).toEqual(expect.arrayContaining(['coffre.depose', 'coffre.lu', 'coffre.ouvert', 'acces.refuse']));
    expect((await t.journal.all()).filter((e) => e.type === 'acces.refuse' && (e.data as { kind?: string }).kind === 'compliance_vault')).toHaveLength(3);
    expect(await verifyChain(await t.journal.all())).toEqual({ ok: true });
  });

  // RC44 : le stockage relu par le coffre ; `swap` change ce qu'il rend, `fail` le met en panne, `reads` compte ses lectures.
  const readerOf = (t: Awaited<ReturnType<typeof setup>>, opts: { swap?: (b: Uint8Array) => Uint8Array | null; fail?: boolean } = {}) => {
    const reads: string[] = [];
    const reader: conformite.VaultReader = {
      read: async (ref) => {
        reads.push(ref);
        if (opts.fail) throw new Error('stockage en panne');
        const b = t.vault.blobs.get(ref) ?? null;
        return b && opts.swap ? opts.swap(b) : b;
      },
    };
    return { reader, reads };
  };

  it('[R90] la pièce lue au stockage n’est remise que si son empreinte et sa taille sont celles du dépôt', async () => {
    const t = await setup();
    const r = await t.coffre.deposit(t.agent, t.person.id, deposit());
    if (!r.ok) throw new Error(r.code);
    const { reader } = readerOf(t);
    const got = await t.coffre.read(t.conformite, r.receipt.pieceId, reader);
    expect(got).toEqual({ ok: true, content: PDF, contentType: 'application/pdf', sha256: r.receipt.sha256 });
    // Ce qui est rendu est une copie : le stockage qui change ses octets après coup ne change pas la pièce remise.
    if (!got.ok) return;
    [...t.vault.blobs.values()][0]![0] = 0;
    expect(got.content).toEqual(new TextEncoder().encode('%PDF-test piece inventee'));
    const types = (await t.journal.all()).map((e) => e.type);
    expect(types.filter((x) => x === 'coffre.ouvert')).toHaveLength(1);
  });

  it('[R90] un octet changé, en plus ou en moins : la pièce est dite altérée, rien n’est remis ni écrit ouvert', async () => {
    const t = await setup();
    const r = await t.coffre.deposit(t.agent, t.person.id, deposit());
    if (!r.ok) throw new Error(r.code);
    const changes: ((b: Uint8Array) => Uint8Array)[] = [
      (b) => { const c = b.slice(); c[3] = c[3]! ^ 1; return c; },
      (b) => { const c = new Uint8Array(b.byteLength + 1); c.set(b); return c; },
      (b) => b.slice(0, b.byteLength - 1),
      () => new Uint8Array(0),
    ];
    for (const swap of changes) {
      expect(await t.coffre.read(t.conformite, r.receipt.pieceId, readerOf(t, { swap }).reader)).toEqual({ ok: false, rule: 'R90', code: 'altered' });
    }
    const events = await t.journal.all();
    expect(events.filter((e) => e.type === 'coffre.altere')).toHaveLength(4);
    expect(events.some((e) => e.type === 'coffre.ouvert')).toBe(false);
    // Au journal, la pièce seule : ni empreinte, ni référence de stockage, ni contenu [R13].
    const text = JSON.stringify(events);
    expect(text).not.toContain(r.receipt.sha256);
    expect(text).not.toContain('coffre/');
    expect(text).not.toContain('PDF-test');
    expect(await verifyChain(events)).toEqual({ ok: true });
  });

  it('[R90] une pièce absente du stockage ou un stockage en panne : refus « absente », rien remis', async () => {
    const t = await setup();
    const r = await t.coffre.deposit(t.agent, t.person.id, deposit());
    if (!r.ok) throw new Error(r.code);
    expect(await t.coffre.read(t.conformite, r.receipt.pieceId, readerOf(t, { swap: () => null }).reader)).toEqual({ ok: false, rule: 'R90', code: 'missing' });
    expect(await t.coffre.read(t.conformite, r.receipt.pieceId, readerOf(t, { fail: true }).reader)).toEqual({ ok: false, rule: 'R90', code: 'missing' });
    const odd: conformite.VaultReader = { read: async () => 'pas des octets' as unknown as Uint8Array };
    expect(await t.coffre.read(t.conformite, r.receipt.pieceId, odd)).toEqual({ ok: false, rule: 'R90', code: 'missing' });
    const events = await t.journal.all();
    expect(events.filter((e) => e.type === 'coffre.absente')).toHaveLength(3);
    expect(events.some((e) => e.type === 'coffre.ouvert')).toBe(false);
  });

  it('[R90] [R16] un autre rôle, un autre réseau ou une pièce inconnue : mêmes refus que l’ouverture, le stockage jamais lu', async () => {
    const t = await setup();
    const r = await t.coffre.deposit(t.agent, t.person.id, deposit());
    if (!r.ok) throw new Error(r.code);
    const { reader, reads } = readerOf(t);
    for (const viewer of [t.agent, t.sam, t.direction, t.partner]) {
      expect(await t.coffre.read(viewer, r.receipt.pieceId, reader)).toEqual({ ok: false, rule: 'R90', code: 'role' });
    }
    expect(await t.coffre.read(t.foreign, r.receipt.pieceId, reader)).toEqual({ ok: false, rule: 'R90', code: 'unknown' });
    expect(await t.coffre.read(t.conformite, 'piece-inconnue', reader)).toEqual({ ok: false, rule: 'R90', code: 'unknown' });
    expect(reads).toEqual([]);
    expect((await t.journal.all()).filter((e) => e.type === 'acces.refuse' && (e.data as { kind?: string }).kind === 'compliance_vault')).toHaveLength(6);
  });

  it('[R13] le journal du coffre ne porte ni nom, ni empreinte, ni référence de stockage', async () => {
    const t = await setup();
    const r = await t.coffre.deposit(t.agent, t.person.id, deposit());
    if (!r.ok) throw new Error(r.code);
    await t.coffre.open(t.conformite, r.receipt.pieceId);
    const text = JSON.stringify(await t.journal.all());
    expect(text).not.toContain('Léa');
    expect(text).not.toContain('Exemple');
    expect(text).not.toContain(r.receipt.sha256);
    expect(text).not.toContain('coffre/');
  });

  it('[R15] la fiche client n’en voit rien ; seul le code de la conformité lit le coffre', async () => {
    const t = await setup();
    const r = await t.coffre.deposit(t.agent, t.person.id, deposit());
    if (!r.ok) throw new Error(r.code);
    const fiche = await t.acces.readFiche(t.agent, t.person.id);
    const text = JSON.stringify(fiche);
    expect(text).not.toContain(r.receipt.sha256);
    expect(text).not.toContain('coffre/');
    expect(text).not.toContain(r.receipt.pieceId);
    // Aucun autre module, et donc aucun appel à l'IA, ne lit la table du coffre.
    const root = fileURLToPath(new URL('../../', import.meta.url));
    const readers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (name === 'node_modules' || name === 'test') continue;
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|mjs|js)$/.test(name) && readFileSync(path, 'utf8').includes('compliance_vault_pieces')) readers.push(path.slice(root.length));
      }
    };
    walk(root);
    // Le registre des traitements (L06) nomme la table sans la lire ; le dossier figé du signalement (L05) et du gel des
    // avoirs (HX57) n'en garde que l'empreinte de chaque ligne, et ne la montre qu'au responsable.
    // Le dossier de la lutte contre le blanchiment de l'agence sous licence (HX76) remet la table entière au seul
    // responsable de la conformité de l'agence, et dit chaque pièce par sa référence et son empreinte [R662, R664].
    expect(readers.sort()).toEqual(['core/src/conformite/coffre.ts', 'core/src/conformite/dossier-fige.ts', 'core/src/conformite/dossier-lcb-agence.ts', 'core/src/conformite/registre-traitements.ts']);
  });

  it('[R90] les autres modules ne voient qu’un état : la date de l’identité vérifiée et valide ce jour-là', async () => {
    const t = await setup();
    expect(await t.coffre.state(t.network.id, t.person.id, '2027-03-10')).toEqual({ identityVerifiedOn: null });
    // Un document anti-blanchiment n'est pas une identité.
    await t.coffre.deposit(t.agent, t.person.id, deposit({ kind: 'origine_fonds', validUntil: null }));
    expect(await t.coffre.state(t.network.id, t.person.id, '2027-03-10')).toEqual({ identityVerifiedOn: null });
    await t.coffre.deposit(t.agent, t.person.id, deposit({ validUntil: '2027-06-30' }));
    expect(await t.coffre.state(t.network.id, t.person.id, '2027-03-10')).toEqual({ identityVerifiedOn: '2027-03-09' });
    expect(await t.coffre.state(t.network.id, t.person.id, '2027-07-01')).toEqual({ identityVerifiedOn: null });
    expect(await t.coffre.state(t.other.id, t.person.id, '2027-03-10')).toEqual({ identityVerifiedOn: null });
  });

  it('[R90] une pièce d’identité déposée vaut identité vérifiée pour les contrôles avant signature (D03)', async () => {
    const t = await setup();
    const modeles = new Modeles(t.db, t.acces, t.journal, { now: t.now });
    const controles = new ControlesSignature(t.db, t.acces, t.journal, { now: t.now });
    const v = await modeles.createVersion(t.direction, 'mandat_vente_exclusif', 'Mandat de test : {{mandant.nom}}, {{bien.reference}}, {{bien.prix}}, honoraires {{honoraires.montant}} {{honoraires.charge}}, {{mandat.duree_mois}}.\n\n!! Clause de test mise en évidence.\n\nNuméro : {{registre.numero}} · {{bien.adresse}} · {{bien.cadastre}} · {{mandant.domicile}}.');
    if (!v.ok) throw new Error(v.code);
    await modeles.validate(t.conformite, v.template.id);
    await controles.setFeeSchedule(t.direction, { maxRatePercent: 5, minEur: 3000 });
    const b = await t.store.createProperty({ networkId: t.network.id, agentId: t.agent.userId, reference: 'REF-L01', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 60, rooms: 3, priceEur: 200000 });
    const project = await t.store.createProject({ networkId: t.network.id, agentId: t.agent.userId, personId: t.person.id, kind: 'sell' });
    await t.store.linkProjectProperty({ networkId: t.network.id, agentId: t.agent.userId, projectId: project.id, propertyId: b.id, role: 'owned' });
    await designerTout(t.db);
    const d = await modeles.generate(t.agent, { kind: 'mandat_vente_exclusif', personId: t.person.id, propertyId: b.id, inputs: { 'honoraires.montant': 10000, 'honoraires.charge': 'vendeur', 'mandat.duree_mois': 12 } as never });
    if (!d.ok) throw new Error(d.code);
    const identity = async () => {
      const c = await controles.check(t.agent, d.document.id);
      return c.ok ? c.value.lines.find((l) => l.check === 'identite')?.code : c.code;
    };
    expect(await identity()).toBe('identity_missing');
    // Vérifiée le jour même, déposée avant midi : elle vaut tout de suite.
    await t.coffre.deposit(t.agent, t.person.id, deposit({ kind: 'passeport', verifiedOn: '2027-03-10' }));
    expect(await identity()).toBe('identity_verified');
  });

  it('[R17] rien ne s’efface ni ne change ; une pièce remplacée reste, remplacée une seule fois', async () => {
    const t = await setup();
    const first = await t.coffre.deposit(t.agent, t.person.id, deposit());
    if (!first.ok) throw new Error(first.code);
    await expect(t.db.run('DELETE FROM compliance_vault_pieces')).rejects.toThrow();
    await expect(t.db.run("UPDATE compliance_vault_pieces SET kind = 'passeport'")).rejects.toThrow();
    t.setClock(new Date('2027-03-11T10:00:00.000Z'));
    const second = await t.coffre.deposit(t.agent, t.person.id, deposit({ kind: 'passeport', verifiedOn: '2027-03-11', replaces: first.receipt.pieceId }));
    expect(second.ok).toBe(true);
    expect(await t.coffre.deposit(t.agent, t.person.id, deposit({ replaces: first.receipt.pieceId }))).toEqual({ ok: false, rule: null, code: 'already_replaced' });
    const list = await t.coffre.list(t.conformite, t.person.id);
    expect(list.ok && list.value.map((l) => [l.kind, l.replacedBy !== null])).toEqual([['carte_identite', true], ['passeport', false]]);
    expect(await t.coffre.state(t.network.id, t.person.id, '2027-03-11')).toEqual({ identityVerifiedOn: '2027-03-11' });
  });

  it('[R90] une fiche réunie à une autre garde ses pièces : liste, état et remplacement lisent toutes les fiches réunies', async () => {
    const t = await setup();
    const b = await t.store.createPerson({ networkId: t.network.id, agentId: t.agent.userId, firstName: 'Léa', lastName: 'Exemple' });
    const first = await t.coffre.deposit(t.agent, b.id, deposit());
    if (!first.ok) throw new Error(first.code);
    await t.fiche.merge({ survivorId: t.person.id, mergedId: b.id, reason: 'test : même personne' });
    const list = await t.coffre.list(t.conformite, t.person.id);
    expect(list.ok && list.value.map((l) => l.pieceId)).toEqual([first.receipt.pieceId]);
    expect(await t.coffre.state(t.network.id, t.person.id, '2027-03-10')).toEqual({ identityVerifiedOn: '2027-03-09' });
    expect(await t.coffre.state(t.network.id, b.id, '2027-03-10')).toEqual({ identityVerifiedOn: '2027-03-09' });
    const proofs = await t.coffre.receipts(t.agent, t.person.id);
    expect(proofs.ok && proofs.value.map((p) => p.pieceId)).toEqual([first.receipt.pieceId]);
    expect(await t.coffre.deposit(t.agent, t.person.id, deposit({ kind: 'passeport', replaces: first.receipt.pieceId }))).toMatchObject({ ok: true });
  });

  it('refuse une pièce inconnue, vide, trop lourde, d’un autre format, ou à une date future', async () => {
    const t = await setup();
    const code = async (o: Record<string, unknown>) => {
      const r = await t.coffre.deposit(t.agent, t.person.id, deposit(o));
      return r.ok ? 'ok' : r.code;
    };
    expect(await code({ kind: 'rib' })).toBe('unknown_piece');
    expect(await code({ content: new Uint8Array() })).toBe('empty_content');
    expect(await code({ content: 'texte' })).toBe('empty_content');
    expect(await code({ content: new Uint8Array(conformite.VAULT_MAX_BYTES + 1) })).toBe('too_large');
    expect(await code({ contentType: 'text/html' })).toBe('bad_content_type');
    expect(await code({ verifiedOn: '2027-03-11' })).toBe('bad_date');
    expect(await code({ verifiedOn: '2027-02-30' })).toBe('bad_date');
    expect(await code({ validUntil: '2027-01-01' })).toBe('bad_date');
    expect(await code({ caseRef: 'Léa Exemple' })).toBe('bad_case');
    expect(await code({ replaces: 'inconnue' })).toBe('unknown_replaced');
    expect(t.vault.blobs.size).toBe(0);
  });
});
