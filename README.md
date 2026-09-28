# naverblog-extention

**네이버 블로그 자동화 by @복사장의생존발악**

일반 Google Chrome과 BlogAuto 확장프로그램으로 네이버·티스토리 글 생성 및 발행을 관리하는 Electron 앱입니다. 로그인은 사용자가 Chrome에서 직접 진행합니다.

## 설치 및 실행

Node.js 24 이상, npm, Google Chrome, 로그인된 Codex CLI가 필요합니다.

```sh
git clone https://github.com/boksajang/naverblog-extention.git
cd naverblog-extention
npm ci
npm start
```

비공개 저장소이므로 GitHub 접근 권한이 필요합니다. 기본 실행은 개발모드이며 계정·설정·작업 기록은 프로젝트의 `runtime` 폴더에 저장됩니다. 업데이트할 때 이 폴더를 유지하세요.

## Chrome 확장 연결

1. 앱에서 네이버 블로그 ID를 등록하고 **블로그 열기 / 로그인**으로 로그인합니다.
2. **크롬 확장 설치 → 설치 폴더 준비**에서 확장 폴더 경로를 확인합니다.
3. 해당 Chrome의 `chrome://extensions`에서 **개발자 모드 → 압축해제된 확장 프로그램을 로드합니다**를 선택하고 준비한 폴더를 지정합니다.
4. 앱의 **확장프로그램 연결**에서 받은 코드를 BlogAuto 확장에 입력합니다.

계정별 Chrome 창마다 최초 설치가 필요합니다. 확장 업데이트 후에는 설치 폴더를 준비하고 Chrome 확장 관리 화면에서 BlogAuto를 새로고침하세요. 폴더는 임의로 이동하거나 삭제하지 마세요.

네이버 계정에 티스토리 블로그 ID를 등록하면 네이버 발행 후 티스토리에도 발행합니다. 비워 두면 네이버만 발행합니다. 티스토리 공용 Chrome에도 최초 로그인과 확장 연결이 필요합니다.

## 배포용 빌드

먼저 `npm ci`로 개발 의존성까지 설치합니다. Windows 빌드는 Windows에서, macOS 빌드는 macOS에서 실행합니다.

```sh
# Windows 휴대용 실행 파일
npm run dist

# macOS DMG
npm run dist:mac
```

결과물은 `dist` 폴더에 생성됩니다. 앱 소스와 확장은 포함하고, 개인 계정·로그인·작업 데이터와 테스트는 포함하지 않습니다. 배포판은 OS의 앱 사용자 데이터 폴더를 사용하므로 개발모드의 `runtime` 데이터가 자동으로 이전되지는 않습니다. 코드 서명·공증은 별도 설정이 필요합니다.

평소에는 `npm start`를 사용하며, 배포가 필요할 때만 빌드합니다.

## 출처

기존 [blogauto-naver](https://github.com/boksajang/blogauto-naver)를 바탕으로 변경했습니다. 휴머나이저의 원본 출처와 라이선스는 [NOTICE](packages/blog-humanizer/NOTICE.md) 및 [LICENSE](packages/blog-humanizer/LICENSE)에 있습니다.
