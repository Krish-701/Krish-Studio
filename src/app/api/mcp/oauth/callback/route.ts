import { finishOAuth } from "@/lib/mcp/oauth";
import { getSettings } from "@/lib/settings";
import { errorMessage } from "@/lib/utils";

/** The provider sends the browser back here after sign-in. */
export async function GET(req: Request) {
  const u = new URL(req.url);
  const code = u.searchParams.get("code");
  const state = u.searchParams.get("state") ?? "magnific";
  const err = u.searchParams.get("error_description") || u.searchParams.get("error");
  let title = "Connected";
  let body = "You can close this tab and go back to Krish Studio.";
  try {
    if (err || !code) throw new Error(err || "No sign-in code returned.");
    const cfg = await finishOAuth((await getSettings()).mcpServers, code, state);
    title = `${cfg.name} connected`;
  } catch (e) {
    title = "Sign-in failed";
    body = errorMessage(e);
  }
  const html = `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="background:#0b0b10;color:#eee;font-family:system-ui;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><h2>${title}</h2><p style="color:#aaa">${body.replace(/</g, "&lt;")}</p><p><a style="color:#f5a524" href="/settings">Back to Settings</a></p></div><script>try{window.opener&&window.opener.postMessage({type:"mcp-oauth",ok:${title !== "Sign-in failed"}},"*");setTimeout(()=>window.close(),1500)}catch(e){}</script></body>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}
