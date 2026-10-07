import { afterEach, describe, expect, it } from "vitest";
import type { Store } from "../db/store";
import { createTestStore } from "../test/store";
import { adminRecoveryFromEnvironment, recoverLocalAdmin } from "./admin-recovery";
import { hashPassword, verifyPassword } from "./password";
import { createSessionToken } from "./session";

const OLD_PASSWORD = "synthetic-old-admin-password";
const NEW_PASSWORD = "synthetic-new-admin-password";
const stores: Store[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map((store) => store.close())); });

async function fixture() {
  const store = await createTestStore();
  await store.migrate();
  stores.push(store);
  const user = await store.createUser({ email: "admin@recovery.hatcheck.test", displayName: "Synthetic Recovery Admin", role: "admin", authSource: "local", isActive: false, passwordHash: await hashPassword(OLD_PASSWORD) });
  const sessions = [createSessionToken(), createSessionToken()];
  for (const session of sessions) await store.createSession({ userId: user.id, tokenHash: session.tokenHash, expiresAt: Date.now() + 60000 });
  return { store, user, sessions };
}

const input = () => adminRecoveryFromEnvironment({ HATCHECK_RECOVERY_EMAIL: "admin@recovery.hatcheck.test", HATCHECK_RECOVERY_PASSWORD: NEW_PASSWORD });

describe("explicit offline administrator recovery", () => {
  it("resets and reactivates an existing local admin, revokes all sessions, and writes sanitized snapshots", async () => {
    const { store, user, sessions } = await fixture();
    expect(await recoverLocalAdmin(store, input())).toEqual({ userId: user.id });
    const recovered = await store.getUserById(user.id);
    expect(recovered?.isActive).toBe(true);
    expect(recovered?.role).toBe("admin");
    expect(await verifyPassword(recovered!.passwordHash!, NEW_PASSWORD)).toBe(true);
    expect(await verifyPassword(recovered!.passwordHash!, OLD_PASSWORD)).toBe(false);
    for (const session of sessions) expect(await store.getSessionUser(session.tokenHash, Date.now())).toBeNull();
    const [audit] = await store.listAudit({ limit: 10 });
    expect(audit?.action).toBe("user.offline_recovery");
    expect(audit?.actorUserId).toBeNull();
    expect(audit?.actorEmail).toBe("system:offline-recovery");
    expect(audit?.entityId).toBe(user.id);
    const details = JSON.parse(audit!.details!);
    expect(details.before).toMatchObject({ email: user.email, role: "admin", authSource: "local", isActive: false });
    expect(details.after).toMatchObject({ email: user.email, role: "admin", authSource: "local", isActive: true });
    expect(details.sessionsRevoked).toBe(true);
    expect(audit!.details).not.toContain("passwordHash");
    expect(audit!.details).not.toContain(OLD_PASSWORD);
    expect(audit!.details).not.toContain(NEW_PASSWORD);
    expect(await store.countUsers()).toBe(1);
  });

  it.each([{}, { HATCHECK_RECOVERY_EMAIL: "admin@recovery.hatcheck.test" }, { HATCHECK_RECOVERY_PASSWORD: NEW_PASSWORD }])("requires both explicit environment bindings", (environment) => {
    expect(() => adminRecoveryFromEnvironment(environment)).toThrow("Set HATCHECK_RECOVERY_EMAIL and HATCHECK_RECOVERY_PASSWORD");
  });

  it("rejects invalid email addresses and passwords shorter than twelve characters", async () => {
    expect(() => adminRecoveryFromEnvironment({ HATCHECK_RECOVERY_EMAIL: "invalid", HATCHECK_RECOVERY_PASSWORD: NEW_PASSWORD })).toThrow("HATCHECK_RECOVERY_EMAIL");
    expect(() => adminRecoveryFromEnvironment({ HATCHECK_RECOVERY_EMAIL: "admin@recovery.hatcheck.test", HATCHECK_RECOVERY_PASSWORD: "short" })).toThrow("12 to 1024");
    const { store, user } = await fixture();
    await expect(recoverLocalAdmin(store, { email: user.email, password: "short" })).rejects.toThrow("12 to 1024");
    expect(await store.countAudit()).toBe(0);
    expect(await store.getUserById(user.id)).toEqual(user);
  });

  it("refuses missing, external, and non-admin accounts without creating or promoting one", async () => {
    const { store, user } = await fixture();
    const external = await store.createUser({ email: "external@recovery.hatcheck.test", displayName: "Synthetic External", role: "admin", authSource: "oidc", oidcSubject: "synthetic-subject", oidcIssuer: "https://identity.recovery.test" });
    const technician = await store.createUser({ email: "tech@recovery.hatcheck.test", displayName: "Synthetic Technician", role: "technician", authSource: "local", passwordHash: await hashPassword(OLD_PASSWORD) });
    await expect(recoverLocalAdmin(store, { email: "missing@recovery.hatcheck.test", password: NEW_PASSWORD })).rejects.toThrow("No existing account");
    for (const account of [external, technician]) {
      await expect(recoverLocalAdmin(store, { email: account.email, password: NEW_PASSWORD })).rejects.toThrow("existing local administrator");
      expect(await store.getUserById(account.id)).toEqual(account);
    }
    expect(await store.getUserById(user.id)).toEqual(user);
    expect(await store.countUsers()).toBe(3);
    expect(await store.countAudit()).toBe(0);
  });

  it("rolls back password, reactivation, and session revocation if the recovery audit fails", async () => {
    const { store, user, sessions } = await fixture();
    const failed: Store = { ...store, transaction: (work) => store.transaction((tx) => work({ ...tx, appendAudit: async () => { throw new Error("Synthetic recovery audit failure"); } })) };
    await expect(recoverLocalAdmin(failed, input())).rejects.toThrow("Synthetic recovery audit failure");
    expect(await store.getUserById(user.id)).toEqual(user);
    expect(await verifyPassword((await store.getUserById(user.id))!.passwordHash!, OLD_PASSWORD)).toBe(true);
    expect(await store.countAudit()).toBe(0);
    // The inactive account hides its sessions from authentication. Reactivate
    // it solely in this fixture to prove those session rows survived rollback.
    await store.updateUser(user.id, { isActive: true });
    for (const session of sessions) expect((await store.getSessionUser(session.tokenHash, Date.now()))?.user.id).toBe(user.id);
  });
});
