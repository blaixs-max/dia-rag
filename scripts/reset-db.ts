/**
 * Danger: deletes all rows from dia_documents (keeps the table/schema).
 * Usage: npm run reset-db
 */
import "./_env";
import { getAdminClient } from "../src/lib/supabase";

async function main() {
  const supabase = getAdminClient();
  const { error } = await supabase
    .schema("dia_rag")
    .from("documents")
    .delete()
    .neq("id", 0);
  if (error) throw new Error(error.message);
  console.log("✓ dia_rag.documents cleared.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
