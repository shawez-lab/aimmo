import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
// @ts-expect-error script du dépôt, sans déclaration de types
import { R2_BINDINGS, declare, parseBucketNames, readBuckets, withBindings } from '../../../scripts/liaisons-r2.mjs';

const TOML = 'name = "aimmo-api"\n\n[[d1_databases]]\nbinding = "DB"\n\n[observability]\nenabled = true\n';
const LIST = 'Listing buckets...\nname:           aimmo-coffre\ncreation_date:  2026-11-03T10:00:00.000Z\n\nname:           autre-chose\ncreation_date:  2026-11-03T10:00:00.000Z\n';

describe('X27 · les compartiments R2 restent liés après un déploiement', () => {
  it('lit les noms dans la sortie de wrangler, et rien d’autre', () => {
    expect(parseBucketNames(LIST)).toEqual(['aimmo-coffre', 'autre-chose']);
    expect(parseBucketNames('Listing buckets...\n')).toEqual([]);
    expect(parseBucketNames('\u001b[37mname:\u001b[39m  \u001b[90maimmo-coffre\u001b[39m\n')).toEqual(['aimmo-coffre']);
  });

  it('un compartiment existant est lié, un absent ne l’est pas, le reste de la configuration est gardé', () => {
    const { toml, linked } = withBindings(TOML, new Map([['aimmo-commerces', null]]));
    expect(linked).toEqual(['COMMERCES']);
    expect(toml.startsWith(TOML.trimEnd())).toBe(true);
    expect(toml).toContain('[[r2_buckets]]\nbinding = "COMMERCES"\nbucket_name = "aimmo-commerces"\n');
    expect(toml).not.toMatch(/PIECES|MEDIA|COFFRE/);
    expect(toml).not.toContain('jurisdiction');
  });

  it('un compartiment en Europe garde sa juridiction ; une liaison déjà déclarée n’est jamais doublée', () => {
    const first = withBindings(TOML, new Map([['aimmo-coffre', 'eu']]));
    expect(first.toml).toContain('bucket_name = "aimmo-coffre"\njurisdiction = "eu"\n');
    expect(withBindings(first.toml, new Map([['aimmo-coffre', 'eu']]))).toEqual({ toml: first.toml, linked: [] });
  });

  it('[L09] le coffre reste sur son propre compartiment, chaque liaison sur le sien', () => {
    expect(R2_BINDINGS).toEqual({ PIECES: 'aimmo-pieces', MEDIA: 'aimmo-medias', COFFRE: 'aimmo-coffre', COMMERCES: 'aimmo-commerces' });
    expect(new Set(Object.values(R2_BINDINGS)).size).toBe(Object.keys(R2_BINDINGS).length);
  });

  it('la juridiction Europe l’emporte quand un nom existe dans les deux', () => {
    const found = readBuckets((j: string | null) => (j === 'eu' ? 'name: aimmo-pieces\n' : 'name: aimmo-pieces\nname: aimmo-medias\n'));
    expect([...found.entries()]).toEqual([['aimmo-pieces', 'eu'], ['aimmo-medias', null]]);
  });

  it('une liste illisible : le fichier ne change pas, la mise en ligne continue, et le résumé le dit', () => {
    let written = false;
    const summary = declare('x', () => { throw new Error('droit manquant'); }, () => TOML, () => { written = true; });
    expect(summary).toMatch(/liste illisible.*H45/);
    expect(written).toBe(false);
  });

  it('le résumé nomme les liaisons posées, jamais une clé', () => {
    let saved = '';
    const summary = declare('x', () => 'name: aimmo-medias\n', () => TOML, (_: string, t: string) => { saved = t; });
    expect(summary).toBe('Compartiments R2 liés : MEDIA.');
    expect(saved).toContain('binding = "MEDIA"');
    expect(declare('x', () => '', () => TOML, () => {})).toBe('Compartiments R2 : aucun à lier.');
  });

  it('le travail de déploiement passe bien par ce script, avant la mise en ligne', () => {
    const flow = readFileSync(new URL('../../../.github/workflows/deployer-api.yml', import.meta.url), 'utf8');
    const step = flow.indexOf('node scripts/liaisons-r2.mjs packages/api/wrangler.toml');
    expect(step).toBeGreaterThan(-1);
    expect(step).toBeLessThan(flow.indexOf('"$WRANGLER" deploy'));
  });
});
