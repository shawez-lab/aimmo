-- AU096b · Les modèles du bail meublé étudiant et du bail mobilité [R40, R102]. La liste des sortes de modèles de bail
-- (`rental_lease_templates.kind`) est fermée par un CHECK que SQLite ne sait pas élargir sans refaire la table ;
-- plutôt que de la refaire, un modèle dit sa variante : `standard` (tous les modèles existants), `etudiant` ou
-- `mobilite`, ces deux-là pour un bail meublé seulement. Le code nomme `bail_meuble_etudiant` et `bail_mobilite` les
-- modèles meublés de ces variantes. Rien n'est refait ni effacé ; la variante, comme le texte, ne change jamais.
ALTER TABLE rental_lease_templates ADD COLUMN variant TEXT NOT NULL DEFAULT 'standard' CHECK (variant IN ('standard', 'etudiant', 'mobilite'));

CREATE TRIGGER IF NOT EXISTS rental_lease_templates_variante
BEFORE INSERT ON rental_lease_templates
WHEN NEW.variant <> 'standard' AND NEW.kind <> 'bail_meuble'
BEGIN
  SELECT RAISE(ABORT, 'rental_lease_templates : un bail étudiant ou mobilité est meublé');
END;

CREATE TRIGGER IF NOT EXISTS rental_lease_templates_variante_figee
BEFORE UPDATE OF variant ON rental_lease_templates
WHEN NEW.variant IS NOT OLD.variant
BEGIN
  SELECT RAISE(ABORT, 'rental_lease_templates : un modèle rangé ne change plus');
END;
