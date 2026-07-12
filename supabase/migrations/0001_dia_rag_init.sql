-- DİA RAG — schema (ISOLATED in its own "dia_rag" schema)
-- Coin/other apps live in the "public" schema; this migration NEVER touches it.
-- It only CREATES a new schema + table + function. No DROP/ALTER on existing objects.
-- Run in Supabase Dashboard > SQL Editor.

create extension if not exists vector;

-- Dedicated, isolated namespace for the RAG.
create schema if not exists dia_rag;

create table if not exists dia_rag.documents (
  id bigint generated always as identity primary key,
  url text not null,
  title text,
  category text,
  chunk_index int not null default 0,
  content text not null,
  embedding vector(1024),
  created_at timestamptz default now(),
  unique (url, chunk_index)
);

create index if not exists documents_embedding_idx
  on dia_rag.documents using hnsw (embedding vector_cosine_ops);

-- RLS on: the table is not directly readable by anon.
-- Reads go through match_documents() (SECURITY DEFINER).
-- Writes (ingestion) use the service_role key, which bypasses RLS.
alter table dia_rag.documents enable row level security;

create or replace function dia_rag.match_documents(
  query_embedding vector(1024),
  match_count int default 40
)
returns table (
  id bigint, url text, title text, category text, content text, similarity float
)
-- search_path includes public so pgvector operators (<=>) resolve.
language sql stable security definer set search_path = dia_rag, public as $$
  select id, url, title, category, content,
    1 - (embedding <=> query_embedding) as similarity
  from dia_rag.documents
  where embedding is not null
  order by embedding <=> query_embedding
  limit match_count;
$$;

-- Grants so the app (anon key via PostgREST) can call the function,
-- and the service role can write during ingestion.
grant usage on schema dia_rag to anon, authenticated, service_role;
grant execute on function dia_rag.match_documents(vector, int) to anon, authenticated;
grant all on dia_rag.documents to service_role;
grant usage, select on all sequences in schema dia_rag to service_role;
