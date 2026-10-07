import { Document, HeadingLevel, Packer, Paragraph, TextRun } from "docx";
import { DOCUMENT_SECTIONS, type DocumentRecord, type DocumentRevision } from "../../db/documents.types";

export const sectionLabels = { purpose: "Purpose", scope: "Scope", prerequisites: "Prerequisites", procedure: "Procedure", verification: "Verification", escalation: "Escalation" } as const;
export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}
/** Plain text authoring: never evaluate HTML, Markdown, images, or link schemes. */
export function exportHtml(document: DocumentRecord, revision: DocumentRevision): string {
  const metadata = `${document.code} | Revision ${revision.revision} | Review date: ${revision.reviewDate}`;
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(document.code)} - ${escapeHtml(revision.title)}</title><style>body{max-width:50rem;margin:2rem auto;padding:0 1rem;font:16px/1.5 system-ui}pre{font:inherit;white-space:pre-wrap;overflow-wrap:anywhere}h2{border-bottom:1px solid #ccc}</style></head><body><h1>${escapeHtml(revision.title)}</h1><p>${escapeHtml(metadata)}</p><p>Author: ${escapeHtml(revision.actorEmail)} | ${escapeHtml(new Date(revision.createdAt).toISOString())}</p>${DOCUMENT_SECTIONS.map((key) => `<section><h2>${sectionLabels[key]}</h2><pre>${escapeHtml(revision.sections[key])}</pre></section>`).join("")}<footer>Change summary: ${escapeHtml(revision.changeSummary)}</footer></body></html>\n`;
}
/** Fence contents as text to preserve safe semantics when opened in a Markdown reader. */
function fenced(value: string): string {
  const runs = value.match(/`+/g) ?? [];
  const fence = "`".repeat(Math.max(3, ...runs.map((run) => run.length + 1)));
  return `${fence}text\n${value}\n${fence}`;
}
export function exportMarkdown(document: DocumentRecord, revision: DocumentRevision): string {
  return [`# ${document.code}`, fenced(revision.title), `Revision: ${revision.revision}  \nReview date: ${revision.reviewDate}`, "## Author", fenced(`${revision.actorEmail}\n${new Date(revision.createdAt).toISOString()}`), ...DOCUMENT_SECTIONS.flatMap((key) => [`## ${sectionLabels[key]}`, fenced(revision.sections[key])]), "## Change summary", fenced(revision.changeSummary), ""].join("\n\n");
}
export async function exportDocx(document: DocumentRecord, revision: DocumentRevision): Promise<Uint8Array> {
  const paragraph = (text: string) => new Paragraph({ children: [new TextRun(text)] });
  const doc = new Document({ creator: "Hatcheck", title: `${document.code} - ${revision.title}`, description: `Immutable revision ${revision.revision}`, sections: [{ children: [
    new Paragraph({ text: revision.title, heading: HeadingLevel.TITLE }),
    paragraph(`${document.code} | Revision ${revision.revision} | Review date: ${revision.reviewDate}`),
    paragraph(`Author: ${revision.actorEmail} | ${new Date(revision.createdAt).toISOString()}`),
    ...DOCUMENT_SECTIONS.flatMap((key) => [new Paragraph({ text: sectionLabels[key], heading: HeadingLevel.HEADING_1 }), ...revision.sections[key].split(/\r?\n/).map(paragraph)]),
    new Paragraph({ text: "Change summary", heading: HeadingLevel.HEADING_1 }), paragraph(revision.changeSummary),
  ] }] });
  const timestamp = new Date(revision.createdAt).toISOString();
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeHtml(document.code)} - ${escapeHtml(revision.title)}</dc:title><dc:creator>${escapeHtml(revision.actorEmail)}</dc:creator><cp:revision>${revision.revision}</cp:revision><dcterms:created xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:modified></cp:coreProperties>`;
  const buffer = await Packer.toBuffer(doc, false, [{ path: "docProps/core.xml", data: core }]);
  // ZIP entry timestamps otherwise depend on export time. Normalize both
  // local and central headers without changing payloads or CRCs.
  let offset = 0;
  while (offset < buffer.length - 4) {
    const signature = buffer.readUInt32LE(offset);
    if (signature === 0x04034b50) {
      buffer.writeUInt16LE(0, offset + 10);
      buffer.writeUInt16LE(33, offset + 12);
      offset += 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28) + buffer.readUInt32LE(offset + 18);
    } else if (signature === 0x02014b50) {
      buffer.writeUInt16LE(0, offset + 12);
      buffer.writeUInt16LE(33, offset + 14);
      offset += 46 + buffer.readUInt16LE(offset + 28) + buffer.readUInt16LE(offset + 30) + buffer.readUInt16LE(offset + 32);
    } else if (signature === 0x06054b50) break;
    else throw new Error("Unsupported generated docx ZIP layout");
  }
  return buffer;
}
