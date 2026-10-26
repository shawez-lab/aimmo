-- Colonnes ajoutées plus tard par le site (functions/_lib/base.js de shawez-immo).
ALTER TABLE demandes ADD COLUMN rappel_le TEXT;
ALTER TABLE demandes ADD COLUMN en_attente INTEGER NOT NULL DEFAULT 0;
ALTER TABLE demandes ADD COLUMN cle TEXT;
ALTER TABLE demandes ADD COLUMN suspect INTEGER NOT NULL DEFAULT 0;
ALTER TABLE demandes ADD COLUMN resultat TEXT;
ALTER TABLE demandes ADD COLUMN raison TEXT;
ALTER TABLE demandes ADD COLUMN statut_le TEXT;
