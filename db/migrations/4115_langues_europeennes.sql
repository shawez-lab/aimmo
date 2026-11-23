-- AU069 · Les annonces en allemand, espagnol, italien et néerlandais [R257, R258]. La langue d'une traduction et d'un
-- relecteur (`language`) est fermée par un CHECK que SQLite ne sait pas élargir sans refaire la table ; plutôt que de la
-- refaire (H73 l'autorisait, mais une table refaite demande un PRAGMA que R633 refuse), chaque ligne dit sa langue
-- réelle dans une colonne ajoutée, `language_code`, de la liste complète. Une ligne sans elle (toutes les anciennes)
-- est de la langue `language`. Une ligne d'une des quatre langues nouvelles est rangée sous `language = 'en'`, pour le
-- CHECK et la clé UNIQUE (bien, langue, numéro) : ses numéros suivent ceux de l'anglais du même bien, sans trou de
-- l'un dans l'autre, et le code lit toujours la langue réelle, COALESCE(language_code, language).
-- Rien n'est refait ni effacé ; la langue d'une ligne, comme le reste, ne change jamais (déclencheurs `_fige`).
ALTER TABLE listing_translations ADD COLUMN language_code TEXT CHECK (language_code IS NULL OR language_code IN ('en', 'ur', 'hi', 'pa', 'fa', 'ar', 'el', 'de', 'es', 'it', 'nl'));
ALTER TABLE translation_reviewers ADD COLUMN language_code TEXT CHECK (language_code IS NULL OR language_code IN ('en', 'ur', 'hi', 'pa', 'fa', 'ar', 'el', 'de', 'es', 'it', 'nl'));

-- Une langue réelle des sept premières se range sous elle-même ; une des quatre nouvelles, sous l'anglais. Rien d'autre.
CREATE TRIGGER IF NOT EXISTS listing_translations_langue
BEFORE INSERT ON listing_translations
WHEN NEW.language_code IS NOT NULL
  AND NOT (NEW.language_code = NEW.language OR (NEW.language_code IN ('de', 'es', 'it', 'nl') AND NEW.language = 'en'))
BEGIN
  SELECT RAISE(ABORT, 'listing_translations : langue rangée sous une autre');
END;

CREATE TRIGGER IF NOT EXISTS translation_reviewers_langue
BEFORE INSERT ON translation_reviewers
WHEN NEW.language_code IS NOT NULL
  AND NOT (NEW.language_code = NEW.language OR (NEW.language_code IN ('de', 'es', 'it', 'nl') AND NEW.language = 'en'))
BEGIN
  SELECT RAISE(ABORT, 'translation_reviewers : langue rangée sous une autre');
END;
