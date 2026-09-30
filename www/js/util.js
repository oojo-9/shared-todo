// 공용 유틸: DOM 생성, 날짜, 상태값, 저장소 래퍼

export function h(tag, props, ...children) {
  const el = document.createElement(tag);
  let value;
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'value') value = v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [sk, sv] of Object.entries(v)) {
          if (sk.startsWith('--')) el.style.setProperty(sk, sv);
          else el.style[sk] = sv;
        }
      } else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
      else if (typeof v === 'boolean') el[k] = v;
      else el.setAttribute(k, v);
    }
  }
  appendChildren(el, children);
  if (value != null) el.value = value;
  return el;
}

function appendChildren(el, children) {
  for (const c of children) {
    if (c == null || c === false) continue;
    if (Array.isArray(c)) appendChildren(el, c);
    else el.append(c instanceof Node ? c : String(c));
  }
}

const ICONS = {
  check: '<path d="M5 12.5l4.2 4.2L19 7"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  left: '<path d="M15 5l-7 7 7 7"/>',
  right: '<path d="M9 5l7 7-7 7"/>',
  down: '<path d="M6 9l6 6 6-6"/>',
  up: '<path d="M6 15l6-6 6 6"/>',
  x: '<path d="M6 6l12 12M18 6L6 18"/>',
  gear: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  userPlus: '<path d="M15 20v-1.5A3.5 3.5 0 0 0 11.5 15h-5A3.5 3.5 0 0 0 3 18.5V20"/><circle cx="9" cy="8" r="3.5"/><path d="M19 8v6M16 11h6"/>',
  split: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M12 4v16"/>',
  list: '<path d="M9 6h11M9 12h11M9 18h11"/><path d="M4 6h.01M4 12h.01M4 18h.01" stroke-width="3"/>',
  copy: '<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V6a2 2 0 0 1 2-2h8"/>',
  share: '<path d="M12 3v12M7 8l5-5 5 5"/><path d="M5 13v6a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-6"/>',
  trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
};

export function icon(name) {
  const span = document.createElement('span');
  span.className = 'ico';
  span.setAttribute('aria-hidden', 'true');
  span.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ''}</svg>`;
  return span;
}

// ---- 날짜 (YYYY-MM-DD, 로컬 시간 기준) ----
const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const parseYmd = (s) => { const [y, m, d] = s.split('-').map(Number); return new Date(y, m - 1, d); };
export const addDays = (s, n) => { const d = parseYmd(s); d.setDate(d.getDate() + n); return ymd(d); };
export const startOfWeek = (s) => { const d = parseYmd(s); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return ymd(d); };
export const today = () => ymd(new Date());
export const WEEK = ['월', '화', '수', '목', '금', '토', '일'];
export const weekdayOf = (s) => WEEK[(parseYmd(s).getDay() + 6) % 7];

// ---- 반복 일정 ----
// freq: 'daily' | 'weekly'(days: 0=월…6=일) | 'monthly'(mday: 1~31, 없는 날은 그 달 말일)
export const REPEAT_MAX_DAYS = 366;
export function expandRepeat({ freq, days = [], mday = 1, start, end }) {
  if (!start || !end || end < start) return [];
  const out = [];
  if (freq === 'monthly') {
    const s = parseYmd(start);
    for (let y = s.getFullYear(), m = s.getMonth(); out.length <= REPEAT_MAX_DAYS; m++) {
      if (m > 11) { m = 0; y++; }
      const last = new Date(y, m + 1, 0).getDate();
      const d = ymd(new Date(y, m, Math.min(mday, last)));
      if (d > end) break;
      if (d >= start) out.push(d);
    }
    return out;
  }
  for (let d = start; d <= end && out.length <= REPEAT_MAX_DAYS; d = addDays(d, 1)) {
    if (freq === 'daily' || days.includes((parseYmd(d).getDay() + 6) % 7)) out.push(d);
  }
  return out;
}
export function repeatLabel({ freq, days = [], mday = 1 }) {
  if (freq === 'daily') return '매일';
  if (freq === 'weekly') return `매주 ${[...days].sort((a, b) => a - b).map((i) => WEEK[i]).join('·')}`;
  return `매월 ${mday}일`;
}

// ---- 할 일 상태 3단계 ----
// ---------- 시작·마감 시간과 알림 ----------
// 시간은 할 일 날짜 기준 'HH:MM', 알림은 몇 분 전에 울릴지 (null = 알림 없음)
export const TIME_KEYS = ['start_time', 'due_time', 'start_alert', 'due_alert'];
export const ALERT_OPTIONS = [[0, '정각'], [5, '5분 전'], [10, '10분 전'], [30, '30분 전'], [60, '1시간 전'], [180, '3시간 전'], [1440, '하루 전']];
export const alertLabel = (m) => (ALERT_OPTIONS.find(([v]) => v === m) || [m, `${m}분 전`])[1];
export const hhmm = (v) => (/^\d{2}:\d{2}/.test(v || '') ? v.slice(0, 5) : null);
const alertMin = (v) => (v === '' || v == null || !ALERT_OPTIONS.some(([m]) => m === Number(v)) ? null : Number(v));
// patch에 들어 있는 시간 항목만 저장용 값으로 바꾼다. 시간이 없으면 그 알림도 끈다.
export function normTimes(patch) {
  const out = {};
  for (const [time, alert] of [['start_time', 'start_alert'], ['due_time', 'due_alert']]) {
    if (time in patch) out[time] = hhmm(patch[time]);
    if (alert in patch) out[alert] = (time in patch && !out[time]) ? null : alertMin(patch[alert]);
  }
  return out;
}
// 목록 정렬: 시간 있는 일을 시간 순으로 위에
export const timeKey = (t) => hhmm(t.start_time) || hhmm(t.due_time) || '99:99';
export const isOverdue = (t, now = new Date()) => {
  const due = hhmm(t.due_time);
  if (!due || t.status === 'done') return false;
  const [y, mo, d] = t.date.split('-').map(Number);
  const [hh, mm] = due.split(':').map(Number);
  return new Date(y, mo - 1, d, hh, mm) < now;
};

export const STATUS = ['todo', 'doing', 'done'];
export const STATUS_LABEL = { todo: '할 일 전', doing: '진행중', done: '완료' };
export const nextStatus = (s) => STATUS[(STATUS.indexOf(s) + 1) % STATUS.length];

export const COLORS = ['#3b7ddd', '#e8833a', '#2e9d62', '#d64576', '#8a5cf6', '#c9a227', '#1a9bb0', '#7a828e'];

// ---- 검증 ----
export function validNickname(s) {
  const v = String(s ?? '').trim();
  if (!/^[\p{L}\p{N}_.-]{2,20}$/u.test(v)) throw new Error('아이디는 공백 없이 2~20자로 입력해 주세요 (한글·영문·숫자·_ . -)');
  return v;
}
export function validText(s, label, max) {
  const v = String(s ?? '').trim();
  if (!v) throw new Error(`${label}을(를) 입력해 주세요`);
  if (v.length > max) throw new Error(`${label}은(는) ${max}자까지 쓸 수 있어요`);
  return v;
}

// base64url 문자열 → 바이트 (푸시 구독의 applicationServerKey 용)
export function b64urlToBytes(s) {
  const b64 = (s + '='.repeat((4 - (s.length % 4)) % 4)).replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : 'id-' + Math.random().toString(36).slice(2) + Date.now().toString(36));
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const genCode = () => Array.from({ length: 6 }, () => CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]).join('');

// ---- 저장소 래퍼 (사생활 모드 등에서 예외가 나도 앱이 멈추지 않게) ----
function wrap(getStorage) {
  return {
    get(k) { try { return getStorage().getItem(k); } catch { return null; } },
    set(k, v) { try { getStorage().setItem(k, v); } catch { /* 무시 */ } },
    del(k) { try { getStorage().removeItem(k); } catch { /* 무시 */ } },
  };
}
export const ls = wrap(() => window.localStorage);
export const ss = wrap(() => window.sessionStorage);
export const prefGet = (k) => ls.get('shtodo.pref.' + k);
export const prefSet = (k, v) => (v == null ? ls.del('shtodo.pref.' + k) : ls.set('shtodo.pref.' + k, v));

let toastTimer;
// action: { label, onClick } 을 주면 토스트 안에 버튼(예: 되돌리기)이 붙는다
export function toast(msg, action) {
  let el = document.querySelector('.toast');
  if (!el) {
    el = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  const hide = () => el.classList.remove('show');
  el.replaceChildren(...[h('span', null, msg), action ? h('button', {
    class: 'toast-action', type: 'button',
    onclick: () => { hide(); action.onClick(); },
  }, action.label) : null].filter(Boolean)); // replaceChildren은 null을 "null" 글자로 넣으므로 걸러 낸다
  el.classList.toggle('has-action', !!action);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hide, action ? 4500 : 2400);
}
