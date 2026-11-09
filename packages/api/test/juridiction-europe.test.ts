import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error script du dépôt, sans déclaration de types
import { checkConfig, checkD1, D1_PLACEHOLDER } from '../../../scripts/juridiction-europe.mjs';
// @ts-expect-error script du dépôt, sans déclaration de types
import { withBindings } from '../../../scripts/liaisons-r2.mjs';

const REPO_TOML = readFileSync(fileURLToPath(new URL('../wrangler.toml', import.meta.url)), 'utf8');
const ID = 'ea390265-0000-4000-8000-000000000001';
const filled = REPO_TOML.replace(D1_PLACEHOLDER, ID);
const list = (over: Record<string, unknown> = {}) => JSON.stringify([{ uuid: ID, name: 'aimmo', jurisdiction: 'eu', ...over }]);

describe('HX56 · données en Europe', () => {
  it('[R602] la configuration du dépôt ne sort pas d’Europe', () => {
    expect(checkConfig(REPO_TOML)).toEqual([]);
  });

  it('[R602] une base hors d’Europe fait échouer la vérification', () => {
    expect(checkD1(filled, list())).toEqual([]);
    expect(checkD1(filled, list({ jurisdiction: null }))).toEqual(['base D1 aimmo hors de la juridiction Europe (juridiction : aucune) [R602]']);
    expect(checkD1(filled, list({ jurisdiction: 'fedramp' }))[0]).toContain('hors de la juridiction Europe');
    // Champ absent : rien ne passe dans le doute.
    expect(checkD1(filled, JSON.stringify([{ uuid: ID, name: 'aimmo' }]))).toHaveLength(1);
  });

  it('[R602] une base introuvable, renommée, sans identifiant ou une liste illisible échouent aussi', () => {
    expect(checkD1(filled, '[]')[0]).toContain('absente de la liste du compte');
    expect(checkD1(filled, list({ name: 'autre' }))[0]).toContain('nommée autre');
    expect(checkD1(REPO_TOML, list())[0]).toContain('sans identifiant rempli');
    expect(checkD1(filled, 'pas du json')).toEqual(['liste des bases D1 illisible [R602]']);
    expect(checkD1(filled, '{}')).toEqual(['liste des bases D1 illisible [R602]']);
  });

  it('[R602] un compartiment R2 sans juridiction "eu" fait échouer la vérification', () => {
    const eu = `${REPO_TOML}\n[[r2_buckets]]\nbinding = "MEDIA"\nbucket_name = "aimmo-medias"\njurisdiction = "eu"\n`;
    expect(checkConfig(eu)).toEqual([]);
    const sans = `${REPO_TOML}\n[[r2_buckets]]\nbinding = "MEDIA"\nbucket_name = "aimmo-medias"\n`;
    expect(checkConfig(sans)).toEqual([expect.stringContaining('compartiment R2 aimmo-medias sans juridiction "eu"')]);
    const autre = `${REPO_TOML}\n[[r2_buckets]]\nbinding = "MEDIA"\nbucket_name = "aimmo-medias"\njurisdiction = "fedramp"\n`;
    expect(checkConfig(autre)).toHaveLength(1);
    const apercu = `${eu}preview_bucket_name = "aimmo-medias-apercu"\n`;
    expect(checkConfig(apercu)).toEqual([expect.stringContaining('compartiment d\'aperçu')]);
  });

  it('[R602] tout autre stockage, en table ou en ligne, fait échouer la vérification', () => {
    expect(checkConfig(`${REPO_TOML}\n[[kv_namespaces]]\nbinding = "KV"\nid = "abc"\n`)).toEqual([expect.stringContaining('table [[kv_namespaces]] non admise')]);
    expect(checkConfig(`${REPO_TOML}\n[[queues.producers]]\nbinding = "Q"\n`)).toHaveLength(1);
    expect(checkConfig(`kv_namespaces = [{ binding = "KV", id = "x" }]\n${REPO_TOML}`)).toEqual([expect.stringContaining('liaison « kv_namespaces » écrite en ligne')]);
    expect(checkConfig(`${REPO_TOML}\n[durable_objects]\nbindings = []\n`)).toHaveLength(1);
    expect(checkConfig(REPO_TOML.replace('migrations_dir', 'preview_database_id = "x"\nmigrations_dir'))[0]).toContain('base d\'aperçu');
  });

  it('[R602] ce que le déploiement ajoute à la configuration passe la vérification', () => {
    const { toml } = withBindings(filled, new Map<string, string | null>([['aimmo-coffre', 'eu'], ['aimmo-pieces', null]]));
    expect(checkConfig(toml)).toEqual([]);
    expect(toml).not.toContain('aimmo-pieces');
  });
});
