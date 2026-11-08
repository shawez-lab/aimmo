-- HX52 · Calendrier de publication sur tous les réseaux (M07, M19) [R580, R581, R582].

-- Les réglages du calendrier d'un agent, par versions qui s'ajoutent : le nombre de publications par réseau et par
-- jour (0 à 3), et les heures de Paris des créneaux. Une version vaut à partir de son premier jour, jamais avant
-- [R581]. Rien ne change ni ne s'efface.
CREATE TABLE IF NOT EXISTS social_calendar_rules (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  instagram INTEGER NOT NULL CHECK (instagram BETWEEN 0 AND 3),
  facebook INTEGER NOT NULL CHECK (facebook BETWEEN 0 AND 3),
  linkedin INTEGER NOT NULL CHECK (linkedin BETWEEN 0 AND 3),
  google INTEGER NOT NULL CHECK (google BETWEEN 0 AND 3),
  tiktok INTEGER NOT NULL CHECK (tiktok BETWEEN 0 AND 3),
  youtube INTEGER NOT NULL CHECK (youtube BETWEEN 0 AND 3),
  hours TEXT NOT NULL CHECK (json_valid(hours) AND json_array_length(hours) BETWEEN 1 AND 3),
  effective_day TEXT NOT NULL CHECK (effective_day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  created_at TEXT NOT NULL,
  UNIQUE (agent_id, version),
  UNIQUE (id, agent_id),
  FOREIGN KEY (agent_id, network_id) REFERENCES agents (id, network_id) ON DELETE RESTRICT,
  -- Jamais plus de créneaux par réseau que d'heures réglées.
  CHECK (max(instagram, facebook, linkedin, google, tiktok, youtube) <= json_array_length(hours))
);
CREATE TRIGGER IF NOT EXISTS social_calendar_rules_garde BEFORE DELETE ON social_calendar_rules BEGIN SELECT RAISE(ABORT, 'social_calendar_rules : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS social_calendar_rules_fige BEFORE UPDATE ON social_calendar_rules BEGIN SELECT RAISE(ABORT, 'social_calendar_rules : une version ne change plus'); END;

-- Les créneaux réservés : un par version, jour, réseau et rang ; un rang au-delà du nombre réglé pour ce réseau est
-- refusé par la base, rejoué ou simultané [R581]. Une publication n'est réservée qu'une fois par version et par réseau.
CREATE TABLE IF NOT EXISTS social_calendar_slots (
  id TEXT PRIMARY KEY,
  network_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  rules_id TEXT NOT NULL,
  day TEXT NOT NULL CHECK (day GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  channel TEXT NOT NULL CHECK (channel IN ('instagram', 'facebook', 'linkedin', 'google', 'tiktok', 'youtube')),
  rank INTEGER NOT NULL CHECK (rank BETWEEN 0 AND 2),
  post_id TEXT NOT NULL REFERENCES social_posts (id) ON DELETE RESTRICT,
  property_id TEXT NOT NULL,
  due_at TEXT NOT NULL,
  booked_at TEXT NOT NULL,
  UNIQUE (rules_id, day, channel, rank),
  UNIQUE (rules_id, post_id, channel),
  FOREIGN KEY (rules_id, agent_id) REFERENCES social_calendar_rules (id, agent_id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS social_calendar_slots_due ON social_calendar_slots (network_id, due_at);
CREATE INDEX IF NOT EXISTS social_calendar_slots_agent ON social_calendar_slots (agent_id, channel, day);
CREATE TRIGGER IF NOT EXISTS social_calendar_slots_quota BEFORE INSERT ON social_calendar_slots
WHEN NEW.rank >= (
  SELECT CASE NEW.channel WHEN 'instagram' THEN r.instagram WHEN 'facebook' THEN r.facebook WHEN 'linkedin' THEN r.linkedin
    WHEN 'google' THEN r.google WHEN 'tiktok' THEN r.tiktok WHEN 'youtube' THEN r.youtube END
  FROM social_calendar_rules r WHERE r.id = NEW.rules_id
) OR NEW.day < (SELECT effective_day FROM social_calendar_rules WHERE id = NEW.rules_id)
BEGIN SELECT RAISE(ABORT, 'social_calendar_slots : nombre réglé dépassé [R581]'); END;
CREATE TRIGGER IF NOT EXISTS social_calendar_slots_garde BEFORE DELETE ON social_calendar_slots BEGIN SELECT RAISE(ABORT, 'social_calendar_slots : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS social_calendar_slots_fige BEFORE UPDATE ON social_calendar_slots BEGIN SELECT RAISE(ABORT, 'social_calendar_slots : un créneau ne change plus'); END;

-- Le passage d'un créneau : réservé avant de demander la publication, pour ne passer qu'une fois, puis son issue
-- [R582]. Rien ne change ni ne s'efface.
CREATE TABLE IF NOT EXISTS social_calendar_runs (
  slot_id TEXT PRIMARY KEY REFERENCES social_calendar_slots (id) ON DELETE RESTRICT,
  claimed_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS social_calendar_runs_garde BEFORE DELETE ON social_calendar_runs BEGIN SELECT RAISE(ABORT, 'social_calendar_runs : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS social_calendar_runs_fige BEFORE UPDATE ON social_calendar_runs BEGIN SELECT RAISE(ABORT, 'social_calendar_runs : un passage ne change plus'); END;

CREATE TABLE IF NOT EXISTS social_calendar_outcomes (
  slot_id TEXT PRIMARY KEY REFERENCES social_calendar_runs (slot_id) ON DELETE RESTRICT,
  outcome TEXT NOT NULL CHECK (outcome IN ('envoye', 'echec', 'refuse')),
  rule TEXT,
  code TEXT,
  done_at TEXT NOT NULL,
  CHECK ((outcome = 'refuse') = (rule IS NOT NULL AND code IS NOT NULL))
);
CREATE TRIGGER IF NOT EXISTS social_calendar_outcomes_garde BEFORE DELETE ON social_calendar_outcomes BEGIN SELECT RAISE(ABORT, 'social_calendar_outcomes : rien ne s''efface'); END;
CREATE TRIGGER IF NOT EXISTS social_calendar_outcomes_fige BEFORE UPDATE ON social_calendar_outcomes BEGIN SELECT RAISE(ABORT, 'social_calendar_outcomes : une issue ne change plus'); END;
