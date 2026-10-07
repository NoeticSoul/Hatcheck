import { inflateRawSync } from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import type { DocumentInput, DocumentRecord, DocumentRevision } from "../db/documents.types";
import type { Role, Store, UserRecord } from "../db/store";
import { exportDocx } from "../modules/documents/export";
import { createDocument, reviseDocument, transitionDocument } from "../modules/documents/service";
import { createTestStore } from "../test/store";
import { createApp } from "./app";
import { hashSessionToken } from "./session";

const stores: Store[] = [];
afterEach(async () => { await Promise.all(stores.splice(0).map((store) => store.close())); });
const SOP: DocumentInput = {
  title: "Verify an inventory backup restore",
  reviewDate: "2020-01-01",
  sections: {
    purpose: "Confirm inventory and custody records survive recovery.",
    scope: "The synthetic lab inventory; run only on an isolated recovery database.",
    prerequisites: "A verified backup, matching application version, and a disposable database.",
    procedure: "1. Stop writes.\n2. Restore the verified backup into the disposable database.\n3. Start the matching application against that database.",
    verification: "Compare asset counts and a complete custody round trip with the backup manifest.",
    escalation: "If counts differ, retain logs and ask the lab administrator before resuming writes.",
  },
  changeSummary: "Initial operational procedure",
};
async function fixture() {
  const store = await createTestStore(); stores.push(store); await store.migrate();
  const app = createApp(store, loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv));
  const users = {} as Record<Role, UserRecord>;
  const cookies = {} as Record<Role, string>;
  for (const role of ["admin", "technician", "readonly"] as const) {
    users[role] = await store.createUser({ email: `${role}@docs.hatcheck.test`, displayName: `Synthetic ${role}`, role, authSource: "local" });
    const token = crypto.randomUUID();
    await store.createSession({ tokenHash: hashSessionToken(token), userId: users[role].id, expiresAt: Date.now() + 60000 });
    cookies[role] = `hatcheck_session=${token}`;
  }
  function request(path: string, method = "GET", role: Role | null = "admin", body?: unknown) {
    return app.request(`/api/v1/documents${path}`, { method, headers: { ...(role ? { cookie: cookies[role] } : {}), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  }
  async function create(input = SOP, code = "SOP-LAB-001") {
    const response = await request("", "POST", "technician", { code, ...input });
    expect(response.status, await response.clone().text()).toBe(201);
    return await response.json() as { document: DocumentRecord; revision: DocumentRevision; stale: boolean };
  }
  return { store, app, users, request, create };
}
function zipText(buffer: Buffer, wanted: string): string {
  let offset = 0;
  while (offset + 30 < buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const compression = buffer.readUInt16LE(offset + 8);
    const length = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.subarray(offset + 30, offset + 30 + nameLength).toString();
    const start = offset + 30 + nameLength + extraLength;
    if (name === wanted) {
      const bytes = buffer.subarray(start, start + length);
      return (compression === 8 ? inflateRawSync(bytes) : bytes).toString();
    }
    offset = start + length;
  }
  throw new Error(`ZIP entry ${wanted} not found`);
}

describe("document studio and knowledge base", () => {
  it("authenticates reads and enforces author and approval roles", async () => {
    const { request, create } = await fixture();
    expect((await request("", "GET", null)).status).toBe(401);
    expect((await request("", "POST", "readonly", { code: "SOP-LAB-001", ...SOP })).status).toBe(403);
    const { document } = await create();
    expect((await request(`/${document.id}/publish`, "POST", "technician", { expectedRevision: 1 })).status).toBe(403);
    expect((await request(`/${document.id}/archive`, "POST", "technician", { expectedRevision: 1 })).status).toBe(403);
  });
  it("validates naming, every required section, real dates and unique codes", async () => {
    const { request, create } = await fixture();
    for (const bad of [ { code: "unsafe", ...SOP }, { code: "SOP-LAB-001", ...SOP, reviewDate: "2026-02-30" }, { code: "SOP-LAB-001", ...SOP, sections: { ...SOP.sections, escalation: " " } }, { code: "SOP-LAB-001", ...SOP, title: "Broken\u0000XML" }, { code: "SOP-LAB-001", ...SOP, title: "Broken\ud800XML" } ]) expect((await request("", "POST", "admin", bad)).status).toBe(400);
    await create();
    expect((await request("", "POST", "admin", { code: "SOP-LAB-001", ...SOP })).status).toBe(409);
  });
  it("flags back-dated SOPs, paginates literal search, and records the author", async () => {
    const { request, create, users } = await fixture();
    const result = await create();
    expect(result.stale).toBe(true);
    expect(result.revision.actorEmail).toBe(users.technician.email);
    await create({ ...SOP, title: "Literal 50% restore", reviewDate: "2099-01-01" }, "SOP-LAB-002");
    const stale = await (await request("?stale=true&limit=1")).json();
    expect(stale.total).toBe(1); expect(stale.items[0].stale).toBe(true);
    const literal = await (await request("?q=50%25&limit=1")).json();
    expect(literal.total).toBe(1); expect(literal.items[0].code).toBe("SOP-LAB-002");
    expect((await (await request("?limit=1&offset=1")).json()).items).toHaveLength(1);
  });
  it("keeps drafts private and preserves the explicitly approved snapshot during edits", async () => {
    const { request, create } = await fixture();
    const { document } = await create(); const path = `/${document.id}`;
    expect((await request(path, "GET", "readonly")).status).toBe(404);
    expect((await (await request("", "GET", "readonly")).json()).total).toBe(0);
    expect((await request(`${path}/publish`, "POST", "admin", { expectedRevision: 1 })).status).toBe(200);
    expect((await request(`${path}/revisions`, "POST", "technician", { ...SOP, title: "Private draft needle", expectedRevision: 1, changeSummary: "New draft" })).status).toBe(201);
    const reader = await (await request(path, "GET", "readonly")).json();
    expect(reader.revision.title).toBe(SOP.title); expect(reader.revision.revision).toBe(1);
    expect((await request(`${path}?revision=2`, "GET", "readonly")).status).toBe(404);
    expect((await request(`${path}/export?revision=2&format=docx`, "GET", "readonly")).status).toBe(404);
    expect((await (await request("?q=needle", "GET", "readonly")).json()).total).toBe(0);
    expect((await (await request("?published=true&q=needle", "GET", "technician")).json()).total).toBe(0);
    const approved = await (await request("?published=true&stale=true", "GET", "admin")).json();
    expect(approved.items[0].visibleRevision).toBe(1);
    expect(approved.items[0].title).toBe(SOP.title);
    const history = await (await request(`${path}/revisions`, "GET", "readonly")).json();
    expect(history.items).toHaveLength(1); expect(history.items[0].revision).toBe(1);
  });
  it("uses revision CAS to reject two simultaneous edits and stale publication", async () => {
    const { request, create, store } = await fixture(); const { document } = await create();
    const responses = await Promise.all(["Editor A", "Editor B"].map((title) => request(`/${document.id}/revisions`, "POST", "technician", { ...SOP, title, expectedRevision: 1 })));
    expect(responses.map((response) => response.status).sort()).toEqual([201, 409]);
    expect((await store.listDocumentRevisions(document.id, { limit: 20 })).map((revision) => revision.revision)).toEqual([2, 1]);
    expect((await request(`/${document.id}/publish`, "POST", "admin", { expectedRevision: 1 })).status).toBe(409);
    const audit = await store.listAudit({ action: "document.revise", limit: 20 });
    expect(audit).toHaveLength(1); expect(JSON.parse(audit[0]!.details!).before.latestRevision).toBe(1);
  });
  it("archives without deleting history and can restore old content as a new revision", async () => {
    const { request, create, store } = await fixture(); const { document, revision } = await create();
    await request(`/${document.id}/revisions`, "POST", "technician", { ...SOP, title: "Replacement", expectedRevision: 1 });
    const restore = await request(`/${document.id}/revisions`, "POST", "technician", { ...SOP, expectedRevision: 2, changeSummary: "Restore revision 1 content" });
    expect(restore.status).toBe(201); expect((await restore.json()).revision.revision).toBe(3);
    expect(await store.getDocumentRevision(document.id, 1)).toEqual(revision);
    expect((await request(`/${document.id}/archive`, "POST", "admin", { expectedRevision: 3 })).status).toBe(200);
    expect((await request(`/${document.id}`, "GET", "readonly")).status).toBe(404);
    expect((await request(`/${document.id}/revisions`, "POST", "technician", { ...SOP, expectedRevision: 3 })).status).toBe(409);
    expect((await store.listDocumentRevisions(document.id, { limit: 20 }))).toHaveLength(3);
  });
  it("rolls back create, revision and approval when their audit append fails", async () => {
    const { store, users, create } = await fixture();
    const failing: Store = { ...store, transaction: (callback) => store.transaction((tx) => callback({ ...tx, appendAudit: async () => { throw new Error("audit unavailable"); } })) };
    await expect(createDocument(failing, "SOP-LAB-001", SOP, users.admin, "local")).rejects.toThrow("audit unavailable");
    expect(await store.getDocumentByCode("SOP-LAB-001")).toBeNull();
    expect(await store.countDocuments({})).toBe(0);
    const initial = await create();
    await expect(reviseDocument(failing, initial.document.id, 1, { ...SOP, title: "Uncommitted" }, users.admin, "local")).rejects.toThrow("audit unavailable");
    expect(await store.getDocument(initial.document.id)).toEqual(initial.document);
    expect(await store.listDocumentRevisions(initial.document.id, { limit: 20 })).toEqual([initial.revision]);
    await expect(transitionDocument(failing, initial.document.id, 1, "published", users.admin, "local")).rejects.toThrow("audit unavailable");
    expect(await store.getDocument(initial.document.id)).toEqual(initial.document);
  });
  it("exports the selected immutable revision with safe HTML and literal Markdown", async () => {
    const { request, create } = await fixture();
    const malicious = '<img src=x onerror="alert(1)"><script>alert(2)</script> [go](javascript:alert(3))';
    const { document } = await create({ ...SOP, title: malicious, sections: { ...SOP.sections, procedure: malicious } });
    const html = await request(`/${document.id}/export?revision=1&format=html`);
    const text = await html.text(); expect(text).not.toContain("<script>"); expect(text).not.toContain("<img src="); expect(text).toContain("&lt;script&gt;"); expect(text).not.toContain("href=");
    expect(html.headers.get("content-security-policy")).toContain("sandbox");
    const markdown = await (await request(`/${document.id}/export?revision=1&format=md`)).text(); expect(markdown).toContain(`\x60\x60\x60text\n${malicious}`);
    await request(`/${document.id}/revisions`, "POST", "technician", { ...SOP, expectedRevision: 1 });
    expect(await (await request(`/${document.id}/export?revision=1&format=html`)).text()).toBe(text);
  });
  it("produces deterministic docx ZIPs with SOP standards and correct metadata", async () => {
    const { request, create } = await fixture(); const { document, revision } = await create();
    const response = await request(`/${document.id}/export?revision=1&format=docx`); expect(response.status).toBe(200);
    const buffer = Buffer.from(await response.arrayBuffer());
    const xml = zipText(buffer, "word/document.xml");
    for (const required of [SOP.title, "SOP-LAB-001", "Revision 1", "Review date: 2020-01-01", "Purpose", "Scope", "Prerequisites", "Procedure", "Verification", "Escalation", "Stop writes.", "Compare asset counts"]) expect(xml).toContain(required);
    expect(zipText(buffer, "docProps/core.xml")).toContain(revision.actorEmail);
    expect(Buffer.from(await exportDocx(document, revision))).toEqual(buffer);
    expect(response.headers.get("content-disposition")).toContain("SOP-LAB-001-r1.docx");
  });
  it("documents its revision, approval, history, and export APIs in OpenAPI", async () => {
    const { app } = await fixture();
    const paths = (await (await app.request("/api/v1/openapi.json")).json()).paths;
    for (const path of ["/api/v1/documents", "/api/v1/documents/{id}", "/api/v1/documents/{id}/revisions", "/api/v1/documents/{id}/publish", "/api/v1/documents/{id}/archive", "/api/v1/documents/{id}/export"]) expect(paths[path]).toBeDefined();
  });
  it("preserves supported Unicode in DOCX while treating markup as plain text", async () => {
    const { request, create } = await fixture();
    const title = "Restore caf\u00e9 inventory \u{1f4cb}";
    const { document } = await create({ ...SOP, title, sections: { ...SOP.sections, procedure: "<script>literal & text</script> \u{1f4cb}" } });
    const response = await request(`/${document.id}/export?revision=1&format=docx`);
    expect(response.status).toBe(200);
    const xml = zipText(Buffer.from(await response.arrayBuffer()), "word/document.xml");
    expect(xml).toContain(title);
    expect(xml).toContain("&lt;script&gt;literal &amp; text&lt;/script&gt;");
    expect(xml).not.toContain("<script>");
    expect(xml).not.toContain("w:hyperlink");
  });
});
