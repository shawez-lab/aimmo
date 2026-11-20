import { expect, it } from 'vitest';
import { setupOffre } from './offres-jeu.ts';
import { describeWithSqlite } from './sqlite.ts';

// AU081 · L'offre d'un acquéreur suivi par un collègue, présentée par l'agent du bien sans la direction.
// Agents, biens, acquéreurs et offres inventés.

async function setup() {
  const t = await setupOffre();
  // L'acquéreur est suivi par Sam, le collègue ; le bien est à Alex.
  const buyer = await t.store.createPerson({ networkId: t.network.id, agentId: t.sam.userId, firstName: 'Colin', lastName: 'Fictif' });
  // Le bien est en vente, dans le fichier commun du réseau : Sam le voit, sans ses clients.
  await t.db.run("UPDATE properties SET status = 'available' WHERE id = ?", [t.propertyId]);
  return { ...t, colleagueBuyer: buyer.id };
}

describeWithSqlite('AU081 · partage de l’acquéreur d’un collègue pour un bien', () => {
  it('[R16] constat : sans partage, l’agent du bien ne peut pas inscrire l’offre de l’acquéreur d’un collègue', async () => {
    const t = await setup();
    expect(await t.offres.record(t.agent, t.propertyId, t.input({ buyerPersonId: t.colleagueBuyer }))).toMatchObject({ ok: false, rule: 'R16', code: 'not_assigned' });
  });

  it('[R16] [R56] avec le partage du collègue, l’agent du bien inscrit l’offre au registre, sans la direction ni la fiche', async () => {
    const t = await setup();
    const share = await t.offres.shareBuyer(t.sam, t.propertyId, t.colleagueBuyer);
    expect(share).toMatchObject({ ok: true, value: { propertyId: t.propertyId, buyerPersonId: t.colleagueBuyer, grantedBy: t.sam.userId, revokedAt: null } });
    const r = await t.offres.record(t.agent, t.propertyId, t.input({ buyerPersonId: t.colleagueBuyer }));
    expect(r).toMatchObject({ ok: true, value: { seq: 1, buyerPersonId: t.colleagueBuyer } });
    expect(await t.offres.check(t.propertyId)).toEqual({ ok: true, count: 1 });
    // Le résultat ne porte que l'identifiant : ni nom, ni coordonnée de la fiche du collègue.
    expect(JSON.stringify(r)).not.toMatch(/Colin|Fictif/);
    // L'agent du bien n'ouvre toujours pas la fiche du collègue.
    expect(await t.acces.readFiche(t.agent, t.colleagueBuyer)).toMatchObject({ ok: false, rule: 'R16', code: 'not_assigned' });
    // L'usage du partage est écrit au nom de l'agent du bien ; rien de la fiche au journal [R13].
    const used = (await t.journal.all()).filter((e) => e.type === 'offre.partage_utilise');
    expect(used).toHaveLength(1);
    expect(used[0]).toMatchObject({ actor: `agent:${t.alexId}`, subject: `property:${t.propertyId}` });
    expect(JSON.stringify(await t.journal.all())).not.toMatch(/Colin|Fictif/);
    // Un rejeu avec la même clé reste reconnu sous le partage.
    const k = { requestKey: 'cle-partage-0000000001', buyerPersonId: t.colleagueBuyer, amountEur: 206000 };
    const a = await t.offres.record(t.agent, t.propertyId, t.input(k));
    expect(await t.offres.record(t.agent, t.propertyId, t.input(k))).toEqual(a);
  });

  it('[R16] le partage vaut pour ce seul bien, ce seul acquéreur et le seul agent du bien', async () => {
    const t = await setup();
    await t.offres.shareBuyer(t.sam, t.propertyId, t.colleagueBuyer);
    // Un autre acquéreur du collègue : pas partagé.
    const other = await t.store.createPerson({ networkId: t.network.id, agentId: t.sam.userId, firstName: 'Autre', lastName: 'Fictif' });
    expect(await t.offres.record(t.agent, t.propertyId, t.input({ buyerPersonId: other.id }))).toMatchObject({ ok: false, rule: 'R16' });
    // Un autre bien d'Alex : le partage ne s'y étend pas.
    const b2 = await t.store.createProperty({ networkId: t.network.id, agentId: t.alexId, reference: 'REF-T-2', kind: 'home', postalCode: '21000', city: 'Dijon', surfaceM2: 40, rooms: 2, priceEur: 150000 } as never);
    expect(await t.offres.record(t.agent, b2.id, t.input({ buyerPersonId: t.colleagueBuyer }))).toMatchObject({ ok: false, rule: 'R16', code: 'not_assigned' });
    // Un troisième agent ne se sert pas du partage donné à l'agent du bien.
    const third = await t.store.createAgent({ networkId: t.network.id, firstName: 'Tom', lastName: 'Agent' });
    const tom = { role: 'agent', userId: third.id, networkId: t.network.id } as never;
    expect(await t.offres.record(tom, t.propertyId, t.input({ buyerPersonId: t.colleagueBuyer }))).toMatchObject({ ok: false, rule: 'R16' });
  });

  it('[R16] seul le collègue qui voit la fiche en entier partage ; l’agent du bien ne se partage rien', async () => {
    const t = await setup();
    // Alex ne peut pas partager l'acquéreur de Sam.
    expect(await t.offres.shareBuyer(t.agent, t.propertyId, t.colleagueBuyer)).toEqual({ ok: false, rule: null, code: 'own_property' });
    const third = await t.store.createAgent({ networkId: t.network.id, firstName: 'Tom', lastName: 'Agent' });
    const tom = { role: 'agent', userId: third.id, networkId: t.network.id } as never;
    expect(await t.offres.shareBuyer(tom, t.propertyId, t.colleagueBuyer)).toMatchObject({ ok: false, rule: 'R16', code: 'not_assigned' });
    expect(await t.offres.shareBuyer(t.direction, t.propertyId, t.colleagueBuyer)).toMatchObject({ ok: false, rule: 'R16', code: 'role' });
    expect(await t.offres.shareBuyer(t.sam, t.propertyId, 'inconnu')).toEqual({ ok: false, rule: null, code: 'unknown_buyer' });
    expect(await t.offres.shareBuyer(t.sam, t.propertyId, 42)).toEqual({ ok: false, rule: null, code: 'invalid', field: 'buyerPersonId' });
    // Un partage déjà en cours est rendu tel quel, sans seconde ligne.
    const a = await t.offres.shareBuyer(t.sam, t.propertyId, t.colleagueBuyer);
    const b = await t.offres.shareBuyer(t.sam, t.propertyId, t.colleagueBuyer);
    expect(b).toEqual(a);
    expect((await t.db.first<{ n: number }>('SELECT count(*) AS n FROM offer_buyer_shares'))!.n).toBe(1);
  });

  it('[R16] [R17] retiré, ou quand le collègue ne suit plus l’acquéreur, le partage ne sert plus ; l’offre inscrite reste', async () => {
    const t = await setup();
    const share = await t.offres.shareBuyer(t.sam, t.propertyId, t.colleagueBuyer);
    if (!share.ok) throw new Error(share.code);
    expect(await t.offres.record(t.agent, t.propertyId, t.input({ buyerPersonId: t.colleagueBuyer }))).toMatchObject({ ok: true });
    // Alex ne retire pas le partage de Sam ; Sam le retire.
    expect(await t.offres.revokeShare(t.agent, share.value.id)).toMatchObject({ ok: false, rule: 'R16' });
    expect(await t.offres.revokeShare(t.sam, share.value.id)).toMatchObject({ ok: true, value: { revokedAt: expect.any(String) } });
    expect(await t.offres.record(t.agent, t.propertyId, t.input({ buyerPersonId: t.colleagueBuyer, amountEur: 207000 }))).toMatchObject({ ok: false, rule: 'R16' });
    const list = await t.offres.list(t.agent, t.propertyId);
    expect(list.ok && list.value.map((o) => o.buyerPersonId)).toEqual([t.colleagueBuyer]);
    // La ligne reste, datée, et ne se réécrit plus [R17].
    await expect(t.db.run('UPDATE offer_buyer_shares SET revoked_at = NULL, revoked_by = NULL WHERE id = ?', [share.value.id])).rejects.toThrow();
    // Un nouveau partage, puis l'acquéreur passe à un autre agent : le partage de Sam ne vaut plus.
    await t.offres.shareBuyer(t.sam, t.propertyId, t.colleagueBuyer);
    const third = await t.store.createAgent({ networkId: t.network.id, firstName: 'Tom', lastName: 'Agent' });
    await t.db.run('UPDATE persons SET agent_id = ? WHERE id = ?', [third.id, t.colleagueBuyer]);
    expect(await t.offres.record(t.agent, t.propertyId, t.input({ buyerPersonId: t.colleagueBuyer, amountEur: 208000 }))).toEqual({ ok: false, rule: 'R16', code: 'share_lapsed' });
    // La direction retire aussi un partage.
    const s2 = await t.offres.shareBuyer({ role: 'agent', userId: third.id, networkId: t.network.id } as never, t.propertyId, t.colleagueBuyer);
    if (!s2.ok) throw new Error(s2.code);
    expect(await t.offres.revokeShare(t.direction, s2.value.id)).toMatchObject({ ok: true });
    expect(await t.offres.revokeShare(t.direction, 'inconnu')).toEqual({ ok: false, rule: null, code: 'unknown_share' });
  });
});
