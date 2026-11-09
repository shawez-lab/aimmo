import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

  it('un compartiment existant en Europe est lié, un absent ne l’est pas, le reste de la configuration est gardé', () => {
    const { toml, linked, outside } = withBindings(TOML, new Map([['aimmo-commerces', 'eu']]));
    expect(linked).toEqual(['COMMERCES']);
    expect(outside).toEqual([]);
    expect(toml.startsWith(TOML.trimEnd())).toBe(true);
    expect(toml).toContain('[[r2_buckets]]\nbinding = "COMMERCES"\nbucket_name = "aimmo-commerces"\njurisdiction = "eu"\n');
    expect(toml).not.toMatch(/PIECES|MEDIA|COFFRE/);
  });

  it('[R602] un compartiment hors de la juridiction Europe n’est jamais lié, et le résumé le dit', () => {
    const { toml, linked, outside } = withBindings(TOML, new Map([['aimmo-commerces', null], ['aimmo-medias', 'eu']]));
    expect(linked).toEqual(['MEDIA']);
    expect(outside).toEqual(['COMMERCES']);
    expect(toml).not.toContain('aimmo-commerces');
    let written = '';
    const summary = declare('x.toml', (j: string | null) => (j === 'eu' ? '' : 'name: aimmo-commerces\n'), () => TOML, (_p: string, t: string) => (written = t));
    expect(written).toBe('');
    expect(summary).toContain('Hors de la juridiction Europe, jamais liés (R602, H45) : COMMERCES (aimmo-commerces).');
  });

  it('un compartiment en Europe garde sa juridiction ; une liaison déjà déclarée n’est jamais doublée', () => {
    const first = withBindings(TOML, new Map([['aimmo-coffre', 'eu']]));
    expect(first.toml).toContain('bucket_name = "aimmo-coffre"\njurisdiction = "eu"\n');
    expect(withBindings(first.toml, new Map([['aimmo-coffre', 'eu']]))).toEqual({ toml: first.toml, linked: [], outside: [] });
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
    expect(summary).toBe('Compartiments R2 liés : MEDIA. Sans compartiment de ce nom : PIECES (aimmo-pieces), COFFRE (aimmo-coffre), COMMERCES (aimmo-commerces).');
    expect(saved).toContain('binding = "MEDIA"');
    expect(declare('x', () => '', () => TOML, () => {})).toMatch(/^Compartiments R2 liés : aucun\. Sans compartiment de ce nom : PIECES .*COMMERCES/);
  });

  describe('le script lancé comme par le travail de déploiement, avec un faux `npx`', () => {
    const SCRIPT = fileURLToPath(new URL('../../../scripts/liaisons-r2.mjs', import.meta.url));
    const run = (npx: string, script = SCRIPT) => {
      const dir = mkdtempSync(join(realpathSync(tmpdir()), 'liaisons-r2-'));
      writeFileSync(join(dir, 'npx'), `#!/bin/sh\n${npx}\n`);
      chmodSync(join(dir, 'npx'), 0o755);
      const toml = join(dir, 'wrangler.toml');
      const summary = join(dir, 'resume.md');
      writeFileSync(toml, TOML);
      writeFileSync(summary, '');
      const target = script === SCRIPT ? SCRIPT : join(dir, 'lien.mjs');
      if (target !== SCRIPT) symlinkSync(SCRIPT, target);
      execFileSync(process.execPath, [target, toml], { env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, GITHUB_STEP_SUMMARY: summary }, stdio: 'ignore' });
      return { toml: readFileSync(toml, 'utf8'), summary: readFileSync(summary, 'utf8') };
    };

    it('un compartiment trouvé : la copie de la configuration est liée, et le résumé le dit', () => {
      const r = run('echo "name:   aimmo-commerces"');
      expect(r.toml).toContain('binding = "COMMERCES"');
      expect(r.summary).toMatch(/liés : COMMERCES\./);
    });

    it('wrangler échoue : le script sort sans erreur, rien ne change, et le résumé le dit', () => {
      const r = run('exit 1');
      expect(r.toml).toBe(TOML);
      expect(r.summary).toMatch(/liste illisible/);
    });

    it('lancé par un lien symbolique, le script fait quand même son travail', () => {
      expect(run('echo "name:   aimmo-medias"', 'lien').toml).toContain('binding = "MEDIA"');
    });
  });

  it('le travail de déploiement passe bien par ce script, avant la mise en ligne', () => {
    const flow = readFileSync(new URL('../../../.github/workflows/deployer-api.yml', import.meta.url), 'utf8');
    const step = flow.indexOf('node scripts/liaisons-r2.mjs packages/api/wrangler.toml');
    expect(step).toBeGreaterThan(-1);
    expect(step).toBeLessThan(flow.indexOf('"$WRANGLER" deploy'));
  });
});
