// 데모 모드 저장소: localStorage에 저장하고, 탭끼리는 storage 이벤트로 실시간 반영한다.
// 탭마다 로그인 사용자가 따로라서, 탭 두 개로 "나"와 "상대"를 흉내 내며 공유 기능을 시험할 수 있다.
// Supabase 저장소(store-supabase.js)와 같은 메서드를 제공하고, 공개 범위 규칙도 RLS와 똑같이 적용한다.
import {
  uid, genCode, today, addDays, nextStatus, COLORS, ls, ss,
  validNickname, validText, STATUS,
} from './util.js';

const DB_KEY = 'shtodo.db.v1';
const SESSION_KEY = 'shtodo.session';
const LAST_KEY = 'shtodo.lastUser';
const DEMO_ID = 'demo-minji';
const now = () => new Date().toISOString();

export function createLocalStore() {
  let db = read();
  const listeners = new Set();
  const authListeners = new Set();
  let sessionId = ss.get(SESSION_KEY) || ls.get(LAST_KEY);
  if (sessionId && !db.users.some((u) => u.id === sessionId)) sessionId = null;

  window.addEventListener('storage', (e) => {
    if (e.key !== DB_KEY) return;
    db = read();
    if (sessionId && !db.users.some((u) => u.id === sessionId)) setSession(null);
    else emit();
  });
  setInterval(botTick, 10000);

  function read() {
    const raw = ls.get(DB_KEY);
    if (raw) {
      try { const d = JSON.parse(raw); if (d && Array.isArray(d.users)) return d; } catch { /* 새로 만든다 */ }
    }
    const d = seed();
    ls.set(DB_KEY, JSON.stringify(d));
    return d;
  }
  function commit() { ls.set(DB_KEY, JSON.stringify(db)); emit(); }
  function emit() { listeners.forEach((f) => { try { f(); } catch (e) { console.error(e); } }); }
  function setSession(id) {
    sessionId = id;
    if (id) { ss.set(SESSION_KEY, id); ls.set(LAST_KEY, id); } else { ss.del(SESSION_KEY); ls.del(LAST_KEY); }
    authListeners.forEach((f) => f());
  }
  function need() {
    const u = db.users.find((x) => x.id === sessionId);
    if (!u) throw new Error('로그인이 필요해요');
    return u;
  }
  function own(list, id) {
    const row = list.find((x) => x.id === id);
    if (!row || row.user_id !== sessionId) throw new Error('수정할 권한이 없어요');
    return row;
  }
  // RLS와 같은 규칙: 나 자신이거나, 상대가 연결을 수락한 경우에만 볼 수 있다
  function canView(ownerId) {
    return ownerId === sessionId
      || db.shares.some((s) => s.owner_id === ownerId && s.viewer_id === sessionId && s.status === 'accepted');
  }
  function isPublicCategory(id) {
    if (!id) return true;
    const c = db.categories.find((x) => x.id === id);
    return !!c && c.is_public;
  }
  function uniqueCode() {
    let c;
    do c = genCode(); while (db.users.some((u) => u.invite_code === c));
    return c;
  }
  function acceptPair(a, b) {
    for (const [owner, viewer] of [[a, b], [b, a]]) {
      const row = db.shares.find((s) => s.owner_id === owner && s.viewer_id === viewer);
      if (row) { row.status = 'accepted'; row.updated_at = now(); } else {
        db.shares.push({ id: uid(), owner_id: owner, viewer_id: viewer, status: 'accepted', created_at: now(), updated_at: now() });
      }
    }
  }
  const userRef = (id) => {
    const u = db.users.find((x) => x.id === id);
    return u ? { id: u.id, nickname: u.nickname } : null;
  };

  // ---- 데모 상대 "민지": 요청을 자동 수락하고, 가끔 할 일을 진행시켜 실시간 반영을 보여 준다 ----
  function botAccept(shareId) {
    setTimeout(() => {
      db = read();
      const s = db.shares.find((x) => x.id === shareId);
      if (!s || s.status !== 'requested') return;
      acceptPair(s.owner_id, s.viewer_id);
      commit();
    }, 1500);
  }
  function botTick() {
    if (document.hidden || !sessionId || sessionId === DEMO_ID) return;
    db = read();
    if (!canView(DEMO_ID)) return;
    const t = today();
    if (!db.todos.some((x) => x.user_id === DEMO_ID && x.date === t)) seedDemoDay(db, t, false);
    const next = db.todos
      .filter((x) => x.user_id === DEMO_ID && x.date === t && x.status !== 'done')
      .sort((a, b) => a.sort - b.sort)[0];
    if (!next) return;
    next.status = nextStatus(next.status);
    next.updated_at = now();
    commit();
  }

  return {
    mode: 'local',
    subscribe(f) { listeners.add(f); return () => listeners.delete(f); },
    onAuthChange(f) { authListeners.add(f); },

    async getMe() { const u = db.users.find((x) => x.id === sessionId); return u ? { ...u } : null; },
    listLocalAccounts() { return db.users.map((u) => ({ id: u.id, nickname: u.nickname })); },
    async signInLocal(nickname) {
      const nick = validNickname(nickname);
      let u = db.users.find((x) => x.nickname === nick);
      if (!u) {
        u = { id: uid(), nickname: nick, invite_code: uniqueCode(), created_at: now() };
        db.users.push(u);
        db.categories.push(...defaultCategories(u.id));
        commit();
      }
      setSession(u.id);
    },
    async signOut() { setSession(null); },
    async deleteAccount() {
      const id = need().id;
      db.users = db.users.filter((u) => u.id !== id);
      db.categories = db.categories.filter((c) => c.user_id !== id);
      db.todos = db.todos.filter((t) => t.user_id !== id);
      db.shares = db.shares.filter((s) => s.owner_id !== id && s.viewer_id !== id);
      commit();
      setSession(null);
    },
    async updateProfile({ nickname }) {
      const me = need();
      const nick = validNickname(nickname);
      if (db.users.some((u) => u.nickname === nick && u.id !== me.id)) throw new Error('이미 사용 중인 아이디예요');
      me.nickname = nick;
      commit();
    },

    async listCategories(userId) {
      if (!canView(userId)) return [];
      return db.categories
        .filter((c) => c.user_id === userId && (userId === sessionId || c.is_public))
        .sort((a, b) => a.sort - b.sort)
        .map((c) => ({ ...c }));
    },
    async createCategory({ name, color, is_public = true }) {
      const me = need();
      const mine = db.categories.filter((c) => c.user_id === me.id);
      const id = uid();
      db.categories.push({
        id, user_id: me.id, name: validText(name, '카테고리 이름', 20),
        color: color || COLORS[mine.length % COLORS.length], is_public: !!is_public,
        sort: mine.reduce((m, c) => Math.max(m, c.sort), -1) + 1, created_at: now(),
      });
      commit();
      return id;
    },
    async updateCategory(id, patch) {
      const c = own(db.categories, id);
      if ('name' in patch) c.name = validText(patch.name, '카테고리 이름', 20);
      if ('color' in patch) c.color = patch.color;
      if ('is_public' in patch) c.is_public = !!patch.is_public;
      commit();
    },
    // ids 순서대로 sort를 다시 매긴다
    async reorderCategories(ids) {
      ids.forEach((id, i) => { own(db.categories, id).sort = i; });
      commit();
    },
    async deleteCategory(id) {
      own(db.categories, id);
      db.categories = db.categories.filter((c) => c.id !== id);
      db.todos = db.todos.filter((t) => t.category_id !== id);
      commit();
    },

    async listTodos(userId, from, to) {
      if (!canView(userId)) return [];
      return db.todos
        .filter((t) => t.user_id === userId && t.date >= from && t.date <= to
          && (userId === sessionId || isPublicCategory(t.category_id)))
        .sort((a, b) => a.sort - b.sort)
        .map((t) => ({ ...t }));
    },
    async createTodo({ date, title, category_id, status = 'todo', sort = Date.now() }) {
      const me = need();
      const cat = category_id && db.categories.some((c) => c.id === category_id && c.user_id === me.id) ? category_id : null;
      db.todos.push({
        id: uid(), user_id: me.id, category_id: cat, date, title: validText(title, '할 일', 200),
        status: STATUS.includes(status) ? status : 'todo', sort, created_at: now(), updated_at: now(),
      });
      commit();
    },
    async updateTodo(id, patch) {
      const t = own(db.todos, id);
      if ('title' in patch) t.title = validText(patch.title, '할 일', 200);
      if ('date' in patch && /^\d{4}-\d{2}-\d{2}$/.test(patch.date)) t.date = patch.date;
      if ('status' in patch && STATUS.includes(patch.status)) t.status = patch.status;
      if ('category_id' in patch) {
        t.category_id = patch.category_id && db.categories.some((c) => c.id === patch.category_id && c.user_id === sessionId)
          ? patch.category_id : null;
      }
      t.updated_at = now();
      commit();
    },
    async deleteTodo(id) {
      own(db.todos, id);
      db.todos = db.todos.filter((t) => t.id !== id);
      commit();
    },

    async listConnections() {
      const me = need();
      const pick = (pred, key) => db.shares.filter(pred).map((s) => ({ shareId: s.id, user: userRef(s[key]) })).filter((x) => x.user);
      return {
        partners: db.shares.filter((s) => s.viewer_id === me.id && s.status === 'accepted' && userRef(s.owner_id))
          .map((s) => ({ ...userRef(s.owner_id), notify: s.notify !== false })),
        incoming: pick((s) => s.owner_id === me.id && s.status === 'requested', 'viewer_id'),
        outgoing: pick((s) => s.viewer_id === me.id && s.status === 'requested', 'owner_id'),
      };
    },
    // 상대 지정: 아이디(닉네임) 또는 초대 코드. 상대가 수락해야 연결된다.
    async requestShare(text) {
      const me = need();
      const q = String(text ?? '').trim();
      if (!q) throw new Error('상대 아이디나 초대 코드를 입력해 주세요');
      const target = db.users.find((u) => u.invite_code === q.toUpperCase()) || db.users.find((u) => u.nickname === q);
      if (!target) throw new Error('해당 아이디나 초대 코드를 찾을 수 없어요');
      if (target.id === me.id) throw new Error('자기 자신은 추가할 수 없어요');
      const mine = db.shares.find((s) => s.owner_id === target.id && s.viewer_id === me.id);
      if (mine?.status === 'accepted') throw new Error('이미 연결된 상대예요');
      // 상대가 먼저 나에게 요청해 두었다면 바로 연결
      if (db.shares.some((s) => s.owner_id === me.id && s.viewer_id === target.id && s.status === 'requested')) {
        acceptPair(me.id, target.id);
        commit();
        return 'accepted';
      }
      if (mine?.status === 'requested') throw new Error('이미 요청을 보냈어요. 상대의 수락을 기다려 주세요');
      let row = mine;
      if (row) { row.status = 'requested'; row.updated_at = now(); } else {
        row = { id: uid(), owner_id: target.id, viewer_id: me.id, status: 'requested', created_at: now(), updated_at: now() };
        db.shares.push(row);
      }
      commit();
      if (target.id === DEMO_ID) botAccept(row.id);
      return 'requested';
    },
    async respondShare(shareId, accept) {
      const me = need();
      const s = db.shares.find((x) => x.id === shareId && x.owner_id === me.id && x.status === 'requested');
      if (!s) throw new Error('처리할 요청을 찾을 수 없어요');
      if (accept) acceptPair(s.owner_id, s.viewer_id);
      else { s.status = 'revoked'; s.updated_at = now(); }
      commit();
    },
    // 데모 모드에선 푸시를 보낼 서버가 없어서 친구별 설정만 저장한다
    pushSupported: false,
    async setDailyReminders(enabled) {
      need().daily_reminders = !!enabled;
      commit();
    },
    async setShareNotify(partnerId, enabled) {
      const me = need();
      const s = db.shares.find((x) => x.owner_id === partnerId && x.viewer_id === me.id);
      if (s) { s.notify = !!enabled; commit(); }
    },
    // 연결 해제(또는 보낸 요청 취소): 언제든 한쪽에서 가능
    async revokeShare(partnerId) {
      const me = need();
      db.shares.forEach((s) => {
        if ((s.owner_id === me.id && s.viewer_id === partnerId) || (s.owner_id === partnerId && s.viewer_id === me.id)) {
          s.status = 'revoked';
          s.updated_at = now();
        }
      });
      commit();
    },
  };
}

// 새 계정의 기본 카테고리는 '비공개' 하나. 나머지는 직접 만든다.
function defaultCategories(userId) {
  return [
    { name: '비공개', color: COLORS[7], is_public: false },
  ].map((c, i) => ({ id: uid(), user_id: userId, sort: i, created_at: now(), ...c }));
}

function seed() {
  const d = { users: [], categories: [], todos: [], shares: [] };
  d.users.push({ id: DEMO_ID, nickname: '민지', invite_code: 'MINJI7', created_at: now() });
  d.categories.push(...[
    { name: '공부', color: COLORS[0], is_public: true },
    { name: '운동', color: COLORS[2], is_public: true },
    { name: '일기', color: COLORS[4], is_public: false },
  ].map((c, i) => ({ id: uid(), user_id: DEMO_ID, sort: i, created_at: now(), ...c })));
  const t = today();
  for (let off = -10; off <= 14; off++) seedDemoDay(d, addDays(t, off), off < 0);
  return d;
}

const DEMO_POOL = [
  [0, '영단어 50개 외우기'],
  [1, '저녁 러닝 5km'],
  [0, '토익 LC 파트 3 풀기'],
  [2, '오늘 있었던 일 기록하기'],
  [0, '알고리즘 문제 2개 풀기'],
  [1, '스트레칭 15분'],
  [0, '전공 과제 초안 작성하고 교수님께 메일로 질문 보내기'],
  [1, '헬스장 하체 운동'],
];

function seedDemoDay(d, date, past) {
  const cats = d.categories.filter((c) => c.user_id === DEMO_ID).sort((a, b) => a.sort - b.sort);
  let hash = 0;
  for (const ch of date) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  if (hash % 5 === 0) return; // 할 일 없는 날도 섞는다
  const n = 3 + (hash % 2);
  const picked = new Set();
  for (let i = 0; picked.size < n && i < 20; i++) picked.add((hash + i * 3) % DEMO_POOL.length);
  [...picked].forEach((idx, i) => {
    const [catIdx, title] = DEMO_POOL[idx];
    d.todos.push({
      id: uid(), user_id: DEMO_ID, category_id: cats[catIdx]?.id ?? null, date, title,
      status: past ? (i === n - 1 && hash % 3 === 0 ? 'todo' : 'done') : 'todo',
      sort: Date.parse(date) + i, created_at: now(), updated_at: now(),
    });
  });
}
