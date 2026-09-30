-- 공유 투두 · 할 일 시작/마감 시간과 알림
-- 006_quotes.sql 다음에 SQL Editor에서 실행한다. 여러 번 실행해도 안전하다.
--   시간은 할 일 날짜(한국 시간) 기준, 알림은 몇 분 전에 울릴지 (null = 알림 없음)
--   pg_cron이 1분마다 울릴 때가 된 알림을 찾아 notify-done 함수(type 'user')로 주인에게만 보낸다.
--   이미 완료한 일은 보내지 않고, 같은 알림은 한 번만 보낸다 (시간·알림을 바꾸면 다시 보낼 수 있게 된다).

alter table public.todos add column if not exists start_time  time;
alter table public.todos add column if not exists due_time    time;
alter table public.todos add column if not exists start_alert integer check (start_alert is null or start_alert between 0 and 1440);
alter table public.todos add column if not exists due_alert   integer check (due_alert is null or due_alert between 0 and 1440);
alter table public.todos add column if not exists start_sent  boolean not null default false;
alter table public.todos add column if not exists due_sent    boolean not null default false;

-- 날짜·시간·알림을 바꾸면 '보냄' 표시를 지워서 새 시간에 다시 울리게 한다
create or replace function public.reset_todo_alerts()
returns trigger language plpgsql as $$
begin
  if new.date is distinct from old.date or new.start_time is distinct from old.start_time
     or new.start_alert is distinct from old.start_alert then
    new.start_sent := false;
  end if;
  if new.date is distinct from old.date or new.due_time is distinct from old.due_time
     or new.due_alert is distinct from old.due_alert then
    new.due_sent := false;
  end if;
  return new;
end $$;

drop trigger if exists todos_reset_alerts on public.todos;
create trigger todos_reset_alerts before update of date, start_time, start_alert, due_time, due_alert on public.todos
  for each row execute function public.reset_todo_alerts();

create index if not exists todos_alert_idx on public.todos (date)
  where (start_alert is not null and not start_sent) or (due_alert is not null and not due_sent);

-- 알림 제목: '지금 시작 시간이에요' / '30분 뒤 마감' / '1시간 뒤 시작' / '내일 마감'
create or replace function public.alert_phrase(mins integer, what text)
returns text language sql immutable as $$
  select case
    when mins = 0 then '지금 ' || what || ' 시간이에요'
    when mins = 1440 then '내일 ' || what
    when mins % 60 = 0 then (mins / 60) || '시간 뒤 ' || what
    else mins || '분 뒤 ' || what
  end;
$$;

-- 1분마다: 울릴 시각이 지난 지 10분 안 된 알림을 보낸다 (너무 지난 알림은 보내지 않는다)
create or replace function public.send_time_alerts()
returns void language plpgsql security definer set search_path = public as $$
declare
  hook_secret text;
  r record;
  tz constant text := 'Asia/Seoul';
begin
  select decrypted_secret into hook_secret from vault.decrypted_secrets where name = 'push_hook_secret';
  if hook_secret is null then return; end if;

  for r in
    update todos t set start_sent = true
    where t.start_alert is not null and not t.start_sent and t.start_time is not null and t.status <> 'done'
      and t.date between (now() at time zone tz)::date - 1 and (now() at time zone tz)::date + 2
      and ((t.date + t.start_time) at time zone tz) - make_interval(mins => t.start_alert) <= now()
      and ((t.date + t.start_time) at time zone tz) - make_interval(mins => t.start_alert) > now() - interval '10 minutes'
    returning t.id, t.user_id, t.title, t.start_time, t.start_alert
  loop
    perform net.http_post(
      url := 'https://wzdlityqbmrebumfooyv.supabase.co/functions/v1/notify-done',
      body := jsonb_build_object('type', 'user', 'user_id', r.user_id,
        'title', '⏰ ' || alert_phrase(r.start_alert, '시작') || ' (' || to_char(r.start_time, 'HH24:MI') || ')',
        'body', r.title, 'tag', 'start-' || r.id),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', hook_secret),
      timeout_milliseconds := 30000
    );
  end loop;

  for r in
    update todos t set due_sent = true
    where t.due_alert is not null and not t.due_sent and t.due_time is not null and t.status <> 'done'
      and t.date between (now() at time zone tz)::date - 1 and (now() at time zone tz)::date + 2
      and ((t.date + t.due_time) at time zone tz) - make_interval(mins => t.due_alert) <= now()
      and ((t.date + t.due_time) at time zone tz) - make_interval(mins => t.due_alert) > now() - interval '10 minutes'
    returning t.id, t.user_id, t.title, t.due_time, t.due_alert
  loop
    perform net.http_post(
      url := 'https://wzdlityqbmrebumfooyv.supabase.co/functions/v1/notify-done',
      body := jsonb_build_object('type', 'user', 'user_id', r.user_id,
        'title', '⌛ ' || alert_phrase(r.due_alert, '마감') || ' (' || to_char(r.due_time, 'HH24:MI') || ')',
        'body', r.title, 'tag', 'due-' || r.id),
      headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', hook_secret),
      timeout_milliseconds := 30000
    );
  end loop;
end $$;
revoke execute on function public.send_time_alerts() from public, anon, authenticated;

select cron.unschedule(jobname) from cron.job where jobname = 'time-alerts';
select cron.schedule('time-alerts', '* * * * *', $$select public.send_time_alerts()$$);

-- 앱이 새 칸을 바로 알아보게
notify pgrst, 'reload schema';
