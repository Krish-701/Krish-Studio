import { db } from "@/lib/db";
import { fail, ok, route, type Params } from "@/lib/api";
import { enqueue } from "@/lib/queue";
import { extractScriptText } from "@/lib/script/extract";
import { newKey, putFile } from "@/lib/storage";

export const maxDuration = 300;

/** Upload a script file (PDF/FDX/Fountain/TXT) or paste text; queues the breakdown into scenes + shots. */
export const POST = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  let text = "";
  let replace = true;
  const ct = req.headers.get("content-type") || "";
  if (ct.includes("multipart/form-data")) {
    const form = await req.formData();
    replace = form.get("replace") !== "false";
    const file = form.get("file");
    if (file instanceof File) {
      const buf = Buffer.from(await file.arrayBuffer());
      const mime = file.type || "text/plain";
      text = await extractScriptText(buf, file.name, mime);
      const key = newKey(id, "script", mime, file.name);
      const stored = await putFile(key, buf, mime);
      await db.asset.create({ data: { projectId: id, kind: "DOCUMENT", role: "SCRIPT", name: file.name, storageKey: stored.key, url: stored.url, mimeType: mime } });
    } else text = String(form.get("text") || "");
  } else {
    const b = await req.json();
    text = String(b.text || "");
    replace = b.replace !== false;
  }
  if (text.trim().length < 20) return fail("The script looks empty. If this is a scanned PDF, paste the text instead.");
  await db.project.update({ where: { id }, data: { scriptText: text, stage: "SCRIPT" } });
  const job = await enqueue({ projectId: id, type: "PARSE_SCRIPT", input: { text, replace }, maxAttempts: 1 });
  return ok({ jobId: job.id, chars: text.length });
});
