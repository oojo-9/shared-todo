// Supabase Edge Function: notify-done
// 할 일이 완료되면 DB 트리거가 호출한다. 그 할 일을 볼 수 있고 알림을 켜 둔 친구들에게 푸시를 보낸다.
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

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.headers.get('x-hook-secret') !== Deno.env.get('PUSH_HOOK_SECRET')) return json({ error: 'forbidden' }, 403);

  const { todo_id } = await req.json().catch(() => ({}));
  if (!todo_id) return json({ error: 'todo_id required' }, 400);

  const { data: todo } = await db.from('todos').select('id, user_id, title, status, category_id').eq('id', todo_id).maybeSingle();
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
  const payload = JSON.stringify({
    title: `${owner?.nickname ?? '친구'}님이 할 일을 완료했어요 ✅`,
    body: todo.title,
    tag: `done-${todo.id}`,
  });

  let sent = 0;
  await Promise.all((subs ?? []).map(async (s) => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { TTL: 60 * 60 });
      sent++;
    } catch (e) {
      const code = (e as { statusCode?: number }).statusCode;
      if (code === 404 || code === 410) await db.from('push_subscriptions').delete().eq('id', s.id); // 만료된 구독 정리
      else console.error('push failed', code, (e as Error).message);
    }
  }));
  return json({ sent });
});
