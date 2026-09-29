-- 공유 투두 · 연결 요청/수락 푸시 알림
-- 002_push.sql, 003_daily.sql 다음에 SQL Editor에서 실행한다. 여러 번 실행해도 안전하다.
--   요청(requested) 되면 → 요청받은 사람(owner)에게 "○○님이 연결을 요청했어요"
--   요청이 수락(requested → accepted) 되면 → 요청한 사람(viewer)에게 "○○님이 연결을 수락했어요"
-- (수락 시 반대 방향 행도 accepted가 되지만, 그 행은 requested를 거치지 않으므로 알림이 한 번만 간다)

create or replace function public.notify_share_change()
returns trigger language plpgsql security definer set search_path = public as $$
declare
  hook_secret text;
  target uuid;
  actor_name text;
  title text;
  msg text;
begin
  if new.status = 'requested' and (tg_op = 'INSERT' or old.status is distinct from 'requested') then
    target := new.owner_id;
    select nickname into actor_name from users where id = new.viewer_id;
    title := coalesce(actor_name, '누군가') || '님이 연결을 요청했어요 👋';
    msg := '수락하면 서로의 할 일을 함께 볼 수 있어요';
  elsif tg_op = 'UPDATE' and new.status = 'accepted' and old.status = 'requested' then
    target := new.viewer_id;
    select nickname into actor_name from users where id = new.owner_id;
    title := coalesce(actor_name, '상대') || '님이 연결을 수락했어요 🎉';
    msg := '이제 공유 보기에서 서로의 할 일이 보여요';
  else
    return new;
  end if;

  select decrypted_secret into hook_secret from vault.decrypted_secrets where name = 'push_hook_secret';
  if hook_secret is null then return new; end if;

  perform net.http_post(
    url := 'https://wzdlityqbmrebumfooyv.supabase.co/functions/v1/notify-done',
    body := jsonb_build_object('type', 'user', 'user_id', target, 'title', title, 'body', msg, 'tag', 'share-' || new.id),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', hook_secret)
  );
  return new;
end $$;
revoke execute on function public.notify_share_change() from public, anon, authenticated;

drop trigger if exists shares_push on public.shares;
create trigger shares_push after insert or update of status on public.shares
  for each row execute function public.notify_share_change();
