-- 공유 투두 · 콕 찌르기 🔔 (상대가 오늘 새로 적은 할 일이 없을 때 푸시로 재촉)
-- 007_time_alerts.sql 다음에 SQL Editor에서 실행한다. 여러 번 실행해도 안전하다.
--   연결된 상대에게만, 한 사람에게 하루(한국 시간) 3번까지 보낼 수 있다.

create table if not exists public.nudges (
  id         uuid primary key default gen_random_uuid(),
  from_id    uuid not null references public.users(id) on delete cascade,
  to_id      uuid not null references public.users(id) on delete cascade,
  created_at timestamptz not null default now()
);
create index if not exists nudges_pair_idx on public.nudges (from_id, to_id, created_at);

-- 표는 함수로만 다룬다 (앱에서 직접 읽고 쓰지 못함)
alter table public.nudges enable row level security;
revoke all on public.nudges from anon, authenticated;

-- 보내고 오늘 남은 횟수를 돌려준다
create or replace function public.send_nudge(partner uuid)
returns integer language plpgsql security definer set search_path = public as $$
declare
  me uuid := auth.uid();
  day_start timestamptz := date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
  used integer;
  my_name text;
  hook_secret text;
begin
  if me is null then raise exception '로그인이 필요해요'; end if;
  if not exists (select 1 from shares where owner_id = partner and viewer_id = me and status = 'accepted') then
    raise exception '연결된 상대에게만 보낼 수 있어요';
  end if;

  -- 같은 사람에게 동시에 여러 번 눌러도 3번을 넘지 않게
  perform pg_advisory_xact_lock(hashtext(me::text || partner::text));
  select count(*) into used from nudges where from_id = me and to_id = partner and created_at >= day_start;
  if used >= 3 then raise exception '오늘은 3번 모두 보냈어요. 내일 다시 찔러 주세요'; end if;

  insert into nudges (from_id, to_id) values (me, partner);
  select nickname into my_name from users where id = me;

  select decrypted_secret into hook_secret from vault.decrypted_secrets where name = 'push_hook_secret';
  if hook_secret is not null then
    perform net.http_post(
      url := 'https://wzdlityqbmrebumfooyv.supabase.co/functions/v1/notify-done',
      body := jsonb_build_object('type', 'user', 'user_id', partner,
        'title', '🔔 ' || coalesce(my_name, '친구') || '님이 콕 찔렀어요',
        'body', '오늘의 할 일이 없을 리가 없는데? 🤔',
        'tag', 'nudge-' || me),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', hook_secret),
      timeout_milliseconds := 30000
    );
  end if;
  return 3 - used - 1;
end $$;

-- 오늘 이 상대에게 남은 횟수 (벨 옆 숫자 표시용)
create or replace function public.nudges_left(partner uuid)
returns integer language sql stable security definer set search_path = public as $$
  select greatest(0, 3 - count(*))::integer from nudges
  where from_id = auth.uid() and to_id = partner
    and created_at >= date_trunc('day', now() at time zone 'Asia/Seoul') at time zone 'Asia/Seoul';
$$;

revoke execute on function public.send_nudge(uuid), public.nudges_left(uuid) from public, anon;
grant execute on function public.send_nudge(uuid), public.nudges_left(uuid) to authenticated;

notify pgrst, 'reload schema';
