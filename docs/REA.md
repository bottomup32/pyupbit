# REA 분석 기록

## 실제 분석한 대상

1. 공개 소스 참조: [Beveren FSM](https://github.com/Beveren-Software-Inc/Field_Service_Management), develop 아카이브의 `schedule/src/hooks`.
2. 독립 구현: `/workspace/hvac-crm/static`의 JavaScript와 HTML.

상용 서비스 후보는 [Jobber](https://www.getjobber.com/features/), [Housecall Pro](https://www.housecallpro.com/), [ServiceTitan](https://www.servicetitan.com/)입니다. Jobber의 공개 검색 결과에서 고객 이력·견적·일정·청구·팀 관리 기능을 확인했습니다. 로그인된 Jobber 계정의 내부 동작은 도구 접근 부재로 분석하지 못했습니다.

## 도구 및 재현

공식 npm 패키지 `rea-agents@6.5.0`을 사용했습니다.

```bash
/workspace/shared/rea-cli/bin/rea analyze-javascript-application \
  /workspace/shared/references/beveren-fsm/schedule/src/hooks \
  --format json > /tmp/reference-evidence.json

/workspace/shared/rea-cli/bin/rea analyze-javascript-application \
  /workspace/hvac-crm/static \
  --format json > /tmp/implementation-evidence.json
```

원본 참조 아카이브 SHA-256:
`e76077253acfdafc29a75e15028bfd284e25940ea66eb0a9f2d86f29a34ed800`.

참조 Evidence ID:
`ev_127bbccdbaabb587029fb6542a1cff83fa2e21175856419269dc7881b274c081`.

REA는 참조 TypeScript 파일 4개, 24,660 bytes, AST 노드 2,994개를 처리했고 파싱 실패는 0개였습니다. 구조상 findings 41개를 반환했습니다. 이 값은 제품 기능 수 또는 취약점 수가 아닙니다.

## 분석에서 확인한 것과 적용

| 참조 근거 | 확인한 동작 | 독립 구현 |
|---|---|---|
| `use-appointments.ts:3` 이후 | 날짜·상태로 방문 목록 조회 | Dispatch의 날짜·상태 필터 |
| `use-appointments.ts:130` 이후 | 기사의 이름·서비스 지역·전문 분야 조회 | 기사 명부와 전문 분야 |
| `use-appointments.ts:293` 이후 | 서비스 작업과 기사·예정 시간으로 방문 생성 | 승인 견적→작업·기사·시간 연결 |
| `use-service-requests.ts:12` 이후 | 상태·기간·검색어를 통한 작업 추적 | 요청 상태 관리·검색·작업 이력 |
| 공개 README | 요청→견적→서비스 작업→방문→실행→청구 | 고객 문의부터 청구까지의 전체 기본 흐름 |

REA 결과에서 관련 구조를 찾고 해당 파일 원문으로 의미를 대조했습니다. 원본 앱을 실행하거나 ERPNext 서버에 연결한 것은 아닙니다. 로그인된 원본의 실제 동작과 동일하다고 검증하지 않았습니다.

## 보존한 분석 결과

- 전체 참조 Evidence: `/workspace/shared/references/beveren-fsm-rea-evidence.json`
- 최종 구현 Evidence: `/workspace/shared/evidence/hvac-implementation.json.gz`
- 요약: `docs/rea-summary.json`

정적 분석의 의미 그래프에는 `unknown` 및 `partial` 커버리지가 존재합니다. 호출과 데이터 관계가 모두 해석된 결과가 아니며, 파싱 성공은 동작 정확성이나 제품 동등성의 증명이 아닙니다. 실행 정확성은 별도의 브라우저·API 워크플로 테스트로 확인했습니다.

공개 참조의 라이선스는 원본 폴더의 `license.txt`에 보관되어 있습니다. 참조 소스는 원본 경로에 보존했고, 앱 구현은 별도로 작성했습니다.
