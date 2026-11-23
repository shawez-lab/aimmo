import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error script du dépôt, sans déclaration de types
import { checkConfig, checkD1, D1_PLACEHOLDER, SANDBOX_D1_PLACEHOLDER } from '../../../scripts/juridiction-europe.mjs';
// @ts-expect-error script du dépôt, sans déclaration de types
import { withBindings } from '../../../scripts/liaisons-r2.mjs';

const REPO_TOML = readFileSync(fileURLToPath(new URL('../wrangler.toml', import.meta.url)), 'utf8');
const ID = 'ea390265-0000-4000-8000-000000000001';
const SANDBOX_ID = 'ea390265-0000-4000-8000-0000000000b5';
const filled = REPO_TOML.replace(D1_PLACEHOLDER, ID).replace(SANDBOX_D1_PLACEHOLDER, SANDBOX_ID);
const list = (over: Record<string, unknown> = {}) => JSON.stringify([{ uuid: ID, name: 'aimmo', jurisdiction: 'eu', ...over }, { uuid: SANDBOX_ID, name: 'aimmo-bac-a-sable', jurisdiction: 'eu' }]);

describe('HX56 · données en Europe', () => {
  it('[R602] la configuration du dépôt ne sort pas d’Europe', () => {
    expect(checkConfig(REPO_TOML)).toEqual([]);
  });

  it('[R602] une base hors d’Europe fait échouer la vérification', () => {
    expect(checkD1(filled, list())).toEqual([]);
    expect(checkD1(filled, list({ jurisdiction: null }))).toEqual(['base D1 aimmo hors de la juridiction Europe (juridiction : aucune) [R602]']);
    expect(checkD1(filled, list({ jurisdiction: 'fedramp' }))[0]).toContain('hors de la juridiction Europe');
    // Champ absent : rien ne passe dans le doute.
    expect(checkD1(filled, JSON.stringify([{ uuid: ID, name: 'aimmo' }, { uuid: SANDBOX_ID, name: 'aimmo-bac-a-sable', jurisdiction: 'eu' }]))).toHaveLength(1);
  });

  it('[R602] [R82] AU025 : la base des bacs à sable est en Europe, remplie, et jamais la base du réseau', () => {
    expect(checkD1(filled, JSON.stringify([{ uuid: ID, name: 'aimmo', jurisdiction: 'eu' }, { uuid: SANDBOX_ID, name: 'aimmo-bac-a-sable', jurisdiction: null }]))).toEqual(['base D1 aimmo-bac-a-sable hors de la juridiction Europe (juridiction : aucune) [R602]']);
    expect(checkD1(REPO_TOML.replace(D1_PLACEHOLDER, ID), list())).toEqual(['base D1 aimmo-bac-a-sable sans identifiant rempli [R602]']);
    // Le gabarit de la base du réseau ne remplit jamais celui du bac à sable.
    expect(REPO_TOML.replace(D1_PLACEHOLDER, ID)).toContain(SANDBOX_D1_PLACEHOLDER);
    // Les deux liaisons sur la même base : refusé.
    const same = REPO_TOML.replace(D1_PLACEHOLDER, ID).replace(SANDBOX_D1_PLACEHOLDER, ID);
    expect(checkD1(same, list())).toEqual(['base D1 aimmo-bac-a-sable liée deux fois (ea390265-0000-4000-8000-000000000001) [R602]']);
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
    expect(checkConfig(apercu)).toEqual([expect.stringContaining('clé « preview_bucket_name » dans [[r2_buckets]] non admise')]);
  });

  it('[R602] tout autre stockage, en table ou en ligne, fait échouer la vérification', () => {
    expect(checkConfig(`${REPO_TOML}\n[[kv_namespaces]]\nbinding = "KV"\nid = "abc"\n`)).toEqual([expect.stringContaining('table [[kv_namespaces]] non admise')]);
    expect(checkConfig(`${REPO_TOML}\n[[queues.producers]]\nbinding = "Q"\n`)).toHaveLength(1);
    expect(checkConfig(`kv_namespaces = [{ binding = "KV", id = "x" }]\n${REPO_TOML}`)).toEqual([expect.stringContaining('clé « kv_namespaces » non admise')]);
    // Une clé entre guillemets, ou une liaison que la liste ne connaît pas encore : refusées aussi.
    expect(checkConfig(`"kv_namespaces" = [{ binding = "KV", id = "x" }]\n${REPO_TOML}`)).toEqual([expect.stringContaining('ligne 1 illisible')]);
    expect(checkConfig(`workflows = [{ name = "w", binding = "W", class_name = "W" }]\n${REPO_TOML}`)).toEqual([expect.stringContaining('clé « workflows » non admise')]);
    expect(checkConfig(`${REPO_TOML}\n[[workflows]]\nname = "w"\n`)).toHaveLength(1);
    expect(checkConfig(`${REPO_TOML}\n[triggers]\ncrons = [\n  "* * * * *",\n]\n`)).toEqual([]);
    expect(checkConfig(`${REPO_TOML}\n[triggers]\ncrons = [\n  "* * * * *",\nkv_namespaces = []\n]\n`)).toContainEqual(expect.stringContaining("illisible"));
    expect(checkConfig(`${REPO_TOML}\n[durable_objects]\nbindings = []\n`)).toHaveLength(1);
    expect(checkConfig(REPO_TOML.replace('migrations_dir', 'preview_database_id = "x"\nmigrations_dir'))[0]).toContain('clé « preview_database_id » dans [[d1_databases]] non admise');
  });

  it('[R602] ce que le déploiement ajoute à la configuration passe la vérification', () => {
    const { toml } = withBindings(filled, new Map<string, string | null>([['aimmo-coffre', 'eu'], ['aimmo-pieces', null]]));
    expect(checkConfig(toml)).toEqual([]);
    expect(toml).not.toContain('aimmo-pieces');
  });
});
