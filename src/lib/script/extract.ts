/** Extracts plain text from an uploaded script (PDF, Fountain, FDX, TXT, Markdown). */
export async function extractScriptText(buf: Buffer, name: string, mime: string): Promise<string> {
  if (mime === "application/pdf" || /\.pdf$/i.test(name)) {
    const { extractText, getDocumentProxy } = await import("unpdf");
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: false });
    return (Array.isArray(text) ? text.join("\n\n") : text).replace(/\r/g, "");
  }
  let text = buf.toString("utf8").replace(/\r/g, "");
  if (/\.fdx$/i.test(name)) {
    // Final Draft XML → plain screenplay text
    text = [...text.matchAll(/<Paragraph[^>]*Type="([^"]+)"[^>]*>([\s\S]*?)<\/Paragraph>/g)]
      .map(([, type, inner]) => {
        const t = [...inner.matchAll(/<Text[^>]*>([\s\S]*?)<\/Text>/g)].map((m) => m[1]).join("");
        return type === "Scene Heading" || type === "Character" ? `\n${t.toUpperCase()}` : t;
      })
      .join("\n");
  }
  return text;
}
