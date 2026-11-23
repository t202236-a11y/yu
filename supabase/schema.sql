-- 성장노트 Supabase 표 만들기
-- 사용법: Supabase 대시보드 → SQL Editor → New query → 이 파일 내용 전체 붙여넣기 → Run
-- 여러 번 실행해도 안전하다.
--
-- 표 하나(planner_docs)에 '문서'를 경로(path)별로 한 줄씩 저장한다.
--   planner/main     상태 S 전체 {json: "...", savedAt}      ← 개발목표 5-1 A안
--   planner/bk-*     백업 {kind:'backup', json, savedAt, auto, note}
--   planner/sn-*     수정 전 기록 {kind:'snap', json, savedAt}
--   planner/inbox    Claude 넣기 상자 {items:[...]}
--   planner/brief    날씨·뉴스, planner/cool 쿨메신저 정리
-- 모든 줄에는 주인(user_id)이 있고, RLS로 본인 줄만 읽고 쓸 수 있다.

create table if not exists public.planner_docs (
  user_id    uuid        not null default auth.uid() references auth.users (id) on delete cascade,
  path       text        not null,
  kind       text,
  saved_at   bigint,
  data       jsonb       not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  primary key (user_id, path)
);

create index if not exists planner_docs_kind_idx on public.planner_docs (user_id, kind, saved_at desc);

-- 보안 규칙(RLS): 로그인한 본인 줄만
alter table public.planner_docs enable row level security;

drop policy if exists "planner_docs 본인 조회" on public.planner_docs;
drop policy if exists "planner_docs 본인 추가" on public.planner_docs;
drop policy if exists "planner_docs 본인 수정" on public.planner_docs;
drop policy if exists "planner_docs 본인 삭제" on public.planner_docs;

create policy "planner_docs 본인 조회" on public.planner_docs
  for select to authenticated using ((select auth.uid()) = user_id);
create policy "planner_docs 본인 추가" on public.planner_docs
  for insert to authenticated with check ((select auth.uid()) = user_id);
create policy "planner_docs 본인 수정" on public.planner_docs
  for update to authenticated using ((select auth.uid()) = user_id) with check ((select auth.uid()) = user_id);
create policy "planner_docs 본인 삭제" on public.planner_docs
  for delete to authenticated using ((select auth.uid()) = user_id);

-- 로그인하지 않은 사용자(anon)는 표에 아예 접근하지 못하게
revoke all on public.planner_docs from anon;
grant select, insert, update, delete on public.planner_docs to authenticated;

-- 다른 기기에서 바꾼 내용을 바로 받기 위한 실시간(Realtime) 켜기
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'planner_docs'
  ) then
    alter publication supabase_realtime add table public.planner_docs;
  end if;
end $$;
