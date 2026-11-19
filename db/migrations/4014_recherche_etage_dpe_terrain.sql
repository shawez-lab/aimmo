-- AU072 · La recherche garde l'étage accepté (0 pour le rez-de-chaussée), la classe énergie la moins bonne acceptée et
-- le terrain minimal ; chacun impératif, sauf s'il est dit souhait dans `soft_criteria` (liste fermée, en JSON).
ALTER TABLE buyer_searches ADD COLUMN floor_min INTEGER CHECK (floor_min IS NULL OR floor_min BETWEEN 0 AND 100);
ALTER TABLE buyer_searches ADD COLUMN floor_max INTEGER CHECK (floor_max IS NULL OR floor_max BETWEEN 0 AND 100);
ALTER TABLE buyer_searches ADD COLUMN energy_class_max TEXT CHECK (energy_class_max IS NULL OR energy_class_max IN ('A', 'B', 'C', 'D', 'E', 'F', 'G'));
ALTER TABLE buyer_searches ADD COLUMN land_min_m2 INTEGER CHECK (land_min_m2 IS NULL OR land_min_m2 > 0);
ALTER TABLE buyer_searches ADD COLUMN soft_criteria TEXT CHECK (soft_criteria IS NULL OR length(soft_criteria) BETWEEN 2 AND 40);
