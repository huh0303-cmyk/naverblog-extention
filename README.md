# 네이버 블로그 자동화

Google Chrome 확장프로그램과 Codex CLI로 네이버·티스토리 글 생성 및 발행을 관리하는 Electron 앱입니다. 로그인은 사용자가 Chrome에서 직접 진행합니다.

## 실행

Node.js 24 이상, Google Chrome, 로그인된 Codex CLI가 필요합니다.

```sh
npm ci
npm start
```

개발 데이터는 기존 `runtime` 폴더에 저장됩니다. 업데이트 시 이 폴더를 유지하세요. 배포판은 OS의 앱 사용자 데이터 폴더를 사용합니다.

## 최초 연결

1. 앱에서 블로그 ID를 등록하고 **블로그 열기 / 로그인**을 실행합니다.
2. **크롬 확장 설치 → 설치 폴더 준비**로 확장 경로를 확인합니다.
3. 해당 Chrome의 `chrome://extensions`에서 개발자 모드를 켜고 **압축해제된 확장 프로그램을 로드합니다**로 폴더를 선택합니다.
4. 앱의 **확장프로그램 연결** 코드를 확장에 입력합니다.

계정별 Chrome마다 최초 연결이 필요합니다. 티스토리를 사용하면 공용 Chrome에도 로그인·연결하세요. 확장 업데이트 후에는 설치 폴더를 준비하고 확장 관리 화면에서 새로고침합니다.

## 배포

```sh
npm run dist           # Windows 휴대용 EXE: Windows에서 실행
npm run dist:mac:arm64 # Apple Silicon DMG: macOS에서 실행
npm run dist:mac:x64   # Intel DMG: macOS에서 실행
```

결과물은 `dist`에 생성되며 테스트·개인 데이터는 제외합니다. macOS에서는 `npm ci`를 새로 실행하세요. macOS 대응은 코드·모의 환경을 검증했으며 실제 Mac 실행·설치는 미검증입니다. 코드 서명·공증은 별도 설정이 필요합니다.

기존 [blogauto-naver](https://github.com/boksajang/blogauto-naver)를 기반으로 합니다. 윤문 규칙의 출처와 라이선스는 [NOTICE](packages/blog-humanizer/NOTICE), [LICENSE](packages/blog-humanizer/LICENSE)에 보존합니다.
