-- HX42 · Vidéo depuis les photos, voix off et avatar. En ajout seul : rien ne s'efface ni ne se réécrit [R17].

-- L'accord écrit de l'agent pour sa voix ou son avatar : donné par lui seul, sur un texte daté et versionné, pour
-- l'enregistrement fait sur son appareil dont seule l'empreinte est rangée (aucune voix ni image ici) [R495].
CREATE TABLE IF NOT EXISTS agent_likeness_consents (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('voix', 'avatar')),
  sample_sha256 TEXT NOT NULL CHECK (length(sample_sha256) = 64),
  text_version TEXT NOT NULL CHECK (length(text_version) BETWEEN 1 AND 40),
  text_sha256 TEXT NOT NULL CHECK (length(text_sha256) = 64),
  given_at TEXT NOT NULL,
  UNIQUE (agent_id, kind, sample_sha256),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS agent_likeness_consents_garde BEFORE DELETE ON agent_likeness_consents BEGIN SELECT RAISE(ABORT, 'agent_likeness_consents : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS agent_likeness_consents_fige BEFORE UPDATE ON agent_likeness_consents BEGIN SELECT RAISE(ABORT, 'agent_likeness_consents : rien ne se réécrit'); END;

-- Le retrait d'un accord, par l'agent lui-même, à tout moment : rangé à part, l'accord reste lisible [R495].
CREATE TABLE IF NOT EXISTS agent_likeness_revocations (
  consent_id TEXT PRIMARY KEY REFERENCES agent_likeness_consents (id) ON DELETE RESTRICT,
  revoked_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS agent_likeness_revocations_garde BEFORE DELETE ON agent_likeness_revocations BEGIN SELECT RAISE(ABORT, 'agent_likeness_revocations : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS agent_likeness_revocations_fige BEFORE UPDATE ON agent_likeness_revocations BEGIN SELECT RAISE(ABORT, 'agent_likeness_revocations : rien ne se réécrit'); END;

-- Une vidéo générée depuis les photos certifiées, faite sur l'appareil : sa référence, son empreinte, le plan du code
-- qu'elle suit, ses mentions, ses langues de sous-titres et l'accord de voix ou d'avatar utilisé [R130, R495 à R497].
CREATE TABLE IF NOT EXISTS generated_videos (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL REFERENCES networks (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  video_ref TEXT NOT NULL CHECK (length(video_ref) BETWEEN 1 AND 200),
  video_sha256 TEXT NOT NULL CHECK (length(video_sha256) = 64),
  plan_sha256 TEXT NOT NULL CHECK (length(plan_sha256) = 64),
  clips_count INTEGER NOT NULL CHECK (clips_count >= 1),
  duration_s INTEGER NOT NULL CHECK (duration_s >= 1),
  mentions TEXT NOT NULL CHECK (instr(mentions, 'Vidéo générée') > 0),
  languages TEXT NOT NULL CHECK (length(languages) BETWEEN 2 AND 200),
  voice_consent_id TEXT REFERENCES agent_likeness_consents (id) ON DELETE RESTRICT,
  avatar_consent_id TEXT REFERENCES agent_likeness_consents (id) ON DELETE RESTRICT,
  processed_on TEXT NOT NULL CHECK (processed_on = 'appareil'),
  recorded_by TEXT NOT NULL,
  recorded_at TEXT NOT NULL,
  UNIQUE (property_id, video_ref),
  FOREIGN KEY (property_id, network_id) REFERENCES properties (id, network_id) ON DELETE RESTRICT
);
CREATE TRIGGER IF NOT EXISTS generated_videos_garde BEFORE DELETE ON generated_videos BEGIN SELECT RAISE(ABORT, 'generated_videos : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS generated_videos_fige BEFORE UPDATE ON generated_videos BEGIN SELECT RAISE(ABORT, 'generated_videos : rien ne se réécrit'); END;
