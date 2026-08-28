-- Raise HNSW recall for match_documents.
--
-- The approximate index only explores `hnsw.ef_search` candidates while walking
-- the graph. With the Supabase default (~40) and a larger match_count (now 100
-- from the app), the index could not return that many high-quality neighbours —
-- the extra candidates were padded with worse matches, so genuinely relevant
-- chunks were missed. Raising ef_search well above match_count fixes the ceiling.
--
-- NOTE: on Supabase the `postgres` role may NOT set `hnsw.ef_search` in a
-- function's SET clause (ERROR 42501). So we set it at runtime inside a plpgsql
-- body via set_config(..., is_local => true) — scoped to this call's transaction,
-- so it never leaks to the rest of the database.
--
-- Only CREATE OR REPLACE on the existing dia_rag function; touches nothing else.

create or replace function dia_rag.match_documents(
  query_embedding vector(1024),
  match_count int default 40
)
returns table (
  id bigint, url text, title text, category text, content text, similarity float
)
language plpgsql stable security definer
set search_path = dia_rag, public
as $$
begin
  perform set_config('hnsw.ef_search', '200', true);  -- true = local to this call
  return query
    select d.id, d.url, d.title, d.category, d.content,
      1 - (d.embedding <=> query_embedding) as similarity
    from dia_rag.documents d
    where d.embedding is not null
    order by d.embedding <=> query_embedding
    limit match_count;
end;
$$;
