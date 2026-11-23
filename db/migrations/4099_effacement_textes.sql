-- AU020b · Le texte libre d'un brouillon d'annonce, vidé par l'effacement réel du vendeur [R17, R231].
-- Un brouillon rangé ne change plus, sauf par cette seule voie : la ligne est d'abord notée ici pour la demande
-- d'effacement, puis son titre, son texte et ses sources sont remplacés par la marque « [effacé] » ; rien d'autre ne
-- change, et le brouillon reste (une publication ou une traduction peut le citer). Une note ne s'efface ni ne change.
CREATE TABLE IF NOT EXISTS erasure_text_wipes (
  wiped_table TEXT NOT NULL CHECK (wiped_table IN ('listing_drafts')),
  row_id TEXT NOT NULL,
  request_id TEXT NOT NULL CHECK (length(trim(request_id)) > 0),
  network_id TEXT NOT NULL,
  wiped_at TEXT NOT NULL,
  PRIMARY KEY (wiped_table, row_id)
);
CREATE TRIGGER IF NOT EXISTS erasure_text_wipes_sans_effacement BEFORE DELETE ON erasure_text_wipes
BEGIN SELECT RAISE(ABORT, 'erasure_text_wipes : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS erasure_text_wipes_fige BEFORE UPDATE ON erasure_text_wipes
BEGIN SELECT RAISE(ABORT, 'erasure_text_wipes : une note rangée ne change plus'); END;

DROP TRIGGER IF EXISTS listing_drafts_fige;
CREATE TRIGGER IF NOT EXISTS listing_drafts_fige BEFORE UPDATE ON listing_drafts
WHEN NOT (
  EXISTS (SELECT 1 FROM erasure_text_wipes w WHERE w.wiped_table = 'listing_drafts' AND w.row_id = OLD.id)
  AND NEW.id IS OLD.id AND NEW.property_id IS OLD.property_id AND NEW.network_id IS OLD.network_id AND NEW.seq IS OLD.seq
  AND NEW.origin IS OLD.origin AND NEW.sheet_version IS OLD.sheet_version AND NEW.created_by IS OLD.created_by
  AND NEW.created_at IS OLD.created_at
  AND NEW.title = '[effacé]' AND NEW.body = '[effacé]' AND NEW.trace = '[]'
)
BEGIN SELECT RAISE(ABORT, 'listing_drafts : un brouillon rangé ne change plus'); END;
