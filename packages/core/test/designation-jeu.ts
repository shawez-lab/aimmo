import type { SqlDatabase } from '../src/index.ts';

/**
 * AU002 · Pour les jeux de test : chaque mandat de vente porte l'adresse du bien, sa désignation cadastrale et le
 * domicile de chaque mandant. Ce placement s'ajoute au texte d'un modèle de test, et `designerTout` range une adresse,
 * une parcelle et un domicile inventés pour chaque bien et chaque fiche qui n'en ont pas encore.
 */
export const DESIGNATION = '\n\nBien situé {{bien.adresse}}, cadastré {{bien.cadastre}}. Mandant domicilié {{mandant.domicile}}.';

export async function designerTout(db: SqlDatabase, at = '2020-01-01T00:00:00.000Z'): Promise<void> {
  await db.run(
    `INSERT INTO property_designations (id, network_id, property_id, version, street, postal_code, city, parcels, set_by, set_at)
     SELECT 'designation-' || p.id, p.network_id, p.id, 1, '1 rue de l’Essai', CASE WHEN length(p.postal_code) = 5 THEN p.postal_code ELSE '21000' END, CASE WHEN length(p.city) BETWEEN 1 AND 100 THEN p.city ELSE 'Dijon' END, '[{"prefix":null,"section":"AB","number":"1"}]', 'test', ?
     FROM properties p WHERE NOT EXISTS (SELECT 1 FROM property_designations d WHERE d.property_id = p.id)`,
    [at],
  );
  await db.run(
    `INSERT INTO person_domiciles (id, network_id, person_id, version, street, postal_code, city, country, set_by, set_at)
     SELECT 'domicile-' || p.id, p.network_id, p.id, 1, '2 avenue du Test', '21000', 'Dijon', NULL, 'test', ?
     FROM persons p WHERE NOT EXISTS (SELECT 1 FROM person_domiciles d WHERE d.person_id = p.id)`,
    [at],
  );
}
