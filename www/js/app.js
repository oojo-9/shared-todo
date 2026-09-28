import { config } from './config.js';
import {
  h, icon, ymd, parseYmd, addDays, startOfWeek, today, WEEK, weekdayOf,
  STATUS, STATUS_LABEL, nextStatus, COLORS, toast, prefGet, prefSet, b64urlToBytes,
} from './util.js';
import { createLocalStore } from './store-local.js';
import { holidayOf } from './holidays.js';

const root = document.getElementById('app');
let store;

const state = {
  ready: false,
  me: null,
  view: prefGet('view') === 'mine' ? 'mine' : 'share', // 화면은 두 개: 공유 보기, 내 목록
  selected: today(),
  pinned: readPinned(), // 친구가 3명보다 많을 때 공유 보기에 띄울 친구 id
  conns: { partners: [], incoming: [], outgoing: [] },
  cats: new Map(), // userId -> categories
  todos: new Map(), // userId -> 이번 주 todos
  sheet: null,
  drafts: { email: prefGet('email') || '' }, // 입력 중인 값 (실시간 갱신으로 화면을 다시 그려도 유지)
  authMode: 'signin',
  pushOn: false, // 이 기기에서 푸시 알림을 받는 중인지
};

function readPinned() {
  try { const v = JSON.parse(prefGet('partners') || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}

// 공유 보기에는 나 + 친구 최대 3명. 친구마다 고정 색을 준다.
const MAX_PARTNERS = 3;
const PARTNER_COLORS = ['var(--partner)', 'var(--partner-2)', 'var(--partner-3)'];
function visiblePartners() {
  const all = state.conns.partners;
  const ids = [
    ...state.pinned.filter((id) => all.some((p) => p.id === id)),
    ...all.map((p) => p.id).filter((id) => !state.pinned.includes(id)),
  ].slice(0, MAX_PARTNERS);
  return ids.map((id, i) => ({ ...all.find((p) => p.id === id), color: PARTNER_COLORS[i] }));
}

async function boot() {
  try {
    // 주소 끝에 ?demo 를 붙이면 서버 대신 데모 모드로 연다 (개발·시연용)
    const forceDemo = new URLSearchParams(location.search).has('demo');
    if (!forceDemo && config.supabaseUrl && config.supabaseAnonKey) {
      const { createSupabaseStore } = await import('./store-supabase.js');
      store = await createSupabaseStore(config);
    } else {
      store = createLocalStore();
    }
  } catch (e) {
    root.replaceChildren(h('div', { class: 'splash' }, '앱을 시작하지 못했어요: ' + e.message));
    return;
  }
  store.subscribe(scheduleReload);
  store.onAuthChange(() => { state.sheet = null; state.drafts = { email: prefGet('email') || '' }; reload(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.sheet) closeSheet(); });
  // 아이폰 사파리는 user-scalable=no를 무시하므로 두 손가락 확대를 직접 막는다
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('visibilitychange', () => { if (!document.hidden) reload(); });
  await reload();
  registerServiceWorker();
  refreshPush();
}

// ---------------- 데이터 ----------------
let seq = 0;
let reloadTimer;
function scheduleReload() { clearTimeout(reloadTimer); reloadTimer = setTimeout(reload, 120); }

async function reload() {
  const my = ++seq;
  try {
    const me = await store.getMe();
    if (my !== seq) return;
    state.me = me;
    if (me && !me.needsProfile) {
      const conns = await store.listConnections();
      if (my !== seq) return;
      state.conns = conns;
      const from = startOfWeek(state.selected);
      const to = addDays(from, 6);
      const ids = [me.id, ...visiblePartners().map((p) => p.id)];
      const res = await Promise.all(ids.map((id) => Promise.all([store.listCategories(id), store.listTodos(id, from, to)])));
      if (my !== seq) return;
      state.cats.clear();
      state.todos.clear();
      ids.forEach((id, i) => { state.cats.set(id, res[i][0]); state.todos.set(id, res[i][1]); });
      if (state.sheet?.type === 'month') await loadMonth();
      if (my !== seq) return;
    }
  } catch (e) {
    console.error(e);
    toast(e.message || '불러오지 못했어요');
  }
  state.ready = true;
  render();
}

async function loadMonth() {
  const s = state.sheet;
  if (!s || s.type !== 'month') return;
  const d = parseYmd(s.cursor);
  const last = ymd(new Date(d.getFullYear(), d.getMonth() + 1, 0));
  const ids = [state.me.id, ...visiblePartners().map((p) => p.id)];
  const lists = await Promise.all(ids.map((id) => store.listTodos(id, s.cursor, last)));
  s.dots = new Map(ids.map((id, i) => [id, new Set(lists[i].map((t) => t.date))]));
}

// 작업 실행 → 결과 메시지 → 다시 불러오기
async function act(fn) {
  try {
    const msg = await fn();
    if (typeof msg === 'string') toast(msg);
  } catch (e) {
    toast(e.message || '처리하지 못했어요');
  }
  await reload();
}

const todosOf = (userId) => (state.todos.get(userId) || []).filter((t) => t.date === state.selected);
const catMapOf = (userId) => new Map((state.cats.get(userId) || []).map((c) => [c.id, c]));

// 토요일은 파랑, 일요일·공휴일은 빨강
function dayTone(d) {
  if (holidayOf(d)) return ' is-red';
  const wd = parseYmd(d).getDay();
  return wd === 0 ? ' is-red' : wd === 6 ? ' is-sat' : '';
}
const md = (d) => { const x = parseYmd(d); return `${x.getMonth() + 1}/${x.getDate()}`; };

// 날짜 칸 아래 점: 친구들(각자 색) → 나 순서
function dayDots(d, hasTodo) {
  return h('span', { class: 'day-dots' },
    visiblePartners().map((p) => (hasTodo(p.id, d) ? h('i', { class: 'dot', style: { background: p.color } }) : null)),
    hasTodo(state.me.id, d) ? h('i', { class: 'dot dot-me' }) : null);
}

// ---------------- 렌더링 ----------------
function render() {
  const active = document.activeElement;
  const key = active?.dataset?.key;
  let s0 = null;
  let s1 = null;
  try { s0 = active.selectionStart; s1 = active.selectionEnd; } catch { /* 선택 범위 없는 요소 */ }
  const sheetScroll = root.querySelector('.sheet-body')?.scrollTop;

  root.replaceChildren(...view().filter(Boolean));
  root.classList.toggle('fill', !!root.querySelector('.split-3, .split-4'));

  if (key) {
    const el = root.querySelector(`[data-key="${CSS.escape(key)}"]`);
    if (el) {
      el.focus({ preventScroll: true });
      try { if (s0 != null) el.setSelectionRange(s0, s1); } catch { /* 무시 */ }
    }
  }
  const body = root.querySelector('.sheet-body');
  if (body && sheetScroll) body.scrollTop = sheetScroll;
}

function view() {
  if (!state.ready) return [h('div', { class: 'splash' }, '불러오는 중…')];
  if (!state.me) return [authView()];
  if (state.me.needsProfile) return [profileView()];
  return [
    topBar(),
    weekStrip(),
    h('main', { class: 'main' },
      weekHolidays(),
      requestBanner(),
      state.view === 'share' ? shareView() : mineView()),
    bottomNav(),
    state.sheet ? sheetView() : null,
  ];
}

function draftInput(key, props = {}) {
  return h('input', {
    ...props,
    'data-key': key,
    value: state.drafts[key] ?? '',
    oninput: (e) => { state.drafts[key] = e.target.value; },
  });
}

// ---------- 로그인 ----------
function authView() {
  const brand = h('div', { class: 'brand' }, h('div', { class: 'brand-mark' }, icon('split')), h('h1', null, config.appName));
  if (store.mode === 'local') {
    const accounts = store.listLocalAccounts();
    return h('div', { class: 'auth' }, h('div', { class: 'auth-card' },
      brand,
      h('p', { class: 'lead' }, '상대를 한 번 지정하면, 그 사람의 하루가 내 화면에 실시간으로 보여요.'),
      h('div', { class: 'notice' },
        h('b', null, '데모 모드 · '), '이 브라우저 안에만 저장돼요. 탭을 두 개 열어 서로 다른 아이디로 들어가면 공유를 직접 시험할 수 있어요. 데모 상대 ',
        h('b', null, '민지'), '(초대 코드 MINJI7)도 준비돼 있어요.'),
      h('form', {
        class: 'stack',
        onsubmit: (e) => { e.preventDefault(); act(() => store.signInLocal(state.drafts.nick)); },
      },
      h('label', { class: 'field' }, h('span', null, '아이디 (닉네임)'),
        draftInput('nick', { placeholder: '예: sora', autocomplete: 'nickname', maxlength: 20, required: true })),
      h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, '시작하기')),
      accounts.length ? h('div', { class: 'accounts' },
        h('div', { class: 'label' }, '이 브라우저의 계정'),
        h('div', { class: 'chips' }, accounts.map((a) => h('button', {
          class: 'chip', type: 'button', onclick: () => act(() => store.signInLocal(a.nickname)),
        }, a.nickname)))) : null));
  }

  const signUp = state.authMode === 'signup';
  const oauth = config.oauthProviders || [];
  return h('div', { class: 'auth' }, h('div', { class: 'auth-card' },
    brand,
    h('p', { class: 'lead' }, '상대를 한 번 지정하면, 그 사람의 하루가 내 화면에 실시간으로 보여요.'),
    h('form', {
      class: 'stack',
      onsubmit: (e) => {
        e.preventDefault();
        const { email = '', pw = '' } = state.drafts;
        prefSet('email', email.trim() || null); // 다음에 로그인 화면에 미리 채움
        act(async () => {
          if (!signUp) return store.signIn(email, pw);
          const r = await store.signUp(email, pw);
          return r.needsConfirm ? '확인 메일을 보냈어요. 메일의 링크를 눌러 주세요.' : undefined;
        });
      },
    },
    h('label', { class: 'field' }, h('span', null, '이메일'), draftInput('email', { type: 'email', autocomplete: 'email', required: true })),
    h('label', { class: 'field' }, h('span', null, '비밀번호'), draftInput('pw', {
      type: 'password', autocomplete: signUp ? 'new-password' : 'current-password', minlength: 6, required: true,
    })),
    h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, signUp ? '가입하기' : '로그인')),
    h('button', {
      class: 'link-btn', type: 'button',
      onclick: () => { state.authMode = signUp ? 'signin' : 'signup'; render(); },
    }, signUp ? '이미 계정이 있어요 · 로그인' : '처음이에요 · 이메일로 가입'),
    oauth.length ? h('div', { class: 'divider' }, '또는') : null,
    oauth.includes('google') ? h('button', { class: 'btn btn-block', type: 'button', onclick: () => act(() => store.signInOAuth('google')) }, 'Google로 계속하기') : null,
    oauth.includes('apple') ? h('button', { class: 'btn btn-block btn-dark', type: 'button', onclick: () => act(() => store.signInOAuth('apple')) }, 'Apple로 계속하기') : null));
}

function profileView() {
  return h('div', { class: 'auth' }, h('div', { class: 'auth-card' },
    h('h1', null, '아이디 만들기'),
    h('p', { class: 'lead' }, '상대가 이 아이디로 나를 찾아 연결을 요청할 수 있어요. 나중에 바꿀 수 있어요.'),
    h('form', {
      class: 'stack',
      onsubmit: (e) => { e.preventDefault(); act(() => store.createProfile(state.drafts.nick)); },
    },
    h('label', { class: 'field' }, h('span', null, '아이디 (닉네임)'), draftInput('nick', { maxlength: 20, required: true })),
    h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, '완료')),
    h('button', { class: 'link-btn', type: 'button', onclick: () => act(() => store.signOut()) }, '로그아웃')));
}

// ---------- 상단 ----------
function topBar() {
  const d = parseYmd(state.selected);
  return h('header', { class: 'topbar' },
    h('button', {
      class: 'month-btn', type: 'button', 'aria-label': '달력 열기',
      onclick: () => openMonth(),
    }, `${d.getFullYear()}년 ${d.getMonth() + 1}월`, icon('down')),
    h('div', { class: 'top-actions' },
      store.mode === 'local' ? h('span', { class: 'demo-badge', title: '이 브라우저에만 저장돼요' }, '데모') : null,
      h('button', { class: 'btn btn-sm btn-accent', type: 'button', onclick: () => openSheet('partner') }, icon('userPlus'), '상대 추가'),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': '설정', onclick: () => openSheet('settings') },
        icon('gear'), state.conns.incoming.length ? h('span', { class: 'badge-dot' }) : null)));
}

function weekStrip() {
  const ws = startOfWeek(state.selected);
  const t = today();
  const hasTodo = (id, d) => (state.todos.get(id) || []).some((x) => x.date === d);
  const days = h('div', { class: 'week-days' }, Array.from({ length: 7 }, (_, i) => {
    const d = addDays(ws, i);
    const dt = parseYmd(d);
    return h('button', {
      type: 'button',
      class: `day${dayTone(d)}${d === t ? ' is-today' : ''}${d === state.selected ? ' is-selected' : ''}`,
      'aria-pressed': String(d === state.selected),
      'aria-label': `${dt.getMonth() + 1}월 ${dt.getDate()}일 ${WEEK[i]}요일${holidayOf(d) ? ` ${holidayOf(d)}` : ''}${d === t ? ' (오늘)' : ''}`,
      title: holidayOf(d) || null,
      onclick: () => selectDate(d),
    },
    h('span', { class: 'day-num' }, `${dt.getMonth() + 1}/${dt.getDate()}`),
    h('span', { class: 'day-wd' }, WEEK[i]),
    dayDots(d, hasTodo));
  }));
  attachSwipe(days, (dir) => shiftWeek(dir));
  return h('nav', { class: 'week', 'aria-label': '날짜 선택' },
    h('button', { class: 'week-arrow', type: 'button', 'aria-label': '지난주', onclick: () => shiftWeek(-1) }, icon('left')),
    days,
    h('button', { class: 'week-arrow', type: 'button', 'aria-label': '다음주', onclick: () => shiftWeek(1) }, icon('right')));
}

// 탭 줄을 좌우로 밀면 지난주·다음주로 이동
function attachSwipe(el, onSwipe) {
  let x0 = null;
  let y0 = 0;
  let swiped = false;
  el.addEventListener('pointerdown', (e) => { x0 = e.clientX; y0 = e.clientY; swiped = false; });
  el.addEventListener('pointerup', (e) => {
    if (x0 == null) return;
    const dx = e.clientX - x0;
    const dy = e.clientY - y0;
    x0 = null;
    if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.5) { swiped = true; onSwipe(dx < 0 ? 1 : -1); }
  });
  el.addEventListener('pointercancel', () => { x0 = null; });
  el.addEventListener('click', (e) => { if (swiped) { e.stopPropagation(); e.preventDefault(); swiped = false; } }, true);
}

// 보고 있는 주에 공휴일이 있으면 이름을 한 줄로 알려 준다
function weekHolidays() {
  const ws = startOfWeek(state.selected);
  const days = Array.from({ length: 7 }, (_, i) => addDays(ws, i)).filter(holidayOf);
  if (!days.length) return null;
  return h('div', { class: 'holiday-line', 'aria-label': '이번 주 공휴일' },
    days.map((d) => h('span', { class: d === state.selected ? 'on' : null },
      `${md(d)}(${weekdayOf(d)}) ${holidayOf(d)}`)));
}

function selectDate(d) {
  const sameWeek = startOfWeek(d) === startOfWeek(state.selected);
  state.selected = d;
  if (sameWeek) render(); else reload();
}

function shiftWeek(dir) {
  const next = addDays(state.selected, 7 * dir);
  state.selected = startOfWeek(next) === startOfWeek(today()) ? today() : next;
  reload();
}

function requestBanner() {
  if (!state.conns.incoming.length) return null;
  return h('div', { class: 'banners' }, state.conns.incoming.map(({ shareId, user }) => h('div', { class: 'banner' },
    h('span', null, h('b', null, user.nickname), '님이 연결을 요청했어요'),
    h('div', { class: 'banner-actions' },
      h('button', { class: 'btn btn-sm', type: 'button', onclick: () => act(() => store.respondShare(shareId, false)) }, '거절'),
      h('button', {
        class: 'btn btn-sm btn-primary', type: 'button',
        onclick: () => act(async () => { await store.respondShare(shareId, true); return `${user.nickname}님과 연결됐어요`; }),
      }, '수락')))));
}

// ---------- 할 일 한 줄 ----------
function todoRow(t, { editable, cats, deletable = false }) {
  const c = t.category_id ? cats.get(t.category_id) : null;
  return h('li', { class: `todo s-${t.status}`, style: { '--cat': c?.color || 'var(--line-strong)' } },
    h('button', {
      class: 'check', type: 'button', disabled: !editable,
      'aria-label': `${t.title}: ${STATUS_LABEL[t.status]}${editable ? ' (눌러서 상태 변경)' : ''}`,
      title: STATUS_LABEL[t.status],
      onclick: editable ? () => cycleStatus(t) : null,
    }, icon('check')),
    h('div', {
      class: 'todo-main',
      role: editable ? 'button' : null,
      tabindex: editable ? '0' : null,
      onclick: editable ? () => openTodo(t) : (e) => e.currentTarget.classList.toggle('expanded'),
      onkeydown: editable ? (e) => { if (e.key === 'Enter') openTodo(t); } : null,
    },
    h('div', { class: 'todo-title' }, t.title),
    (c || t.status === 'doing') ? h('div', { class: 'todo-meta' },
      c ? h('span', { class: 'cat-tag' }, h('i', { class: 'cat-dot' }), c.name) : null,
      t.status === 'doing' ? h('span', { class: 'doing-tag' }, '진행중') : null) : null),
    deletable ? h('button', {
      class: 'del-btn', type: 'button', 'aria-label': `${t.title} 삭제`, title: '삭제',
      onclick: () => deleteTodo(t),
    }, icon('trash')) : null);
}

// 바로 삭제하고, 몇 초 동안 되돌리기를 보여 준다
function deleteTodo(t) {
  const list = state.todos.get(state.me.id) || [];
  state.todos.set(state.me.id, list.filter((x) => x.id !== t.id));
  render();
  act(async () => {
    await store.deleteTodo(t.id);
    toast('삭제했어요', {
      label: '되돌리기',
      onClick: () => act(() => store.createTodo({
        date: t.date, title: t.title, category_id: t.category_id, status: t.status, sort: t.sort,
      })),
    });
  });
}

function cycleStatus(t) {
  const status = nextStatus(t.status);
  const list = state.todos.get(state.me.id) || [];
  const row = list.find((x) => x.id === t.id);
  if (row) row.status = status; // 바로 반영하고 저장
  render();
  act(() => store.updateTodo(t.id, { status }));
}

function progress(list) {
  const done = list.filter((t) => t.status === 'done').length;
  return list.length ? `${done}/${list.length}` : '';
}

// ---------- 공유 보기: 친구들 · 나 ----------
// 2명: 좌우 두 칸(페이지 스크롤) / 3명: 위 친구 둘, 아래 나 / 4명: 2×2, 나는 오른쪽 아래
// 3명부터는 화면 높이에 맞추고 각 칸 안에서 스크롤한다.
function shareView() {
  const ps = visiblePartners();
  if (!ps.length) return h('section', { class: 'split split-2' }, emptyPartnerPane(), myPane());
  return h('section', { class: `split split-${ps.length + 1}` }, ps.map(partnerPane), myPane());
}

function emptyPartnerPane() {
  return h('div', { class: 'pane pane-partner' },
    h('div', { class: 'pane-head' }, h('span', { class: 'pane-name' }, '상대방')),
    h('div', { class: 'pane-empty' },
      h('p', null, '아직 연결된 상대가 없어요'),
      h('button', { class: 'btn btn-sm btn-accent', type: 'button', onclick: () => openSheet('partner') }, icon('userPlus'), '상대 추가'),
      state.conns.outgoing.length ? h('p', { class: 'hint' }, `${state.conns.outgoing.map((o) => o.user.nickname).join(', ')}님의 수락을 기다리는 중`) : null));
}

function partnerPane(p) {
  const list = todosOf(p.id);
  const canPick = state.conns.partners.length > MAX_PARTNERS;
  const headInner = [
    h('span', { class: 'pane-name' }, p.nickname),
    canPick ? icon('down') : null,
    h('span', { class: 'pane-count' }, progress(list)),
  ];
  return h('div', { class: 'pane pane-partner', style: { '--pc': p.color } },
    canPick
      ? h('button', { class: 'pane-head pane-head-btn', type: 'button', onclick: () => openSheet('pick'), 'aria-label': `${p.nickname}, 함께 볼 친구 고르기` }, headInner)
      : h('div', { class: 'pane-head' }, headInner),
    h('div', { class: 'pane-scroll' },
      list.length
        ? h('ul', { class: 'todo-list' }, list.map((t) => todoRow(t, { editable: false, cats: catMapOf(p.id) })))
        : h('p', { class: 'empty-text' }, '공개된 할 일이 없어요')),
    h('div', { class: 'pane-foot' }, h('i', { class: 'live-dot' }), '보기 전용 · 실시간 반영'));
}

function myPane() {
  const list = todosOf(state.me.id);
  return h('div', { class: 'pane pane-me' },
    h('div', { class: 'pane-head' }, h('span', { class: 'pane-name' }, '나'), h('span', { class: 'pane-count' }, progress(list))),
    h('div', { class: 'pane-scroll' },
      list.length
        ? h('ul', { class: 'todo-list' }, list.map((t) => todoRow(t, { editable: true, cats: catMapOf(state.me.id) })))
        : h('p', { class: 'empty-text' }, '할 일을 추가해 보세요')),
    addForm('add-share', false),
    h('div', { class: 'pane-foot' }, '추가 · 체크 · 수정 가능'));
}

// 카테고리 선택 목록: 카테고리 없음 / 내 카테고리들 / + 추가하기
const NEW_CAT = '__new__';
function categoryOptions(cats) {
  return [
    h('option', { value: '' }, '카테고리 없음'),
    cats.map((c) => h('option', { value: c.id }, `${c.name}${c.is_public ? '' : ' 🔒'}`)),
    h('option', { value: NEW_CAT }, '+ 추가하기'),
  ];
}

function openNewCategory(ret) {
  const cats = state.cats.get(state.me.id) || [];
  Object.assign(state.drafts, { 'nc-name': '', 'nc-color': COLORS[cats.length % COLORS.length], 'nc-public': true });
  openSheet('newcat', { ret });
}

function addForm(key, withCategory) {
  const cats = state.cats.get(state.me.id) || [];
  const last = prefGet('lastCat');
  const catId = cats.some((c) => c.id === last) ? last : '';
  return h('form', {
    class: `add-form${withCategory ? ' with-cat' : ''}`,
    onsubmit: (e) => {
      e.preventDefault();
      const title = (state.drafts[key] || '').trim();
      if (!title) return;
      state.drafts[key] = '';
      act(() => store.createTodo({ date: state.selected, title, category_id: catId || null }));
    },
  },
  withCategory ? h('select', {
    class: 'cat-select', 'aria-label': '카테고리', value: catId,
    onchange: (e) => {
      if (e.target.value === NEW_CAT) { e.target.value = catId; openNewCategory({ after: 'add' }); return; }
      prefSet('lastCat', e.target.value || null);
      render();
    },
  }, categoryOptions(cats)) : null,
  draftInput(key, { placeholder: '할 일 추가', maxlength: 200, enterkeyhint: 'done', 'aria-label': '할 일 추가', autocomplete: 'off' }),
  h('button', { class: 'add-btn', type: 'submit', 'aria-label': '추가' }, icon('plus')));
}

// ---------- 내 목록 ----------
function mineView() {
  const list = todosOf(state.me.id);
  const cats = state.cats.get(state.me.id) || [];
  const d = parseYmd(state.selected);
  const done = list.filter((t) => t.status === 'done').length;
  const groups = [
    ...cats.map((c) => ({ c, items: list.filter((t) => t.category_id === c.id) })),
    { c: null, items: list.filter((t) => !t.category_id || !cats.some((c) => c.id === t.category_id)) },
  ].filter((g) => g.items.length);
  const catMap = catMapOf(state.me.id);

  return h('section', { class: 'mine' },
    h('div', { class: 'mine-head' },
      h('h2', { class: dayTone(state.selected).trim() || null },
        `${d.getMonth() + 1}월 ${d.getDate()}일 ${weekdayOf(state.selected)}요일`,
        holidayOf(state.selected) ? h('span', { class: 'hol-tag' }, holidayOf(state.selected)) : null),
      list.length ? h('span', { class: 'mine-progress' }, `${done}/${list.length} 완료`) : null),
    list.length ? h('div', { class: 'bar' }, h('div', { class: 'bar-fill', style: { width: `${(done / list.length) * 100}%` } })) : null,
    addForm('add-mine', true),
    groups.length ? groups.map(({ c, items }) => h('div', { class: 'group' },
      h('div', { class: 'group-head', style: { '--cat': c?.color || 'var(--line-strong)' } },
        h('i', { class: 'cat-dot' }), c ? c.name : '카테고리 없음',
        c && !c.is_public ? h('span', { class: 'private-tag' }, '비공개') : null),
      h('ul', { class: 'todo-list' }, items.map((t) => todoRow(t, { editable: true, cats: catMap, deletable: true })))))
      : h('p', { class: 'empty-text big' }, '이 날의 할 일이 없어요'),
    h('p', { class: 'hint center' }, '체크박스를 누를 때마다 할 일 전 → 진행중 → 완료 순으로 바뀌어요.'));
}

function bottomNav() {
  const tab = (id, label, ic) => h('button', {
    type: 'button', class: `nav-tab${state.view === id ? ' active' : ''}`, 'aria-current': state.view === id ? 'page' : null,
    onclick: () => { state.view = id; prefSet('view', id); render(); window.scrollTo(0, 0); },
  }, icon(ic), h('span', null, label));
  return h('nav', { class: 'bottom-nav' }, tab('share', '공유 보기', 'split'), tab('mine', '내 목록', 'list'));
}

// ---------------- 시트(모달) ----------------
function openSheet(type, data = {}) { state.sheet = { type, ...data }; render(); }
function closeSheet() { state.sheet = null; render(); }

async function openMonth() {
  const d = parseYmd(state.selected);
  state.sheet = { type: 'month', cursor: ymd(new Date(d.getFullYear(), d.getMonth(), 1)) };
  render();
  await loadMonth().catch((e) => toast(e.message));
  render();
}

function openTodo(t) {
  Object.assign(state.drafts, { 'e-title': t.title, 'e-date': t.date, 'e-cat': t.category_id || '', 'e-status': t.status });
  openSheet('todo', { id: t.id });
}

function sheetView() {
  const s = state.sheet;
  const builders = { partner: partnerSheet, pick: pickSheet, todo: todoSheet, settings: settingsSheet, month: monthSheet, newcat: newCategorySheet };
  const { title, body } = builders[s.type](s);
  return h('div', {
    class: 'sheet-overlay',
    onclick: (e) => { if (e.target === e.currentTarget) closeSheet(); },
  },
  h('div', { class: `sheet sheet-${s.type}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'sheet-head' },
      h('h2', null, title),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': '닫기', onclick: closeSheet }, icon('x'))),
    h('div', { class: 'sheet-body' }, body)));
}

function partnerSheet() {
  const me = state.me;
  const inviteText = `${config.appName}에서 나를 추가해 줘! 초대 코드: ${me.invite_code} (아이디: ${me.nickname})`;
  return {
    title: '상대 추가',
    body: [
      h('div', { class: 'code-card' },
        h('div', { class: 'label' }, '내 초대 코드'),
        h('div', { class: 'code' }, me.invite_code),
        h('div', { class: 'code-sub' }, `아이디: ${me.nickname}`),
        h('div', { class: 'row gap' },
          h('button', { class: 'btn btn-sm', type: 'button', onclick: () => copy(me.invite_code) }, icon('copy'), '코드 복사'),
          navigator.share ? h('button', {
            class: 'btn btn-sm', type: 'button',
            onclick: () => navigator.share({ text: inviteText }).catch(() => {}),
          }, icon('share'), '공유') : null)),
      h('form', {
        class: 'stack',
        onsubmit: (e) => {
          e.preventDefault();
          const q = state.drafts.req;
          act(async () => {
            const r = await store.requestShare(q);
            state.drafts.req = '';
            return r === 'accepted' ? '연결됐어요' : '연결 요청을 보냈어요. 상대가 수락하면 보여요.';
          });
        },
      },
      h('label', { class: 'field' }, h('span', null, '상대 아이디 또는 초대 코드'),
        h('div', { class: 'row gap' },
          draftInput('req', { placeholder: '예: 민지 또는 MINJI7', autocapitalize: 'off', autocomplete: 'off', required: true }),
          h('button', { class: 'btn btn-primary', type: 'submit' }, '요청')))),
      h('p', { class: 'hint' }, '상대가 수락하면 서로의 공개 카테고리 할 일이 자동으로, 실시간으로 보여요. 상대 할 일은 보기만 할 수 있어요.'),
      connectionLists(),
    ],
  };
}

function connectionLists() {
  const { incoming, outgoing, partners } = state.conns;
  return [
    incoming.length ? h('div', { class: 'section' }, h('h3', null, '받은 요청'),
      h('ul', { class: 'rows' }, incoming.map(({ shareId, user }) => h('li', { class: 'row-item' },
        h('span', { class: 'grow' }, user.nickname),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => act(() => store.respondShare(shareId, false)) }, '거절'),
        h('button', { class: 'btn btn-sm btn-primary', type: 'button', onclick: () => act(() => store.respondShare(shareId, true)) }, '수락'))))) : null,
    outgoing.length ? h('div', { class: 'section' }, h('h3', null, '수락 대기 중'),
      h('ul', { class: 'rows' }, outgoing.map(({ user }) => h('li', { class: 'row-item' },
        h('span', { class: 'grow' }, user.nickname),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => act(() => store.revokeShare(user.id)) }, '요청 취소'))))) : null,
    partners.length ? h('div', { class: 'section' }, h('h3', null, '연결된 상대'),
      h('ul', { class: 'rows' }, partners.map((p) => h('li', { class: 'row-item' },
        h('span', { class: 'grow' }, p.nickname),
        h('button', {
          class: `bell${p.notify ? ' on' : ''}`, type: 'button', 'aria-pressed': String(!!p.notify),
          'aria-label': `${p.nickname} 완료 알림 ${p.notify ? '끄기' : '켜기'}`, title: p.notify ? '완료 알림 켜짐' : '완료 알림 꺼짐',
          onclick: () => act(() => store.setShareNotify(p.id, !p.notify)),
        }, p.notify ? '🔔' : '🔕'),
        h('button', {
          class: 'btn btn-sm btn-danger-ghost', type: 'button',
          onclick: () => { if (confirm(`${p.nickname}님과 연결을 해제할까요? 서로의 할 일이 더 이상 보이지 않아요.`)) act(() => store.revokeShare(p.id)); },
        }, '연결 해제'))))) : null,
  ];
}

// 친구가 3명보다 많을 때: 공유 보기에 띄울 친구 고르기
function pickSheet() {
  const shown = visiblePartners().map((p) => p.id);
  const toggle = (id) => {
    const next = shown.includes(id) ? shown.filter((x) => x !== id) : [...shown, id];
    if (next.length > MAX_PARTNERS) { toast(`최대 ${MAX_PARTNERS}명까지 함께 볼 수 있어요`); return; }
    if (!next.length) { toast('한 명 이상 골라 주세요'); return; }
    state.pinned = next;
    prefSet('partners', JSON.stringify(next));
    reload();
  };
  return {
    title: '함께 볼 친구',
    body: [
      h('p', { class: 'hint' }, `공유 보기에 최대 ${MAX_PARTNERS}명까지 함께 보여요.`),
      h('ul', { class: 'rows' }, state.conns.partners.map((p) => {
        const on = shown.includes(p.id);
        return h('li', null, h('button', {
          type: 'button', role: 'checkbox', 'aria-checked': String(on), class: `pick${on ? ' active' : ''}`,
          onclick: () => toggle(p.id),
        }, h('span', { class: 'grow' }, p.nickname), on ? icon('check') : null));
      })),
      h('button', { class: 'btn btn-block', type: 'button', onclick: () => openSheet('partner') }, icon('userPlus'), '상대 추가'),
    ],
  };
}

function todoSheet(s) {
  const cats = state.cats.get(state.me.id) || [];
  const status = state.drafts['e-status'];
  const save = (e) => {
    e?.preventDefault();
    const patch = {
      title: state.drafts['e-title'], date: state.drafts['e-date'] || state.selected,
      category_id: state.drafts['e-cat'] || null, status,
    };
    state.sheet = null;
    act(() => store.updateTodo(s.id, patch));
  };
  return {
    title: '할 일 수정',
    body: h('form', { class: 'stack', onsubmit: save },
      h('label', { class: 'field' }, h('span', null, '제목'), draftInput('e-title', { maxlength: 200, required: true })),
      h('div', { class: 'field' }, h('span', null, '상태'),
        h('div', { class: 'segmented', role: 'radiogroup' }, STATUS.map((st) => h('button', {
          type: 'button', role: 'radio', 'aria-checked': String(st === status), class: `seg s-${st}${st === status ? ' active' : ''}`,
          onclick: () => { state.drafts['e-status'] = st; render(); },
        }, STATUS_LABEL[st])))),
      h('div', { class: 'two-col' },
        h('label', { class: 'field' }, h('span', null, '날짜'), draftInput('e-date', { type: 'date', required: true })),
        h('label', { class: 'field' }, h('span', null, '카테고리'),
          h('select', {
            value: state.drafts['e-cat'] || '',
            onchange: (e) => {
              if (e.target.value === NEW_CAT) { e.target.value = state.drafts['e-cat'] || ''; openNewCategory({ after: 'todo', todoId: s.id }); return; }
              state.drafts['e-cat'] = e.target.value;
            },
          }, categoryOptions(cats)))),
      h('div', { class: 'row gap end' },
        h('button', {
          class: 'btn btn-danger-ghost', type: 'button',
          onclick: () => { if (confirm('이 할 일을 삭제할까요?')) { state.sheet = null; act(() => store.deleteTodo(s.id)); } },
        }, icon('trash'), '삭제'),
        h('span', { class: 'grow' }),
        h('button', { class: 'btn btn-primary', type: 'submit' }, '저장'))),
  };
}

function newCategorySheet(s) {
  const color = state.drafts['nc-color'];
  const isPublic = state.drafts['nc-public'];
  const back = () => {
    state.sheet = s.ret.after === 'todo' ? { type: 'todo', id: s.ret.todoId } : null;
    render();
  };
  return {
    title: '카테고리 추가',
    body: h('form', {
      class: 'stack',
      onsubmit: (e) => {
        e.preventDefault();
        act(async () => {
          const id = await store.createCategory({ name: state.drafts['nc-name'], color, is_public: isPublic });
          if (s.ret.after === 'todo') {
            state.drafts['e-cat'] = id;
            state.sheet = { type: 'todo', id: s.ret.todoId };
          } else {
            prefSet('lastCat', id);
            state.sheet = null;
          }
          return '카테고리를 만들었어요';
        });
      },
    },
    h('label', { class: 'field' }, h('span', null, '이름'),
      draftInput('nc-name', { placeholder: '예: 운동, 공부, 회사', maxlength: 20, required: true, autocomplete: 'off' })),
    h('div', { class: 'field' }, h('span', null, '색상'),
      h('div', { class: 'swatches', role: 'radiogroup', 'aria-label': '색상' }, COLORS.map((c) => h('button', {
        type: 'button', role: 'radio', 'aria-checked': String(c === color), 'aria-label': c,
        class: `swatch${c === color ? ' selected' : ''}`, style: { background: c },
        onclick: () => { state.drafts['nc-color'] = c; render(); },
      })))),
    h('div', { class: 'field' }, h('span', null, '공개 범위'),
      h('div', { class: 'segmented two', role: 'radiogroup' },
        [[true, '공개'], [false, '비공개 🔒']].map(([v, label]) => h('button', {
          type: 'button', role: 'radio', 'aria-checked': String(v === isPublic), class: `seg${v === isPublic ? ' active' : ''}`,
          onclick: () => { state.drafts['nc-public'] = v; render(); },
        }, label))),
      h('p', { class: 'hint' }, isPublic ? '연결된 상대에게 이 카테고리의 할 일이 보여요.' : '이 카테고리의 할 일은 나만 볼 수 있어요.')),
    h('div', { class: 'row gap' },
      h('button', { class: 'btn grow', type: 'button', onclick: back }, '취소'),
      h('button', { class: 'btn btn-primary grow', type: 'submit' }, '추가'))),
  };
}

function settingsSheet() {
  const me = state.me;
  const cats = state.cats.get(me.id) || [];
  return {
    title: '설정',
    body: [
      h('div', { class: 'section' }, h('h3', null, '내 정보'),
        h('form', {
          class: 'row gap',
          onsubmit: (e) => { e.preventDefault(); act(async () => { await store.updateProfile({ nickname: state.drafts['s-nick'] ?? me.nickname }); return '아이디를 바꿨어요'; }); },
        },
        h('input', {
          'data-key': 's-nick', value: state.drafts['s-nick'] ?? me.nickname, maxlength: 20, 'aria-label': '아이디',
          oninput: (e) => { state.drafts['s-nick'] = e.target.value; },
        }),
        h('button', { class: 'btn', type: 'submit' }, '저장')),
        h('p', { class: 'hint' }, '초대 코드 ', h('b', { class: 'mono' }, me.invite_code), ' · 상대가 이 코드나 아이디로 나를 찾을 수 있어요.')),

      h('div', { class: 'section' }, h('h3', null, '연결 관리'),
        state.conns.partners.length + state.conns.incoming.length + state.conns.outgoing.length
          ? connectionLists()
          : h('p', { class: 'hint' }, '연결된 상대가 없어요.'),
        h('button', { class: 'btn btn-sm', type: 'button', onclick: () => openSheet('partner') }, icon('userPlus'), '상대 추가')),

      h('div', { class: 'section' }, h('h3', null, '알림'), pushSection()),

      h('div', { class: 'section' }, h('h3', null, '카테고리와 공개 범위'),
        h('p', { class: 'hint' }, '비공개 카테고리의 할 일은 상대에게 보이지 않아요. 색상 원을 누르면 색이 바뀌어요.'),
        h('ul', { class: 'rows' }, cats.map((c, i) => h('li', { class: 'row-item cat-row' },
          h('div', { class: 'reorder' },
            h('button', {
              type: 'button', 'aria-label': `${c.name} 위로`, disabled: i === 0,
              onclick: () => moveCategory(i, -1),
            }, icon('up')),
            h('button', {
              type: 'button', 'aria-label': `${c.name} 아래로`, disabled: i === cats.length - 1,
              onclick: () => moveCategory(i, 1),
            }, icon('down'))),
          h('button', {
            class: 'swatch', type: 'button', style: { background: c.color }, 'aria-label': `${c.name} 색상 바꾸기`,
            onclick: () => act(() => store.updateCategory(c.id, { color: COLORS[(COLORS.indexOf(c.color) + 1) % COLORS.length] })),
          }),
          h('input', {
            class: 'grow', 'data-key': `cat-${c.id}`, value: state.drafts[`cat-${c.id}`] ?? c.name, maxlength: 20, 'aria-label': '카테고리 이름',
            oninput: (e) => { state.drafts[`cat-${c.id}`] = e.target.value; },
            onchange: (e) => { const v = e.target.value; delete state.drafts[`cat-${c.id}`]; if (v.trim() !== c.name) act(() => store.updateCategory(c.id, { name: v })); },
          }),
          h('label', { class: 'switch', title: c.is_public ? '공개' : '비공개' },
            h('input', {
              type: 'checkbox', checked: !!c.is_public, 'aria-label': `${c.name} 공개`,
              onchange: (e) => act(() => store.updateCategory(c.id, { is_public: e.target.checked })),
            }),
            h('span', { class: 'switch-ui' }),
            h('span', { class: 'switch-label' }, c.is_public ? '공개' : '비공개')),
          h('button', {
            class: 'icon-btn', type: 'button', 'aria-label': `${c.name} 삭제`,
            onclick: () => { if (confirm(`'${c.name}' 카테고리를 삭제할까요? 이 카테고리의 할 일도 함께 삭제돼요.`)) act(() => store.deleteCategory(c.id)); },
          }, icon('trash'))))),
        h('form', {
          class: 'row gap',
          onsubmit: (e) => { e.preventDefault(); const name = state.drafts['new-cat']; act(async () => { await store.createCategory({ name }); state.drafts['new-cat'] = ''; }); },
        },
        draftInput('new-cat', { placeholder: '새 카테고리', maxlength: 20, required: true }),
        h('button', { class: 'btn', type: 'submit' }, '추가'))),

      h('div', { class: 'section' }, h('h3', null, '지원'),
        h('button', {
          class: 'btn btn-block', type: 'button',
          onclick: () => {
            if (!config.supportEmail) { toast('문의 메일 주소가 아직 설정되지 않았어요 (js/config.js)'); return; }
            location.href = `mailto:${config.supportEmail}?subject=${encodeURIComponent(`[${config.appName}] 문의`)}&body=${encodeURIComponent(`\n\n---\n버전 ${config.version} · ${navigator.userAgent}`)}`;
          },
        }, '문의하기'),
        h('p', { class: 'hint' }, `핵심 기능(할 일, 상대 추가, 공유 보기)은 앞으로도 무료로 유지합니다. · 버전 ${config.version}${store.mode === 'local' ? ' · 데모 모드' : ''}`)),

      h('div', { class: 'section' },
        h('button', { class: 'btn btn-block', type: 'button', onclick: () => act(signOut) }, '로그아웃'),
        h('button', {
          class: 'btn btn-block btn-danger-ghost', type: 'button',
          onclick: () => {
            if (confirm('계정을 삭제할까요? 할 일, 카테고리, 연결이 모두 지워지고 되돌릴 수 없어요.')) act(() => store.deleteAccount());
          },
        }, '계정 삭제')),
    ],
  };
}

// 카테고리를 한 칸 위/아래로. 화면에 먼저 반영하고 저장한다.
function moveCategory(i, dir) {
  const cats = [...(state.cats.get(state.me.id) || [])];
  const j = i + dir;
  if (j < 0 || j >= cats.length) return;
  [cats[i], cats[j]] = [cats[j], cats[i]];
  state.cats.set(state.me.id, cats);
  render();
  act(() => store.reorderCategories(cats.map((c) => c.id)));
}

function monthSheet(s) {
  const first = parseYmd(s.cursor);
  const y = first.getFullYear();
  const m = first.getMonth();
  const lead = (first.getDay() + 6) % 7;
  const count = new Date(y, m + 1, 0).getDate();
  const t = today();
  const move = async (dir) => {
    s.cursor = ymd(new Date(y, m + dir, 1));
    s.dots = null;
    render();
    await loadMonth().catch((e) => toast(e.message));
    render();
  };
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(h('span', { class: 'cal-cell empty' }));
  for (let day = 1; day <= count; day++) {
    const d = ymd(new Date(y, m, day));
    const hol = holidayOf(d);
    cells.push(h('button', {
      type: 'button', class: `cal-cell${dayTone(d)}${d === t ? ' is-today' : ''}${d === state.selected ? ' is-selected' : ''}`,
      'aria-label': `${m + 1}월 ${day}일${hol ? ` ${hol}` : ''}`,
      onclick: () => { state.selected = d; state.sheet = null; reload(); },
    },
    h('span', { class: 'cal-num' }, day),
    hol ? h('span', { class: 'cal-hol', title: hol }, shortHoliday(hol)) : null,
    dayDots(d, (id, day) => !!s.dots?.get(id)?.has(day))));
  }
  return {
    title: `${y}년 ${m + 1}월`,
    body: [
      h('div', { class: 'cal-nav' },
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': '이전 달', onclick: () => move(-1) }, icon('left')),
        h('button', {
          class: 'btn btn-sm', type: 'button',
          onclick: () => { state.selected = t; state.sheet = null; reload(); },
        }, '오늘'),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': '다음 달', onclick: () => move(1) }, icon('right'))),
      h('div', { class: 'cal' },
        WEEK.map((w, i) => h('span', { class: `cal-wd${i === 5 ? ' is-sat' : i === 6 ? ' is-red' : ''}` }, w)),
        cells),
      h('div', { class: 'legend' },
        visiblePartners().map((p) => h('span', null, h('i', { class: 'dot', style: { background: p.color } }), p.nickname)),
        h('span', null, h('i', { class: 'dot dot-me' }), '나')),
      monthHolidayList(y, m),
    ],
  };
}

// 달력 칸은 좁아서 긴 이름만 줄여 쓴다 (아래 목록에는 전체 이름)
const SHORT_HOLIDAY = { 대체공휴일: '대체휴일', 임시공휴일: '임시휴일', 대통령선거: '대선', 국회의원선거: '총선', 부처님오신날: '석가탄신', '어린이날·부처님오신날': '어린이날' };
const shortHoliday = (name) => SHORT_HOLIDAY[name] || name;

function monthHolidayList(y, m) {
  const count = new Date(y, m + 1, 0).getDate();
  const days = Array.from({ length: count }, (_, i) => ymd(new Date(y, m, i + 1))).filter(holidayOf);
  if (!days.length) return null;
  return h('ul', { class: 'hol-list' }, days.map((d) => h('li', null,
    h('b', null, `${parseYmd(d).getDate()}일 (${weekdayOf(d)})`), holidayOf(d))));
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); toast('복사했어요'); } catch { toast(text); }
}

// ---------------- 푸시 알림 ----------------
function pushEnv() {
  if (!store.pushSupported || !config.vapidPublicKey) return 'server-only';
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return ios && !standalone ? 'ios-install' : 'unsupported';
  }
  if (Notification.permission === 'denied') return 'denied';
  return 'ok';
}

async function currentSubscription() {
  const reg = await navigator.serviceWorker?.getRegistration();
  return reg ? reg.pushManager.getSubscription() : null;
}

async function saveSubscription(sub) {
  const j = sub.toJSON();
  await store.savePushSubscription({ endpoint: j.endpoint, p256dh: j.keys.p256dh, auth: j.keys.auth });
}

// 이 기기의 구독 상태를 읽고, 로그인한 계정에 다시 연결해 둔다
async function refreshPush() {
  if (pushEnv() !== 'ok') return;
  try {
    const sub = await currentSubscription();
    state.pushOn = !!sub && Notification.permission === 'granted';
    if (state.pushOn && state.me && !state.me.needsProfile) await saveSubscription(sub);
  } catch (e) { console.error(e); }
  render();
}

async function enablePush() {
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error('알림이 허용되지 않았어요. 브라우저나 휴대폰 설정에서 이 사이트 알림을 허용해 주세요');
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription())
    || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(config.vapidPublicKey) });
  await saveSubscription(sub);
  state.pushOn = true;
  return '이 기기에서 알림을 받아요';
}

async function disablePush() {
  const sub = await currentSubscription();
  if (sub) {
    await store.deletePushSubscription(sub.endpoint).catch(() => {});
    await sub.unsubscribe();
  }
  state.pushOn = false;
  return '이 기기의 알림을 껐어요';
}

async function signOut() {
  if (store.pushSupported) {
    const sub = await currentSubscription().catch(() => null);
    if (sub) await store.deletePushSubscription(sub.endpoint).catch(() => {});
  }
  await store.signOut();
}

function pushSection() {
  const env = pushEnv();
  const hint = (t) => h('p', { class: 'hint' }, t);
  if (env === 'server-only') return hint('데모 모드에서는 알림을 받을 수 없어요.');
  if (env === 'ios-install') return hint('아이폰은 사파리 공유 버튼 → "홈 화면에 추가"로 설치한 앱에서 알림을 켤 수 있어요.');
  if (env === 'unsupported') return hint('이 브라우저는 알림을 지원하지 않아요.');
  if (env === 'denied') return hint('알림이 차단돼 있어요. 브라우저나 휴대폰 설정에서 이 사이트의 알림을 허용해 주세요.');
  return [
    h('div', { class: 'row gap' },
      h('span', { class: 'grow' }, state.pushOn ? '🔔 이 기기에서 알림 받는 중' : '이 기기에서 알림 꺼짐'),
      h('button', {
        class: `btn btn-sm${state.pushOn ? '' : ' btn-primary'}`, type: 'button',
        onclick: () => act(state.pushOn ? disablePush : enablePush),
      }, state.pushOn ? '끄기' : '알림 켜기')),
    hint('친구가 공개 카테고리의 할 일을 완료하면 알려 드려요. 친구별로 끄려면 연결 관리에서 🔔를 누르세요.'),
  ];
}

function registerServiceWorker() {
  const local = ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && (location.protocol === 'https:' || local)) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

boot();
