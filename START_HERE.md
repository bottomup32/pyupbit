# 아침에 여기부터 확인해 주세요

**Airframe 0.2.0 — 미국 HVAC 업체용 로컬 CRM**

## 1. 가장 쉽게 실행하기

ZIP 압축을 먼저 풀어 주세요. Python 3.12 이상이 설치된 컴퓨터에서:

- **Windows:** `Start Airframe.bat`를 더블클릭합니다.
- **macOS:** `Start Airframe.command`를 엽니다. 실행 확인 창이 나오면 파일을 우클릭한 뒤 열기를 선택합니다.
- **터미널:** 프로젝트 폴더에서 `python3 launch.py`를 실행합니다. Windows에서는 `py -3 launch.py`도 됩니다.

실행기가 서버 준비를 확인한 후 브라우저를 자동으로 엽니다. 같은 데이터의 앱이 이미 실행 중이면 기존 앱을 엽니다. 실행 창을 유지하고, 종료할 때는 Ctrl+C를 누릅니다. 데이터는 자동 저장됩니다.

Python이 없다면 먼저 [공식 Python](https://www.python.org/downloads/) 3.12 이상을 설치해야 합니다. 앱을 위한 추가 패키지나 API 키는 필요하지 않습니다. Windows에서 시스템 시간대 파일이 없어도 실행되도록 Pacific 시간대 자료를 포함했습니다.

클라우드 개발 환경에는 Python·REA·Chromium이 준비되어 있고 앱이 실행 중입니다. 이 클라우드의 루프백 서버를 사용자 컴퓨터에서 직접 여는 연결 기능은 제공되지 않아, 다운로드한 앱은 본인 컴퓨터에서 실행합니다.

## 2. 화면만 먼저 둘러보기

압축을 푼 폴더의 **`REVIEW.html`**을 열면 16개 화면과 모바일 화면, 검증 요약을 볼 수 있습니다. 이 문서는 Python 없이도 볼 수 있는 화면 갤러리입니다. 실제 입력·저장은 실행기를 통해 연 앱에서 합니다.

## 3. 직접 확인할 순서

1. **Customers:** 샘플 고객을 열어 사업장·장비·이력을 확인합니다.
2. **Estimates:** 샘플 견적을 열어 **Edit draft**로 수정하고 **Record approval**을 선택합니다.
3. **Schedule visit:** 기사와 시간을 정합니다. 같은 기사의 일정이 겹치면 저장을 거부합니다.
4. **Dispatch board:** 작업을 열고 **Mark en route → Start job → Complete job**을 진행합니다. 메모·체크리스트·사진·사용 부품을 기록할 수 있습니다.
5. **Create invoice → Record payment:** 청구와 부분 수금·완납을 확인합니다. 이 버튼은 이미 받은 돈을 기록하며 카드에 청구하지 않습니다.

샘플 작업 날짜가 오늘과 다르면 Dispatch의 날짜를 바꾸거나 Overview의 **View latest scheduled day**를 선택하면 됩니다. 사용자 작업의 날짜를 자동으로 옮기지 않습니다.

## 4. 데이터 보호

- 시작할 때 `data/backups`에 **일별 백업**을 만듭니다. 기존 일별 백업은 덮어쓰지 않습니다.
- **Settings → Download workspace backup**으로 고객·작업·첨부파일을 함께 백업합니다.
- `python3 manage.py check`는 데이터와 연결 관계를 검사합니다.
- 복구는 서버를 종료한 뒤 `python3 manage.py restore 백업파일.sqlite3`로 실행합니다. 실행 중인 데이터는 복구할 수 없으며, 복구 직전 데이터도 별도 백업으로 보존합니다.
- `data/crm.sqlite3`와 `data/backups`를 지우지 마세요. 배포 ZIP에는 기존 작업 데이터나 개인 정보가 들어 있지 않으며 첫 실행에 가상 데이터가 생성됩니다.

## 5. 검증 결과와 범위

- [기본 업무 흐름 결과](docs/test-results.txt): 고객→견적→작업→청구→수금 등 34개 확인.
- [복구·설치·동시 처리 결과](docs/recovery-results.txt): 백업/복구, 실행기 재시작, 중복 결제·재고 사용, 서머타임 등 10개 테스트.
- [UI 확인 결과](docs/ui-results.txt): 11개 검증 묶음. 4개 화면 폭에서 16개 화면, 작은 화면의 입력 창 12개, 빈 상태, 키보드, 인쇄/PDF 확인.
- [REA 분석 기록](docs/REA.md) / [상세 기능 및 실행 문서](README.md).

테스트는 Linux/Chromium에서 수행했습니다. Windows/macOS 실행 파일을 포함했고 시간대 부재를 재현해 검증했지만, 실제 Windows/macOS 기기에서 실행한 결과는 아닙니다.

## 외부 연동 상태

기본 실행기는 단일 회사용 로컬 워크스페이스입니다. 온라인 배포 어댑터에는 공유 비밀번호 로그인을 추가했으며 [DEPLOY.md](DEPLOY.md)에 설정을 정리했습니다. 온라인 주소는 아직 발급되지 않았습니다. 실제 결제·이메일·SMS·QuickBooks·공개 고객 포털·직원별 계정은 연결하지 않았습니다. Jobber 로그인 화면 전체를 읽어 복제한 결과가 아니라 REA로 공개 참조 앱과 자체 구현을 분석한 독립 CRM입니다.
