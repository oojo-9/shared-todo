# 공유 투두 (가칭)

상대를 한 번 지정하면 그 사람의 할 일 목록을 내 화면에서 자동으로, 실시간으로 함께 보는 투두리스트.
`공유 투두리스트 앱 기획서 (초안).pdf`의 **1차 출시(MVP)** 범위를 구현한 웹앱(PWA)입니다.

## 구현 범위

| 기획서 항목 | 구현 |
|---|---|
| 날짜별 할 일 추가·수정·삭제, 체크박스 | ✅ 할 일을 누르면 수정 시트 (제목·날짜·카테고리·상태·삭제) |
| 카테고리와 색상 | ✅ 설정에서 추가·이름 변경·색상 변경·삭제 |
| 상태 3단계 (할 일 전 / 진행중 / 완료) | ✅ 체크박스를 누를 때마다 순서대로 바뀜 |
| 아이디 또는 초대 코드로 상대 지정, 상대 수락 후 연결 | ✅ 홈 상단 "상대 추가" 버튼, 받은 요청은 배너로 표시 |
| 상대 할 일 자동·실시간 조회, 보기 전용 | ✅ |
| 카테고리별 공개/비공개 | ✅ 비공개 카테고리의 할 일은 상대에게 안 보임 (DB에서 차단) |
| 연결 해제는 언제든 한쪽에서 | ✅ 설정 > 연결 관리 |
| 공유 화면: 좌(상대)·우(나) 분할, 공용 날짜 탭 | ✅ 월~일 한 줄, 좌우로 밀면 지난주·다음주, 오늘 강조 |
| "2026년 10월" 누르면 한 달 달력, 나/상대 색 점 | ✅ |
| 긴 제목 두 줄 줄바꿈 | ✅ (상대 칸 항목은 눌러서 전체 보기) |
| 상대 여러 명이면 왼쪽 이름 눌러 전환 | ✅ |
| 화면은 공유 보기·내 목록 두 개 | ✅ 하단 탭 |
| 설정에 문의하기 메뉴 | ✅ `js/config.js`의 `supportEmail` 설정 필요 |
| 앱 안 계정 삭제 (애플 심사) | ✅ |
| 시스템 글꼴, UTF-8·LF | ✅ `.gitattributes`, `.editorconfig` |

2차 기능(반복 루틴, D-day, 알림, 응원 반응, 위젯)은 아직 넣지 않았습니다.

## 폴더 구조

```
www/                  ← 앱 (Capacitor의 기본 webDir 이름과 같게 맞춤)
  index.html
  css/style.css
  js/app.js           화면과 동작
  js/store-local.js   데모 모드 저장소 (localStorage)
  js/store-supabase.js 서버 모드 저장소 (Supabase)
  js/config.js        Supabase 주소·키, 문의 메일
  manifest.webmanifest, sw.js, icons/
supabase/schema.sql   테이블 + Row Level Security + 공유 함수 + 실시간 설정
```

## 1. 바로 실행해 보기 (데모 모드)

`js/config.js`가 비어 있으면 **데모 모드**로 돌아갑니다. 데이터는 그 브라우저 안에만 저장됩니다.

```bash
python -m http.server 5173 --directory www
```

브라우저에서 http://localhost:5173 을 엽니다.

- 데모 상대 **민지**(초대 코드 `MINJI7`)가 들어 있습니다. 요청하면 자동으로 수락하고, 10초마다 민지의 오늘 할 일이 하나씩 진행돼 실시간 반영을 볼 수 있습니다.
- 탭을 두 개 열어 서로 다른 아이디로 로그인하면, 요청·수락·실시간 반영을 직접 시험할 수 있습니다.

## 2. Supabase 연결 (실제 서비스)

1. https://supabase.com 에서 새 프로젝트 만들기 (무료 요금제)
2. **SQL Editor**에 `supabase/schema.sql` 전체를 붙여 넣고 Run
3. **Project Settings > API**에서 `Project URL`과 `anon public` 키를 복사해 `www/js/config.js`에 입력
4. **Authentication > URL Configuration**의 Site URL / Redirect URLs에 앱 주소 추가 (예: `http://localhost:5173`, 배포 주소)
5. (선택) **Authentication > Providers**에서 Google, Apple 로그인 켜기

권한은 DB가 막습니다 — `can_view()`와 RLS 정책으로 "연결이 수락된 상대만, 공개 카테고리만" 조회되고, 수정은 본인 것만 됩니다.
연결 요청·수락·해제는 `request_share`, `respond_share`, `revoke_share` 함수로만 바꿀 수 있습니다.

## 3. 배포 (GitHub Pages)

`www/` 폴더를 그대로 올리면 됩니다. PWA 설치(홈 화면 추가)와 서비스 워커는 HTTPS에서만 동작합니다.
배포 주소를 Supabase Redirect URLs에도 추가하세요.

## 4. 스토어 앱으로 변환 (Capacitor)

Node.js 설치 후 프로젝트 루트에서:

```bash
npm init -y
```

```bash
npm install @capacitor/core @capacitor/cli @capacitor/android @capacitor/ios
```

```bash
npx cap init "공유 투두" com.example.sharedtodo --web-dir www
```

```bash
npx cap add android
```

```bash
npx cap open android
```

앱 ID(`com.example.sharedtodo`)는 스토어에 올리기 전에 본인 도메인 기반으로 바꾸세요. iOS는 맥과 Xcode가 필요합니다.

## 출시 전 체크리스트

- [ ] `config.js`에 Supabase 키, 문의 메일 입력
- [ ] 앱 이름 확정 (`manifest.webmanifest`, `index.html`, `config.js`의 "공유 투두")
- [ ] 개인정보처리방침 페이지
- [ ] 구글 플레이: 비공개 테스트 12명 × 14일 이상 → 프로덕션 신청
- [ ] 앱스토어: 구글 로그인을 넣었으면 애플 로그인도 제공, 심사용 테스트 계정 준비
