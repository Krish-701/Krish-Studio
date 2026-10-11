import type { PrismaClient } from "@prisma/client";
import { localDb } from "./local-store";
import { noDatabase } from "./runtime";

const g = globalThis as unknown as { prisma?: PrismaClient };

function create(): PrismaClient {
  // KRISH_NO_DB keeps films in data/studio.json. Postgres is never opened.
  if (noDatabase()) return localDb as unknown as PrismaClient;
  if (!g.prisma) {
    const { PrismaClient } = require("@prisma/client") as typeof import("@prisma/client");
    g.prisma = new PrismaClient();
  }
  return g.prisma;
}

export const db = create();
