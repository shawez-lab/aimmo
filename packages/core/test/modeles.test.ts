import { expect, it } from 'vitest';
import { Acces, FicheClient, FicheUnique, Modeles, SqlJournalStore, applyMigrations, canSignForReal, fromSyncSqlite, renderDocument, type SqlDatabase, type Viewer } from '../src/index.ts';
import { loadMigrations } from './migrations.ts';
import { describeWithSqlite, openMemoryDatabase } from './sqlite.ts';
import { designerTout } from './designation-jeu.ts';

// Modèle d'essai inventé pour les tests : ce n'est pas un modèle juridique.
const BODY = [
  'MANDAT DE VENTE EXCLUSIF (MODÈLE DE TEST)',
  'Entre {{mandant.nom}}, mandant, et {{reseau.nom}}, représenté par {{agent.nom}}.',
  'Bien : {{bien.type}} référence {{bien.reference}}, {{bien.commune}}, {{bien.surface}}, {{bien.pieces}} pièces, au prix de {{bien.prix}}.',
  'Honoraires : {{honoraires.montant}}, {{honoraires.charge}}. Durée : {{mandat.duree_mois}}.',
  '!! Clause d’exclusivité de test : le mandant confie la vente au seul agent désigné ci-dessus.',
  'Numéro au registre : {{registre.numero}} · {{bien.adresse}} · {{bien.cadastre}} · {{mandant.domicile}}. Fait le {{document.date}}.',
].join('\n\n');
const NOW = new Date('2027-02-10T10:00:00.000Z');

async function setup() {
  const raw = openMemoryDatabase();
  const db: SqlDatabase = fromSyncSqlite(raw);
  await applyMigrations(db, loadMigrations());
  const now = () => NOW;
  const journal = new SqlJournalStore(db);
  const store = new FicheClient(db, { now });
  const fiche = new FicheUnique(db, store, { now });
  const acces = new Acces(db, store, fiche, journal, { now });
  const modeles = new Modeles(db, acces, journal, { now });
  const network = await store.createNetwork('Réseau test');
  const alex = await store.createAgent({ networkId: network.id, firstName: 'Alex', lastName: 'Agent' });
  const sam = await store.createAgent({ networkId: network.id, firstName: 'Sam', lastName: 'Agent' });
  const as = (role: string, userId: string): Viewer => ({ role, userId, networkId: network.id }) as Viewer;
  const direction = as('direction', 'direction-1');
  const conformite = as('compliance', 'conformite-1');
  const client = async (n: number) => {
    const p = await store.createPerson({ networkId: network.id, agentId: alex.id, firstName: `Prénom${n}`, lastName: `Nom${n}` });
    const b = await store.createProperty({ networkId: network.id, agentId: alex.id, reference: `REF-T-${n}`, kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 50 + n, rooms: 2 + n, priceEur: 150000 + n * 1000 });
    return { personId: p.id, propertyId: b.id };
  };
  return { raw, db, journal, modeles, network, alex, sam, as, direction, conformite, client, store };
}

const INPUTS = { 'honoraires.montant': 9000, 'honoraires.charge': 'vendeur', 'mandat.duree_mois': 12 } as const;
const fr = (n: number) => new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 2 }).format(n);

describeWithSqlite('D02 · bibliothèque de modèles et documents générés', () => {
  it('[R40] 5 mandats tests générés identiques à leur modèle, au caractère près, champs remplis depuis la base', async () => {
    const t = await setup();
    const v = await t.modeles.createVersion(t.direction, 'mandat_vente_exclusif', BODY);
    if (!v.ok) throw new Error(v.code);
    expect(v.template).toMatchObject({ version: 1, status: 'essai', fields: ['mandant.nom', 'reseau.nom', 'agent.nom', 'bien.type', 'bien.reference', 'bien.commune', 'bien.surface', 'bien.pieces', 'bien.prix', 'honoraires.montant', 'honoraires.charge', 'mandat.duree_mois', 'registre.numero', 'bien.adresse', 'bien.cadastre', 'mandant.domicile', 'document.date'] });
    expect(await t.modeles.validate(t.conformite, v.template.id)).toMatchObject({ ok: true, template: { status: 'valide', validatedBy: 'compliance:conformite-1' } });
    for (let n = 1; n <= 5; n++) {
      const c = await t.client(n);
      await designerTout(t.db);
      const r = await t.modeles.generate(t.as('agent', t.alex.id), { kind: 'mandat_vente_exclusif', ...c, inputs: INPUTS });
      if (!r.ok) throw new Error(r.code);
      expect(r.document).toMatchObject({ mode: 'reel', status: 'complet', missing: [], templateVersion: 1 });
      expect(canSignForReal(r.document)).toBe(true);
      const expected = BODY.replace('{{mandant.nom}}', `Prénom${n} Nom${n}`)
        .replace('{{reseau.nom}}', 'Réseau test')
        .replace('{{agent.nom}}', 'Alex Agent')
        .replace('{{bien.type}}', 'logement')
        .replace('{{bien.reference}}', `REF-T-${n}`)
        .replace('{{bien.commune}}', '21000 Dijon')
        .replace('{{bien.surface}}', `${50 + n} m²`)
        .replace('{{bien.pieces}}', String(2 + n))
        .replace('{{bien.prix}}', `${fr(150000 + n * 1000)} €`)
        .replace('{{honoraires.montant}}', `${fr(9000)} €`)
        .replace('{{honoraires.charge}}', 'à la charge du vendeur')
        .replace('{{mandat.duree_mois}}', '12 mois')
        .replace('{{registre.numero}}', '[numéro au registre à la signature]')
        .replace('{{bien.adresse}}', '1 rue de l’Essai, 21000 Dijon')
        .replace('{{bien.cadastre}}', 'section AB n° 1')
        .replace('{{mandant.domicile}}', '2 avenue du Test, 21000 Dijon')
        .replace('{{document.date}}', '10/02/2027');
      const html = expected
        .split('\n\n')
        .map((p) => (p.startsWith('!! ') ? `<p class="evidence">${p.slice(3)}</p>` : `<p>${p}</p>`))
        .join('\n')
        .replace('[numéro au registre à la signature]', '<span class="a-signer">[numéro au registre à la signature]</span>')
        .replace(/’/g, '’');
      expect(r.document.content).toContain(`\n${html}\n</main>\n</body>`);
      expect(r.document.content).toContain('<p class="evidence">Clause d’exclusivité de test');
    }
  });

  it('[R40] un champ absent rend le document incomplet et se voit, jamais un texte inventé ; une saisie mal formée est refusée', async () => {
    const t = await setup();
    await t.modeles.createVersion(t.direction, 'mandat_vente_exclusif', BODY);
    const p = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: 'Léa', lastName: null as never });
    const b = await t.store.createProperty({ networkId: t.network.id, agentId: t.alex.id, reference: 'REF-T-9', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: null as never, rooms: null as never, priceEur: null as never });
    await designerTout(t.db);
    const r = await t.modeles.generate(t.as('agent', t.alex.id), { kind: 'mandat_vente_exclusif', personId: p.id, propertyId: b.id, inputs: { 'honoraires.montant': 9000 } });
    if (!r.ok) throw new Error(r.code);
    expect(r.document.status).toBe('incomplet');
    expect(r.document.missing).toEqual(['mandant.nom', 'bien.surface', 'bien.pieces', 'bien.prix', 'honoraires.charge', 'mandat.duree_mois']);
    expect(r.document.content).toContain('[à compléter : nom du mandant]');
    expect(r.document.content).toContain('<span class="manque">[à compléter : surface du bien]</span>');
    expect(canSignForReal(r.document)).toBe(false);
    for (const inputs of [{ 'honoraires.montant': -1 }, { 'honoraires.montant': 9000.5 }, { 'honoraires.charge': 'notaire' }, { 'mandat.duree_mois': 0 }, { autre: 1 }]) {
      expect(await t.modeles.generate(t.as('agent', t.alex.id), { kind: 'mandat_vente_exclusif', personId: p.id, propertyId: b.id, inputs: inputs as never })).toEqual({ ok: false, rule: null, code: 'bad_input' });
    }
  });

  it('[R40] un modèle d’essai ne produit qu’un document d’essai, marqué, refusé à la signature réelle', async () => {
    const t = await setup();
    await t.modeles.createVersion(t.direction, 'mandat_vente_exclusif', BODY);
    const c = await t.client(1);
    await designerTout(t.db);
    const r = await t.modeles.generate(t.as('agent', t.alex.id), { kind: 'mandat_vente_exclusif', ...c, inputs: INPUTS });
    if (!r.ok) throw new Error(r.code);
    expect(r.document).toMatchObject({ mode: 'essai', status: 'complet' });
    expect(r.document.content).toContain('DOCUMENT D’ESSAI');
    expect(canSignForReal(r.document)).toBe(false);
  });

  it('[R40] changer un modèle crée une version ; le document garde la sienne ; ni modèle ni document ne se modifient ou ne s’effacent', async () => {
    const t = await setup();
    const v1 = await t.modeles.createVersion(t.direction, 'mandat_vente_exclusif', BODY);
    if (!v1.ok) throw new Error(v1.code);
    const c = await t.client(1);
    await designerTout(t.db);
    const d1 = await t.modeles.generate(t.as('agent', t.alex.id), { kind: 'mandat_vente_exclusif', ...c, inputs: INPUTS });
    const v2 = await t.modeles.createVersion(t.direction, 'mandat_vente_exclusif', BODY.replace('Durée', 'Durée du mandat'));
    expect(v2.ok && v2.template.version).toBe(2);
    expect(v2.ok && v2.template.hash).not.toBe(v1.template.hash);
    await designerTout(t.db);
    const d2 = await t.modeles.generate(t.as('agent', t.alex.id), { kind: 'mandat_vente_exclusif', ...c, inputs: INPUTS });
    expect(d1.ok && d2.ok && [d1.document.templateVersion, d2.document.templateVersion]).toEqual([1, 2]);
    const again = await t.modeles.read(t.as('agent', t.alex.id), d1.ok ? d1.document.id : '');
    expect(again.ok && again.document.templateHash).toBe(v1.template.hash);
    expect(again.ok && again.document.content).not.toContain('Durée du mandat');
    await expect(t.db.run('UPDATE document_templates SET body = ? WHERE id = ?', ['autre', v1.template.id])).rejects.toThrow(/modèle figé/);
    await expect(t.db.run('DELETE FROM document_templates WHERE id = ?', [v1.template.id])).rejects.toThrow(/modèle gardé/);
    await expect(t.db.run('UPDATE documents SET content = ? WHERE id = ?', ['x', d1.ok ? d1.document.id : ''])).rejects.toThrow(/document figé/);
    await expect(t.db.run('DELETE FROM documents')).rejects.toThrow(/document gardé/);
    // Un modèle validé ne repasse jamais à l'essai.
    await t.modeles.validate(t.conformite, v1.template.id);
    expect(await t.modeles.validate(t.conformite, v1.template.id)).toEqual({ ok: false, rule: null, code: 'not_essai' });
    await expect(t.db.run(`UPDATE document_templates SET status = 'essai', validated_by = NULL, validated_at = NULL WHERE id = ?`, [v1.template.id])).rejects.toThrow(/modèle figé/);
  });

  it('[R40] un champ hors du catalogue ou mal écrit refuse le modèle ; seule la direction crée, seule la conformité valide', async () => {
    const t = await setup();
    expect(await t.modeles.createVersion(t.direction, 'mandat_vente_exclusif', 'Prix : {{bien.prix_imaginaire}}')).toEqual({ ok: false, rule: 'R40', code: 'unknown_field' });
    expect(await t.modeles.createVersion(t.direction, 'mandat_vente_exclusif', 'Prix : {{ bien.prix }')).toEqual({ ok: false, rule: 'R40', code: 'unknown_field' });
    expect(await t.modeles.createVersion(t.direction, 'mandat_bail_inconnu' as never, 'x')).toEqual({ ok: false, rule: null, code: 'unknown_kind' });
    expect(await t.modeles.createVersion(t.as('agent', t.alex.id), 'mandat_vente_exclusif', BODY)).toMatchObject({ ok: false, rule: 'R16' });
    const v = await t.modeles.createVersion(t.direction, 'mandat_vente_exclusif', BODY);
    expect(await t.modeles.validate(t.direction, v.ok ? v.template.id : '')).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.modeles.validate(t.as('agent', t.alex.id), v.ok ? v.template.id : '')).toMatchObject({ ok: false, rule: 'R16' });
  });

  it('[R16, R13] la fiche et le bien d’un autre agent sont refusés ; le texte d’une fiche est échappé ; le journal ne porte aucun nom', async () => {
    const t = await setup();
    await t.modeles.createVersion(t.direction, 'mandat_vente_exclusif', BODY);
    const c = await t.client(1);
    expect(await t.modeles.generate(t.as('agent', t.sam.id), { kind: 'mandat_vente_exclusif', ...c })).toMatchObject({ ok: false, rule: 'R16' });
    const other = await t.store.createProperty({ networkId: t.network.id, agentId: t.sam.id, reference: 'REF-SAM', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 40, rooms: 2, priceEur: 1 });
    await t.db.run(`UPDATE properties SET status = 'available' WHERE id = ?`, [other.id]);
    expect(await t.modeles.generate(t.as('agent', t.alex.id), { kind: 'mandat_vente_exclusif', personId: c.personId, propertyId: other.id })).toMatchObject({ ok: false, rule: 'R16' });
    const p = await t.store.createPerson({ networkId: t.network.id, agentId: t.alex.id, firstName: '<script>alert(1)</script>', lastName: 'Test' });
    await designerTout(t.db);
    const r = await t.modeles.generate(t.as('agent', t.alex.id), { kind: 'mandat_vente_exclusif', personId: p.id, propertyId: c.propertyId, inputs: INPUTS });
    expect(r.ok && r.document.content).toContain('&lt;script&gt;alert(1)&lt;/script&gt; Test');
    expect(r.ok && r.document.content).not.toContain('<script>');
    expect(await t.modeles.read(t.as('agent', t.sam.id), r.ok ? r.document.id : '')).toMatchObject({ ok: false, rule: 'R16' });
    for (const viewer of [t.direction, t.conformite]) expect((await t.modeles.read(viewer, r.ok ? r.document.id : '')).ok).toBe(true);
    expect(JSON.stringify(await t.journal.all())).not.toMatch(/Prénom1|Nom1|script/);
  });

  it('le rendu échappe le texte du modèle lui-même', () => {
    expect(renderDocument('A <b> & {{bien.reference}}', { 'bien.reference': '"x"' }, { title: 't', trial: false })).toContain('<p>A &lt;b&gt; &amp; &quot;x&quot;</p>');
  });

  it('[R40] une version d’essai nouvelle ne remplace pas la version validée en vigueur', async () => {
    const t = await setup();
    const v1 = await t.modeles.createVersion(t.direction, 'mandat_vente_exclusif', BODY);
    await t.modeles.validate(t.conformite, v1.ok ? v1.template.id : '');
    await t.modeles.createVersion(t.direction, 'mandat_vente_exclusif', BODY.replace('Durée', 'Durée du mandat'));
    const c = await t.client(1);
    await designerTout(t.db);
    const r = await t.modeles.generate(t.as('agent', t.alex.id), { kind: 'mandat_vente_exclusif', ...c, inputs: INPUTS });
    expect(r.ok && [r.document.templateVersion, r.document.mode]).toEqual([1, 'reel']);
  });

  it('[R40] un mandat exclusif sans clause mise en évidence est refusé', async () => {
    const t = await setup();
    expect(await t.modeles.createVersion(t.direction, 'mandat_vente_exclusif', BODY.replace('!! ', ''))).toEqual({ ok: false, rule: 'R40', code: 'no_evidence' });
    expect((await t.modeles.createVersion(t.direction, 'mandat_vente_simple', BODY.replace('!! ', ''))).ok).toBe(true);
  });

  it('[R16] la lecture du bien est écrite au journal avant que le document soit rendu', async () => {
    const t = await setup();
    await t.modeles.createVersion(t.direction, 'mandat_vente_exclusif', BODY);
    const c = await t.client(1);
    await designerTout(t.db);
    await t.modeles.generate(t.as('agent', t.alex.id), { kind: 'mandat_vente_exclusif', ...c, inputs: INPUTS });
    const types = (await t.journal.all()).map((e) => [e.type, e.subject]);
    const read = types.findIndex(([type, subject]) => type === 'bien.lu' && subject === `property:${c.propertyId}`);
    const made = types.findIndex(([type]) => type === 'document.genere');
    expect(read).toBeGreaterThanOrEqual(0);
    expect(read).toBeLessThan(made);
  });
});
