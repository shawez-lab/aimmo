/**
 * L'atelier d'un bien dans le Studio (M19, X11) : ce que l'écran « Studio » de l'application doit connaître pour que
 * l'agent choisisse sans rien saisir à la main : les photos de la fiche du bien (M07), celles qui ont leur certificat
 * d'honnêteté (X02) et peuvent donc partir, et les publications déjà préparées pour ce bien (X05).
 *
 * Lecture sous R16 : seulement pour qui voit le bien en entier, un refus écrit au journal. Rien de personnel : des
 * références de stockage, des états et des dates. Aucune image ne passe par ici [R130].
 */
import type { Acces } from '../acces/acces.ts';
import type { Viewer } from '../acces/droits.ts';
import type { SqlDatabase } from '../db/sql.ts';
import { appendEvent } from '../journal/journal.ts';
import type { JournalStore } from '../journal/types.ts';
import type { CertifiedPhoto } from './certificats.ts';
import type { SocialEvent } from './publications.ts';

export interface AtelierPhoto {
  ref: string;
  /** Ce que la fiche dit de la photo : `aucune`, `corrigee`, `amenagement_virtuel`… */
  edit: string;
  /** Le lien public du certificat quand la photo en a un et peut partir ; null sinon. */
  certificatePath: string | null;
  overlay: 'Aménagement virtuel' | null;
}

export interface AtelierPost {
  id: string;
  event: SocialEvent;
  validated: boolean;
  createdAt: string;
}

export interface AtelierView {
  propertyId: string;
  photos: AtelierPhoto[];
  posts: AtelierPost[];
}

export type AtelierResult = { ok: true; value: AtelierView } | { ok: false; rule: 'R16' | 'R10'; code: string };

/** Les publications montrées : les plus récentes d'abord, assez pour la vie d'un bien. */
export const MAX_ATELIER_POSTS = 30;

export class AtelierStudio {
  private readonly now: () => Date;

  constructor(
    private readonly db: SqlDatabase,
    private readonly acces: Acces,
    private readonly journal: JournalStore,
    private readonly certs: { publishable(propertyId: string): Promise<CertifiedPhoto[]> },
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  async read(viewer: Viewer, propertyId: string): Promise<AtelierResult> {
    // Le Studio est un outil de l'agent du bien et de la direction : un autre rôle ne lit rien.
    if (viewer.role !== 'agent' && viewer.role !== 'direction') return this.refused(viewer, propertyId, 'role');
    const read = await this.acces.readProperty(viewer, propertyId);
    if (!read.ok) return { ok: false, rule: 'R16', code: read.code };
    if (read.view !== 'full') return this.refused(viewer, propertyId, 'not_assigned');
    const sheet = await this.sheetPhotos(propertyId);
    if (sheet === null) return { ok: false, rule: 'R10', code: 'fiche_illisible' };
    const certified = new Map((await this.certs.publishable(propertyId)).map((c) => [c.ref, c]));
    const photos = sheet.map((m) => {
      const c = certified.get(m.ref);
      return { ref: m.ref, edit: m.edit, certificatePath: c ? c.certificatePath : null, overlay: c ? c.overlay : null };
    });
    const rows = await this.db.all<{ id: string; event: SocialEvent; created_at: string; validated: number }>(
      `SELECT p.id, p.event, p.created_at, (SELECT COUNT(*) FROM social_post_validations v WHERE v.post_id = p.id) AS validated
       FROM social_posts p WHERE p.property_id = ? ORDER BY p.created_at DESC, p.rowid DESC LIMIT ?`,
      [propertyId, MAX_ATELIER_POSTS],
    );
    const posts = rows.map((r) => ({ id: r.id, event: r.event, validated: Number(r.validated) > 0, createdAt: r.created_at }));
    return { ok: true, value: { propertyId, photos, posts } };
  }

  private async refused(viewer: Viewer, propertyId: string, code: string): Promise<AtelierResult> {
    await appendEvent(
      this.journal,
      { type: 'acces.refuse', actor: `${String(viewer.role)}:${viewer.userId}`, subject: `property:${propertyId}`, data: { rule: 'R16', role: String(viewer.role), kind: 'studio_atelier', code } },
      this.now,
    );
    return { ok: false, rule: 'R16', code };
  }

  /** Les photos de la dernière version de la fiche ; une fiche sans liste de médias lisible ferme tout (null). */
  private async sheetPhotos(propertyId: string): Promise<{ ref: string; edit: string }[] | null> {
    const row = await this.db.first<{ data: string }>('SELECT data FROM property_sheets WHERE property_id = ? ORDER BY version DESC LIMIT 1', [propertyId]);
    if (!row) return [];
    let media: unknown;
    try {
      const data = JSON.parse(row.data) as unknown;
      media = typeof data === 'object' && data !== null && !Array.isArray(data) ? ((data as Record<string, unknown>).media ?? []) : null;
    } catch {
      media = null;
    }
    if (!Array.isArray(media)) return null;
    return media
      .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null && m.kind === 'photo' && typeof m.ref === 'string')
      .map((m) => ({ ref: m.ref as string, edit: typeof m.edit === 'string' ? m.edit : 'aucune' }));
  }
}
