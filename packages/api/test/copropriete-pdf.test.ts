import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { Viewer } from "@aimmo/core";
import type { CoproExcerpt } from "../../core/src/documents/index.ts";
import { PDF_TEXT_REFUSAL_TEXT } from "../../core/src/documents/texte-pdf.ts";
import {
  MAX_COPROPRIETE_PDF_BYTES,
  coproprieteRoutes,
  type CoproprieteServices,
} from "../src/copropriete.ts";
import { setupDossier } from "../../core/test/dossiers-jeu.ts";
import { describeWithSqlite } from "../../core/test/sqlite.ts";

// Des PDF inventés, écrits à la main : aucune vraie personne, aucun vrai bien, aucune vraie copropriété.

const enc = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0) & 0xff);

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** Un PDF d'une page par contenu (`null` : une page sans texte, comme un scan), police Helvetica en WinAnsi. */
function pdf(contents: (string | null)[], trailer = ""): Uint8Array {
  const kids = contents.map((_, i) => `${4 + i * 2} 0 R`).join(" ");
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${kids}] /Count ${contents.length} >>`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>",
  ];
  const streams: string[] = [];
  contents.forEach((c, i) => {
    objs.push(
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ${5 + i * 2} 0 R >>`,
    );
    objs.push("");
    streams[objs.length - 1] = c === null ? "q 100 0 0 100 0 0 cm Q" : c;
  });
  const parts: Uint8Array[] = [enc("%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")];
  const offsets: number[] = [];
  let at = parts[0]!.length;
  objs.forEach((o, i) => {
    offsets.push(at);
    const data = streams[i];
    const chunk =
      data === undefined
        ? enc(`${i + 1} 0 obj\n${o}\nendobj\n`)
        : enc(
            `${i + 1} 0 obj\n<< /Length ${data.length} >>\nstream\n${data}\nendstream\nendobj\n`,
          );
    parts.push(chunk);
    at += chunk.length;
  });
  let x = `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) x += `${String(o).padStart(10, "0")} 00000 n \n`;
  x += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R ${trailer} >>\nstartxref\n${at}\n%%EOF\n`;
  parts.push(enc(x));
  return concat(parts);
}

/** Des lignes l'une sous l'autre. */
const lines = (...ls: string[]) =>
  `BT /F1 12 Tf 72 760 Td ${ls.map((l) => `(${l}) Tj`).join(" 0 -16 Td ")} ET`;

const PV = pdf([
  lines("Procès-verbal de l'assemblée générale ordinaire du 15 janvier 2027."),
  null,
  lines(
    "Résolution n° 7 : l'assemblée décide le ravalement de la façade sur rue.",
    "Aucune procédure judiciaire n'est en cours contre le syndicat.",
  ),
]);
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

async function setup(
  o: { reader?: (e: CoproExcerpt[]) => Promise<unknown> } = {},
) {
  const t = await setupDossier("appartement");
  const seen: CoproExcerpt[][] = [];
  const services: CoproprieteServices = {
    db: t.db,
    journal: t.journal,
    now: t.now,
    ...(o.reader
      ? {
          reader: {
            read: async (e: CoproExcerpt[]) => {
              seen.push(e);
              return o.reader!(e);
            },
          },
        }
      : {}),
  };
  const routes = coproprieteRoutes();
  let bodyRead = 0;
  const call = async (
    viewer: Viewer,
    path: string,
    query: string,
    body: Uint8Array | string,
    type = "application/pdf",
  ) => {
    const route = routes.find(
      (r) => r.method === "POST" && r.pattern.test(path),
    );
    if (!route) throw new Error(`pas de route ${path}`);
    const params = path.match(route.pattern)!.slice(1);
    const bytes = typeof body === "string" ? enc(body) : body;
    // Un corps qui compte ses lectures : un refus de droits ne doit jamais le lire [R16].
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(c) {
          bodyRead++;
          c.enqueue(bytes);
          c.close();
        },
      },
      { highWaterMark: 0 },
    );
    const request = new Request(`https://api.example.test/v1${path}${query}`, {
      method: "POST",
      body: stream,
      headers: { "content-type": type },
      duplex: "half",
    } as RequestInit);
    const res = await route.handle(services, viewer, params, request);
    return {
      status: res.status,
      body: (await res.json()) as {
        ok: boolean;
        code?: string;
        rule?: string | null;
        message?: string;
        data?: any;
      },
    };
  };
  const journalText = async () =>
    JSON.stringify(await t.db.all("SELECT * FROM journal"));
  return {
    ...t,
    call,
    seen,
    journalText,
    bodyRead: () => bodyRead,
    path: `/dossiers/${t.fileId}/copropriete/pdf`,
  };
}

const PV_QUERY = "?kind=pv_assemblee&meetingDay=2027-01-15";

describeWithSqlite(
  "RC53 · le PDF d’un document de copropriété déposé tel quel, prélu",
  () => {
    it("[R448] le texte des pages est tiré du PDF, le document porte l’empreinte du fichier, la prélecture est faite", async () => {
      const t = await setup();
      const r = await t.call(t.agent, t.path, PV_QUERY, PV);
      expect(r.status).toBe(200);
      const doc = r.body.data.document;
      expect(doc).toMatchObject({
        kind: "pv_assemblee",
        meetingDay: "2027-01-15",
        ref: `sha256:${sha(PV)}`,
      });
      expect(doc.pages).toHaveLength(3);
      expect(doc.pages[0]).toContain(
        "assemblée générale ordinaire du 15 janvier 2027",
      );
      expect(doc.pages[2]).toContain("ravalement de la façade");
      expect(r.body.data.reading).toMatchObject({
        source: "manuel",
        sentences: [],
      });
      expect(r.body.data.reading.toRead).toContain("travaux_votes");
    });

    it("[R12] une page sans texte (un scan) est nommée à lire, jamais devinée", async () => {
      const t = await setup();
      const r = await t.call(t.agent, t.path, PV_QUERY, PV);
      expect(r.body.data.pagesToRead).toEqual([2]);
      expect(r.body.data.pagesToReadText).toBe(
        "La page 2 n’a pas pu être lue : lisez-la vous-même.",
      );
      expect(r.body.data.document.pages[1]).toBe("");
      const many = await t.call(
        t.agent,
        t.path,
        "?kind=reglement_copropriete",
        pdf([null, lines("Article 1 : objet."), null, null]),
      );
      expect(many.body.data.pagesToRead).toEqual([1, 3, 4]);
      expect(many.body.data.pagesToReadText).toBe(
        "Les pages 1, 3 et 4 n’ont pas pu être lues : lisez-les vous-même.",
      );
      const clean = await t.call(
        t.agent,
        t.path,
        "?kind=plu_reglement",
        pdf([lines("Zone UA : zone urbaine centrale.")]),
      );
      expect(clean.body.data).toMatchObject({
        pagesToRead: [],
        pagesToReadText: null,
      });
    });

    it("[R448] avec un lecteur inventé, la phrase vérifiée est proposée sur la page du PDF et passe au résumé", async () => {
      const t = await setup({
        reader: async () => ({
          sentences: [
            {
              topic: "procedures",
              text: "Aucune procédure judiciaire en cours contre le syndicat",
              document: 0,
              page: 3,
              line: 2,
            },
          ],
        }),
      });
      const r = await t.call(t.agent, t.path, PV_QUERY, PV);
      expect(r.status).toBe(200);
      expect(r.body.data.reading.source).toBe("ia");
      expect(r.body.data.reading.sentences).toEqual([
        expect.objectContaining({
          topic: "procedures",
          page: 3,
          quote:
            "Aucune procédure judiciaire n'est en cours contre le syndicat.",
        }),
      ]);
      // Ce qui part au lecteur ne porte ni le fichier ni son empreinte.
      expect(JSON.stringify(t.seen)).not.toContain(sha(PV));
      const resume = coproprieteRoutes().find(
        (x) => x.name === "copropriete.preparer",
      )!;
      const req = new Request(
        `https://api.example.test/v1/dossiers/${t.fileId}/copropriete/resume`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            documents: [r.body.data.document],
            sentences: r.body.data.reading.sentences,
          }),
        },
      );
      const prepared = await resume.handle(
        { db: t.db, journal: t.journal, now: t.now },
        t.agent,
        [t.fileId],
        req,
      );
      const body = (await prepared.json()) as {
        data: { rejected: unknown[]; documents: { ref: string }[] };
      };
      expect(prepared.status).toBe(200);
      expect(body.data.rejected).toEqual([]);
      expect(body.data.documents[0]!.ref).toBe(`sha256:${sha(PV)}`);
    });

    it("pas un PDF, PDF chiffré, corps trop gros, autre type de corps : refus en mots, rien prélu", async () => {
      const t = await setup({ reader: async () => ({ sentences: [] }) });
      const notPdf = await t.call(
        t.agent,
        t.path,
        PV_QUERY,
        "Ceci n’est pas un PDF.",
      );
      expect(notPdf).toMatchObject({
        status: 422,
        body: {
          ok: false,
          code: "not_pdf",
          message: PDF_TEXT_REFUSAL_TEXT.not_pdf,
        },
      });
      const encrypted = await t.call(
        t.agent,
        t.path,
        PV_QUERY,
        pdf([lines("Secret.")], "/Encrypt 99 0 R"),
      );
      expect(encrypted).toMatchObject({
        status: 422,
        body: { code: "encrypted", message: PDF_TEXT_REFUSAL_TEXT.encrypted },
      });
      const huge = await t.call(
        t.agent,
        t.path,
        PV_QUERY,
        new Uint8Array(MAX_COPROPRIETE_PDF_BYTES + 1),
      );
      expect(huge).toMatchObject({
        status: 413,
        body: { code: "too_large", message: PDF_TEXT_REFUSAL_TEXT.too_large },
      });
      const json = await t.call(
        t.agent,
        t.path,
        PV_QUERY,
        PV,
        "application/json",
      );
      expect(json).toMatchObject({
        status: 415,
        body: { code: "not_pdf_body", message: "Déposez le document en PDF." },
      });
      expect(t.seen).toEqual([]);
      expect(await t.journalText()).not.toContain("dossier.copropriete_prelue");
    });

    it("type de document inconnu, jour d’assemblée absent, mal formé, futur ou en trop : 400", async () => {
      const t = await setup();
      expect((await t.call(t.agent, t.path, "", PV)).body.code).toBe(
        "bad_kind",
      );
      expect((await t.call(t.agent, t.path, "?kind=bail", PV)).body.code).toBe(
        "bad_kind",
      );
      expect(
        (await t.call(t.agent, t.path, "?kind=pv_assemblee", PV)).body.code,
      ).toBe("bad_meeting_day");
      expect(
        (
          await t.call(
            t.agent,
            t.path,
            "?kind=pv_assemblee&meetingDay=15/01/2027",
            PV,
          )
        ).body.code,
      ).toBe("bad_meeting_day");
      expect(
        (
          await t.call(
            t.agent,
            t.path,
            "?kind=plu_reglement&meetingDay=2027-01-15",
            PV,
          )
        ).body.code,
      ).toBe("bad_meeting_day");
      const future = await t.call(
        t.agent,
        t.path,
        "?kind=pv_assemblee&meetingDay=2099-01-15",
        PV,
      );
      expect(future).toMatchObject({
        status: 400,
        body: { code: "bad_documents" },
      });
    });

    it("[R16] autre agent, direction, dossier inconnu : refus au journal, le PDF jamais lu", async () => {
      const t = await setup();
      expect((await t.call(t.sam, t.path, PV_QUERY, PV)).status).toBe(403);
      expect(await t.call(t.direction, t.path, PV_QUERY, PV)).toMatchObject({
        status: 403,
        body: { rule: "R16", code: "role" },
      });
      expect(
        (
          await t.call(
            t.agent,
            "/dossiers/inconnu/copropriete/pdf",
            PV_QUERY,
            PV,
          )
        ).status,
      ).toBe(404);
      expect(t.bodyRead()).toBe(0);
      expect(await t.journalText()).toContain("acces.refuse");
    });

    it("[R13] ni le texte ni l’empreinte du fichier ne sont écrits au journal", async () => {
      const t = await setup();
      expect((await t.call(t.agent, t.path, PV_QUERY, PV)).status).toBe(200);
      expect(t.bodyRead()).toBeGreaterThan(0);
      const log = await t.journalText();
      expect(log).toContain("dossier.copropriete_prelue");
      for (const leak of [
        sha(PV),
        "ravalement",
        "procédure judiciaire",
        "Procès-verbal",
      ])
        expect(log).not.toContain(leak);
    });
  },
);
