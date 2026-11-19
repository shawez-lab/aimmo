-- AU101 · L'indice de révision du bail commercial, rangé avec la fiche ; colonne vide pour les fiches d'avant [R17], confidentielle [R110].
ALTER TABLE business_sheets ADD COLUMN lease_index TEXT CHECK (lease_index IS NULL OR lease_index IN ('ilc', 'ilat', 'icc', 'aucun'));
