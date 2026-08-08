/**
 * Seed (or re-seed) the Postgres database with the synthetic catalog.
 *
 * Usage:
 *   bun run db:seed
 *   bun run scripts/seed.ts
 */
import { Store } from "../src/store.ts";
import { prisma } from "../src/db.ts";

async function main() {
  const store = new Store();
  await store.reset();
  const counts = await store.counts();
  console.log("Seeded synthetic catalog:", counts);
}

main()
  .catch((err) => {
    console.error("Seed failed:", err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
