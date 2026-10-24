#define UNICODE
#define _UNICODE
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <tlhelp32.h>
#include <shellapi.h>
#include <bcrypt.h>
#include <shlobj.h>
#include <appmodel.h>
#include <wchar.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef APPROVED_PATCH_SHA256
#define APPROVED_PATCH_SHA256 ""
#endif
#ifndef APPROVED_RUNTIME_VERSION
#define APPROVED_RUNTIME_VERSION ""
#endif
#ifndef APPROVED_SOURCE_COMMIT
#define APPROVED_SOURCE_COMMIT ""
#endif
#define MAX_PATH_CHARS 32768
#define MAX_RECEIPT 16384
#define PROBE_TIMEOUT_MS 1800
static const wchar_t *RESOLVE_OFFICIAL_ARGUMENT = L"--codex-native-resolve-official-cli-v1";
static const wchar_t *RESOLVE_OFFICIAL_ARGUMENT_V2 = L"--bootstrap-resolve-official-cli";
static const wchar_t *OBSERVE_BACKEND_ARGUMENT = L"--bootstrap-observe-backend";
static const wchar_t *CAPABILITIES_ARGUMENT = L"--bootstrap-capabilities";
static const wchar_t *FAMILY_SUFFIX = L"_x64__2p2nqsd0c76g0";
static const wchar_t *PACKAGE_FAMILY = L"OpenAI.Codex_2p2nqsd0c76g0";
static const char *STATUS_NO_OFFICIAL = "未能定位可启动的 Codex 官方桌面 CLI，原生分工已停用。Codex 桌面包可能已卸载或不可访问；请修复/重新安装 Codex，随后重新启动桌面应用。";
static const char *STATUS_INCOMPATIBLE = "兼容补丁尚未通过当前 Codex 版本验证";


typedef struct { wchar_t exe[MAX_PATH_CHARS]; wchar_t packageVersion[128]; } Official;

static int regular_file(const wchar_t *p) {
  DWORD a = GetFileAttributesW(p);
  return a != INVALID_FILE_ATTRIBUTES && !(a & FILE_ATTRIBUTE_DIRECTORY) && !(a & FILE_ATTRIBUTE_REPARSE_POINT);
}
static int same_path(const wchar_t *a, const wchar_t *b) { return _wcsicmp(a,b)==0; }
static int starts_i(const wchar_t *a, const wchar_t *b) { return _wcsnicmp(a,b,wcslen(b))==0; }

static int valid_package_path(const wchar_t *image, Official *out,int requireResource) {
  wchar_t full[MAX_PATH_CHARS];
  if(!GetFullPathNameW(image,MAX_PATH_CHARS,full,NULL)) return 0;
  wchar_t *package=wcsstr(full,L"\\WindowsApps\\OpenAI.Codex_");
  wchar_t *app=package?wcsstr(package,L"\\app\\"):NULL;
  if(!package || !app) return 0;
  const wchar_t *imageName=app+wcslen(L"\\app\\");
  if(_wcsicmp(imageName,L"Codex.exe")!=0&&_wcsicmp(imageName,L"ChatGPT.exe")!=0)return 0;
  wchar_t *version=package+wcslen(L"\\WindowsApps\\OpenAI.Codex_");
  wchar_t *pkgEnd=wcsstr(version,FAMILY_SUFFIX);
  if(!pkgEnd || pkgEnd>app) return 0;
  wchar_t versionText[128]; size_t n=(size_t)(pkgEnd-version);
  if(n==0 || n>=128) return 0;
  wmemcpy(versionText,version,n); versionText[n]=0;
  wchar_t resource[MAX_PATH_CHARS]; wcsncpy(resource,full,MAX_PATH_CHARS-1); resource[MAX_PATH_CHARS-1]=0;
  app=wcsstr(resource,L"\\app\\"); if(!app) return 0;
  wcscpy(app,L"\\app\\resources\\codex.exe");
  if(requireResource&&!regular_file(resource)) return 0;
  wcscpy(out->exe,resource); wcscpy(out->packageVersion,versionText); return 1;
}
static int parent_official(Official *out) {
  HANDLE snap=CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0); if(snap==INVALID_HANDLE_VALUE) return 0;
  PROCESSENTRY32W e; e.dwSize=sizeof(e); DWORD pid=GetCurrentProcessId(), parent=0;
  if(Process32FirstW(snap,&e)) do { if(e.th32ProcessID==pid){parent=e.th32ParentProcessID;break;} } while(Process32NextW(snap,&e));
  for(int i=0;i<12 && parent;i++) {
    HANDLE proc=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,parent);
    wchar_t image[MAX_PATH_CHARS]; DWORD size=MAX_PATH_CHARS; int found=0;
    if(proc && QueryFullProcessImageNameW(proc,0,image,&size)) found=valid_package_path(image,out,1);
    PROCESSENTRY32W p; p.dwSize=sizeof(p); DWORD next=0;
    if(Process32FirstW(snap,&p)) do { if(p.th32ProcessID==parent){next=p.th32ParentProcessID;break;} } while(Process32NextW(snap,&p));
    if(proc) CloseHandle(proc); if(found){CloseHandle(snap);return 1;} parent=next;
  }
  CloseHandle(snap); return 0;
}
static int version_greater(const wchar_t *a,const wchar_t *b) {
  const wchar_t *x=a,*y=b;
  for(int i=0;i<4;i++) { unsigned long av=wcstoul(x,(wchar_t**)&x,10), bv=wcstoul(y,(wchar_t**)&y,10); if(av!=bv)return av>bv; if(*x==L'.')x++; if(*y==L'.')y++; }
  return 0;
}
static int package_root_official(const wchar_t *root,Official *out,int requireResource) {
  wchar_t image[MAX_PATH_CHARS];int n=_snwprintf(image,MAX_PATH_CHARS,L"%s\\app\\Codex.exe",root);if(n<0||n>=MAX_PATH_CHARS)return 0;
  return valid_package_path(image,out,requireResource);
}
static int current_package_official(Official *out) {
  UINT32 length=0;LONG result=GetCurrentPackagePath(&length,NULL);if(result!=ERROR_INSUFFICIENT_BUFFER||!length||length>MAX_PATH_CHARS)return 0;
  wchar_t *root=(wchar_t*)HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,(SIZE_T)length*sizeof(wchar_t));if(!root)return 0;
  result=GetCurrentPackagePath(&length,root);int found=result==ERROR_SUCCESS&&package_root_official(root,out,1);HeapFree(GetProcessHeap(),0,root);return found;
}
static int registered_package_official(Official *out) {
  UINT32 count=0,bufferLength=0;LONG result=GetPackagesByPackageFamily(PACKAGE_FAMILY,&count,NULL,&bufferLength,NULL);
  if((result!=ERROR_INSUFFICIENT_BUFFER&&result!=ERROR_SUCCESS)||!count||!bufferLength)return 0;
  PWSTR *names=(PWSTR*)HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,(SIZE_T)count*sizeof(PWSTR));WCHAR *buffer=(WCHAR*)HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,(SIZE_T)bufferLength*sizeof(WCHAR));if(!names||!buffer){if(names)HeapFree(GetProcessHeap(),0,names);if(buffer)HeapFree(GetProcessHeap(),0,buffer);return 0;}
  result=GetPackagesByPackageFamily(PACKAGE_FAMILY,&count,names,&bufferLength,buffer);wchar_t bestPath[MAX_PATH_CHARS]=L"",bestVersion[128]=L"";
  if(result==ERROR_SUCCESS)for(UINT32 i=0;i<count;i++){
    UINT32 pathLength=0;LONG pathResult=GetPackagePathByFullName(names[i],&pathLength,NULL);if(pathResult!=ERROR_INSUFFICIENT_BUFFER||!pathLength||pathLength>MAX_PATH_CHARS)continue;
    wchar_t *root=(wchar_t*)HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,(SIZE_T)pathLength*sizeof(wchar_t));if(!root)continue;
    pathResult=GetPackagePathByFullName(names[i],&pathLength,root);Official candidate;ZeroMemory(&candidate,sizeof(candidate));if(pathResult==ERROR_SUCCESS&&package_root_official(root,&candidate,1)&&(!bestPath[0]||version_greater(candidate.packageVersion,bestVersion))){wcscpy(bestPath,candidate.exe);wcscpy(bestVersion,candidate.packageVersion);}HeapFree(GetProcessHeap(),0,root);
  }
  HeapFree(GetProcessHeap(),0,names);HeapFree(GetProcessHeap(),0,buffer);if(!bestPath[0])return 0;wcscpy(out->exe,bestPath);wcscpy(out->packageVersion,bestVersion);return 1;
}
enum { OFFICIAL_NONE=0,OFFICIAL_PARENT=1,OFFICIAL_CURRENT_PACKAGE=2,OFFICIAL_REGISTERED_PACKAGE=3 };
static int resolve_official(Official *out,int *source) {
#ifdef TEST_HARNESS
  if(!_wgetenv(L"CODEX_BOOTSTRAP_TEST_SKIP_PARENT")&&parent_official(out)){*source=OFFICIAL_PARENT;return 1;}
#else
  if(parent_official(out)){*source=OFFICIAL_PARENT;return 1;}
#endif
  if(current_package_official(out)){*source=OFFICIAL_CURRENT_PACKAGE;return 1;}
  if(registered_package_official(out)){*source=OFFICIAL_REGISTERED_PACKAGE;return 1;}
  *source=OFFICIAL_NONE;return 0;
}
#ifdef TEST_HARNESS
static int test_registered_roots(Official *out) {
  wchar_t *configured=_wgetenv(L"CODEX_BOOTSTRAP_TEST_REGISTERED_ROOTS");if(!configured)return 0;wchar_t *copy=(wchar_t*)HeapAlloc(GetProcessHeap(),0,(wcslen(configured)+1)*sizeof(wchar_t));if(!copy)return 0;wcscpy(copy,configured);int found=0;wchar_t bestVersion[128]=L"";
  for(wchar_t *ctx=NULL,*root=wcstok(copy,L";",&ctx);root;root=wcstok(NULL,L";",&ctx)){Official candidate;ZeroMemory(&candidate,sizeof(candidate));if(package_root_official(root,&candidate,0)&&(!found||version_greater(candidate.packageVersion,bestVersion))){*out=candidate;wcscpy(bestVersion,candidate.packageVersion);found=1;}}
  HeapFree(GetProcessHeap(),0,copy);return found;
}
#endif
static int sha256_file(const wchar_t *path,char out[65]) {
  HANDLE f=CreateFileW(path,GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_DELETE,NULL,OPEN_EXISTING,FILE_FLAG_SEQUENTIAL_SCAN,NULL); if(f==INVALID_HANDLE_VALUE)return 0;
  BCRYPT_ALG_HANDLE alg=NULL; BCRYPT_HASH_HANDLE h=NULL; DWORD objLen=0,cb=0; PUCHAR object=NULL; UCHAR digest[32]; int ok=0;
  if(BCryptOpenAlgorithmProvider(&alg,BCRYPT_SHA256_ALGORITHM,NULL,0)<0)goto done;
  if(BCryptGetProperty(alg,BCRYPT_OBJECT_LENGTH,(PUCHAR)&objLen,sizeof(objLen),&cb,0)<0)goto done;
  object=(PUCHAR)HeapAlloc(GetProcessHeap(),0,objLen); if(!object)goto done;
  if(BCryptCreateHash(alg,&h,object,objLen,NULL,0,0)<0)goto done;
  BYTE buf[65536]; DWORD got=0; while(ReadFile(f,buf,sizeof(buf),&got,NULL)&&got){if(BCryptHashData(h,buf,got,0)<0)goto done;}
  if(BCryptFinishHash(h,digest,sizeof(digest),0)<0)goto done;
  for(int i=0;i<32;i++) sprintf(out+i*2,"%02x",digest[i]);
  out[64]=0; ok=1;
done: if(h)BCryptDestroyHash(h);if(object)HeapFree(GetProcessHeap(),0,object);if(alg)BCryptCloseAlgorithmProvider(alg,0);CloseHandle(f);return ok;
}
static int write_stdout(const char *text) {
  HANDLE out=GetStdHandle(STD_OUTPUT_HANDLE);if(!out||out==INVALID_HANDLE_VALUE)return 0;DWORD wrote=0;DWORD n=(DWORD)strlen(text);return WriteFile(out,text,n,&wrote,NULL)&&wrote==n;
}
static char *json_escape_wide(const wchar_t *value) {
  int bytes=WideCharToMultiByte(CP_UTF8,0,value,-1,NULL,0,NULL,NULL);if(bytes<=1)return NULL;char *utf8=(char*)HeapAlloc(GetProcessHeap(),0,(SIZE_T)bytes);if(!utf8)return NULL;
  if(!WideCharToMultiByte(CP_UTF8,0,value,-1,utf8,bytes,NULL,NULL)){HeapFree(GetProcessHeap(),0,utf8);return NULL;}
  size_t cap=(size_t)bytes*6+1;char *escaped=(char*)HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,cap);if(!escaped){HeapFree(GetProcessHeap(),0,utf8);return NULL;}size_t at=0;
  for(const unsigned char *p=(const unsigned char*)utf8;*p;p++){if(*p=='"'||*p=='\\'){escaped[at++]='\\';escaped[at++]=(char)*p;}else if(*p<0x20){static const char hex[]="0123456789abcdef";escaped[at++]='\\';escaped[at++]='u';escaped[at++]='0';escaped[at++]='0';escaped[at++]=hex[*p>>4];escaped[at++]=hex[*p&15];}else escaped[at++]=(char)*p;}
  HeapFree(GetProcessHeap(),0,utf8);return escaped;
}
static int find_parent_codex(wchar_t *out) {
  HANDLE snap=CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS,0);if(snap==INVALID_HANDLE_VALUE)return 0;PROCESSENTRY32W e;e.dwSize=sizeof(e);DWORD pid=GetCurrentProcessId(),parent=0;
  if(Process32FirstW(snap,&e))do{if(e.th32ProcessID==pid){parent=e.th32ParentProcessID;break;}}while(Process32NextW(snap,&e));
  for(int i=0;i<16&&parent;i++){
    HANDLE proc=OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,FALSE,parent);wchar_t image[MAX_PATH_CHARS];DWORD size=MAX_PATH_CHARS;int found=0;
    if(proc&&QueryFullProcessImageNameW(proc,0,image,&size)){wchar_t *base=wcsrchr(image,L'\\');base=base?base+1:image;if(_wcsicmp(base,L"codex.exe")==0&&regular_file(image)){wcscpy(out,image);found=1;}}
    PROCESSENTRY32W p;p.dwSize=sizeof(p);DWORD next=0;if(Process32FirstW(snap,&p))do{if(p.th32ProcessID==parent){next=p.th32ParentProcessID;break;}}while(Process32NextW(snap,&p));if(proc)CloseHandle(proc);if(found){CloseHandle(snap);return 1;}parent=next;
  }
  CloseHandle(snap);return 0;
}
static int emit_capabilities(void) {
  char json[1024];
#ifdef TEST_HARNESS
  const char *testBuild="true";
#else
  const char *testBuild="false";
#endif
  if(APPROVED_PATCH_SHA256[0])_snprintf(json,sizeof(json),"{\"schemaVersion\":1,\"testBuild\":%s,\"runtimeVersion\":\"%s\",\"sourceCommit\":\"%s\",\"approvedPatchHashes\":[\"%s\"]}\n",testBuild,APPROVED_RUNTIME_VERSION,APPROVED_SOURCE_COMMIT,APPROVED_PATCH_SHA256);
  else _snprintf(json,sizeof(json),"{\"schemaVersion\":1,\"testBuild\":%s,\"runtimeVersion\":\"%s\",\"sourceCommit\":\"%s\",\"approvedPatchHashes\":[]}\n",testBuild,APPROVED_RUNTIME_VERSION,APPROVED_SOURCE_COMMIT);
  return write_stdout(json);
}
static int emit_observed_backend(void) {
  wchar_t exe[MAX_PATH_CHARS];char digest[65];if(!find_parent_codex(exe))return write_stdout("{\"schemaVersion\":1,\"observed\":false,\"exePath\":null,\"exeSha256\":null}\n");
  if(!sha256_file(exe,digest))return write_stdout("{\"schemaVersion\":1,\"observed\":false,\"exePath\":null,\"exeSha256\":null}\n");char *escaped=json_escape_wide(exe);if(!escaped)return 0;
  size_t cap=strlen(escaped)+256;char *json=(char*)HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,cap);if(!json){HeapFree(GetProcessHeap(),0,escaped);return 0;}
  _snprintf(json,cap,"{\"schemaVersion\":1,\"observed\":true,\"exePath\":\"%s\",\"exeSha256\":\"%s\"}\n",escaped,digest);HeapFree(GetProcessHeap(),0,escaped);int ok=write_stdout(json);HeapFree(GetProcessHeap(),0,json);return ok;
}
static int query_cli_version(const wchar_t *exe,char *out,size_t cap) {
  SECURITY_ATTRIBUTES sa={sizeof(sa),NULL,TRUE}; HANDLE rd=NULL,wr=NULL;
  if(!CreatePipe(&rd,&wr,&sa,4096)) return 0;
  SetHandleInformation(rd,HANDLE_FLAG_INHERIT,0);
  HANDLE nul=CreateFileW(L"NUL",GENERIC_READ,FILE_SHARE_READ|FILE_SHARE_WRITE,&sa,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,NULL);
  if(nul==INVALID_HANDLE_VALUE){CloseHandle(rd);CloseHandle(wr);return 0;}
  wchar_t command[MAX_PATH_CHARS+32]; _snwprintf(command,MAX_PATH_CHARS+32,L"\"%s\" --version",exe);
  STARTUPINFOW si; ZeroMemory(&si,sizeof(si));si.cb=sizeof(si);si.dwFlags=STARTF_USESTDHANDLES|STARTF_USESHOWWINDOW;si.wShowWindow=SW_HIDE;si.hStdInput=nul;si.hStdOutput=wr;si.hStdError=wr;
  PROCESS_INFORMATION pi;ZeroMemory(&pi,sizeof(pi));BOOL ok=CreateProcessW(exe,command,NULL,NULL,TRUE,CREATE_NO_WINDOW,NULL,NULL,&si,&pi);
  CloseHandle(wr);CloseHandle(nul);if(!ok){CloseHandle(rd);return 0;}
  DWORD wait=WaitForSingleObject(pi.hProcess,5000),code=1; if(wait==WAIT_OBJECT_0)GetExitCodeProcess(pi.hProcess,&code);else{TerminateProcess(pi.hProcess,124);WaitForSingleObject(pi.hProcess,1000);}
  CloseHandle(pi.hThread);CloseHandle(pi.hProcess);
  if(wait!=WAIT_OBJECT_0||code!=0){CloseHandle(rd);return 0;}
  DWORD got=0;BOOL read=ReadFile(rd,out,(DWORD)(cap-1),&got,NULL);CloseHandle(rd);if(!read||!got)return 0;out[got]=0;
  while(got&& (out[got-1]=='\r'||out[got-1]=='\n'||out[got-1]==' '||out[got-1]=='\t'))out[--got]=0;
  const char *prefix="codex-cli ";if(strncmp(out,prefix,strlen(prefix))!=0)return 0;memmove(out,out+strlen(prefix),strlen(out+strlen(prefix))+1);return out[0]!=0;
}
static char *read_text(const wchar_t *p) {
  HANDLE f=CreateFileW(p,GENERIC_READ,FILE_SHARE_READ,NULL,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,NULL);if(f==INVALID_HANDLE_VALUE)return NULL;
  DWORD n=GetFileSize(f,NULL);if(n==INVALID_FILE_SIZE||n>MAX_RECEIPT){CloseHandle(f);return NULL;} char *s=(char*)HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,n+1);DWORD got=0;
  if(!s||!ReadFile(f,s,n,&got,NULL)||got!=n){if(s)HeapFree(GetProcessHeap(),0,s);CloseHandle(f);return NULL;}CloseHandle(f);return s;
}
static int json_string(const char *json,const char *key,char *out,size_t cap) {
  char name[96];_snprintf(name,sizeof(name),"\"%s\"",key);const char *p=strstr(json,name);if(!p)return 0;p=strchr(p,':');if(!p)return 0;p++;while(*p==' '||*p=='\t')p++;if(*p!='\"')return 0;p++;
  size_t n=0;while(*p&&*p!='\"'&&n+1<cap){if(*p=='\\'&&p[1])p++;out[n++]=*p++;}if(*p!='\"')return 0;out[n]=0;return 1;
}
static int json_member_value(const char *object,const char *name,const char **value);
static int json_string_member(const char *object,const char *name,const char **value,size_t *valueLen);
static int json_number_one(const char *json,const char *key) {char name[96];_snprintf(name,sizeof(name),"\"%s\"",key);const char*p=strstr(json,name);if(!p)return 0;p=strchr(p,':');if(!p)return 0;while(*++p==' '||*p=='\t');return *p=='1'&&(p[1]==','||p[1]=='}');}
static int beneath(const wchar_t *root,const wchar_t *candidate) {wchar_t a[MAX_PATH_CHARS],b[MAX_PATH_CHARS];if(!GetFullPathNameW(root,MAX_PATH_CHARS,a,NULL)||!GetFullPathNameW(candidate,MAX_PATH_CHARS,b,NULL))return 0;size_t n=wcslen(a);if(a[n-1]!=L'\\'){a[n++]=L'\\';a[n]=0;}return _wcsnicmp(a,b,n)==0;}
static int compatible_patch(const Official *official,const wchar_t *runtimeRoot,wchar_t patch[MAX_PATH_CHARS],char expectedVersion[128]) {
  if(!APPROVED_PATCH_SHA256[0])return 0;
  wchar_t receiptPath[MAX_PATH_CHARS];_snwprintf(receiptPath,MAX_PATH_CHARS,L"%s\\compatibility.json",runtimeRoot);char *j=read_text(receiptPath);if(!j)return 0;
  char officialHash[65],patchHash[65],recordedOfficial[65],recordedVersion[128],recordedPackage[128],probeVersion[128],recordedApproved[65],actualVersion[128];
  const char *compatibility=NULL,*probeStatus=NULL,*probeName=NULL,*probeVersionValue=NULL;
  size_t probeStatusLen=0,probeNameLen=0,probeVersionLen=0;

  int ok=0;
  if(!json_number_one(j,"schemaVersion"))goto done;
  if(!sha256_file(official->exe,officialHash))goto done;
  if(!query_cli_version(official->exe,actualVersion,sizeof(actualVersion)))goto done;
  // The app-server installation probe stores all compatibility identity fields in the receipt.
  if(!json_string(j,"officialSha256",recordedOfficial,sizeof(recordedOfficial))||strcmp(officialHash,recordedOfficial))goto done;
  if(!json_string(j,"desktopPackageVersion",recordedPackage,sizeof(recordedPackage)))goto done;
  char packageUtf8[128]; if(!WideCharToMultiByte(CP_UTF8,0,official->packageVersion,-1,packageUtf8,sizeof(packageUtf8),NULL,NULL)||strcmp(packageUtf8,recordedPackage))goto done;
    char patchUtf8[MAX_PATH_CHARS*4];if(!json_string(j,"patchedPath",patchUtf8,sizeof(patchUtf8)))goto done;
  if(!MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,patchUtf8,-1,patch,MAX_PATH_CHARS))goto done;
  if(!beneath(runtimeRoot,patch)||!regular_file(patch)||!sha256_file(patch,patchHash))goto done;
  if(!json_string(j,"patchedSha256",recordedApproved,sizeof(recordedApproved))||strcmp(patchHash,recordedApproved)||_stricmp(patchHash,APPROVED_PATCH_SHA256))goto done;
  if(!json_member_value(j,"compatibility",&compatibility)||*compatibility!='{')goto done;
  if(!json_string_member(compatibility,"status",&probeStatus,&probeStatusLen)||probeStatusLen!=6||memcmp(probeStatus,"passed",6))goto done;
  if(!json_string_member(compatibility,"probe",&probeName,&probeNameLen)||probeNameLen!=sizeof("app-server-initialize")-1||memcmp(probeName,"app-server-initialize",sizeof("app-server-initialize")-1))goto done;
  if(!json_string(j,"officialVersion",recordedVersion,sizeof(recordedVersion))||strcmp(recordedVersion,actualVersion))goto done;
  if(!json_string_member(compatibility,"cliVersion",&probeVersionValue,&probeVersionLen)||probeVersionLen>=sizeof(probeVersion))goto done;
  memcpy(probeVersion,probeVersionValue,probeVersionLen);probeVersion[probeVersionLen]=0;
  if(strcmp(recordedVersion,probeVersion))goto done;
  // Prevent selecting the official executable itself as a patched child.
  if(same_path(official->exe,patch))goto done;
  strcpy(expectedVersion,recordedVersion);ok=1;
done: HeapFree(GetProcessHeap(),0,j);return ok;
}
static int append_quoted(wchar_t *dst,size_t cap,size_t *at,const wchar_t *arg) {
  if(*at+2>=cap) return 0;
  dst[(*at)++]=L'"';size_t slashes=0;
  for(const wchar_t*p=arg;*p;p++) { if(*p==L'\\'){slashes++;continue;} if(*p==L'"'){for(size_t i=0;i<slashes*2+1;i++){if(*at+1>=cap)return 0;dst[(*at)++]=L'\\';}dst[(*at)++]=L'"';slashes=0;continue;} while(slashes>0){slashes--;if(*at+1>=cap)return 0;dst[(*at)++]=L'\\';}slashes=0;if(*at+1>=cap)return 0;dst[(*at)++]=*p; }
  for(size_t i=0;i<slashes*2;i++){if(*at+1>=cap)return 0;dst[(*at)++]=L'\\';}if(*at+2>=cap)return 0;dst[(*at)++]=L'"';dst[*at]=0;return 1;
}
static int launch_child(const wchar_t *exe,int argc,wchar_t **argv) {
  wchar_t *cmd=(wchar_t*)HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,131072*sizeof(wchar_t));if(!cmd)return -1;size_t at=0;
  if(!append_quoted(cmd,131072,&at,exe)){HeapFree(GetProcessHeap(),0,cmd);return -1;}
  for(int i=1;i<argc;i++){if(at+1>=131072){HeapFree(GetProcessHeap(),0,cmd);return -1;}cmd[at++]=L' ';cmd[at]=0;if(!append_quoted(cmd,131072,&at,argv[i])){HeapFree(GetProcessHeap(),0,cmd);return -1;}}
  HANDLE stds[3]={0};for(int i=0;i<3;i++){DWORD id=i==0?STD_INPUT_HANDLE:i==1?STD_OUTPUT_HANDLE:STD_ERROR_HANDLE;HANDLE h=GetStdHandle(id);int owned=0;if(!h||h==INVALID_HANDLE_VALUE){h=CreateFileW(L"NUL",i==0?GENERIC_READ:GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE,NULL,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,NULL);owned=1;}if(!h||h==INVALID_HANDLE_VALUE||!DuplicateHandle(GetCurrentProcess(),h,GetCurrentProcess(),&stds[i],0,TRUE,DUPLICATE_SAME_ACCESS)){if(owned&&h&&h!=INVALID_HANDLE_VALUE)CloseHandle(h);for(int j=0;j<i;j++)if(stds[j])CloseHandle(stds[j]);HeapFree(GetProcessHeap(),0,cmd);return -1;}if(owned)CloseHandle(h);}
  SIZE_T bytes=0;InitializeProcThreadAttributeList(NULL,1,0,&bytes);LPPROC_THREAD_ATTRIBUTE_LIST attrs=(LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(),0,bytes);if(!attrs){for(int i=0;i<3;i++)if(stds[i])CloseHandle(stds[i]);HeapFree(GetProcessHeap(),0,cmd);return -1;}
  STARTUPINFOEXW si;ZeroMemory(&si,sizeof(si));si.StartupInfo.cb=sizeof(si);si.StartupInfo.dwFlags=STARTF_USESHOWWINDOW|STARTF_USESTDHANDLES;si.StartupInfo.wShowWindow=SW_HIDE;si.StartupInfo.hStdInput=stds[0];si.StartupInfo.hStdOutput=stds[1];si.StartupInfo.hStdError=stds[2];
  if(!InitializeProcThreadAttributeList(attrs,1,0,&bytes)){HeapFree(GetProcessHeap(),0,attrs);for(int i=0;i<3;i++)CloseHandle(stds[i]);HeapFree(GetProcessHeap(),0,cmd);return -1;}
  if(!UpdateProcThreadAttribute(attrs,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,stds,sizeof(stds),NULL,NULL)){DeleteProcThreadAttributeList(attrs);HeapFree(GetProcessHeap(),0,attrs);for(int i=0;i<3;i++)CloseHandle(stds[i]);HeapFree(GetProcessHeap(),0,cmd);return -1;}si.lpAttributeList=attrs;
  PROCESS_INFORMATION pi;ZeroMemory(&pi,sizeof(pi));BOOL created=CreateProcessW(exe,cmd,NULL,NULL,TRUE,CREATE_NO_WINDOW|EXTENDED_STARTUPINFO_PRESENT,NULL,NULL,&si.StartupInfo,&pi);
  DeleteProcThreadAttributeList(attrs);HeapFree(GetProcessHeap(),0,attrs);for(int i=0;i<3;i++)if(stds[i])CloseHandle(stds[i]);HeapFree(GetProcessHeap(),0,cmd);
  if(!created)return -1;
  WaitForSingleObject(pi.hProcess,INFINITE);DWORD code=1;GetExitCodeProcess(pi.hProcess,&code);CloseHandle(pi.hThread);CloseHandle(pi.hProcess);return (int)code;
}
static const char *json_ws(const char *p){while(*p==' '||*p=='\t'||*p=='\r'||*p=='\n')p++;return p;}
static int json_parse_value(const char **cursor,int depth);
static int json_parse_string(const char **cursor){const char*p=*cursor;if(*p++!='"')return 0;while(*p&&*p!='"'){unsigned char c=(unsigned char)*p++;if(c<0x20)return 0;if(c=='\\'){char e=*p++;if(!e)return 0;if(e=='u'){for(int i=0;i<4;i++){char h=*p++;if(!((h>='0'&&h<='9')||(h>='a'&&h<='f')||(h>='A'&&h<='F')))return 0;}}else if(!(e=='"'||e=='\\'||e=='/'||e=='b'||e=='f'||e=='n'||e=='r'||e=='t'))return 0;}}if(*p!='"')return 0;*cursor=p+1;return 1;}
static int json_parse_number(const char **cursor){const char*p=*cursor;if(*p=='-')p++;if(*p=='0')p++;else{if(*p<'1'||*p>'9')return 0;while(*p>='0'&&*p<='9')p++;}if(*p=='.'){p++;if(*p<'0'||*p>'9')return 0;while(*p>='0'&&*p<='9')p++;}if(*p=='e'||*p=='E'){p++;if(*p=='+'||*p=='-')p++;if(*p<'0'||*p>'9')return 0;while(*p>='0'&&*p<='9')p++;}*cursor=p;return 1;}
static int json_parse_value(const char **cursor,int depth){if(depth>64)return 0;const char*p=json_ws(*cursor);if(*p=='"'){*cursor=p;return json_parse_string(cursor);}if(*p=='{'){p=json_ws(p+1);if(*p=='}'){*cursor=p+1;return 1;}for(;;){if(*p!='"')return 0;*cursor=p;if(!json_parse_string(cursor))return 0;p=json_ws(*cursor);if(*p++!=':')return 0;*cursor=p;if(!json_parse_value(cursor,depth+1))return 0;p=json_ws(*cursor);if(*p=='}'){*cursor=p+1;return 1;}if(*p++!=',')return 0;p=json_ws(p);}}
  if(*p=='['){p=json_ws(p+1);if(*p==']'){*cursor=p+1;return 1;}for(;;){*cursor=p;if(!json_parse_value(cursor,depth+1))return 0;p=json_ws(*cursor);if(*p==']'){*cursor=p+1;return 1;}if(*p++!=',')return 0;p=json_ws(p);}}
  if(*p=='-'||(*p>='0'&&*p<='9')){*cursor=p;return json_parse_number(cursor);}const char*words[]={"true","false","null"};for(int i=0;i<3;i++){size_t n=strlen(words[i]);if(strncmp(p,words[i],n)==0){*cursor=p+n;return 1;}}return 0;}
static int json_valid(const char *text){const char*p=json_ws(text);if(!json_parse_value(&p,0))return 0;return *json_ws(p)==0;}
static int json_top_id(const char *text,const char *expected){const char*p=json_ws(text);if(*p++!='{')return 0;for(;;){p=json_ws(p);if(*p=='}')return 0;const char*key=p;if(!json_parse_string(&p))return 0;size_t keyLen=(size_t)(p-key);p=json_ws(p);if(*p++!=':')return 0;p=json_ws(p);if(keyLen==4&&memcmp(key,"\"id\"",4)==0){const char*start=p;if(!json_parse_number(&p))return 0;size_t n=(size_t)(p-start);return strlen(expected)==n&&memcmp(start,expected,n)==0&&(*p==','||*p=='}'||*p==' '||*p=='\t'||*p=='\r'||*p=='\n');}if(!json_parse_value(&p,1))return 0;p=json_ws(p);if(*p=='}')return 0;if(*p++!=',')return 0;}}
static int json_member_value(const char *object,const char *name,const char **value){const char*p=json_ws(object);if(*p++!='{')return 0;for(;;){p=json_ws(p);if(*p=='}')return 0;const char*key=p;if(!json_parse_string(&p))return 0;size_t keyLen=(size_t)(p-key),wantedLen=strlen(name)+2;p=json_ws(p);if(*p++!=':')return 0;p=json_ws(p);if(keyLen==wantedLen&&key[0]=='"'&&memcmp(key+1,name,wantedLen-2)==0){*value=p;return 1;}if(!json_parse_value(&p,1))return 0;p=json_ws(p);if(*p=='}')return 0;if(*p++!=',')return 0;}}
static int json_string_member(const char *object,const char *name,const char **value,size_t *valueLen){const char*p=json_ws(object);if(*p++!='{')return 0;for(;;){p=json_ws(p);if(*p=='}')return 0;const char*key=p;if(!json_parse_string(&p))return 0;size_t keyLen=(size_t)(p-key),wantedLen=strlen(name)+2;p=json_ws(p);if(*p++!=':')return 0;p=json_ws(p);if(keyLen==wantedLen&&key[0]=='"'&&memcmp(key+1,name,wantedLen-2)==0){if(*p!='"')return 0;const char*start=p+1;const char*end=p;if(!json_parse_string(&end))return 0;*value=start;*valueLen=(size_t)(end-start-1);return 1;}if(!json_parse_value(&p,1))return 0;p=json_ws(p);if(*p=='}')return 0;if(*p++!=',')return 0;}}
static int version_char(char c){return(c>='0'&&c<='9')||(c>='a'&&c<='z')||(c>='A'&&c<='Z')||c=='.'||c=='+'||c=='-';}
static int version_token_in_user_agent(const char *json,const char *version){const char*result=NULL;if(!json_member_value(json,"result",&result)||*result!='{')return 0;const char*agent=NULL;size_t agentLen=0;if(!json_string_member(result,"userAgent",&agent,&agentLen))return 0;size_t n=strlen(version);if(!n||n>agentLen)return 0;for(size_t i=0;i+n<=agentLen;i++)if(memcmp(agent+i,version,n)==0&&(i==0||!version_char(agent[i-1]))&&(i+n==agentLen||!version_char(agent[i+n])))return 1;return 0;}
static int probe_read_line(HANDLE process,HANDLE output,const char *needle,const char *expectedVersion,const char *expectedId,DWORD timeoutMs) {
  ULONGLONG deadline=GetTickCount64()+timeoutMs;
  while(GetTickCount64()<deadline) {
    char line[8192];size_t used=0;int complete=0;
    while(GetTickCount64()<deadline && used+1<sizeof(line)) {
      DWORD available=0;if(!PeekNamedPipe(output,NULL,0,NULL,&available,NULL))return 0;
      if(available){DWORD got=0;if(!ReadFile(output,line+used,1,&got,NULL)||!got)return 0;if(line[used++]=='\n'){line[used]=0;complete=1;break;}}
      else {if(WaitForSingleObject(process,0)==WAIT_OBJECT_0)return 0;Sleep(10);}
    }
    if(!complete)return 0;
    char *p=line;while(*p==' '||*p=='\t'||*p=='\r'||*p=='\n')p++;if(*p!='{'||!json_valid(p))return 0;
    if(json_top_id(p,expectedId))return strstr(p,"\"result\"")&&!strstr(p,"\"error\"")&&strstr(p,needle)&&(!expectedVersion||version_token_in_user_agent(p,expectedVersion));
    const char *idValue=NULL,*methodValue=NULL;size_t methodLen=0;
    if(json_member_value(p,"id",&idValue)||json_member_value(p,"error",&idValue))return 0;
    if(!json_string_member(p,"method",&methodValue,&methodLen)||methodLen==0)return 0;
  }
  return 0;
}
static void remove_probe_tree(const wchar_t *root) {
  wchar_t pattern[MAX_PATH_CHARS];_snwprintf(pattern,MAX_PATH_CHARS,L"%s\\*",root);WIN32_FIND_DATAW data;HANDLE find=FindFirstFileW(pattern,&data);
  if(find!=INVALID_HANDLE_VALUE){do{if(wcscmp(data.cFileName,L".")==0||wcscmp(data.cFileName,L"..")==0)continue;wchar_t child[MAX_PATH_CHARS];_snwprintf(child,MAX_PATH_CHARS,L"%s\\%s",root,data.cFileName);if(data.dwFileAttributes&FILE_ATTRIBUTE_DIRECTORY){if(data.dwFileAttributes&FILE_ATTRIBUTE_REPARSE_POINT)RemoveDirectoryW(child);else remove_probe_tree(child);}else DeleteFileW(child);}while(FindNextFileW(find,&data));FindClose(find);}
  RemoveDirectoryW(root);
}
static int probe_app_server(const wchar_t *exe,const char *expectedVersion,const wchar_t *runtimeRoot,int argc,wchar_t **argv) {
  (void)argc;(void)argv;wchar_t *cmd=(wchar_t*)HeapAlloc(GetProcessHeap(),HEAP_ZERO_MEMORY,131072*sizeof(wchar_t));if(!cmd)return 0;size_t at=0;
  if(!append_quoted(cmd,131072,&at,exe)){HeapFree(GetProcessHeap(),0,cmd);return 0;}
  const wchar_t *probeArgs[3]={L"app-server",L"--listen",L"stdio://"};for(int i=0;i<3;i++){if(at+1>=131072){HeapFree(GetProcessHeap(),0,cmd);return 0;}cmd[at++]=L' ';cmd[at]=0;if(!append_quoted(cmd,131072,&at,probeArgs[i])){HeapFree(GetProcessHeap(),0,cmd);return 0;}}
  SECURITY_ATTRIBUTES sa={sizeof(sa),NULL,TRUE};HANDLE childIn=NULL,parentIn=NULL,parentOut=NULL,childOut=NULL,nul=NULL;
  if(!CreatePipe(&childIn,&parentIn,&sa,0)||!CreatePipe(&parentOut,&childOut,&sa,0))goto failed;
  SetHandleInformation(parentIn,HANDLE_FLAG_INHERIT,0);SetHandleInformation(parentOut,HANDLE_FLAG_INHERIT,0);
  nul=CreateFileW(L"NUL",GENERIC_WRITE,FILE_SHARE_READ|FILE_SHARE_WRITE,&sa,OPEN_EXISTING,FILE_ATTRIBUTE_NORMAL,NULL);if(nul==INVALID_HANDLE_VALUE)goto failed;
  SIZE_T attrBytes=0;InitializeProcThreadAttributeList(NULL,1,0,&attrBytes);LPPROC_THREAD_ATTRIBUTE_LIST attrs=(LPPROC_THREAD_ATTRIBUTE_LIST)HeapAlloc(GetProcessHeap(),0,attrBytes);if(!attrs)goto failed;
  if(!InitializeProcThreadAttributeList(attrs,1,0,&attrBytes)){HeapFree(GetProcessHeap(),0,attrs);goto failed;}
  HANDLE probeHandles[3]={childIn,childOut,nul};if(!UpdateProcThreadAttribute(attrs,0,PROC_THREAD_ATTRIBUTE_HANDLE_LIST,probeHandles,sizeof(probeHandles),NULL,NULL)){DeleteProcThreadAttributeList(attrs);HeapFree(GetProcessHeap(),0,attrs);goto failed;}
  STARTUPINFOEXW si;ZeroMemory(&si,sizeof(si));si.StartupInfo.cb=sizeof(si);si.StartupInfo.dwFlags=STARTF_USESHOWWINDOW|STARTF_USESTDHANDLES;si.StartupInfo.wShowWindow=SW_HIDE;si.StartupInfo.hStdInput=childIn;si.StartupInfo.hStdOutput=childOut;si.StartupInfo.hStdError=nul;si.lpAttributeList=attrs;
  wchar_t *oldHome=NULL,*oldProbe=NULL;DWORD homeSize=GetEnvironmentVariableW(L"CODEX_HOME",NULL,0),probeSize=GetEnvironmentVariableW(L"CODEX_BOOTSTRAP_PROBE",NULL,0);if(homeSize){oldHome=(wchar_t*)HeapAlloc(GetProcessHeap(),0,homeSize*sizeof(wchar_t));if(oldHome)GetEnvironmentVariableW(L"CODEX_HOME",oldHome,homeSize);}if(probeSize){oldProbe=(wchar_t*)HeapAlloc(GetProcessHeap(),0,probeSize*sizeof(wchar_t));if(oldProbe)GetEnvironmentVariableW(L"CODEX_BOOTSTRAP_PROBE",oldProbe,probeSize);}
  if((homeSize&&!oldHome)||(probeSize&&!oldProbe)){if(oldHome)HeapFree(GetProcessHeap(),0,oldHome);if(oldProbe)HeapFree(GetProcessHeap(),0,oldProbe);CloseHandle(nul);nul=NULL;goto failed;}
  wchar_t tempBase[MAX_PATH_CHARS],tempName[MAX_PATH_CHARS]={0};_snwprintf(tempBase,MAX_PATH_CHARS,L"%s\\probes",runtimeRoot);DWORD baseAttrs=GetFileAttributesW(tempBase);BOOL baseReady=FALSE;if(baseAttrs!=INVALID_FILE_ATTRIBUTES){baseReady=(baseAttrs&FILE_ATTRIBUTE_DIRECTORY)&&!(baseAttrs&FILE_ATTRIBUTE_REPARSE_POINT);}else if(CreateDirectoryW(tempBase,NULL))baseReady=TRUE;
  int ownedTemp=0,haveTemp=baseReady&&GetTempFileNameW(tempBase,L"cgp",0,tempName);if(haveTemp){if(!DeleteFileW(tempName))haveTemp=FALSE;else{haveTemp=CreateDirectoryW(tempName,NULL);ownedTemp=haveTemp;}}wchar_t probeHome[MAX_PATH_CHARS],probeCwd[MAX_PATH_CHARS];if(haveTemp){_snwprintf(probeHome,MAX_PATH_CHARS,L"%s\\codex-home",tempName);_snwprintf(probeCwd,MAX_PATH_CHARS,L"%s\\workspace",tempName);if(!CreateDirectoryW(probeHome,NULL)||!CreateDirectoryW(probeCwd,NULL))haveTemp=FALSE;}if(haveTemp)SetEnvironmentVariableW(L"CODEX_HOME",probeHome);if(!haveTemp){if(ownedTemp)remove_probe_tree(tempName);if(oldHome)HeapFree(GetProcessHeap(),0,oldHome);if(oldProbe)HeapFree(GetProcessHeap(),0,oldProbe);CloseHandle(nul);nul=NULL;goto failed;}
  SetEnvironmentVariableW(L"CODEX_BOOTSTRAP_PROBE",L"1");PROCESS_INFORMATION pi;ZeroMemory(&pi,sizeof(pi));BOOL created=CreateProcessW(exe,cmd,NULL,NULL,TRUE,CREATE_NO_WINDOW|EXTENDED_STARTUPINFO_PRESENT,NULL,probeCwd,&si.StartupInfo,&pi);
  DeleteProcThreadAttributeList(attrs);HeapFree(GetProcessHeap(),0,attrs);
  if(oldProbe){SetEnvironmentVariableW(L"CODEX_BOOTSTRAP_PROBE",oldProbe);HeapFree(GetProcessHeap(),0,oldProbe);}else SetEnvironmentVariableW(L"CODEX_BOOTSTRAP_PROBE",NULL);
  if(oldHome){SetEnvironmentVariableW(L"CODEX_HOME",oldHome);HeapFree(GetProcessHeap(),0,oldHome);}else if(haveTemp)SetEnvironmentVariableW(L"CODEX_HOME",NULL);
  HeapFree(GetProcessHeap(),0,cmd);CloseHandle(childIn);CloseHandle(childOut);CloseHandle(nul);childIn=childOut=nul=NULL;
  if(!created){if(haveTemp)remove_probe_tree(tempName);goto failed;}
  const char *init="{\"id\":1,\"method\":\"initialize\",\"params\":{\"clientInfo\":{\"name\":\"native-bootstrap-probe\",\"title\":\"Native Bootstrap Probe\",\"version\":\"1\"},\"capabilities\":{\"experimentalApi\":true}}}\n";
  DWORD wrote=0;int ok=WriteFile(parentIn,init,(DWORD)strlen(init),&wrote,NULL)&&wrote==strlen(init)&&probe_read_line(pi.hProcess,parentOut,"userAgent",expectedVersion,"1",PROBE_TIMEOUT_MS);
  if(ok){char *cwdUtf8=json_escape_wide(probeCwd);if(!cwdUtf8)ok=0;else{char config[8192];int configLen=_snprintf(config,sizeof(config),"{\"id\":2,\"method\":\"config/read\",\"params\":{\"includeLayers\":true,\"cwd\":\"%s\"}}\n",cwdUtf8);HeapFree(GetProcessHeap(),0,cwdUtf8);ok=configLen>0&&(size_t)configLen<sizeof(config)&&WriteFile(parentIn,config,(DWORD)configLen,&wrote,NULL)&&wrote==(DWORD)configLen&&probe_read_line(pi.hProcess,parentOut,"config",NULL,"2",PROBE_TIMEOUT_MS);}}
  TerminateProcess(pi.hProcess,0);WaitForSingleObject(pi.hProcess,1000);CloseHandle(pi.hThread);CloseHandle(pi.hProcess);CloseHandle(parentIn);CloseHandle(parentOut);if(haveTemp)remove_probe_tree(tempName);return ok;
failed:
  if(childIn)CloseHandle(childIn);if(parentIn)CloseHandle(parentIn);if(parentOut)CloseHandle(parentOut);if(childOut)CloseHandle(childOut);if(nul&&nul!=INVALID_HANDLE_VALUE)CloseHandle(nul);if(cmd)HeapFree(GetProcessHeap(),0,cmd);return 0;
}
static void write_status(const wchar_t *runtimeRoot,const char *reason) {
  CreateDirectoryW(runtimeRoot,NULL);wchar_t p[MAX_PATH_CHARS],tmp[MAX_PATH_CHARS];_snwprintf(p,MAX_PATH_CHARS,L"%s\\upgrade-status.json",runtimeRoot);_snwprintf(tmp,MAX_PATH_CHARS,L"%s\\upgrade-status.%lu.tmp",runtimeRoot,GetCurrentProcessId());
  HANDLE f=CreateFileW(tmp,GENERIC_WRITE,0,NULL,CREATE_ALWAYS,FILE_ATTRIBUTE_HIDDEN,NULL);if(f==INVALID_HANDLE_VALUE)return;
  char text[1024];if(reason)_snprintf(text,sizeof(text),"{\"state\":\"disabled\",\"reason\":\"%s\",\"repairAttempted\":false,\"updatedAt\":\"%lu\"}\n",reason,GetTickCount());else _snprintf(text,sizeof(text),"{\"state\":\"healthy\",\"reason\":null,\"repairAttempted\":false,\"updatedAt\":\"%lu\"}\n",GetTickCount());DWORD wrote=0;WriteFile(f,text,(DWORD)strlen(text),&wrote,NULL);FlushFileBuffers(f);CloseHandle(f);MoveFileExW(tmp,p,MOVEFILE_REPLACE_EXISTING|MOVEFILE_WRITE_THROUGH);
}
static int runtime_root(wchar_t *out,const wchar_t *self) {
#ifdef TEST_HARNESS
  wchar_t *testRoot=_wgetenv(L"CODEX_BOOTSTRAP_TEST_RUNTIME_ROOT");if(testRoot&&wcslen(testRoot)<MAX_PATH_CHARS){wcscpy(out,testRoot);return 1;}
#endif
  wchar_t ownPath[MAX_PATH_CHARS];if(wcslen(self)<MAX_PATH_CHARS){wcscpy(ownPath,self);wchar_t *sep=wcsrchr(ownPath,L'\\');if(sep){*sep=0;sep=wcsrchr(ownPath,L'\\');if(sep&&_wcsicmp(sep+1,L"bootstrap")==0){*sep=0;wcscpy(out,ownPath);return 1;}}}
  wchar_t home[MAX_PATH_CHARS];DWORD n=GetEnvironmentVariableW(L"CODEX_HOME",home,MAX_PATH_CHARS);if(!n||n>=MAX_PATH_CHARS){n=GetEnvironmentVariableW(L"USERPROFILE",home,MAX_PATH_CHARS);if(!n||n>=MAX_PATH_CHARS)return 0;wcscat(home,L"\\.codex");}
  _snwprintf(out,MAX_PATH_CHARS,L"%s\\router-runtime",home);return 1;
}
int WINAPI wWinMain(HINSTANCE instance,HINSTANCE prev,LPWSTR cmdline,int show) {
  (void)instance;(void)prev;(void)cmdline;(void)show;
#ifdef TEST_HARNESS
  wchar_t *versionCase=_wgetenv(L"CODEX_BOOTSTRAP_TEST_VERSION_CASE");if(versionCase){const char *valid="{\"id\":1,\"result\":{\"userAgent\":\"codex-cli/0.164.0-alpha.11.1 (windows)\"}}";const char *wrongField="{\"id\":1,\"result\":{\"userAgent\":\"codex-cli/0.163.0\",\"other\":\"0.164.0-alpha.11.1\"}}";const char *prefix="{\"id\":1,\"result\":{\"userAgent\":\"codex-cli/0.164.0-alpha.11.10 (windows)\"}}";const char *line=_wcsicmp(versionCase,L"wrong-field")==0?wrongField:_wcsicmp(versionCase,L"prefix")==0?prefix:valid;const char*r=NULL,*agent=NULL;size_t len=0;int a=json_valid(line),b=json_top_id(line,"1"),c=json_member_value(line,"result",&r),d=c?json_string_member(r,"userAgent",&agent,&len):0,e=version_token_in_user_agent(line,"0.164.0-alpha.11.1");printf("%d%d%d%d%d|%s",a,b,c,d,e,c?r:"null");return 0;}
  wchar_t *testParentImage=_wgetenv(L"CODEX_BOOTSTRAP_TEST_PARENT_IMAGE");
  if(testParentImage){Official injected;ZeroMemory(&injected,sizeof(injected));if(valid_package_path(testParentImage,&injected,1)){wprintf(L"package=%ls|exe=%ls",injected.packageVersion,injected.exe);return 0;}return 126;}
#endif
  int argc=0;wchar_t **argv=CommandLineToArgvW(GetCommandLineW(),&argc);if(!argv)return 127;
  wchar_t self[MAX_PATH_CHARS];DWORD sn=GetModuleFileNameW(NULL,self,MAX_PATH_CHARS);if(!sn||sn>=MAX_PATH_CHARS){LocalFree(argv);return 127;}
  if(argc==2&&_wcsicmp(argv[1],CAPABILITIES_ARGUMENT)==0){int ok=emit_capabilities();LocalFree(argv);return ok?0:126;}
  if(argc==2&&_wcsicmp(argv[1],OBSERVE_BACKEND_ARGUMENT)==0){int ok=emit_observed_backend();LocalFree(argv);return ok?0:126;}
  if(argc==2&&(_wcsicmp(argv[1],RESOLVE_OFFICIAL_ARGUMENT)==0||_wcsicmp(argv[1],RESOLVE_OFFICIAL_ARGUMENT_V2)==0)){Official resolved;ZeroMemory(&resolved,sizeof(resolved));int source=OFFICIAL_NONE;if(!resolve_official(&resolved,&source)){LocalFree(argv);return 126;}int bytes=WideCharToMultiByte(CP_UTF8,0,resolved.exe,-1,NULL,0,NULL,NULL);if(bytes<=1){LocalFree(argv);return 126;}char *utf8=(char*)HeapAlloc(GetProcessHeap(),0,(SIZE_T)bytes);if(!utf8){LocalFree(argv);return 126;}WideCharToMultiByte(CP_UTF8,0,resolved.exe,-1,utf8,bytes,NULL,NULL);HANDLE out=GetStdHandle(STD_OUTPUT_HANDLE);DWORD wrote=0;BOOL ok=out&&out!=INVALID_HANDLE_VALUE&&WriteFile(out,utf8,(DWORD)(bytes-1),&wrote,NULL)&&wrote==(DWORD)(bytes-1);HeapFree(GetProcessHeap(),0,utf8);LocalFree(argv);return ok?0:126;}
  wchar_t root[MAX_PATH_CHARS];if(!runtime_root(root,self)){LocalFree(argv);return 126;}
  Official official;ZeroMemory(&official,sizeof(official));int found=0,source=OFFICIAL_NONE;
#ifdef TEST_HARNESS
  wchar_t *testResolveOnly=_wgetenv(L"CODEX_BOOTSTRAP_TEST_RESOLVE_ONLY");if(testResolveOnly){int testSource=OFFICIAL_NONE;int testFound=test_registered_roots(&official);if(testFound)testSource=OFFICIAL_REGISTERED_PACKAGE;else testFound=resolve_official(&official,&testSource);if(testFound)wprintf(L"source=%ls|version=%ls|exe=%ls",testSource==OFFICIAL_PARENT?L"parent":testSource==OFFICIAL_CURRENT_PACKAGE?L"current-package":L"registered-package",official.packageVersion,official.exe);return testFound?0:126;}
  wchar_t *forceNoOfficial=_wgetenv(L"CODEX_BOOTSTRAP_TEST_FORCE_NO_OFFICIAL");if(forceNoOfficial){found=0;}
  else {
  wchar_t *testOfficial=_wgetenv(L"CODEX_BOOTSTRAP_TEST_OFFICIAL");wchar_t *testPackage=_wgetenv(L"CODEX_BOOTSTRAP_TEST_PACKAGE_VERSION");if(testOfficial&&testPackage&&wcslen(testOfficial)<MAX_PATH_CHARS&&wcslen(testPackage)<128&&regular_file(testOfficial)){wcscpy(official.exe,testOfficial);wcscpy(official.packageVersion,testPackage);found=1;}
  else found=resolve_official(&official,&source);
  }
#else
  found=resolve_official(&official,&source);
#endif
  if(!found){write_status(root,STATUS_NO_OFFICIAL);LocalFree(argv);return 126;}
  if(same_path(self,official.exe)){write_status(root,STATUS_NO_OFFICIAL);LocalFree(argv);return 126;}
  wchar_t patch[MAX_PATH_CHARS];char expectedVersion[128]={0};int usePatch=compatible_patch(&official,root,patch,expectedVersion);
  write_status(root,usePatch?NULL:STATUS_INCOMPATIBLE);
  int appServer=0;for(int i=1;i<argc;i++)if(_wcsicmp(argv[i],L"app-server")==0)appServer=1;
  if(usePatch&&(!appServer||probe_app_server(patch,expectedVersion,root,argc,argv))){int result=launch_child(patch,argc,argv);if(result>=0){if(appServer&&result!=0)write_status(root,STATUS_INCOMPATIBLE);LocalFree(argv);return result;}write_status(root,STATUS_INCOMPATIBLE);}
  else if(usePatch)write_status(root,STATUS_INCOMPATIBLE);
  int result=launch_child(official.exe,argc,argv);LocalFree(argv);return result<0?126:result;
}











