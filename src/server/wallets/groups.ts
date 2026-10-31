import { randomUUID } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/server/db/client";

export const groupNameSchema = z
  .string()
  .trim()
  .min(1, "Name is required")
  .max(40, "Max 40 characters");

export class DuplicateGroupError extends Error {
  constructor() {
    super("A group with that name already exists.");
  }
}

export function createGroup(name: string) {
  const parsed = groupNameSchema.parse(name);
  const exists = db()
    .select({ id: schema.groups.id })
    .from(schema.groups)
    .where(eq(schema.groups.name, parsed))
    .get();
  if (exists) throw new DuplicateGroupError();
  const id = randomUUID();
  db().insert(schema.groups).values({ id, name: parsed }).run();
  return { id };
}

export function deleteGroup(id: string) {
  db().delete(schema.groups).where(eq(schema.groups.id, id)).run();
}

export function listGroups() {
  return db()
    .select({
      id: schema.groups.id,
      name: schema.groups.name,
      wallets: count(schema.walletGroups.walletId),
    })
    .from(schema.groups)
    .leftJoin(schema.walletGroups, eq(schema.walletGroups.groupId, schema.groups.id))
    .groupBy(schema.groups.id)
    .orderBy(schema.groups.name)
    .all();
}

export function walletGroupIds(walletId: string): string[] {
  return db()
    .select({ id: schema.walletGroups.groupId })
    .from(schema.walletGroups)
    .where(eq(schema.walletGroups.walletId, walletId))
    .all()
    .map((r) => r.id);
}

export function walletIdsInGroup(groupId: string): string[] {
  return db()
    .select({ id: schema.walletGroups.walletId })
    .from(schema.walletGroups)
    .where(eq(schema.walletGroups.groupId, groupId))
    .all()
    .map((r) => r.id);
}

export function setMembership(walletId: string, groupId: string, member: boolean) {
  if (member) {
    db().insert(schema.walletGroups).values({ walletId, groupId }).onConflictDoNothing().run();
  } else {
    db()
      .delete(schema.walletGroups)
      .where(
        and(eq(schema.walletGroups.walletId, walletId), eq(schema.walletGroups.groupId, groupId)),
      )
      .run();
  }
}
