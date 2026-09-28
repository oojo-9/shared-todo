-- 공유 투두 · Supabase 스키마
-- Supabase 대시보드 > SQL Editor에 통째로 붙여 넣고 Run 하면 된다.
-- 권한 원칙: "연결이 수락된 상대만, 공개 카테고리만" 볼 수 있다. 수정은 본인 것만.

create extension if not exists pgcrypto;

-- ---------- 초대 코드 ----------
create or replace function public.gen_invite_code()
returns text language plpgsql as $$
declare
  chars constant text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  code text;
begin
  loop
    code := '';
    for i in 1..6 loop
      code := code || substr(chars, 1 + floor(random() * length(chars))::int, 1);
    end loop;
    exit when not exists (select 1 from public.users where invite_code = code);
  end loop;
  return code;
end $$;

-- ---------- 테이블 ----------
create table if not exists public.users (
  id          uuid primary key references auth.users(id) on delete cascade,
  nickname    text not null unique check (char_length(nickname) between 2 and 20 and nickname !~ '\s'),
  invite_code text not null unique default public.gen_invite_code(),
  created_at  timestamptz not null default now()
);

create table if not exists public.categories (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null default auth.uid() references public.users(id) on delete cascade,
  name       text not null check (char_length(name) between 1 and 20),
  color      text not null default '#3b7ddd' check (color ~ '^#[0-9a-fA-F]{6}$'),
  is_public  boolean not null default true,
  sort       int not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists public.todos (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null default auth.uid() references public.users(id) on delete cascade,
  category_id uuid references public.categories(id) on delete cascade,
  date        date not null,
  title       text not null check (char_length(title) between 1 and 200),
  status      text not null default 'todo' check (status in ('todo', 'doing', 'done')),
  sort        double precision not null default 0,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table if not exists public.shares (
  id         uuid primary key default gen_random_uuid(),
  owner_id   uuid not null references public.users(id) on delete cascade,  -- 목록 주인
  viewer_id  uuid not null references public.users(id) on delete cascade,  -- 보는 사람
  status     text not null default 'requested' check (status in ('requested', 'accepted', 'revoked')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (owner_id, viewer_id),
  check (owner_id <> viewer_id)
);

create index if not exists todos_user_date_idx on public.todos (user_id, date);
create index if not exists categories_user_idx on public.categories (user_id);
create index if not exists shares_viewer_idx on public.shares (viewer_id, status);

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin new.updated_at := now(); return new; end $$;

drop trigger if exists todos_touch on public.todos;
create trigger todos_touch before update on public.todos
  for each row execute function public.touch_updated_at();

-- ---------- 권한 확인 함수 ----------
create or replace function public.can_view(target uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select target = auth.uid() or exists (
    select 1 from shares
    where owner_id = target and viewer_id = auth.uid() and status = 'accepted'
  );
$$;

create or replace function public.is_public_category(cat uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select cat is null or exists (select 1 from categories where id = cat and is_public);
$$;

-- ---------- 테이블 접근 권한 ----------
-- ("Automatically expose new tables"를 꺼 둔 프로젝트에서도 동작하도록 명시한다.
--  실제로 어떤 행을 볼 수 있는지는 아래 RLS가 정한다. 로그인 안 한 anon은 접근 불가.)
revoke all on public.users, public.categories, public.todos, public.shares from anon;
grant select, insert, update on public.users to authenticated;
grant select, insert, update, delete on public.categories, public.todos to authenticated;
grant select on public.shares to authenticated;

-- ---------- Row Level Security ----------
alter table public.users      enable row level security;
alter table public.categories enable row level security;
alter table public.todos      enable row level security;
alter table public.shares     enable row level security;

drop policy if exists users_select on public.users;
create policy users_select on public.users for select to authenticated using (
  id = auth.uid() or exists (
    select 1 from public.shares s
    where (s.owner_id = users.id and s.viewer_id = auth.uid())
       or (s.viewer_id = users.id and s.owner_id = auth.uid())
  )
);
drop policy if exists users_insert on public.users;
create policy users_insert on public.users for insert to authenticated with check (id = auth.uid());
drop policy if exists users_update on public.users;
create policy users_update on public.users for update to authenticated using (id = auth.uid()) with check (id = auth.uid());

drop policy if exists categories_select on public.categories;
create policy categories_select on public.categories for select to authenticated using (
  user_id = auth.uid() or (is_public and public.can_view(user_id))
);
drop policy if exists categories_write on public.categories;
create policy categories_write on public.categories for all to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

drop policy if exists todos_select on public.todos;
create policy todos_select on public.todos for select to authenticated using (
  user_id = auth.uid() or (public.can_view(user_id) and public.is_public_category(category_id))
);
drop policy if exists todos_write on public.todos;
create policy todos_write on public.todos for all to authenticated
  using (user_id = auth.uid())
  with check (
    user_id = auth.uid()
    and (category_id is null or exists (select 1 from public.categories c where c.id = category_id and c.user_id = auth.uid()))
  );

-- shares는 조회만 직접 허용하고, 요청·수락·해제는 아래 함수로만 바꾼다
drop policy if exists shares_select on public.shares;
create policy shares_select on public.shares for select to authenticated using (
  owner_id = auth.uid() or viewer_id = auth.uid()
);

-- ---------- 공유 함수 ----------
create or replace function public._accept_pair(a uuid, b uuid)
returns void language sql security definer set search_path = public as $$
  insert into shares (owner_id, viewer_id, status) values (a, b, 'accepted'), (b, a, 'accepted')
  on conflict (owner_id, viewer_id) do update set status = 'accepted', updated_at = now();
$$;
revoke execute on function public._accept_pair(uuid, uuid) from public, anon, authenticated;

-- 아이디(닉네임) 또는 초대 코드로 상대에게 연결 요청. 반환: 'requested' | 'accepted'
create or replace function public.request_share(target text)
returns text language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  q text := btrim(target);
  t uuid;
  mine_status text;
begin
  if me is null then raise exception '로그인이 필요해요'; end if;
  if not exists (select 1 from users where id = me) then raise exception '아이디를 먼저 만들어 주세요'; end if;
  select id into t from users where invite_code = upper(q) or nickname = q limit 1;
  if t is null then raise exception '해당 아이디나 초대 코드를 찾을 수 없어요'; end if;
  if t = me then raise exception '자기 자신은 추가할 수 없어요'; end if;

  select status into mine_status from shares where owner_id = t and viewer_id = me;
  if mine_status = 'accepted' then raise exception '이미 연결된 상대예요'; end if;

  -- 상대가 먼저 나에게 요청해 두었다면 바로 연결
  if exists (select 1 from shares where owner_id = me and viewer_id = t and status = 'requested') then
    perform _accept_pair(me, t);
    return 'accepted';
  end if;
  if mine_status = 'requested' then raise exception '이미 요청을 보냈어요. 상대의 수락을 기다려 주세요'; end if;

  insert into shares (owner_id, viewer_id, status) values (t, me, 'requested')
  on conflict (owner_id, viewer_id) do update set status = 'requested', updated_at = now();
  return 'requested';
end $$;

-- 받은 요청 수락/거절. 수락하면 서로 볼 수 있게 양방향으로 연결한다.
create or replace function public.respond_share(share_id uuid, accept boolean)
returns void language plpgsql security definer set search_path = public as $$
declare
  s shares%rowtype;
begin
  select * into s from shares where id = share_id and owner_id = auth.uid() and status = 'requested';
  if s.id is null then raise exception '처리할 요청을 찾을 수 없어요'; end if;
  if accept then
    perform _accept_pair(s.owner_id, s.viewer_id);
  else
    update shares set status = 'revoked', updated_at = now() where id = s.id;
  end if;
end $$;

-- 연결 해제 또는 보낸 요청 취소 (언제든 한쪽에서 가능)
create or replace function public.revoke_share(partner uuid)
returns void language sql security definer set search_path = public as $$
  update shares set status = 'revoked', updated_at = now()
  where (owner_id = auth.uid() and viewer_id = partner)
     or (owner_id = partner and viewer_id = auth.uid());
$$;

-- 앱 안에서 계정 삭제 (애플 심사 요건). 모든 데이터가 cascade로 지워진다.
create or replace function public.delete_account()
returns void language sql security definer set search_path = public, auth as $$
  delete from auth.users where id = auth.uid();
$$;

revoke execute on function public.request_share(text), public.respond_share(uuid, boolean),
  public.revoke_share(uuid), public.delete_account() from public, anon;
grant execute on function public.request_share(text), public.respond_share(uuid, boolean),
  public.revoke_share(uuid), public.delete_account() to authenticated;

-- ---------- 실시간 ----------
-- Realtime은 구독자의 RLS를 적용해, 볼 수 있는 행의 변경만 전달한다.
do $$
declare t text;
begin
  foreach t in array array['todos', 'categories', 'shares', 'users'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;
