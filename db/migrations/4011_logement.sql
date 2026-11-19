-- AU070 · Maison ou appartement : un logement du socle (« home ») dit lequel il est, pour qu'un acquéreur qui ne
-- cherche qu'une maison ne reçoive jamais un appartement. Inconnu tant que personne ne l'a dit (null).
ALTER TABLE properties ADD COLUMN dwelling TEXT CHECK (dwelling IS NULL OR dwelling IN ('house', 'apartment'));
