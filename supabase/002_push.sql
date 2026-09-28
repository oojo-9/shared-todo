-- 공유 투두 · 푸시 알림 (친구가 할 일을 완료했을 때)
-- schema.sql 다음에 SQL Editor에서 한 번 실행한다. 여러 번 실행해도 안전하다.
-- 실행 뒤, 전송용 비밀값을 Vault에 넣는 한 줄을 따로 실행해야 한다 (README 참고, 비밀값은 저장소에 올리지 않음).

create extension if not exists pg_net;

-- 친구별 완료 알림 켜기/끄기: (owner=친구, viewer=나) 행의 notify를 내가 정한다
alter table public.shares add column if not exists notify boolean not null default true;

-- 기기별 푸시 구독 정보
create table if not exists public.push_subscriptions (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references public.users(id) on delete cascade,
  endpoint   text not null unique,
  p256dh     text not null,
  auth       text not null,
  created_at timestamptz not null default now()
);
create index if not exists push_subscriptions_user_idx on public.push_subscriptions (user_id);

alter table public.push_subscriptions enable row level security;
revoke all on public.push_subscriptions from anon;
grant select on public.push_subscriptions to authenticated;
drop policy if exists push_select on public.push_subscriptions;
create policy push_select on public.push_subscriptions for select to authenticated using (user_id = auth.uid());

-- 구독 저장: 같은 기기(endpoint)에 다른 계정이 로그인하면 그 계정으로 넘긴다
create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text)
returns void language sql security definer set search_path = public as $$
  insert into push_subscriptions (user_id, endpoint, p256dh, auth)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth)
  on conflict (endpoint) do update
    set user_id = auth.uid(), p256dh = excluded.p256dh, auth = excluded.auth;
$$;

create or replace function public.delete_push_subscription(p_endpoint text)
returns void language sql security definer set search_path = public as $$
  delete from push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
$$;

create or replace function public.set_share_notify(partner uuid, enabled boolean)
returns void language sql security definer set search_path = public as $$
  update shares set notify = enabled where owner_id = partner and viewer_id = auth.uid();
$$;

revoke execute on function public.save_push_subscription(text, text, text), public.delete_push_subscription(text),
  public.set_share_notify(uuid, boolean) from public, anon;
grant execute on function public.save_push_subscription(text, text, text), public.delete_push_subscription(text),
  public.set_share_notify(uuid, boolean) to authenticated;

-- 할 일이 '완료'로 바뀌면 Edge Function(notify-done)을 호출한다
create or replace function public.notify_todo_done()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  hook_secret text;
begin
  if new.status = 'done' and old.status is distinct from 'done' then
    select decrypted_secret into hook_secret from vault.decrypted_secrets where name = 'push_hook_secret';
    if hook_secret is null then return new; end if; -- 아직 설정 전이면 조용히 건너뜀
    perform net.http_post(
      url := 'https://wzdlityqbmrebumfooyv.supabase.co/functions/v1/notify-done',
      body := jsonb_build_object('todo_id', new.id),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', hook_secret)
    );
  end if;
  return new;
end $$;
revoke execute on function public.notify_todo_done() from public, anon, authenticated;

drop trigger if exists todos_done_push on public.todos;
create trigger todos_done_push after update of status on public.todos
  for each row execute function public.notify_todo_done();
