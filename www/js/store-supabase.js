// 서버 모드 저장소: Supabase Auth + Postgres + Realtime.
// 보기 권한은 DB의 Row Level Security(supabase/schema.sql)가 막고, 여기서는 조회·수정만 한다.
import { COLORS, validNickname, validText, normTimes, uid } from './util.js';

const SDK_URL = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';

const BUCKET = 'photos';
const URL_TTL = 3600; // 사진 주소 유효 시간(초)

const ERRORS = [
  [/Bucket not found|photo_usage|photo_trash|public\.photos|'photos'/i, '사진 기능을 아직 준비 중이에요'],
  [/exceeded the maximum allowed size/i, '사진이 너무 커요'],
  [/users_nickname_key/, '이미 사용 중인 아이디예요'],
  [/Invalid login credentials/i, '이메일 또는 비밀번호가 맞지 않아요'],
  [/User already registered/i, '이미 가입된 이메일이에요'],
  [/Password should be at least/i, '비밀번호는 6자 이상이어야 해요'],
  [/Email not confirmed/i, '메일함에서 가입 확인 링크를 먼저 눌러 주세요'],
  [/Failed to fetch|NetworkError/i, '네트워크에 연결할 수 없어요'],
];

function ok({ data, error }) {
  if (error) {
    const msg = error.message || String(error);
    const hit = ERRORS.find(([re]) => re.test(msg));
    throw new Error(hit ? hit[1] : msg);
  }
  return data;
}

export async function createSupabaseStore(cfg) {
  const { createClient } = await import(SDK_URL);
  // 로그인 정보를 기기에 저장해 두고 자동 연장한다 → 같은 기기에선 로그아웃 전까지 자동 로그인
  const sb = createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  const listeners = new Set();
  const authListeners = new Set();
  let session = ok(await sb.auth.getSession()).session;
  let me = null;
  let channel = null;
  let photoChannel = null;
  const signed = new Map(); // 사진 경로 -> { url, exp }. 주소가 바뀌면 사진을 다시 내려받으므로 유효한 동안 재사용한다

  sb.auth.onAuthStateChange((event, s) => {
    const changed = (s?.user?.id ?? null) !== (session?.user?.id ?? null);
    session = s;
    if (changed || event === 'SIGNED_OUT') {
      me = null;
      setupRealtime();
      authListeners.forEach((f) => f());
    }
  });
  setupRealtime();

  function emit() { listeners.forEach((f) => { try { f(); } catch (e) { console.error(e); } }); }

  // 변경 이벤트가 오면 화면이 필요한 범위를 다시 불러온다 (RLS가 적용된 조회라 안전)
  function setupRealtime() {
    if (channel) { sb.removeChannel(channel); channel = null; }
    if (!session) return;
    channel = sb.channel('shtodo-changes');
    for (const table of ['todos', 'categories', 'shares', 'users']) {
      channel.on('postgres_changes', { event: '*', schema: 'public', table }, emit);
    }
    channel.subscribe();
    // 사진은 채널을 따로 둔다 (009_photos.sql 실행 전이라 표가 없어도 위 채널은 멀쩡하게)
    if (photoChannel) sb.removeChannel(photoChannel);
    photoChannel = sb.channel('shtodo-photos').on('postgres_changes', { event: '*', schema: 'public', table: 'photos' }, emit);
    photoChannel.subscribe();
  }

  // 지워진 사진 줄의 파일을 Storage에서 지운다. 할 일·카테고리를 지우면 사진 줄은 DB가 함께 지우고
  // 파일 경로만 photo_trash에 남기므로, 주인의 앱이 여기서 마저 지운다.
  async function sweepPhotos() {
    try {
      for (let i = 0; i < 20; i++) {
        const paths = ok(await sb.from('photo_trash').select('path').limit(100)).map((r) => r.path);
        if (!paths.length) return;
        ok(await sb.storage.from(BUCKET).remove(paths));
        ok(await sb.from('photo_trash').delete().in('path', paths));
        paths.forEach((p) => signed.delete(p));
      }
    } catch (e) { console.warn(e); }
  }
  if (session) sweepPhotos(); // 다른 기기에서 지웠거나 지난번에 못 지운 것

  async function signedUrls(paths) {
    const now = Date.now();
    const need = paths.filter((p) => !(signed.get(p)?.exp > now));
    if (need.length) {
      const res = ok(await sb.storage.from(BUCKET).createSignedUrls(need, URL_TTL));
      for (const r of res) if (r.signedUrl) signed.set(r.path, { url: r.signedUrl, exp: now + (URL_TTL - 600) * 1000 });
    }
    return paths.map((p) => signed.get(p)?.url || null);
  }

  function uidOrThrow() {
    if (!session) throw new Error('로그인이 필요해요');
    return session.user.id;
  }

  return {
    mode: 'supabase',
    subscribe(f) { listeners.add(f); return () => listeners.delete(f); },
    onAuthChange(f) { authListeners.add(f); },

    async getMe() {
      if (!session) return null;
      if (me && me.id === session.user.id && !me.needsProfile) return { ...me };
      const row = ok(await sb.from('users').select('*').eq('id', session.user.id).maybeSingle());
      me = row || { id: session.user.id, needsProfile: true, email: session.user.email };
      return { ...me };
    },
    async signIn(email, password) {
      ok(await sb.auth.signInWithPassword({ email: email.trim(), password }));
    },
    async signUp(email, password) {
      const data = ok(await sb.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: location.href.split('#')[0] } }));
      return { needsConfirm: !data.session };
    },
    async signInOAuth(provider) {
      ok(await sb.auth.signInWithOAuth({ provider, options: { redirectTo: location.href.split('#')[0] } }));
    },
    async signOut() { ok(await sb.auth.signOut()); },
    async createProfile(nickname) {
      const id = uidOrThrow();
      ok(await sb.from('users').insert({ id, nickname: validNickname(nickname) }));
      // 기본 카테고리는 '비공개' 하나. 나머지는 직접 만든다.
      ok(await sb.from('categories').insert({ user_id: id, name: '비공개', color: COLORS[7], is_public: false, sort: 0 }));
      me = null;
    },
    // 앱 안 계정 삭제 (애플 심사 요건)
    async deleteAccount() {
      // 사진 파일은 계정과 함께 지워지지 않으므로 먼저 지운다
      await sb.from('photos').delete().eq('user_id', uidOrThrow());
      await sweepPhotos();
      ok(await sb.rpc('delete_account'));
      await sb.auth.signOut();
    },
    async updateProfile({ nickname }) {
      ok(await sb.from('users').update({ nickname: validNickname(nickname) }).eq('id', uidOrThrow()));
      me = null;
    },

    async listCategories(userId) {
      return ok(await sb.from('categories').select('*').eq('user_id', userId).order('sort'));
    },
    async createCategory({ name, color, is_public = true }) {
      const id = uidOrThrow();
      const mine = ok(await sb.from('categories').select('sort').eq('user_id', id));
      const row = ok(await sb.from('categories').insert({
        user_id: id, name: validText(name, '카테고리 이름', 20), color: color || COLORS[mine.length % COLORS.length],
        is_public: !!is_public, sort: mine.reduce((m, c) => Math.max(m, c.sort), -1) + 1,
      }).select('id').single());
      return row.id;
    },
    async updateCategory(id, patch) {
      const p = {};
      if ('name' in patch) p.name = validText(patch.name, '카테고리 이름', 20);
      if ('color' in patch) p.color = patch.color;
      if ('is_public' in patch) p.is_public = !!patch.is_public;
      ok(await sb.from('categories').update(p).eq('id', id));
    },
    // ids 순서대로 sort를 다시 매긴다
    async reorderCategories(ids) {
      const results = await Promise.all(ids.map((id, i) => sb.from('categories').update({ sort: i }).eq('id', id)));
      results.forEach(ok);
    },
    async deleteCategory(id) {
      ok(await sb.from('categories').delete().eq('id', id)); // 할 일은 FK cascade로 함께 삭제
      await sweepPhotos();
    },

    async listTodos(userId, from, to) {
      return ok(await sb.from('todos').select('*').eq('user_id', userId)
        .gte('date', from).lte('date', to).order('sort').order('created_at'));
    },
    async createTodo(todo) { return this.createTodos([todo]); },
    // 여러 개를 한 번에 (반복 일정)
    async createTodos(list) {
      const userId = uidOrThrow();
      const rows = list.map(({ date, title, category_id, status = 'todo', sort = Date.now(), series_id = null, repeat = null, ...rest }) => ({
        user_id: userId, date, title: validText(title, '할 일', 200),
        category_id: category_id || null, status, sort, series_id, repeat, ...normTimes(rest),
      }));
      ok(await sb.from('todos').insert(rows));
    },
    // 반복 일정: 이 날부터 같은 묶음 전체 수정/삭제
    async updateSeries(seriesId, fromDate, patch) {
      const p = {};
      if ('title' in patch) p.title = validText(patch.title, '할 일', 200);
      if ('category_id' in patch) p.category_id = patch.category_id || null;
      Object.assign(p, normTimes(patch));
      ok(await sb.from('todos').update(p).eq('series_id', seriesId).gte('date', fromDate));
    },
    async deleteSeries(seriesId, fromDate) {
      ok(await sb.from('todos').delete().eq('series_id', seriesId).gte('date', fromDate));
      await sweepPhotos();
    },
    async updateTodo(id, patch) {
      const p = { ...patch, ...normTimes(patch) };
      if ('title' in p) p.title = validText(p.title, '할 일', 200);
      if ('category_id' in p) p.category_id = p.category_id || null;
      ok(await sb.from('todos').update(p).eq('id', id));
    },
    async deleteTodo(id) {
      ok(await sb.from('todos').delete().eq('id', id));
      await sweepPhotos();
    },

    // ---- 찰칵 (인증사진) ----
    // 내가 볼 수 있는 사진을 최신순으로 (누구 것까지 보이는지는 RLS가 정한다)
    async listPhotos(limit) {
      const rows = ok(await sb.from('photos').select('id, user_id, todo_id, path, width, height, created_at, todos(title)')
        .order('created_at', { ascending: false }).limit(limit));
      const urls = await signedUrls(rows.map((r) => r.path));
      return rows.map(({ todos, path, ...r }, i) => ({ ...r, title: todos?.title || '', url: urls[i] }));
    },
    // 이 기간의 할 일 중 사진이 붙은 것의 id
    async listPhotoMarks(userIds, from, to) {
      const rows = ok(await sb.from('photos').select('todo_id, todos!inner(date)').in('user_id', userIds)
        .gte('todos.date', from).lte('todos.date', to));
      return rows.map((r) => r.todo_id);
    },
    async addPhoto(todoId, { blob, width, height }) {
      const userId = uidOrThrow();
      const usage = await this.photoUsage();
      if (usage.total + blob.size > cfg.photoQuotaBytes * 0.95) throw new Error('사진 저장 공간이 거의 찼어요. 찰칵에서 예전 사진을 지워 주세요');
      const path = `${userId}/${uid()}.jpg`;
      ok(await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', cacheControl: '31536000' }));
      const res = await sb.from('photos').insert({ user_id: userId, todo_id: todoId, path, size: blob.size, width, height });
      if (res.error) await sb.storage.from(BUCKET).remove([path]); // 줄을 못 적었으면 파일도 남기지 않는다
      ok(res);
    },
    async deletePhoto(id) {
      ok(await sb.from('photos').delete().eq('id', id));
      await sweepPhotos();
    },
    // { total: 전체 사용자 합계, mine: 내 사진 } (바이트)
    async photoUsage() {
      return ok(await sb.rpc('photo_usage'));
    },

    async listConnections() {
      const myId = uidOrThrow();
      const shares = ok(await sb.from('shares').select('*').neq('status', 'revoked'));
      const ids = [...new Set(shares.flatMap((s) => [s.owner_id, s.viewer_id]))].filter((x) => x !== myId);
      const users = ids.length ? ok(await sb.from('users').select('id, nickname').in('id', ids)) : [];
      const byId = new Map(users.map((u) => [u.id, u]));
      const pick = (pred, key) => shares.filter(pred).map((s) => ({ shareId: s.id, user: byId.get(s[key]) })).filter((x) => x.user);
      return {
        partners: shares.filter((s) => s.viewer_id === myId && s.status === 'accepted' && byId.has(s.owner_id))
          .map((s) => ({ ...byId.get(s.owner_id), notify: s.notify !== false })),
        incoming: pick((s) => s.owner_id === myId && s.status === 'requested', 'viewer_id'),
        outgoing: pick((s) => s.viewer_id === myId && s.status === 'requested', 'owner_id'),
      };
    },
    async requestShare(text) {
      const q = String(text ?? '').trim();
      if (!q) throw new Error('상대 아이디나 초대 코드를 입력해 주세요');
      return ok(await sb.rpc('request_share', { target: q }));
    },
    async respondShare(shareId, accept) {
      ok(await sb.rpc('respond_share', { share_id: shareId, accept }));
    },
    async revokeShare(partnerId) {
      ok(await sb.rpc('revoke_share', { partner: partnerId }));
    },

    // ---- 푸시 알림 ----
    pushSupported: true,
    // 매일 7시·12시·19시 하루 알림 (기본 켜짐)
    async setDailyReminders(enabled) {
      ok(await sb.from('users').update({ daily_reminders: !!enabled }).eq('id', uidOrThrow()));
      me = null;
    },
    async setShareNotify(partnerId, enabled) {
      ok(await sb.rpc('set_share_notify', { partner: partnerId, enabled }));
    },
    // 콕 찌르기: 보내고 오늘 남은 횟수를 돌려준다 (하루 3번, 서버가 막는다)
    async sendNudge(partnerId) {
      return ok(await sb.rpc('send_nudge', { partner: partnerId }));
    },
    async nudgesLeft(partnerId) {
      return ok(await sb.rpc('nudges_left', { partner: partnerId }));
    },
    async savePushSubscription({ endpoint, p256dh, auth }) {
      ok(await sb.rpc('save_push_subscription', { p_endpoint: endpoint, p_p256dh: p256dh, p_auth: auth }));
    },
    async deletePushSubscription(endpoint) {
      ok(await sb.rpc('delete_push_subscription', { p_endpoint: endpoint }));
    },
  };
}
