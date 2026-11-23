# 성장노트

교사 개인용 수업·일정·할 일 관리 웹앱. 목표와 원칙은 [개발목표.md](개발목표.md), 지금까지의 기능·변경 이력은 [성장노트_개발기록.md](성장노트_개발기록.md).

## 폴더

| 경로 | 내용 |
|------|------|
| `web/index.html` | 성장노트 본체 (Ver2, 아티팩트 판을 그대로 옮기고 Supabase 연결 스크립트 3줄만 추가) |
| `web/config.js` | Supabase **Project URL**과 **Publishable key**만 넣는 곳 (비어 있으면 이 브라우저에만 저장) |
| `web/supabase-bridge.js` | 이메일 코드 로그인 화면 + 저장을 Supabase로 보내는 연결 코드 |
| `supabase/schema.sql` | Supabase SQL Editor에서 한 번 실행할 표·보안 규칙(RLS)·실시간 설정 |

## 연결 순서

1. Supabase 프로젝트 만들기, 이메일 코드 설정 — 개발목표.md 2-1, 2-2
2. SQL Editor에서 `supabase/schema.sql` 실행
3. `web/config.js`에 Project URL과 Publishable key 넣기 (⛔ secret/service_role 키는 절대 넣지 않음)
4. Cloudflare Pages에 배포 — **Build output directory를 `web`** 으로 지정(문서 파일이 사이트에 올라가지 않게), 빌드 명령은 비움
5. 사이트 주소를 Supabase Authentication → URL Configuration에 등록 — 개발목표.md 2-3
6. 로그인 후 도구 → 백업 → '파일에서 불러오기'로 아티팩트에서 내려받은 백업 .json을 넣어 자료 옮기기
