-- 공유 투두 · 하루 알림 (매일 07:00 / 12:00 / 19:00, 한국 시간)
-- 002_push.sql 다음에 SQL Editor에서 실행한다. 여러 번 실행해도 안전하다.

create extension if not exists pg_cron;

-- 사람마다 하루 알림 켜기/끄기 (기본 켜짐, 원하지 않으면 설정에서 끈다)
alter table public.users add column if not exists daily_reminders boolean not null default true;

-- Edge Function(notify-done)에 하루 알림을 보내 달라고 요청한다
create or replace function public.send_daily_reminder(slot text)
returns void language plpgsql security definer set search_path = public as $$
declare
  hook_secret text;
begin
  select decrypted_secret into hook_secret from vault.decrypted_secrets where name = 'push_hook_secret';
  if hook_secret is null then return; end if;
  perform net.http_post(
    url := 'https://wzdlityqbmrebumfooyv.supabase.co/functions/v1/notify-done',
    body := jsonb_build_object('type', 'daily', 'slot', slot),
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-hook-secret', hook_secret),
    timeout_milliseconds := 30000
  );
end $$;
revoke execute on function public.send_daily_reminder(text) from public, anon, authenticated;

-- 예약 (cron은 UTC 기준: 한국 07시 = UTC 22시(전날), 12시 = UTC 03시, 19시 = UTC 10시)
select cron.unschedule(jobname) from cron.job
where jobname in ('daily-morning', 'daily-noon', 'daily-evening');

select cron.schedule('daily-morning', '0 22 * * *', $$select public.send_daily_reminder('morning')$$);
select cron.schedule('daily-noon',    '0 3 * * *',  $$select public.send_daily_reminder('noon')$$);
select cron.schedule('daily-evening', '0 10 * * *', $$select public.send_daily_reminder('evening')$$);
