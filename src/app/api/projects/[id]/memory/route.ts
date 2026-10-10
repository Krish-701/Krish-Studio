import { fail, ok, route, type Params } from "@/lib/api";
import { listMemory, writeMemory } from "@/lib/memory";

/** GET ?q=&category= — the project's shared memory. */
export const GET = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const u = new URL(req.url);
  return ok(await listMemory(id, { query: u.searchParams.get("q") ?? undefined, category: u.searchParams.get("category") ?? undefined }));
});

/** POST { key, content, category?, pinned? } — add (or update by key) an entry as the user. */
export const POST = route(async (req: Request, { params }: Params<"id">) => {
  const { id } = await params;
  const b = await req.json();
  if (!b.key?.trim() || !b.content?.trim()) return fail("Key and content are required");
  return ok(await writeMemory(id, { key: b.key, content: b.content, category: b.category, pinned: b.pinned }, "USER"));
});
