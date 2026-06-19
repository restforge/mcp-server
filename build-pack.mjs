#!/usr/bin/env node
/**
 * build-pack.mjs
 *
 * Helper script for build-final.bat. Performs:
 *   1. Bump version in package.json (based on flag)
 *   2. Run `npm run build` (TypeScript -> dist/)
 *   3. Run `npm pack` to create the tarball
 *   4. Move the tarball into dist-tarball/
 *
 * Invoked by build-final.bat with one of these flags:
 *   --nobump | --patch | --minor | --major | --beta | --stable | --minor-beta | --major-beta
 */

import { readFileSync, writeFileSync, mkdirSync, renameSync, existsSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { join, resolve } from 'node:path';

const flag = process.argv[2] ?? '--nobump';
const validFlags = [
  '--nobump',
  '--patch',
  '--minor',
  '--major',
  '--beta',
  '--stable',
  '--minor-beta',
  '--major-beta',
];

if (!validFlags.includes(flag)) {
  console.error(`[build-pack] Invalid version flag: ${flag}`);
  console.error(`[build-pack] Valid flags: ${validFlags.join(', ')}`);
  process.exit(1);
}

const projectRoot = resolve(import.meta.dirname);
const pkgPath = join(projectRoot, 'package.json');
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
const oldVersion = pkg.version;

function bumpVersion(current, flag) {
  if (flag === '--nobump') return current;

  const match = current.match(/^(\d+)\.(\d+)\.(\d+)(?:-(beta|alpha|rc)\.(\d+))?$/);
  if (!match) {
    throw new Error(`Cannot parse semver: ${current}`);
  }

  let [, majorStr, minorStr, patchStr, preTag, preNumStr] = match;
  let major = parseInt(majorStr, 10);
  let minor = parseInt(minorStr, 10);
  let patch = parseInt(patchStr, 10);
  const preNum = preNumStr !== undefined ? parseInt(preNumStr, 10) : null;

  switch (flag) {
    case '--patch':
      // Stable patch bump. Drops pre-release tag if present.
      if (preTag) return `${major}.${minor}.${patch}`;
      return `${major}.${minor}.${patch + 1}`;

    case '--minor':
      if (preTag) return `${major}.${minor}.0`;
      return `${major}.${minor + 1}.0`;

    case '--major':
      if (preTag) return `${major}.0.0`;
      return `${major + 1}.0.0`;

    case '--beta':
      // Increment beta number. Requires current to already be beta.
      if (preTag === 'beta') {
        return `${major}.${minor}.${patch}-beta.${preNum + 1}`;
      }
      throw new Error(
        `--beta requires current version to be a beta release. Current: ${current}. Use --minor-beta or --major-beta to start a new beta cycle.`,
      );

    case '--stable':
      // Promote pre-release to stable.
      if (preTag) return `${major}.${minor}.${patch}`;
      // Already stable, do a patch bump as fallback.
      return `${major}.${minor}.${patch + 1}`;

    case '--minor-beta':
      return `${major}.${minor + 1}.0-beta.0`;

    case '--major-beta':
      return `${major + 1}.0.0-beta.0`;

    default:
      throw new Error(`Unhandled flag: ${flag}`);
  }
}

let newVersion;
try {
  newVersion = bumpVersion(oldVersion, flag);
} catch (err) {
  console.error(`[build-pack] ${err.message}`);
  process.exit(1);
}

if (newVersion !== oldVersion) {
  pkg.version = newVersion;
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n', 'utf-8');
  console.log(`[build-pack] Version bumped: ${oldVersion} -> ${newVersion}`);
} else {
  console.log(`[build-pack] Version unchanged: ${oldVersion}`);
}

console.log('\n[build-pack] [1/2] Compiling TypeScript...');
try {
  execSync('npm run build', { cwd: projectRoot, stdio: 'inherit' });
} catch (err) {
  console.error('[build-pack] Build failed.');
  process.exit(1);
}

console.log('\n[build-pack] [2/2] Creating tarball with npm pack...');
const distDir = join(projectRoot, 'dist-tarball');
mkdirSync(distDir, { recursive: true });

let packResult;
try {
  const json = execSync('npm pack --json', { cwd: projectRoot, encoding: 'utf-8' });
  packResult = JSON.parse(json);
} catch (err) {
  console.error('[build-pack] npm pack failed.');
  process.exit(1);
}

if (!Array.isArray(packResult) || packResult.length === 0 || !packResult[0].filename) {
  console.error('[build-pack] Unexpected output from npm pack.');
  process.exit(1);
}

const tarballName = packResult[0].filename;
const sourcePath = join(projectRoot, tarballName);
const destPath = join(distDir, tarballName);

if (existsSync(destPath)) {
  rmSync(destPath);
}
renameSync(sourcePath, destPath);

console.log(`\n[build-pack] Tarball created: dist-tarball/${tarballName}`);
console.log(`[build-pack] Full path: ${destPath}`);
console.log(`[build-pack] Package: ${pkg.name}@${newVersion}`);

// Determine npm dist-tag from version
function determineNpmTag(version) {
  const preMatch = version.match(/-(alpha|beta|rc)\./);
  if (preMatch) return preMatch[1];
  return 'latest';
}

const npmTag = determineNpmTag(newVersion);

// Determine scope name (without @, without /package-name) for permission hint
const scopeMatch = pkg.name.match(/^@([^/]+)\//);
const scopeForHint = scopeMatch ? `@${scopeMatch[1]}` : pkg.name;

// Generate publish.bat in dist-tarball/
// NOTE: Pakai goto labels untuk error branches agar terhindar dari batch parser
// issue saat ada parenthesis (mis. "(untuk stable)") di echo dalam if-block.
const publishBatContent = `@echo off
setlocal

echo ========================================
echo   NPM PUBLISH - ${pkg.name}
echo ========================================
echo.
echo Package: ${pkg.name}
echo Version: ${newVersion}
echo NPM Tag: ${npmTag}
echo Tarball: ${tarballName}
echo.

REM Phase 1: Pre-check npm login (avoid auth flow triggering mid-publish)
echo [1/3] Checking npm login status...
call npm whoami >nul 2>&1
if errorlevel 1 goto :not_logged_in

for /f "delims=" %%i in ('call npm whoami') do set NPM_USER=%%i
echo      Logged in as: %NPM_USER%
echo.

REM Phase 2: Pre-check version not yet published
echo [2/3] Checking if version already published...
call npm view ${pkg.name}@${newVersion} version >nul 2>&1
if not errorlevel 1 goto :version_exists

echo      Version ${newVersion} belum ada di registry, OK to publish.
echo.

REM Phase 3: Confirm and publish
echo [3/3] Ready to publish.
set /p CONFIRM="Publish ke NPM registry? (y/N): "
if /I not "%CONFIRM%"=="y" goto :cancelled

echo.
echo Running: npm publish ${tarballName} --tag ${npmTag} --access public
echo.
call npm publish ${tarballName} --tag ${npmTag} --access public

REM Post-verify by querying registry with retry (CDN propagation can take a few seconds)
echo.
echo Verifying publish by querying registry...
set VERIFY_RETRY=0

:verify_loop
call npm view ${pkg.name}@${newVersion} version >nul 2>&1
if not errorlevel 1 goto :verify_ok
set /a VERIFY_RETRY+=1
if %VERIFY_RETRY% geq 6 goto :publish_failed
echo      Attempt %VERIFY_RETRY%/6 - not visible yet, retry in 5 seconds...
timeout /t 5 /nobreak >nul
goto :verify_loop

:verify_ok

echo.
echo ========================================
echo   PUBLISH BERHASIL
echo ========================================
echo.
echo Package: ${pkg.name}@${newVersion}
echo Tag: ${npmTag}
echo URL: https://www.npmjs.com/package/${pkg.name}
echo.
echo Verify install dari registry:
echo   npm install -g ${pkg.name}@${npmTag}
echo.
pause
exit /b 0

:not_logged_in
echo.
echo [ERROR] Belum login ke npm.
echo.
echo Jalankan command berikut untuk login dulu:
echo   npm login
echo.
echo Setelah login berhasil, jalankan ulang publish.bat ini.
echo.
pause
exit /b 1

:version_exists
echo.
echo [ERROR] Versi ${newVersion} sudah pernah di-publish ke registry.
echo.
echo Bump version dulu di folder source restforge-mcp dengan salah satu flag:
echo   build-final.bat --patch     -- stable patch bump
echo   build-final.bat --minor     -- stable minor bump
echo   build-final.bat --beta      -- increment beta number
echo   build-final.bat --stable    -- promote pre-release ke stable
echo.
pause
exit /b 1

:cancelled
echo.
echo Publish dibatalkan oleh user.
exit /b 0

:publish_failed
echo.
echo [WARNING] Verifikasi via 'npm view' tidak menemukan package setelah 6 attempts.
echo.
echo Hal ini bisa berarti:
echo   1. Publish berhasil tapi CDN propagation lambat -- cek manual:
echo        npm view ${pkg.name}@${newVersion} version
echo      Kalau muncul versinya, publish sudah sukses. Abaikan warning ini.
echo.
echo   2. Publish benar-benar gagal. Common issues:
echo        - Tidak punya akses publish ke scope ${scopeForHint}: cek member organization di npmjs.org
echo        - Network issue: cek koneksi internet dan firewall
echo        - Auth issue: coba 'npm logout' lalu 'npm login' ulang
echo.
echo Cek manual di:
echo   https://www.npmjs.com/package/${pkg.name}
echo.
pause
exit /b 1
`;

const publishBatPath = join(distDir, 'publish.bat');
writeFileSync(publishBatPath, publishBatContent, 'utf-8');
console.log(`[build-pack] Publish script: ${publishBatPath}`);
console.log(`[build-pack] NPM tag: ${npmTag}`);
