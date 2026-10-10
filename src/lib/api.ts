import { NextResponse } from "next/server";
import { errorMessage } from "./utils";

export function ok(data: unknown, init?: number) {
  return NextResponse.json(data, { status: init ?? 200 });
}

export function fail(message: string, status = 400) {
  return NextResponse.json({ error: message }, { status });
}

/** Wraps a route handler with uniform error handling. */
export function route<A extends unknown[]>(fn: (...args: A) => Promise<Response>) {
  return async (...args: A) => {
    try {
      return await fn(...args);
    } catch (e) {
      const msg = errorMessage(e);
      console.error("[api]", msg);
      const status = /not ?found|No .* found/i.test(msg) ? 404 : 500;
      return fail(msg, status);
    }
  };
}

export type Params<T extends string> = { params: Promise<Record<T, string>> };
