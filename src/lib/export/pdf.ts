import { promises as fs } from "fs";
import path from "path";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";
import { db } from "../db";
import { ffmpeg, tmpDir } from "../ffmpeg";
import { localPath, newKey, putFile } from "../storage";

/** Storyboard PDF: landscape A4, 6 frames per page with shot metadata and dialogue. */
export async function exportStoryboardPdf(projectId: string, onProgress: (pct: number, step: string) => void | Promise<void>) {
  const project = await db.project.findUniqueOrThrow({ where: { id: projectId } });
  const shots = await db.shot.findMany({ where: { projectId }, orderBy: { order: "asc" }, include: { scene: true, characters: { include: { character: true } } } });
  const images = await db.asset.findMany({ where: { id: { in: shots.map((s) => s.imageAssetId).filter((x): x is string => !!x) } } });
  const byId = new Map(images.map((a) => [a.id, a]));

  const pdf = await PDFDocument.create();
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const dir = await tmpDir();
  const PW = 842, PH = 595, M = 32, COLS = 3, ROWS = 2;
  const cellW = (PW - M * 2 - 16 * (COLS - 1)) / COLS;
  const [ar1, ar2] = project.aspectRatio.split(":").map(Number);
  const imgH = Math.min(cellW * (ar2 / ar1), 150);
  const cellH = (PH - M * 2 - 40 - 16 * (ROWS - 1)) / ROWS;
  const clean = (s: string) => s.replace(/[^\x20-\x7E]/g, (c) => ({ "“": '"', "”": '"', "’": "'", "‘": "'", "—": "-", "–": "-", "…": "..." })[c] ?? "");

  const wrap = (text: string, size: number, width: number, maxLines: number) => {
    const words = clean(text).split(/\s+/);
    const lines: string[] = [];
    let line = "";
    for (const w of words) {
      const next = line ? `${line} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) > width) {
        lines.push(line);
        line = w;
        if (lines.length >= maxLines) break;
      } else line = next;
    }
    if (line && lines.length < maxLines) lines.push(line);
    return lines;
  };

  let page = pdf.addPage([PW, PH]);
  const header = (n: number) => {
    page.drawRectangle({ x: 0, y: 0, width: PW, height: PH, color: rgb(0.06, 0.06, 0.07) });
    page.drawText(clean(project.title.toUpperCase()), { x: M, y: PH - M - 8, size: 14, font: bold, color: rgb(0.96, 0.62, 0.04) });
    page.drawText(`STORYBOARD  -  page ${n}`, { x: PW - M - 140, y: PH - M - 8, size: 9, font, color: rgb(0.6, 0.6, 0.6) });
  };
  header(1);

  for (const [i, s] of shots.entries()) {
    const slot = i % (COLS * ROWS);
    if (i > 0 && slot === 0) {
      page = pdf.addPage([PW, PH]);
      header(Math.floor(i / (COLS * ROWS)) + 1);
    }
    await onProgress(5 + Math.round((i / shots.length) * 90), `Laying out shot ${i + 1}/${shots.length}`);
    const col = slot % COLS, row = Math.floor(slot / COLS);
    const x = M + col * (cellW + 16);
    const top = PH - M - 40 - row * (cellH + 16);
    const asset = s.imageAssetId ? byId.get(s.imageAssetId) : null;
    page.drawRectangle({ x, y: top - imgH, width: cellW, height: imgH, color: rgb(0.12, 0.12, 0.14) });
    if (asset?.storageKey) {
      try {
        const out = path.join(dir, `${i}.jpg`);
        await ffmpeg(["-i", await localPath(asset.storageKey), "-vf", "scale=640:-2", "-frames:v", "1", "-q:v", "4", out]);
        const jpg = await pdf.embedJpg(await fs.readFile(out));
        const scale = Math.min(cellW / jpg.width, imgH / jpg.height);
        const w = jpg.width * scale, h = jpg.height * scale;
        page.drawImage(jpg, { x: x + (cellW - w) / 2, y: top - imgH + (imgH - h) / 2, width: w, height: h });
      } catch {}
    }
    let y = top - imgH - 14;
    page.drawText(`#${s.order + 1}`, { x, y, size: 10, font: bold, color: rgb(0.96, 0.62, 0.04) });
    page.drawText(clean(`${s.shotType ?? ""}  ${s.cameraMove ?? ""}  ${s.durationSec}s`).slice(0, 60), { x: x + 30, y, size: 7.5, font, color: rgb(0.6, 0.6, 0.65) });
    y -= 12;
    for (const l of wrap(s.title, 8.5, cellW, 1)) {
      page.drawText(l, { x, y, size: 8.5, font: bold, color: rgb(0.92, 0.92, 0.92) });
      y -= 11;
    }
    for (const l of wrap(s.description, 7.5, cellW, s.dialogue ? 3 : 5)) {
      page.drawText(l, { x, y, size: 7.5, font, color: rgb(0.75, 0.75, 0.78) });
      y -= 9.5;
    }
    if (s.dialogue) {
      for (const l of wrap(`${s.speaker ?? ""}: "${s.dialogue}"`, 7.5, cellW, 2)) {
        page.drawText(l, { x, y, size: 7.5, font, color: rgb(0.55, 0.85, 0.95) });
        y -= 9.5;
      }
    }
  }

  const bytes = await pdf.save();
  await fs.rm(dir, { recursive: true, force: true });
  const key = newKey(projectId, "exports", "application/pdf");
  const stored = await putFile(key, Buffer.from(bytes), "application/pdf");
  const asset = await db.asset.create({
    data: { projectId, kind: "DOCUMENT", role: "EXPORT", name: `${project.title} - storyboard.pdf`, storageKey: stored.key, url: stored.url, mimeType: "application/pdf" },
  });
  return { assetId: asset.id, url: asset.url };
}
