-- 공유 투두 · 찰칵 📷 (진행중인 할 일에 사진 등록, 피드로 보기)
-- 008_nudge.sql 다음에 SQL Editor에서 실행한다. 여러 번 실행해도 안전하다.
--   사진 파일은 Storage의 비공개 보관함 'photos'에 '주인id/파일이름.jpg'로 들어가고,
--   어떤 할 일의 사진인지는 public.photos 표에 적는다.
--   보기 권한은 할 일과 같다: 연결이 수락된 상대만, 공개 카테고리의 할 일에 붙은 사진만.
--   할 일을 지우면 표의 사진 줄도 함께 지워지고(cascade), 파일은 photo_trash에 적어 두었다가
--   주인의 앱이 Storage에서 지운다 (DB에서 Storage 파일을 직접 지울 수는 없어서).

-- ---------- 보관함 ----------
-- 앱이 올리기 전에 줄여서 보내지만, 서버에서도 1MB·JPEG만 받도록 막는다
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('photos', 'photos', false, 1048576, array['image/jpeg'])
on conflict (id) do update
  set public = false, file_size_limit = 1048576, allowed_mime_types = array['image/jpeg'];

-- ---------- 표 ----------
create table if not exists public.photos (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references public.users(id) on delete cascade,
  todo_id    uuid not null references public.todos(id) on delete cascade,
  path       text not null unique,
  size       integer not null default 0,
  width      integer,
  height     integer,
  created_at timestamptz not null default now()
);
create index if not exists photos_created_idx on public.photos (created_at desc);
create index if not exists photos_user_idx on public.photos (user_id);
create index if not exists photos_todo_idx on public.photos (todo_id);

-- 지워야 할 파일 목록 (주인이 사라진 뒤에도 남을 수 있게 users를 참조하지 않는다)
create table if not exists public.photo_trash (
  path       text primary key,
  user_id    uuid not null,
  created_at timestamptz not null default now()
);

create or replace function public.photos_to_trash()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into photo_trash (path, user_id) values (old.path, old.user_id) on conflict (path) do nothing;
  return old;
end $$;

drop trigger if exists photos_trash on public.photos;
create trigger photos_trash after delete on public.photos
  for each row execute function public.photos_to_trash();

-- ---------- 접근 권한 ----------
revoke all on public.photos, public.photo_trash from anon;
grant select, insert, delete on public.photos to authenticated;
grant select, delete on public.photo_trash to authenticated;

alter table public.photos      enable row level security;
alter table public.photo_trash enable row level security;

drop policy if exists photos_select on public.photos;
create policy photos_select on public.photos for select to authenticated using (
  user_id = auth.uid() or exists (
    select 1 from public.todos t
    where t.id = todo_id and public.can_view(t.user_id) and public.is_public_category(t.category_id)
  )
);
-- 내 할 일에만, 내 폴더의 파일만 등록할 수 있다
drop policy if exists photos_insert on public.photos;
create policy photos_insert on public.photos for insert to authenticated with check (
  user_id = auth.uid()
  and path like auth.uid()::text || '/%'
  and exists (select 1 from public.todos t where t.id = todo_id and t.user_id = auth.uid())
);
drop policy if exists photos_delete on public.photos;
create policy photos_delete on public.photos for delete to authenticated using (user_id = auth.uid());

drop policy if exists photo_trash_select on public.photo_trash;
create policy photo_trash_select on public.photo_trash for select to authenticated using (user_id = auth.uid());
drop policy if exists photo_trash_delete on public.photo_trash;
create policy photo_trash_delete on public.photo_trash for delete to authenticated using (user_id = auth.uid());

-- ---------- Storage 파일 권한 ----------
-- 보기: 내 폴더이거나, 내가 볼 수 있는 사진 줄(위 photos_select)에 적힌 파일
drop policy if exists photos_obj_select on storage.objects;
create policy photos_obj_select on storage.objects for select to authenticated using (
  bucket_id = 'photos' and (
    (storage.foldername(name))[1] = auth.uid()::text
    or exists (select 1 from public.photos p where p.path = objects.name)
  )
);
drop policy if exists photos_obj_insert on storage.objects;
create policy photos_obj_insert on storage.objects for insert to authenticated with check (
  bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text
);
drop policy if exists photos_obj_delete on storage.objects;
create policy photos_obj_delete on storage.objects for delete to authenticated using (
  bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text
);

-- ---------- 사용량 ----------
-- 설정 화면의 "사진 용량" 표시용. total은 모든 사용자의 파일을 합친 값 (무료 요금제 한도가 프로젝트 전체 기준이라서)
create or replace function public.photo_usage()
returns json language sql stable security definer set search_path = public as $$
  select json_build_object(
    'total', coalesce(sum((metadata->>'size')::bigint), 0),
    'mine', coalesce(sum((metadata->>'size')::bigint)
      filter (where bucket_id = 'photos' and (storage.foldername(name))[1] = auth.uid()::text), 0))
  from storage.objects;
$$;
revoke execute on function public.photo_usage() from public, anon;
grant execute on function public.photo_usage() to authenticated;

-- ---------- 실시간 ----------
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'photos'
  ) then
    alter publication supabase_realtime add table public.photos;
  end if;
end $$;

notify pgrst, 'reload schema';
