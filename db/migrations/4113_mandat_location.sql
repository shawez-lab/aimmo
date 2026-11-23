-- AU014 · Le mandat de location : une sorte de modèle de plus, `mandat_location` [R40, R42, R100]. Décidé par Shawez
-- (H73, 2026-11-23) : `document_templates.kind` portait une liste fermée (CHECK), que SQLite ne sait pas élargir ; la
-- table est refaite, à l'identique, ligne à ligne, comme `sale_files` sous H51. Rien n'est effacé : la recopie est
-- vérifiée complète, colonne par colonne, avant que l'ancienne table ne parte. Si une seule ligne manque ou diffère,
-- la vérification échoue et la migration s'arrête sans rien changer.
-- Les documents qui citent un modèle (`documents.template_id`) sont reportés le temps du DROP et du RENAME, qui rétablit
-- leur table ; le test le vérifie après coup par `PRAGMA foreign_key_check`.
PRAGMA defer_foreign_keys = ON;
CREATE TABLE document_templates_refaite (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK (kind IN ('mandat_vente_simple', 'mandat_vente_exclusif', 'avenant_mandat', 'mandat_location')),
  version INTEGER NOT NULL CHECK (version >= 1),
  status TEXT NOT NULL CHECK (status IN ('essai', 'valide')),
  body TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 50000),
  fields TEXT NOT NULL,
  hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  validated_by TEXT,
  validated_at TEXT,
  UNIQUE (network_id, kind, version),
  UNIQUE (id, network_id),
  CHECK ((status = 'essai' AND validated_by IS NULL AND validated_at IS NULL) OR (status = 'valide' AND validated_by IS NOT NULL AND validated_at IS NOT NULL))
);
INSERT INTO document_templates_refaite (id, network_id, kind, version, status, body, fields, hash, created_by, created_at, validated_by, validated_at)
  SELECT id, network_id, kind, version, status, body, fields, hash, created_by, created_at, validated_by, validated_at FROM document_templates;

-- La preuve de la recopie, gardée : même nombre de lignes, et aucune ligne d'un côté qui manque de l'autre.
CREATE TABLE IF NOT EXISTS document_templates_recopie (
  done_at TEXT NOT NULL,
  rows_copied INTEGER NOT NULL,
  complete INTEGER NOT NULL CHECK (complete = 1)
);
INSERT INTO document_templates_recopie (done_at, rows_copied, complete)
  SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), (SELECT COUNT(*) FROM document_templates_refaite),
    (SELECT COUNT(*) FROM document_templates) = (SELECT COUNT(*) FROM document_templates_refaite)
    AND NOT EXISTS (
      SELECT id, network_id, kind, version, status, body, fields, hash, created_by, created_at, validated_by, validated_at FROM document_templates
      EXCEPT SELECT id, network_id, kind, version, status, body, fields, hash, created_by, created_at, validated_by, validated_at FROM document_templates_refaite)
    AND NOT EXISTS (
      SELECT id, network_id, kind, version, status, body, fields, hash, created_by, created_at, validated_by, validated_at FROM document_templates_refaite
      EXCEPT SELECT id, network_id, kind, version, status, body, fields, hash, created_by, created_at, validated_by, validated_at FROM document_templates);
CREATE TRIGGER IF NOT EXISTS document_templates_recopie_fige BEFORE UPDATE ON document_templates_recopie BEGIN SELECT RAISE(ABORT, 'document_templates_recopie : rien ne change'); END;
CREATE TRIGGER IF NOT EXISTS document_templates_recopie_sans_effacement BEFORE DELETE ON document_templates_recopie BEGIN SELECT RAISE(ABORT, 'document_templates_recopie : rien ne s''efface'); END;

-- R17-EXCEPTION-H73 : l'ancienne table, recopiée et vérifiée juste au-dessus.
DROP TABLE document_templates;
ALTER TABLE document_templates_refaite RENAME TO document_templates;
CREATE TRIGGER IF NOT EXISTS document_templates_sans_effacement
BEFORE DELETE ON document_templates
BEGIN
  SELECT RAISE(ABORT, 'modèle gardé');
END;
CREATE TRIGGER IF NOT EXISTS document_templates_fige
BEFORE UPDATE ON document_templates
WHEN NEW.id IS NOT OLD.id OR NEW.network_id IS NOT OLD.network_id OR NEW.kind IS NOT OLD.kind OR NEW.version IS NOT OLD.version
  OR NEW.body IS NOT OLD.body OR NEW.fields IS NOT OLD.fields OR NEW.hash IS NOT OLD.hash
  OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at
  OR OLD.status <> 'essai' OR NEW.status <> 'valide'
BEGIN
  SELECT RAISE(ABORT, 'modèle figé : créer une nouvelle version');
END;
PRAGMA defer_foreign_keys = OFF;
