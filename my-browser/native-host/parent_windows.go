package main

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
)

func browserParent() error {
	// Query the immediate parent and verify its Authenticode publisher. No path or
	// script text comes from the extension message or command-line origin.
	script := fmt.Sprintf(`$ErrorActionPreference='Stop'; $p=Get-CimInstance Win32_Process -Filter 'ProcessId = %d'; $exe=$p.ExecutablePath; if ($exe -ieq (Join-Path $env:SystemRoot 'System32\cmd.exe')) {$p=Get-CimInstance Win32_Process -Filter ('ProcessId = '+$p.ParentProcessId);$exe=$p.ExecutablePath}; if ([IO.Path]::GetFileName($exe) -notin @('chrome.exe','msedge.exe','brave.exe')) {exit 1}; $s=Get-AuthenticodeSignature -LiteralPath $exe; if ($s.Status -ne 'Valid') {exit 1}; if ($s.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false) -notin @('Google LLC','Microsoft Corporation','Brave Software, Inc.')) {exit 1}`, os.Getppid())
	cmd := exec.Command(filepath.Join(os.Getenv("SystemRoot"), "System32", "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoProfile", "-NonInteractive", "-Command", script)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: 0x08000000}
	return cmd.Run()
}
