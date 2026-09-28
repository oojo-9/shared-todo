// Supabase Edge Function: notify-done
// 1) 할 일 완료: DB 트리거가 { todo_id }로 호출 → 볼 수 있고 알림을 켜 둔 친구들에게 푸시
// 2) 하루 알림: pg_cron이 { type: 'daily', slot }로 호출 → 하루 알림을 켜 둔 사람 모두에게 푸시
//    { dry_run: true }를 함께 보내면 보내지 않고 대상 수만 돌려준다 (점검용)
// 필요한 Secrets: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT, PUSH_HOOK_SECRET
// (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY는 Supabase가 자동으로 넣어 준다)
import webpush from 'npm:web-push@3.6.7';
import { createClient } from 'npm:@supabase/supabase-js@2';

const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
webpush.setVapidDetails(
  Deno.env.get('VAPID_SUBJECT') ?? 'mailto:admin@example.com',
  Deno.env.get('VAPID_PUBLIC_KEY')!,
  Deno.env.get('VAPID_PRIVATE_KEY')!,
);

const DAILY: Record<string, { title: string; body: string }> = {
  morning: { title: '☀️ 좋은 아침', body: '야무지게 하루를 살아보자! 오늘 일정 뭐야?' },
  noon: { title: '🕛 점심시간', body: '벌써 오후래, 남은 일정 체크해보자!' },
  evening: { title: '🌙 저녁 7시', body: '못한일정이 있다면 지금이라도 늦지않았어!' },
};

type Sub = { id: string; endpoint: string; p256dh: string; auth: string };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

async function sendAll(subs: Sub[], payload: string) {
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 60 * 60 });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.from('push_subscriptions').delete().eq('id', s.id); // 만료된 구독 정리
      else console.error('push failed', code, (e as Error).message);
    }
  }));
  return sent;
}

async function daily(slot: string, dryRun: boolean) {
  const msg = DAILY[slot];
  if (!msg) return json({ error: 'unknown slot' }, 400);
  const { data: users } = await db.from('users').select('id').eq('daily_reminders', true);
  const ids = (users ?? []).map((u) => u.id);
  if (!ids.length) return json({ sent: 0, targets: 0 });
  const { data: subs } = await db.from('push_subscriptions').select('*').in('user_id', ids);
  if (dryRun) return json({ dry_run: true, slot, users: ids.length, devices: subs?.length ?? 0 });
  const sent = await sendAll(subs ?? [], JSON.stringify({ ...msg, tag: `daily-${slot}` }));
  return json({ slot, sent });
}

async function todoDone(todoId: string) {
  const { data: todo } = await db.from('todos').select('id, user_id, title, status, category_id').eq('id', todoId).maybeSingle();
  if (!todo || todo.status !== 'done') return json({ skipped: 'not done' });

  // 비공개 카테고리는 알리지 않는다 (보기 권한과 같은 규칙)
  if (todo.category_id) {
    const { data: cat } = await db.from('categories').select('is_public').eq('id', todo.category_id).maybeSingle();
    if (!cat?.is_public) return json({ skipped: 'private' });
  }

  const { data: owner } = await db.from('users').select('nickname').eq('id', todo.user_id).single();
  const { data: viewers } = await db.from('shares').select('viewer_id')
    .eq('owner_id', todo.user_id).eq('status', 'accepted').eq('notify', true);
  const ids = (viewers ?? []).map((v) => v.viewer_id);
  if (!ids.length) return json({ sent: 0 });

  const { data: subs } = await db.from('push_subscriptions').select('*').in('user_id', ids);
  const sent = await sendAll(subs ?? [], JSON.stringify({
    title: `${owner?.nickname ?? '친구'}님이 할 일을 완료했어요 ✅`,
    body: todo.title,
    tag: `done-${todo.id}`,
  }));
  return json({ sent });
}

Deno.serve(async (req) => {
  if (req.headers.get('x-hook-secret') !== Deno.env.get('PUSH_HOOK_SECRET')) return json({ error: 'forbidden' }, 403);
  const body = await req.json().catch(() => ({}));
  if (body.type === 'daily') return daily(body.slot, !!body.dry_run);
  if (body.todo_id) return todoDone(body.todo_id);
  return json({ error: 'bad request' }, 400);
});
