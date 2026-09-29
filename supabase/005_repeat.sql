-- 공유 투두 · 반복 일정 (매일 / 매주 / 매월, 시작일~종료일)
-- 반복 일정은 날짜마다 할 일 행을 만들어 두고, 같은 series_id로 묶는다.
-- 그래서 날짜별 체크·공유·완료 알림은 일반 할 일과 똑같이 동작한다. 여러 번 실행해도 안전하다.

alter table public.todos add column if not exists series_id uuid;
alter table public.todos add column if not exists repeat text check (repeat is null or char_length(repeat) <= 40);

create index if not exists todos_series_idx on public.todos (series_id, date) where series_id is not null;
