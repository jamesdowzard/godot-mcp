import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';

import { listInstalledNdkVersions, readVendorsAddonVersion } from './validator.js';

const execFileAsync = promisify(execFile);

/**
 * Bundles the 5-step Android-build-template install recipe that Godot's
 * --install-android-build-template flag only partially performs:
 *
 *   1. Run the flag (writes android/.build_version)
 *   2. Extract android_source.zip into android/build/
 *   3. Pin ndkVersion in config.gradle to a locally-installed NDK
 *   4. Match openxrVendorsVersion in config.gradle to the addon version
 *   5. Create android/build/.gdignore so Godot's file scanner ignores the
 *      Gradle template's webp mipmaps (they break the resource merger).
 *
 * Companion to `validator.ts`: after this runs, `validate_export` should show
 * zero errors for `android_template_missing`, `ndk_not_installed`, and
 * `vendors_version_mismatch`.
 */

export interface InstallStep {
  name: string;
  status: 'success' | 'skipped' | 'failed';
  message?: string;
}

export interface InstallResult {
  success: boolean;
  projectPath: string;
  godotVersion?: string;
  templateZip?: string;
  ndkVersion?: string;
  vendorsVersion?: string;
  steps: InstallStep[];
  errors: string[];
}

export interface InstallOptions {
  projectPath: string;
  godotPath: string;
  ndkVersion?: string;
  vendorsVersion?: string;
}

function templateSearchPaths(godotVersion: string): string[] {
  const home = process.env.HOME || '';
  const xdgData = process.env.XDG_DATA_HOME || join(home, '.local/share');
  return [
    join(home, 'Library/Application Support/Godot/export_templates', `${godotVersion}.stable`, 'android_source.zip'),
    join(xdgData, 'godot/export_templates', `${godotVersion}.stable`, 'android_source.zip'),
    join(home, '.local/share/godot/export_templates', `${godotVersion}.stable`, 'android_source.zip'),
  ];
}

function parseGodotVersion(raw: string): string | undefined {
  // `godot --version` prints e.g. "4.6.2.stable.official.71f334935"
  // or sometimes "4.6.stable.official.<sha>" for .0 releases.
  const match = raw.match(/^(\d+)\.(\d+)(?:\.(\d+))?/m);
  if (!match) return undefined;
  const [, major, minor, patch] = match;
  return patch ? `${major}.${minor}.${patch}` : `${major}.${minor}`;
}

function stepSuccess(steps: InstallStep[], name: string, message?: string) {
  steps.push({ name, status: 'success', message });
}

function stepSkipped(steps: InstallStep[], name: string, message: string) {
  steps.push({ name, status: 'skipped', message });
}

function stepFailed(steps: InstallStep[], errors: string[], name: string, message: string) {
  steps.push({ name, status: 'failed', message });
  errors.push(`${name}: ${message}`);
}

export async function installAndroidBuildTemplate(opts: InstallOptions): Promise<InstallResult> {
  const { projectPath, godotPath } = opts;
  const steps: InstallStep[] = [];
  const errors: string[] = [];
  const result: InstallResult = {
    success: false,
    projectPath,
    steps,
    errors,
  };

  if (!existsSync(join(projectPath, 'project.godot'))) {
    errors.push(`project.godot not found at ${projectPath}`);
    return result;
  }

  // 1. Detect Godot version.
  let godotVersion: string | undefined;
  try {
    const { stdout } = await execFileAsync(godotPath, ['--version'], { timeout: 10000 });
    godotVersion = parseGodotVersion(stdout);
    if (!godotVersion) throw new Error(`unparseable output: ${stdout.trim()}`);
    result.godotVersion = godotVersion;
    stepSuccess(steps, 'detect_godot_version', godotVersion);
  } catch (e: any) {
    stepFailed(steps, errors, 'detect_godot_version', e?.message ?? String(e));
    return result;
  }

  // 2. Locate android_source.zip.
  let templateZip: string | undefined;
  for (const candidate of templateSearchPaths(godotVersion)) {
    if (existsSync(candidate)) {
      templateZip = candidate;
      break;
    }
  }
  if (!templateZip) {
    stepFailed(
      steps,
      errors,
      'locate_template_zip',
      `android_source.zip not found for Godot ${godotVersion}. Install export templates via Editor → Manage Export Templates.`
    );
    return result;
  }
  result.templateZip = templateZip;
  stepSuccess(steps, 'locate_template_zip', templateZip);

  // 3. Write android/.build_version so Godot's export pipeline sees the template.
  // Godot's own --install-android-build-template flag is unreliable: on projects
  // without an Android export preset it hangs or no-ops without writing the file.
  // The file content is deterministic (just the version string), so write it
  // directly.
  const androidDir = join(projectPath, 'android');
  const buildVersionFile = join(androidDir, '.build_version');
  if (existsSync(buildVersionFile)) {
    const existing = readFileSync(buildVersionFile, 'utf8').trim();
    if (existing === `${godotVersion}.stable`) {
      stepSkipped(steps, 'write_build_version', `already ${existing}`);
    } else {
      writeFileSync(buildVersionFile, `${godotVersion}.stable`);
      stepSuccess(steps, 'write_build_version', `${existing} → ${godotVersion}.stable`);
    }
  } else {
    mkdirSync(androidDir, { recursive: true });
    writeFileSync(buildVersionFile, `${godotVersion}.stable`);
    stepSuccess(steps, 'write_build_version', `${godotVersion}.stable`);
  }

  // 4. Unzip android_source.zip into android/build/.
  const buildDir = join(projectPath, 'android/build');
  const buildGradle = join(buildDir, 'build.gradle');
  if (existsSync(buildGradle)) {
    stepSkipped(steps, 'unzip_template', 'android/build/build.gradle already present');
  } else {
    try {
      mkdirSync(buildDir, { recursive: true });
      await execFileAsync('/usr/bin/unzip', ['-oq', templateZip, '-d', buildDir], { timeout: 60000 });
      if (!existsSync(buildGradle)) {
        throw new Error('unzip completed but build.gradle is still missing');
      }
      stepSuccess(steps, 'unzip_template', buildDir);
    } catch (e: any) {
      stepFailed(steps, errors, 'unzip_template', e?.message ?? String(e));
      return result;
    }
  }

  // 5. Patch ndkVersion in config.gradle.
  const configGradle = join(buildDir, 'config.gradle');
  if (!existsSync(configGradle)) {
    stepFailed(steps, errors, 'patch_ndk', `config.gradle missing at ${configGradle}`);
    return result;
  }

  const installedNdks = listInstalledNdkVersions();
  let targetNdk = opts.ndkVersion;
  if (!targetNdk) {
    targetNdk = installedNdks[0];
  }
  if (!targetNdk) {
    stepFailed(
      steps,
      errors,
      'patch_ndk',
      'no NDK version provided and none installed under ~/Library/Android/sdk/ndk or ANDROID_NDK_HOME. Install via Android Studio SDK Manager.'
    );
    return result;
  }
  if (opts.ndkVersion && installedNdks.length > 0 && !installedNdks.includes(opts.ndkVersion)) {
    stepFailed(
      steps,
      errors,
      'patch_ndk',
      `requested NDK ${opts.ndkVersion} not installed. Installed: ${installedNdks.join(', ')}`
    );
    return result;
  }

  let gradleText = readFileSync(configGradle, 'utf8');
  const currentNdkMatch = gradleText.match(/ndkVersion\s*:\s*'([^']+)'/);
  if (!currentNdkMatch) {
    stepFailed(steps, errors, 'patch_ndk', 'could not find ndkVersion line in config.gradle');
    return result;
  }
  result.ndkVersion = targetNdk;
  if (currentNdkMatch[1] === targetNdk) {
    stepSkipped(steps, 'patch_ndk', `already ${targetNdk}`);
  } else {
    gradleText = gradleText.replace(/ndkVersion\s*:\s*'[^']+'/, `ndkVersion : '${targetNdk}'`);
    writeFileSync(configGradle, gradleText);
    stepSuccess(steps, 'patch_ndk', `${currentNdkMatch[1]} → ${targetNdk}`);
  }

  // 6. Patch openxrVendorsVersion in config.gradle (warn-only if addon absent).
  const addonVersion = readVendorsAddonVersion(projectPath);
  let targetVendors = opts.vendorsVersion;
  if (!targetVendors && addonVersion) {
    targetVendors = `${addonVersion}-stable`;
  }
  const currentVendorsMatch = gradleText.match(/openxrVendorsVersion\s*:\s*'([^']+)'/);
  if (!currentVendorsMatch) {
    stepSkipped(steps, 'patch_vendors_version', 'openxrVendorsVersion line not present in config.gradle');
  } else if (!targetVendors) {
    stepSkipped(
      steps,
      'patch_vendors_version',
      'godotopenxrvendors addon not found; leaving openxrVendorsVersion untouched'
    );
  } else {
    result.vendorsVersion = targetVendors;
    if (currentVendorsMatch[1] === targetVendors) {
      stepSkipped(steps, 'patch_vendors_version', `already ${targetVendors}`);
    } else {
      gradleText = gradleText.replace(
        /openxrVendorsVersion\s*:\s*'[^']+'/,
        `openxrVendorsVersion: '${targetVendors}'`
      );
      writeFileSync(configGradle, gradleText);
      stepSuccess(steps, 'patch_vendors_version', `${currentVendorsMatch[1]} → ${targetVendors}`);
    }
  }

  // 7. Create .gdignore so Godot's file scanner skips the gradle template.
  const gdignore = join(buildDir, '.gdignore');
  if (existsSync(gdignore)) {
    stepSkipped(steps, 'create_gdignore', 'already present');
  } else {
    writeFileSync(gdignore, '');
    stepSuccess(steps, 'create_gdignore');
  }

  result.success = errors.length === 0;
  return result;
}
