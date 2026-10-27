import { describe, expect, it } from 'vitest';
import { ExportPortails, TRIAL_FORMAT, type ListingPayload } from '../src/annonces/index.ts';
import { setupAnnonce } from './annonces-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// Annonces inventées.
const L: ListingPayload = {
  reference: 'REF-B',
  version: 2,
  state: 'en_vente',
  title: 'Appartement <3 pièces> & balcon 🏡',
  body: 'Au 3e étage. "Lumineux" \u0001',
  mentions: 'Prix : 210 000 €\nCarte professionnelle n° CPI 0000.',
  priceEur: 210000,
  media: [
    { ref: 'biens/b/0b6f1d2e-1111-4a2b-8c3d-000000000001.jpg', kind: 'photo', overlay: null },
    { ref: 'biens/b/0b6f1d2e-2222-4a2b-8c3d-000000000002.jpg', kind: 'photo', overlay: 'Aménagement virtuel' },
  ],
};

describe('P07 · format d’essai des portails', () => {
  it('[R43] [R44] le flux porte le prix publié, les mentions et la mention de l’aménagement virtuel ; tout est échappé', () => {
    const out = TRIAL_FORMAT.render([L]);
    expect(out).toBe(
      '<?xml version="1.0" encoding="UTF-8"?>\n<flux format="aimmo-essai-1">' +
        '<annonce reference="REF-B" version="2" etat="en_vente"><prix devise="EUR">210000</prix>' +
        '<titre>Appartement &lt;3 pièces&gt; &amp; balcon 🏡</titre><texte>Au 3e étage. &quot;Lumineux&quot; </texte>' +
        '<mentions>Prix : 210 000 €\nCarte professionnelle n° CPI 0000.</mentions>' +
        '<medias><media type="photo" ref="biens/b/0b6f1d2e-1111-4a2b-8c3d-000000000001.jpg"/><media type="photo" ref="biens/b/0b6f1d2e-2222-4a2b-8c3d-000000000002.jpg" mention="Aménagement virtuel"/></medias>' +
        '</annonce></flux>\n',
    );
  });
});

describeWithSqlite('P07 · flux depuis les versions publiées', () => {
  it('[R44] [R46] même prix que les autres canaux, sans adresse ni nom ; une même version donne le même flux ; un bien vendu ou retiré sort du flux', async () => {
    const t = await setupAnnonce();
    const exporter = new ExportPortails(t.db);
    expect((await exporter.feed(t.network.id)).body).toBe('<?xml version="1.0" encoding="UTF-8"?>\n<flux format="aimmo-essai-1"></flux>\n');
    t.setClock(new Date('2027-02-12T10:00:00.000Z'));
    await t.annonces.validate(t.agent, t.draftId);
    t.setClock(new Date('2027-03-01T08:00:00.000Z'));
    await t.publication.sync(t.network.id, t.propertyId);
    const first = await exporter.feed(t.network.id);
    expect(first.contentType).toBe('application/xml; charset=utf-8');
    expect(first.body).toContain('<prix devise="EUR">210000</prix>');
    expect(first.body).toContain(`<prix devise="EUR">${t.channels[0]!.received.at(-1)!.priceEur}</prix>`);
    expect(first.body).toContain('mention="Aménagement virtuel"');
    expect(first.body).not.toMatch(/Léa|Exemple|rue /);
    expect((await exporter.feed(t.network.id)).body).toBe(first.body);
    // Un avenant de prix : le flux suit la nouvelle version.
    await t.amend(190000);
    await t.publication.sync(t.network.id, t.propertyId);
    expect((await exporter.feed(t.network.id)).body).toContain('<prix devise="EUR">200000</prix>');
    // Vendu : il sort du flux.
    await t.db.run("UPDATE properties SET status = 'sold' WHERE id = ?", [t.propertyId]);
    await t.publication.sync(t.network.id, t.propertyId);
    expect(await exporter.listings(t.network.id)).toEqual([]);
    expect(await exporter.listings('autre-reseau')).toEqual([]);
  });
});
