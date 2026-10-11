/** True when this process should not open Postgres. Set KRISH_NO_DB=1 in .env. */
export function noDatabase() {
  return process.env.KRISH_NO_DB === "1";
}
