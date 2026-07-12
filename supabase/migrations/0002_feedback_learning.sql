-- DİA RAG — conversations + feedback (learning loop). Additive, dia_rag schema.
-- Run in Supabase Dashboard > SQL Editor.

-- One row per assistant answer (for feedback + learning).
create table if not exists dia_rag.conversations (
  id uuid primary key default gen_random_uuid(),
  session_id text,
  question text,
  has_image boolean default false,
  screen text,               -- vision-derived screen/module description
  answer text,
  sources jsonb,
  created_at timestamptz default now()
);

-- User feedback on an answer.
create table if not exists dia_rag.feedback (
  id bigint generated always as identity primary key,
  conversation_id uuid references dia_rag.conversations(id) on delete cascade,
  helpful boolean,           -- true = worked, false = didn't
  correction text,           -- user's correct steps, if provided
  learned boolean default false,  -- folded into the corpus?
  created_at timestamptz default now()
);

create index if not exists conversations_created_idx on dia_rag.conversations (created_at desc);
create index if not exists feedback_conversation_idx on dia_rag.feedback (conversation_id);

alter table dia_rag.conversations enable row level security;
alter table dia_rag.feedback enable row level security;

grant all on dia_rag.conversations to service_role;
grant all on dia_rag.feedback to service_role;
grant usage, select on all sequences in schema dia_rag to service_role;

-- Note: learned solutions are stored back into dia_rag.documents with
-- category = 'learned' and url = 'learned://<conversation_id>', so they are
-- retrieved by the same match_documents() function. Review them with:
--   select url, title, created_at from dia_rag.documents where category='learned';
