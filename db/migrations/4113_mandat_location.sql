-- AU014 · Le mandat de location [R40, R42, R100]. La liste des sortes de modèles (`document_templates.kind`) est fermée
-- par un CHECK que SQLite ne sait pas élargir sans refaire la table ; plutôt que de la refaire, un modèle dit son objet :
-- `vente` (tous les modèles existants) ou `location`. Un modèle de mandat de location est rangé comme un mandat simple
-- (`kind = 'mandat_vente_simple'`) d'objet `location` ; le code le nomme `mandat_location`, et les documents qu'il fait
-- portent cette sorte. Rien n'est refait ni effacé ; l'objet, comme le reste du modèle, ne change jamais.
ALTER TABLE document_templates ADD COLUMN purpose TEXT NOT NULL DEFAULT 'vente' CHECK (purpose IN ('vente', 'location'));

-- Seul un mandat simple peut avoir l'objet « location » : ni un mandat exclusif, ni un avenant.
CREATE TRIGGER IF NOT EXISTS document_templates_objet
BEFORE INSERT ON document_templates
WHEN NEW.purpose = 'location' AND NEW.kind <> 'mandat_vente_simple'
BEGIN
  SELECT RAISE(ABORT, 'modèle : seul un mandat simple a l''objet location');
END;

-- L'objet d'un modèle rangé ne change jamais, pas plus que son texte.
CREATE TRIGGER IF NOT EXISTS document_templates_objet_fige
BEFORE UPDATE OF purpose ON document_templates
WHEN NEW.purpose IS NOT OLD.purpose
BEGIN
  SELECT RAISE(ABORT, 'modèle figé : créer une nouvelle version');
END;
