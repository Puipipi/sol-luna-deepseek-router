#include <windows.h>
#include <wchar.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
static int app_server(int argc) {
  char line[4096];
#ifdef PATCHED_FAKE
  wchar_t *mode = _wgetenv(L"PATCHED_MODE");
  const wchar_t *selected = mode ? mode : L"exit";
  if (!fgets(line, sizeof(line), stdin)) return 3;
  if (!_wgetenv(L"CODEX_BOOTSTRAP_PROBE")) { if(_wcsicmp(selected,L"live-exit")==0){fputs("patched stream already consumed\n",stdout);fflush(stdout);return 2;}fputs("{\"id\":1,\"result\":{\"origin\":\"patched\"}}\n", stdout); fflush(stdout); if(!fgets(line,sizeof(line),stdin))return 6;fputs("{\"id\":2,\"result\":{\"config\":{}}}\n",stdout);fflush(stdout);return 0; }
  wchar_t *probeMarker=_wgetenv(L"PROBE_HOME_MARKER"),*probeHome=_wgetenv(L"CODEX_HOME");if(probeMarker&&probeHome){HANDLE f=CreateFileW(probeMarker,GENERIC_WRITE,0,NULL,CREATE_ALWAYS,FILE_ATTRIBUTE_NORMAL,NULL);if(f!=INVALID_HANDLE_VALUE){char utf8[2048];int n=WideCharToMultiByte(CP_UTF8,0,probeHome,-1,utf8,sizeof(utf8),NULL,NULL);DWORD written;if(n>0)WriteFile(f,utf8,(DWORD)(n-1),&written,NULL);CloseHandle(f);}}
  if (_wcsicmp(selected, L"hang") == 0) { Sleep(6000); return 0; }
  if (_wcsicmp(selected, L"garbage") == 0) { fputs("this is not JSON\n", stdout); fflush(stdout); return 0; }
  if (_wcsicmp(selected, L"malformed") == 0) { fputs("{\"id\":1,\"result\":{\"userAgent\":\"broken\"}\n", stdout); fflush(stdout); return 0; }
  if (_wcsicmp(selected, L"wrong-version") == 0) { fputs("{\"id\":1,\"result\":{\"userAgent\":\"0.163.0\"}}\n", stdout); fflush(stdout); return 0; }
  if (_wcsicmp(selected, L"wrong-field-version") == 0) { fputs("{\"id\":1,\"result\":{\"userAgent\":\"codex-cli/0.163.0\",\"other\":\"0.164.0-alpha.11.1\"}}\n", stdout); fflush(stdout); if(!fgets(line,sizeof(line),stdin))return 4;fputs("{\"id\":2,\"result\":{\"config\":{}}}\n",stdout);fflush(stdout);return 0; }
  if (_wcsicmp(selected, L"version-prefix") == 0) { fputs("{\"id\":1,\"result\":{\"userAgent\":\"codex-cli/0.164.0-alpha.11.10 (windows)\"}}\n", stdout); fflush(stdout); if(!fgets(line,sizeof(line),stdin))return 4;fputs("{\"id\":2,\"result\":{\"config\":{}}}\n",stdout);fflush(stdout);return 0; }
  if (_wcsicmp(selected, L"live-exit") == 0) { fputs("{\"id\":1,\"result\":{\"userAgent\":\"0.164.0-alpha.11.1\"}}\n",stdout);fflush(stdout);if(!fgets(line,sizeof(line),stdin))return 4;fputs("{\"id\":2,\"result\":{\"config\":{}}}\n",stdout);fflush(stdout);return 0; }
  if (_wcsicmp(selected, L"error") == 0) { fputs("{\"id\":1,\"error\":{\"code\":-1,\"message\":\"bad init\"}}\n", stdout); fflush(stdout); return 0; }
  if (_wcsicmp(selected, L"exit") == 0) return 2;
  if (_wcsicmp(selected, L"success") == 0) {
    fputs("{\"id\":1,\"result\":{\"userAgent\":\"codex-cli/0.164.0-alpha.11.1 (windows)\"}}\n", stdout); fflush(stdout);
    if (_wgetenv(L"CODEX_BOOTSTRAP_PROBE")) { fputs("{\"method\":\"remoteControl/status/changed\",\"params\":{}}\n", stdout); fflush(stdout); }
    if (!fgets(line, sizeof(line), stdin)) return 4;
    fputs("{\"id\":2,\"result\":{\"config\":{}}}\n", stdout); fflush(stdout);
    return 0;
  }
#else
  if (!fgets(line, sizeof(line), stdin)) return 3;
  fputs("{\"id\":1,\"result\":{\"userAgent\":\"official\"}}\n", stdout); fflush(stdout);
  if (!fgets(line, sizeof(line), stdin)) return 4;
  fputs("{\"id\":2,\"result\":{\"config\":{}}}\n", stdout); fflush(stdout); return 0;
#endif
  return argc;
}
int wmain(int argc, wchar_t **argv) {
  HANDLE out=GetStdHandle(STD_OUTPUT_HANDLE); DWORD wrote;
  if(argc>2 && _wcsicmp(argv[1],L"--spawn-observer")==0){wchar_t command[32768];_snwprintf(command,32768,L"\"%s\" --bootstrap-observe-backend",argv[2]);STARTUPINFOW si;ZeroMemory(&si,sizeof(si));si.cb=sizeof(si);si.dwFlags=STARTF_USESTDHANDLES|STARTF_USESHOWWINDOW;si.wShowWindow=SW_HIDE;si.hStdInput=GetStdHandle(STD_INPUT_HANDLE);si.hStdOutput=GetStdHandle(STD_OUTPUT_HANDLE);si.hStdError=GetStdHandle(STD_ERROR_HANDLE);PROCESS_INFORMATION pi;ZeroMemory(&pi,sizeof(pi));if(!CreateProcessW(argv[2],command,NULL,NULL,TRUE,CREATE_NO_WINDOW,NULL,NULL,&si,&pi))return 126;WaitForSingleObject(pi.hProcess,10000);DWORD exitCode=126;GetExitCodeProcess(pi.hProcess,&exitCode);CloseHandle(pi.hThread);CloseHandle(pi.hProcess);return (int)exitCode;}
  if(argc>1 && _wcsicmp(argv[1],L"--version")==0){const char *version="codex-cli 0.164.0-alpha.11.1\n";WriteFile(out,version,(DWORD)strlen(version),&wrote,NULL);return 0;}
#ifdef PATCHED_FAKE
  if(argc>1 && _wcsicmp(argv[1],L"app-server")==0){wchar_t *marker=_wgetenv(L"PATCH_MARKER");if(marker){HANDLE f=CreateFileW(marker,FILE_APPEND_DATA,FILE_SHARE_READ,NULL,OPEN_ALWAYS,FILE_ATTRIBUTE_NORMAL,NULL);if(f!=INVALID_HANDLE_VALUE){DWORD written;WriteFile(f,"started\n",8,&written,NULL);CloseHandle(f);}}return app_server(argc);}
#else
  if(argc>1 && _wcsicmp(argv[1],L"app-server")==0)return app_server(argc);
#endif
  char count[32]; sprintf(count,"argc=%d|",argc); WriteFile(out,count,(DWORD)strlen(count),&wrote,NULL);
  for(int i=1;i<argc;i++) { int n=WideCharToMultiByte(CP_UTF8,0,argv[i],-1,NULL,0,NULL,NULL); char *b=(char*)malloc(n); WideCharToMultiByte(CP_UTF8,0,argv[i],-1,b,n,NULL,NULL); WriteFile(out,b,(DWORD)(n-1),&wrote,NULL); WriteFile(out,"|",1,&wrote,NULL); free(b); }
  wchar_t *code=_wgetenv(L"FAKE_EXIT_CODE"); return code?_wtoi(code):0;
}

