@echo off
rem Browse 插件在 Windows 上的 MCP 入口，查找顺序同 bin/run
setlocal
set "B="
if defined ENSO_BROWSE if exist "%ENSO_BROWSE%" set "B=%ENSO_BROWSE%"
if not defined B if defined XDG_BIN_HOME if exist "%XDG_BIN_HOME%\browse.exe" set "B=%XDG_BIN_HOME%\browse.exe"
if not defined B if exist "%USERPROFILE%\.local\bin\browse.exe" set "B=%USERPROFILE%\.local\bin\browse.exe"
if not defined B for %%I in (browse.exe) do if not "%%~$PATH:I"=="" set "B=%%~$PATH:I"
if not defined B if exist "%~dp0..\..\..\..\data\enso.browse\bin\browse.exe" set "B=%~dp0..\..\..\..\data\enso.browse\bin\browse.exe"
if not defined B (
  echo browse: 没有找到原版 browse。在 Enso 侧栏的 Browse 页点「下载 browse」，然后开一个新会话。 1>&2
  exit /b 127
)
"%B%" %*
