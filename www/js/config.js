// Supabase 프로젝트 정보를 넣으면 서버 모드로 동작합니다.
// 비워 두면 "데모 모드": 이 브라우저(localStorage) 안에서만 저장됩니다.
// anon key는 공개용 키라서 앱에 넣어도 됩니다. 데이터 보호는 DB의 Row Level Security가 맡습니다.
export const config = {
  supabaseUrl: 'https://wzdlityqbmrebumfooyv.supabase.co',
  supabaseAnonKey: 'sb_publishable__bQ6JAw5Q7AG7ywx6UzyAA_LFe7yXvl',
  // Supabase > Authentication > Providers 에서 켠 소셜 로그인만 적는다. 예: ['google', 'apple']
  oauthProviders: [],
  // 설정 > 문의하기 에서 열릴 메일 주소
  supportEmail: '',
  appName: '공유 투두',
  version: '0.1.0',
};
